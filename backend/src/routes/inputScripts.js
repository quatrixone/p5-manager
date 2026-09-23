import express from 'express';
import fs from 'fs';
import path from 'path';
import { getRepo, log } from '../db/sqlite.js';
import { getBuiltinDir } from '../lib/builtinLoader.js';

const router = express.Router();

const BUILTIN_FILE = 'inputScripts.json';
const BUILTIN_MAX_BYTES = 256 * 1024;

// Built-in scripts live in /frontend/builtin/inputScripts.json - a plain
// JSON array of { id, name, description, script, notes? }. Read fresh on
// every call (the file is a few KB; no caching needed) so an edit via
// PUT /builtin/:id below is visible on the very next request without any
// module-cache invalidation dance.
function readBuiltinInputScripts() {
  const filePath = path.join(getBuiltinDir(), BUILTIN_FILE);
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    log('error', `Failed to load built-in input scripts: ${err.message}`);
    return [];
  }
}

// List of built-in scripts (id, name, description, script). Edit them
// through the app (the ✏️ Edit action, or the step editor's "Save to
// built-in") or directly in /frontend/builtin/inputScripts.json.
router.get('/builtin', (req, res) => {
  try {
    res.json(readBuiltinInputScripts());
  } catch (err) {
    log('error', `Failed to get built-in input scripts: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    res.json(getRepo().queryAll('SELECT * FROM input_scripts ORDER BY created_at DESC'));
  } catch (error) {
    log('error', `Failed to get input scripts: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const script = getRepo().queryOne('SELECT * FROM input_scripts WHERE id = ?', [parseInt(req.params.id)]);
    if (!script) return res.status(404).json({ error: 'Script not found' });
    res.json(script);
  } catch (error) {
    log('error', `Failed to get input script: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { name, script } = req.body;
    if (!name || !script) return res.status(400).json({ error: 'name and script required' });
    const lastId = getRepo().runAndSave(
      'INSERT INTO input_scripts (name, script) VALUES (?, ?)',
      [name, script],
    );
    log('info', `Created input script: ${name}`);
    res.json({ success: true, id: lastId });
  } catch (error) {
    log('error', `Failed to create input script: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { name, script } = req.body;
    if (!name || !script) return res.status(400).json({ error: 'name and script required' });
    const repo = getRepo();
    if (!repo.queryOne('SELECT id FROM input_scripts WHERE id = ?', [parseInt(req.params.id)])) {
      return res.status(404).json({ error: 'Script not found' });
    }
    repo.runAndSave(
      'UPDATE input_scripts SET name = ?, script = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, script, parseInt(req.params.id)],
    );
    log('info', `Updated input script: ${name}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to update input script: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    getRepo().runAndSave('DELETE FROM input_scripts WHERE id = ?', [parseInt(req.params.id)]);
    log('info', `Deleted input script ${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to delete input script: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ─── Built-in script editor ──────────────────────────────────────────────
//
// Updates the `script` field of a single entry in inputScripts.json.
// Previously this file was inputScripts.js and edits went through a
// hand-rolled regex/bracket-balancing scan of the raw JS source (locate
// `id: '<id>'`, expand outward to find the `script:` array literal,
// splice in a rebuilt literal) - correct but fragile by construction.
// Being JSON now, an edit is just parse → mutate the matching array
// entry → stringify. Same atomic-write-with-backup discipline as before
// (write to a tmp sibling, JSON.parse it back as a sanity check, then
// backup + rename) since that part was never about the file format.
router.put('/builtin/:id', (req, res) => {
  let tmpPath = null;
  try {
    const builtinId = req.params.id;
    const { script } = req.body || {};
    if (typeof script !== 'string') {
      return res.status(400).json({ error: '`script` must be a string' });
    }
    if (!builtinId.startsWith('builtin:')) {
      return res.status(400).json({ error: 'Only built-in ids (builtin:*) accepted here' });
    }

    const filePath = path.join(getBuiltinDir(), BUILTIN_FILE);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `${BUILTIN_FILE} not found on disk` });
    }

    const entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(entries)) {
      return res.status(500).json({ error: `${BUILTIN_FILE} does not contain a JSON array` });
    }
    const entry = entries.find(e => e && e.id === builtinId);
    if (!entry) {
      return res.status(404).json({ error: `Entry id "${builtinId}" not found in ${BUILTIN_FILE}` });
    }
    entry.script = script;

    const updated = JSON.stringify(entries, null, 2) + '\n';
    if (Buffer.byteLength(updated, 'utf8') > BUILTIN_MAX_BYTES) {
      return res.status(413).json({ error: `File would exceed ${BUILTIN_MAX_BYTES} bytes` });
    }

    tmpPath = `${filePath}.tmp-${Date.now()}-${process.pid}.json`;
    fs.writeFileSync(tmpPath, updated, 'utf8');
    try {
      const reparsed = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
      if (!Array.isArray(reparsed) || !reparsed.some(e => e && e.id === builtinId)) {
        throw new Error(`Entry "${builtinId}" missing after edit`);
      }
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      tmpPath = null;
      return res.status(400).json({ error: `Script failed validation: ${err.message}` });
    }

    if (fs.existsSync(filePath)) {
      try { fs.copyFileSync(filePath, `${filePath}.bak`); } catch (_) {}
    }
    fs.renameSync(tmpPath, filePath);
    tmpPath = null;

    log('info', `Built-in input script updated: ${builtinId}`);
    res.json({ success: true });
  } catch (err) {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
    const status = err.message?.includes('not found') ? 404 : 500;
    if (status >= 500) log('error', `builtin input PUT ${req.params.id}: ${err.message}`);
    res.status(status).json({ error: err.message });
  }
});

export default router;