import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import AdmZip from 'adm-zip';
import { getRepo, log } from '../db/sqlite.js';
import { loadBuiltin } from './builtinLoader.js';
import { payloadsDir } from './paths.js';

// Authoritative list lives in /frontend/builtin/payloads.js — single source
// of truth so the user only edits one file to change what gets auto-fetched.
// loadBuiltin() caches by mtime, so getEssentialPayloads() transparently
// returns the freshly-edited list the next time it's called.
export async function getEssentialPayloads() {
  const mod = await loadBuiltin('payloads.js');
  return Array.isArray(mod.ESSENTIAL_PAYLOADS) ? mod.ESSENTIAL_PAYLOADS : [];
}

function ensurePayloadsDir() {
  if (!fs.existsSync(payloadsDir)) {
    fs.mkdirSync(payloadsDir, { recursive: true });
  }
}

function payloadExists(filename) {
  const row = getRepo().queryOne(
    'SELECT id, filepath FROM payloads WHERE filename = ? OR name = ? LIMIT 1',
    [filename, filename],
  );
  if (!row) return false;
  // Make sure the file is actually on disk; otherwise treat as missing so we re-fetch.
  if (row.filepath && fs.existsSync(row.filepath)) return true;
  // Some old rows pointed to /app/data/payloads/... — check the current dir too.
  const here = path.join(payloadsDir, filename);
  if (fs.existsSync(here)) return true;
  return false;
}

function normalizeConsoleType(v) {
  if (v === 'ps4' || v === 'ps5') return v;
  return null;
}

function insertPayload({ name, filename, filepath, source_url, size, version, console_type }) {
  const repo = getRepo();
  // If a stale row exists (file missing), refresh it instead of duplicating.
  const existingId = repo.queryScalar(
    'SELECT id FROM payloads WHERE filename = ? OR name = ? LIMIT 1',
    [filename, filename],
  );

  const ct = normalizeConsoleType(console_type);
  if (existingId) {
    repo.run(
      'UPDATE payloads SET name = ?, filename = ?, filepath = ?, source_url = ?, size = ?, version = ?, console_type = COALESCE(?, console_type), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, filename, filepath, source_url || null, size || null, version || null, ct, existingId],
    );
  } else {
    repo.run(
      'INSERT INTO payloads (name, filename, filepath, source_url, size, version, console_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, filename, filepath, source_url || null, size || null, version || null, ct],
    );
  }
  repo.save();
}

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function downloadEntry(entry) {
  ensurePayloadsDir();
  const url = entry.url;
  const targetFilename = entry.filename;

  // ZIP archives: extract and keep the first .lua/.elf/.bin that matches the
  // expected target filename, or the first one we find. .bin is the PS4
  // GoldHEN payload format, so it gets the same treatment as PS5 .elf/.lua.
  if (url.toLowerCase().endsWith('.zip')) {
    const buf = await fetchBuffer(url);
    const zip = new AdmZip(buf);
    let written = null;
    for (const e of zip.getEntries()) {
      const en = e.entryName.toLowerCase();
      if (en.endsWith('.lua') || en.endsWith('.elf') || en.endsWith('.bin')) {
        const name = path.basename(e.entryName);
        const filepath = path.join(payloadsDir, name);
        const data = e.getData();
        fs.writeFileSync(filepath, data);
        insertPayload({
          name,
          filename: name,
          filepath,
          source_url: url,
          size: data.length,
          console_type: entry.console_type,
        });
        if (!written || name.toLowerCase() === targetFilename.toLowerCase()) {
          written = { name, filepath, size: data.length };
        }
      }
    }
    if (!written) throw new Error(`No .lua/.elf/.bin inside ${url}`);
    return written;
  }

  const buf = await fetchBuffer(url);
  const filepath = path.join(payloadsDir, targetFilename);
  fs.writeFileSync(filepath, buf);
  insertPayload({
    name: targetFilename,
    filename: targetFilename,
    filepath,
    source_url: url,
    size: buf.length,
    console_type: entry.console_type,
  });
  return { name: targetFilename, filepath, size: buf.length };
}

