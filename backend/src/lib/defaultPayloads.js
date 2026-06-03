import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import AdmZip from 'adm-zip';
import { getDatabase, saveDatabase, log } from '../db/sqlite.js';

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const payloadsDir = path.join(dataDir, 'payloads');

// Authoritative list of payloads that the manager keeps available out of the
// box. These are auto-downloaded on first startup and appear in the Payloads
// tab alongside whatever the user has added. They cover:
//   * built-in templates (e.g. p2jb.lua used by the "p2jb jailbreak" template)
//   * the Log viewer (klogsrv-ps5.elf and setlogserver.lua)
//   * common community payloads
//
// Each entry can have:
//   filename:    exact name the manager will store / look up by
//   url:         direct download URL (.elf / .lua / .zip — zips are
//                auto-extracted, keeping the first .elf/.lua found)
//   description: shown only in logs
//   tag:         marker used to identify what feature requires this payload
export const ESSENTIAL_PAYLOADS = [
  // --- Required by the Log viewer ----------------------------------------
  {
    filename: 'klogsrv-ps5.elf',
    url: 'https://github.com/ps5-payload-dev/klogsrv/releases/download/v0.8/klogsrv-ps5.elf',
    tag: 'log',
    description: 'Kernel log server (used by Log viewer)',
  },
  {
    filename: 'setlogserver.lua',
    url: 'https://raw.githubusercontent.com/Gezine/Luac0re/main/payloads/setlogserver.lua',
    tag: 'log',
    description: 'Lua log redirector (used by Log viewer)',
  },

  // --- Required by built-in templates ------------------------------------
  {
    filename: 'p2jb.lua',
    url: 'https://raw.githubusercontent.com/Gezine/Luac0re/main/payloads/p2jb.lua',
    tag: 'template',
    description: 'p2jb kernel exploit (used by the "p2jb jailbreak" template)',
  },

  // --- Pre-curated convenience payloads (existing defaults) --------------
  {
    filename: 'klogsrv.elf',
    url: 'https://github.com/john-tornblom/ps5-payload-klogsrv/releases/latest/download/klogsrv.elf',
    tag: 'community',
    description: 'Payload Kernel Logger (klogsrv)',
  },
  {
    filename: 'ps5-backpork.elf',
    url: 'https://github.com/BestPig/BackPork/releases/download/0.1/ps5-backpork.elf',
    tag: 'community',
    description: 'BackPork ELF',
  },
  {
    filename: 'kstuff.elf',
    url: 'https://github.com/EchoStretch/kstuff-lite/releases/download/v1.06/kstuff.elf',
    tag: 'community',
    description: 'kstuff-lite',
  },
  {
    filename: 'micromount.elf',
    url: 'https://github.com/PSBrew/MicroMount/releases/latest/download/micromount.elf',
    tag: 'community',
    description: 'MicroMount ELF loader',
  },
];

function ensurePayloadsDir() {
  if (!fs.existsSync(payloadsDir)) {
    fs.mkdirSync(payloadsDir, { recursive: true });
  }
}

function payloadExists(filename) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT id, filepath FROM payloads WHERE filename = ? OR name = ? LIMIT 1');
  stmt.bind([filename, filename]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  if (!row) return false;
  // Make sure the file is actually on disk; otherwise treat as missing so we re-fetch.
  if (row.filepath && fs.existsSync(row.filepath)) return true;
  // Some old rows pointed to /app/data/payloads/... — check the current dir too.
  const here = path.join(payloadsDir, filename);
  if (fs.existsSync(here)) return true;
  return false;
}

function insertPayload({ name, filename, filepath, source_url, size, version }) {
  const db = getDatabase();
  // If a stale row exists (file missing), refresh it instead of duplicating.
  const checkStmt = db.prepare('SELECT id FROM payloads WHERE filename = ? OR name = ? LIMIT 1');
  checkStmt.bind([filename, filename]);
  let existingId = null;
  if (checkStmt.step()) existingId = checkStmt.getAsObject().id;
  checkStmt.free();

  if (existingId) {
    db.run(
      'UPDATE payloads SET name = ?, filename = ?, filepath = ?, source_url = ?, size = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, filename, filepath, source_url || null, size || null, version || null, existingId]
    );
  } else {
    db.run(
      'INSERT INTO payloads (name, filename, filepath, source_url, size, version) VALUES (?, ?, ?, ?, ?, ?)',
      [name, filename, filepath, source_url || null, size || null, version || null]
    );
  }
  saveDatabase();
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

  // ZIP archives: extract and keep the first .lua/.elf that matches the
  // expected target filename, or the first .elf/.lua we find.
  if (url.toLowerCase().endsWith('.zip')) {
    const buf = await fetchBuffer(url);
    const zip = new AdmZip(buf);
    let written = null;
    for (const e of zip.getEntries()) {
      const en = e.entryName.toLowerCase();
      if (en.endsWith('.lua') || en.endsWith('.elf')) {
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
        });
        if (!written || name.toLowerCase() === targetFilename.toLowerCase()) {
          written = { name, filepath, size: data.length };
        }
      }
    }
    if (!written) throw new Error(`No .lua/.elf inside ${url}`);
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
  });
  return { name: targetFilename, filepath, size: buf.length };
}

// Ensure every essential payload is present. Missing entries are downloaded.
// Returns a summary. Errors on individual entries are logged but do not abort
// the whole batch — startup must remain resilient when offline.
export async function ensureDefaultPayloads({ force = false } = {}) {
  const summary = { added: [], skipped: [], failed: [] };
  ensurePayloadsDir();

  for (const entry of ESSENTIAL_PAYLOADS) {
    try {
      if (!force && payloadExists(entry.filename)) {
        summary.skipped.push(entry.filename);
        continue;
      }
      log('info', `Downloading default payload: ${entry.filename} (${entry.description || entry.tag})`);
      const r = await downloadEntry(entry);
      summary.added.push({ filename: entry.filename, size: r.size });
    } catch (e) {
      log('error', `Default payload ${entry.filename} failed: ${e.message}`);
      summary.failed.push({ filename: entry.filename, error: e.message });
    }
  }

  return summary;
}
