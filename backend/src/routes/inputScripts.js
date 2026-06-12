import express from 'express';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { getRepo, log } from '../db/sqlite.js';
import { loadBuiltin, getBuiltinDir, clearBuiltinCache } from '../lib/builtinLoader.js';

const router = express.Router();

const BUILTIN_FILE = 'inputScripts.js';
const BUILTIN_MAX_BYTES = 256 * 1024;

// Built-in scripts come from /frontend/builtin/inputScripts.js — see
// builtinLoader.js for path resolution. loadBuiltin caches by mtime so file
// edits via the built-in editor are visible on the next request.
async function getBuiltinInputScripts() {
  try {
    const mod = await loadBuiltin('inputScripts.js');
    return Array.isArray(mod.BUILTIN_INPUT_SCRIPTS) ? mod.BUILTIN_INPUT_SCRIPTS : [];
  } catch (err) {
    log('error', `Failed to load built-in input scripts: ${err.message}`);
    return [];
  }
}

// List of built-in scripts (id, name, description, script). These cannot
// be modified through the API — to change them the user edits
// /frontend/builtin/inputScripts.js.
router.get('/builtin', async (req, res) => {
  try {
    const list = await getBuiltinInputScripts();
    res.json(list);
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

// ─── Built-in script surgical editor ─────────────────────────────────────────
//
// Replaces the `script` field of a single entry inside the editable source
// file /frontend/builtin/inputScripts.js. The rest of the file (other
// entries, leading comments, formatting) is preserved verbatim.
//
// The matching strategy:
//   1. Read the source file.
//   2. For each entry in BUILTIN_INPUT_SCRIPTS (parsed via dynamic import),
//      check if its `id` matches the requested id.
//   3. Locate the literal `id: '<id>'` in the source, then expand outward
//      to find the enclosing object's `script:` array literal and replace it.
//
// Validation mirrors backend/src/routes/builtin.js: write to a tmp sibling,
// import it, and only rename on success. Previous version is kept as
// inputScripts.js.bak (single-level undo, identical to the file editor).

function escapeForJsString(line) {
  // Use JSON.stringify which produces a valid double-quoted JS string.
  // JS string syntax is a strict superset of JSON string syntax, so the
  // output is always a parseable literal regardless of input contents.
  return JSON.stringify(line);
}

function rebuildScriptArrayLiteral(scriptText, indent = '      ') {
  const lines = String(scriptText || '').split('\n');
  // Trim a single trailing empty line — common when the recorded textarea
  // has a stray \n — but keep intentional blank lines inside the script
  // (they survive .join('\n') just fine).
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const body = lines.length === 0
    ? ''
    : lines.map(l => `${indent}${escapeForJsString(l)},`).join('\n');
  return body
    ? `[\n${body}\n${indent.slice(2)}].join('\\n')`
    : `[].join('\\n')`;
}

function replaceBuiltinScriptInSource(source, builtinId, newScriptText) {
  // Step 1: locate the `id: '<id>'` literal. The id is always a string
  // literal in the source ("builtin:xxx"); accept both single and double
  // quotes for robustness.
  const idEsc = builtinId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idRe = new RegExp(
    `id\\s*:\\s*(?:'${idEsc}'|"${idEsc}")`,
  );
  const idMatch = idRe.exec(source);
  if (!idMatch) {
    throw new Error(`Entry id "${builtinId}" not found in source file`);
  }

  // Step 2: scan forward from the id match for the `script:` key. It must
  // be inside the same object literal (the source is hand-edited but
  // consistent: `script:` always follows `id:` within ~200 lines).
  const after = source.slice(idMatch.index + idMatch[0].length);
  const scriptKeyMatch = /\n(\s*)script\s*:\s*/.exec(after);
  if (!scriptKeyMatch) {
    throw new Error(`No script: field found after id "${builtinId}"`);
  }
  const indent = scriptKeyMatch[1] + '  '; // body indent = key indent + 2
  const valStart = idMatch.index + idMatch[0].length
    + scriptKeyMatch.index + scriptKeyMatch[0].length;

  // Step 3: parse the value. Two shapes are supported:
  //   a) [ 'line', 'line', ... ].join('\n')   (the conventional shape)
  //   b) 'single line string'                  (legacy / simple entries)
  let valEnd;
  if (source[valStart] === '[') {
    // Walk forward, balancing brackets and respecting string literals.
    let depth = 0;
    let i = valStart;
    let inStr = false;
    let strCh = '';
    for (; i < source.length; i++) {
      const ch = source[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === strCh) inStr = false;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { inStr = true; strCh = ch; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    // Consume optional `.join('\n')` / `.join("\n")` suffix.
    const joinRe = /^\s*\.join\(\s*(?:'\\n'|"\\n")\s*\)/;
    const tail = source.slice(i);
    const joinMatch = joinRe.exec(tail);
    if (joinMatch) i += joinMatch[0].length;
    valEnd = i;
  } else if (source[valStart] === "'" || source[valStart] === '"' || source[valStart] === '`') {
    const strCh = source[valStart];
    let i = valStart + 1;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '\\') { i++; continue; }
      if (ch === strCh) { i++; break; }
    }
    valEnd = i;
  } else {
    throw new Error(`Unexpected token at script: value (id ${builtinId})`);
  }

  const replacement = rebuildScriptArrayLiteral(newScriptText, indent);
  return source.slice(0, valStart) + replacement + source.slice(valEnd);
}

router.put('/builtin/:id', async (req, res) => {
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

    const dir = getBuiltinDir();
    const filePath = path.join(dir, BUILTIN_FILE);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `${BUILTIN_FILE} not found on disk` });
    }

    const source = fs.readFileSync(filePath, 'utf8');
    const updated = replaceBuiltinScriptInSource(source, builtinId, script);

    if (Buffer.byteLength(updated, 'utf8') > BUILTIN_MAX_BYTES) {
      return res.status(413).json({ error: `File would exceed ${BUILTIN_MAX_BYTES} bytes` });
    }

    // Validate by importing a tmp sibling. Identical pattern to builtin.js.
    tmpPath = `${filePath}.tmp-${Date.now()}-${process.pid}.js`;
    fs.writeFileSync(tmpPath, updated, 'utf8');
    try {
      const url = pathToFileURL(tmpPath).href + `?v=${Date.now()}`;
      const mod = await import(url);
      if (!Array.isArray(mod.BUILTIN_INPUT_SCRIPTS)) {
        throw new Error('export BUILTIN_INPUT_SCRIPTS missing or not an array');
      }
      const found = mod.BUILTIN_INPUT_SCRIPTS.some(e => e && e.id === builtinId);
      if (!found) throw new Error(`Entry "${builtinId}" missing after edit`);
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
    clearBuiltinCache(BUILTIN_FILE);

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