// Heuristic platform detection from filename. Kept local so this module
// doesn't depend on routes/payloads.js (which has its own slightly broader
// detector that also takes URL hints). For a bare disk scan we only have
// the filename to work with.
function detectConsoleTypeFromFilename(name) {
  const lc = (name || '').toLowerCase();
  if (lc.endsWith('.bin')) return 'ps4';
  if (/(^|[^a-z])(goldhen|mira|gold_hen|jkpatch)([^a-z]|$)/.test(lc)) return 'ps4';
  if (/(\b)(ps4|fw9\.00|fw5\.05|fw7\.55|fw6\.72)(\b)/.test(lc)) return 'ps4';
  if (/ps5-payload-dev|ps5_payload|byepervisor|kstuff|backpork|micromount|p2jb/.test(lc)) return 'ps5';
  if (/(\b)ps5(\b)/.test(lc)) return 'ps5';
  if (lc.endsWith('.lua')) return 'ps5';
  return null;
}

// Scan `data/payloads/` for .lua/.elf/.bin files that don't have a DB row
// yet, and insert them. Lets users drop arbitrary payload files into the
// folder (via FTP / SCP / file browser / volume mount) without having to
// upload them through the UI. Idempotent: re-running the scan only adds
// rows for unknown filenames, every known file is left alone.
//
// Returns the list of newly-registered filenames so the caller (typically
// the GET /api/payloads route) can log a single "auto-registered N files"
// line at boot or on first request.
export function scanPayloadsDir() {
  const added = [];
  if (!fs.existsSync(payloadsDir)) return added;

  let entries = [];
  try {
    entries = fs.readdirSync(payloadsDir, { withFileTypes: true });
  } catch (e) {
    log('error', `scanPayloadsDir: readdir failed: ${e.message}`);
    return added;
  }

  // Collect filenames currently known to the DB once — much cheaper than
  // one SELECT per file when the folder has dozens of entries.
  const known = new Set();
  try {
    for (const row of getRepo().queryAll('SELECT filename FROM payloads')) {
      if (row.filename) known.add(String(row.filename));
    }
  } catch (e) {
    log('error', `scanPayloadsDir: SELECT failed: ${e.message}`);
    return added;
  }

  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const name = ent.name;
    const lc = name.toLowerCase();
    if (!(lc.endsWith('.lua') || lc.endsWith('.elf') || lc.endsWith('.bin'))) continue;
    if (known.has(name)) continue;

    const filepath = path.join(payloadsDir, name);
    let size = null;
    try {
      size = fs.statSync(filepath).size;
    } catch (_) { /* keep size null */ }

    try {
      insertPayload({
        name,
        filename: name,
        filepath,
        source_url: null,
        size,
        version: null,
        console_type: detectConsoleTypeFromFilename(name),
      });
      added.push(name);
    } catch (e) {
      log('error', `scanPayloadsDir: insert failed for ${name}: ${e.message}`);
    }
  }

  if (added.length > 0) {
    log('info', `Auto-registered ${added.length} payload file(s) from disk: ${added.join(', ')}`);
  }
  return added;
}

// Ensure every essential payload is present. Missing entries are downloaded.
// Returns a summary. Errors on individual entries are logged but do not abort
// the whole batch — startup must remain resilient when offline.
export async function ensureDefaultPayloads({ force = false } = {}) {
  const summary = { added: [], skipped: [], failed: [] };
  ensurePayloadsDir();

  // Pick up any pre-existing files on disk before the network fetch loop
  // so the `payloadExists()` check below sees them as "already on disk"
  // and skips the redundant download. Important when the container is
  // restarted on top of a populated `data/payloads/` volume — without
  // this, every essential payload was being re-downloaded into the
  // already-present file (wasteful but otherwise harmless).
  try { scanPayloadsDir(); } catch (e) { log('error', `scanPayloadsDir at boot failed: ${e.message}`); }

  const list = await getEssentialPayloads();
  for (const entry of list) {
    try {
      if (!force && payloadExists(entry.filename)) {
        summary.skipped.push(entry.filename);
        continue;
      }
      log('info', `Downloading default payload: ${entry.filename} (${entry.description || entry.tag})`);
      const r = await downloadEntry(entry);
      summary.added.push({ filename: entry.filename, size: r.size });
    } catch (e) {
      // Default-payload download failures are not fatal — the upstream
      // GitHub release may have been retagged, deleted or rate-limited,
      // and the user can still upload the file by hand. Log as `warn`
      // (not `error`) so a transient 404 doesn't pollute the "Errors"
      // filter in the log viewer with permanent noise on every boot.
      const msg = `Default payload ${entry.filename} unavailable: ${e.message}`;
      if (/HTTP 4\d\d/.test(e.message)) log('warn', msg);
      else log('error', msg);
      summary.failed.push({ filename: entry.filename, error: e.message });
    }
  }

  return summary;
}
