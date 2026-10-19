import fs from 'fs';
import path from 'path';
import { getRepo, log } from '../db/sqlite.js';
import { readBuiltinList } from './builtinLoader.js';
import { readMarketplaceBuiltinList } from './marketplaceCatalog.js';
import { payloadsDir } from './paths.js';
import { fileURLToPath } from 'url';

// The app's bundled payloads (p5managerclient/). They are not downloaded from
// anywhere: the built files ship with the app - in vendored/ next to src/ in
// the Docker image, the Windows package and an update bundle, in
// p5managerclient/ in a checkout - and are copied into the payloads folder
// when they are not there, like the downloaded ones.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VENDORED_PAYLOADS = [
  { filename: 'rp-get-pin-ps4.bin', dir: 'rp-get-pin-ps4', console_type: 'ps4', version: '3' },
  { filename: 'offact-ps4.bin', dir: 'offact-ps4', console_type: 'ps4', version: '2' },
  { filename: 'rp-get-pin.elf', dir: 'rp-get-pin', console_type: 'ps5' },
  { filename: 'offact.elf', dir: 'offact', console_type: 'ps5', version: '2' },
  { filename: 'pkg-install.elf', dir: 'pkg-install', console_type: 'ps5' },
  { filename: 'save-mounter.elf', dir: 'save-mounter', console_type: 'ps5' },
  { filename: 'lz4-compression.elf', dir: 'lz4-compression', console_type: 'ps5', version: '1.6.2-p5manager' },
];
// Same bytes on both sides? Used to tell a payload that only needs its
// version recorded from one that really has to be rewritten. Reads both
// files; they are a few hundred kB at most.
export function sameContent(a, b) {
  try {
    if (fs.statSync(a).size !== fs.statSync(b).size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

// Put a shipped payload in place. Returns 'copied', or 'kept' when the
// file on disk cannot be overwritten but already holds the same bytes —
// a payloads folder left over from a run as another user (root, before
// the compose file pinned the container to the host user) is read-only
// to us, and rewriting it is then pointless anyway.
export function placeVendoredPayload(source, filepath) {
  try {
    fs.copyFileSync(source, filepath);
    return 'copied';
  } catch (e) {
    if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
    if (sameContent(source, filepath)) return 'kept';
    throw new Error(`cannot replace ${filepath} (owned by another user): ${e.message}`);
  }
}

export function vendoredSource(entry) {
  const candidates = [
    path.resolve(__dirname, '../../vendored', entry.filename),
    path.resolve(__dirname, '../../../p5managerclient', entry.dir, entry.filename),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

// The list comes from the Marketplace, like the curated scripts and
// templates, so a new default payload reaches running installs without a
// release. The copy shipped in the app answers while the first fetch has
// not happened yet, or when there is no network at all.
export async function getEssentialPayloads() {
  try {
    return await readMarketplaceBuiltinList('payloads.json');
  } catch (e) {
    log('warn', `Default payload list from the marketplace unavailable: ${e.message}`);
    return readBuiltinList('payloads.json');
  }
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

export function insertPayload({ name, filename, filepath, source_url, size, version, console_type }) {
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

// Heuristic platform detection from filename. Kept local so this module
// doesn't depend on routes/payloads.js (which has its own slightly broader
// detector that also takes URL hints). For a bare disk scan we only have
// the filename to work with.
function detectConsoleTypeFromFilename(name) {
  const lc = (name || '').toLowerCase();
  if (lc.endsWith('.bin')) return 'ps4';
  if (/(^|[^a-z])(goldhen|mira|gold_hen|jkpatch)([^a-z]|$)/.test(lc)) return 'ps4';
  if (/(\b)(ps4|fw9\.00|fw5\.05|fw7\.55|fw6\.72)(\b)/.test(lc)) return 'ps4';
  if (/ps5-payload-dev|ps5_payload|byepervisor|kstuff|backpork|p2jb/.test(lc)) return 'ps5';
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
// Files that happen to match an ESSENTIAL_PAYLOADS filename get that
// entry's `url` stamped in as source_url, so a file that was already on
// disk (e.g. restored from a volume) still gets the Check/Update buttons
// in the UI instead of looking like a manual upload with no known origin.
//
// Returns the list of newly-registered filenames so the caller (typically
// the GET /api/payloads route) can log a single "auto-registered N files"
// line at boot or on first request.
export async function scanPayloadsDir() {
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

  const essentialByFilename = new Map();
  try {
    for (const entry of await getEssentialPayloads()) {
      if (entry.filename) essentialByFilename.set(entry.filename, entry);
    }
  } catch (e) {
    log('error', `scanPayloadsDir: getEssentialPayloads failed: ${e.message}`);
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

    const essential = essentialByFilename.get(name);

    try {
      insertPayload({
        name,
        filename: name,
        filepath,
        source_url: essential?.url || null,
        size,
        version: null,
        console_type: essential?.console_type || detectConsoleTypeFromFilename(name),
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

// Put the app's own payloads in the library: the ones built from
// p5managerclient/ and shipped with the app. Nothing is downloaded here -
// the rest of the built-in payloads are Marketplace items the user
// installs, so they can be updated without a new release.
export async function ensureDefaultPayloads({ force = false } = {}) {
  const summary = { added: [], skipped: [], failed: [] };
  ensurePayloadsDir();

  // Pick up any pre-existing files on disk before the network fetch loop
  // so the `payloadExists()` check below sees them as "already on disk"
  // and skips the redundant download. Important when the container is
  // restarted on top of a populated `data/payloads/` volume — without
  // this, every essential payload was being re-downloaded into the
  // already-present file (wasteful but otherwise harmless).
  try { await scanPayloadsDir(); } catch (e) { log('error', `scanPayloadsDir at boot failed: ${e.message}`); }

  for (const entry of VENDORED_PAYLOADS) {
    try {
      const installedVersion = entry.version
        ? getRepo().queryScalar('SELECT version FROM payloads WHERE filename = ? LIMIT 1', [entry.filename])
        : null;
      if (!force && payloadExists(entry.filename) && (!entry.version || installedVersion === entry.version)) {
        summary.skipped.push(entry.filename);
        continue;
      }
      const source = vendoredSource(entry);
      if (!source) throw new Error('not shipped with this installation');
      const filepath = path.join(payloadsDir, entry.filename);
      const outcome = placeVendoredPayload(source, filepath);
      const size = fs.statSync(filepath).size;
      insertPayload({ name: entry.filename, filename: entry.filename, filepath, size, version: entry.version, console_type: entry.console_type });
      if (outcome === 'kept') {
        // Only the version in the database was missing, so this is not
        // worth a line on every boot.
        summary.skipped.push(entry.filename);
        continue;
      }
      log('info', `Added the app's own payload: ${entry.filename}`);
      summary.added.push({ filename: entry.filename, size });
    } catch (e) {
      log('warn', `Own payload ${entry.filename} unavailable: ${e.message}`);
      summary.failed.push({ filename: entry.filename, error: e.message });
    }
  }

  // Everything else is a Marketplace item now. The app ships only what it
  // builds itself, and the payloads the built-in features use are
  // installed from Marketplace, where they can also be updated.
  return summary;
}
