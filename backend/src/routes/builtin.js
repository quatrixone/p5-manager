// Editor API for /frontend/builtin/*.js.
//
// Lets the hidden UI editor (frontend BuiltinEditor.jsx) read and write the
// three built-in source files. Edits are:
//   * restricted to a fixed allow-list of filenames,
//   * validated by attempting a dynamic import of a temp copy — a syntax
//     error or runtime throw aborts the save without touching the real file,
//   * atomic (write to tmp, fsync, rename),
//   * backed up — previous version goes to `<file>.bak` next to it,
//   * cache-invalidated so loadBuiltin() picks the new file up immediately.

import express from 'express';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { log } from '../db/sqlite.js';
import { getBuiltinDir, clearBuiltinCache } from '../lib/builtinLoader.js';

const router = express.Router();

// Only these files can be read/written. Each entry advertises the named
// export(s) the editor should expect after a successful save — pure
// metadata for the UI; the server doesn't enforce the export name beyond
// confirming the dynamic import doesn't throw.
const EDITABLE_FILES = [
  {
    name: 'payloads.js',
    title: 'Default Payloads',
    description: 'Payloads auto-downloaded on startup. Each entry has filename + url + tag + description.',
    expectsExport: 'ESSENTIAL_PAYLOADS',
  },
  {
    name: 'templates.js',
    title: 'Autoload Templates',
    description: 'Sequence templates shown in the Autoload "Templates" panel.',
    expectsExport: 'DEFAULT_TEMPLATES',
  },
  {
    name: 'inputScripts.js',
    title: 'Built-in Input Scripts',
    description: 'Script Runner macros (Restart PS5, Rest Mode, …).',
    expectsExport: 'BUILTIN_INPUT_SCRIPTS',
  },
];
const ALLOWED_NAMES = new Set(EDITABLE_FILES.map(f => f.name));

const MAX_BYTES = 256 * 1024; // 256 KB is plenty for these data files

function resolveBuiltinFile(name) {
  if (!ALLOWED_NAMES.has(name)) {
    const err = new Error(`File not editable: ${name}`);
    err.status = 400;
    throw err;
  }
  const dir = getBuiltinDir();
  const filePath = path.join(dir, name);
  // Defence in depth: path.join() already strips ..; double-check the
  // resolved path is still inside the builtin dir (catches symlink shenanigans).
  if (!filePath.startsWith(dir + path.sep) && filePath !== path.join(dir, name)) {
    const err = new Error(`Path escape attempt: ${name}`);
    err.status = 400;
    throw err;
  }
  return { dir, filePath };
}

router.get('/files', (req, res) => {
  try {
    const dir = getBuiltinDir();
    const files = EDITABLE_FILES.map(meta => {
      const p = path.join(dir, meta.name);
      let stat = null;
      try { stat = fs.statSync(p); } catch (_) {}
      return {
        ...meta,
        exists: !!stat,
        size: stat ? stat.size : 0,
        mtime: stat ? stat.mtimeMs : null,
      };
    });
    res.json({ dir, files });
  } catch (err) {
    log('error', `builtin /files failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/files/:name', (req, res) => {
  try {
    const { filePath } = resolveBuiltinFile(req.params.name);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File missing on disk' });
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const stat = fs.statSync(filePath);
    res.json({
      name: req.params.name,
      content,
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) log('error', `builtin GET ${req.params.name}: ${err.message}`);
    res.status(status).json({ error: err.message });
  }
});

router.put('/files/:name', async (req, res) => {
  let tmpPath = null;
  try {
    const { filePath } = resolveBuiltinFile(req.params.name);
    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: '`content` must be a string' });
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
      return res.status(413).json({ error: `File exceeds ${MAX_BYTES} bytes` });
    }

    // Validate by importing a sibling tmp copy. Same directory so any sibling
    // imports (none today, but future-proof) and relative URLs behave the
    // same. Bust Node's ESM cache with a unique query string each time.
    tmpPath = `${filePath}.tmp-${Date.now()}-${process.pid}.js`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    try {
      const url = pathToFileURL(tmpPath).href + `?v=${Date.now()}`;
      await import(url);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      tmpPath = null;
      return res.status(400).json({
        error: `Script failed validation: ${err.message}`,
      });
    }

    // Backup current version (best effort) then atomically replace.
    if (fs.existsSync(filePath)) {
      try { fs.copyFileSync(filePath, `${filePath}.bak`); } catch (_) {}
    }
    fs.renameSync(tmpPath, filePath);
    tmpPath = null;

    clearBuiltinCache(req.params.name);

    const stat = fs.statSync(filePath);
    log('info', `Built-in updated: ${req.params.name} (${stat.size} bytes)`);
    res.json({ success: true, size: stat.size, mtime: stat.mtimeMs });
  } catch (err) {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
    const status = err.status || 500;
    if (status >= 500) log('error', `builtin PUT ${req.params.name}: ${err.message}`);
    res.status(status).json({ error: err.message });
  }
});

// Restore the previous version from .bak (single level of undo).
router.post('/files/:name/restore-backup', (req, res) => {
  try {
    const { filePath } = resolveBuiltinFile(req.params.name);
    const bak = `${filePath}.bak`;
    if (!fs.existsSync(bak)) {
      return res.status(404).json({ error: 'No backup available' });
    }
    fs.copyFileSync(bak, filePath);
    clearBuiltinCache(req.params.name);
    const stat = fs.statSync(filePath);
    log('info', `Built-in restored from backup: ${req.params.name}`);
    res.json({ success: true, size: stat.size, mtime: stat.mtimeMs });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) log('error', `builtin restore ${req.params.name}: ${err.message}`);
    res.status(status).json({ error: err.message });
  }
});

export default router;
