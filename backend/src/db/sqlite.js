import initSqlJs from 'sql.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { fileLog } from '../lib/fileLog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// docker: /app/src/db/sqlite.js -> /app
// dev: /path/to/backend/src/db/sqlite.js -> /path/to
const isInDocker = __dirname.startsWith('/app');
const projectRoot = isInDocker ? '/app' : path.resolve(__dirname, '../..');
// P5M_DB_DIR: the portable build keeps the database outside the program
// folder so replacing the app with a newer one keeps the data.
const dbPath = path.join(process.env.P5M_DB_DIR || path.join(projectRoot, 'data'), 'p5manager.db');
const dbDir = path.dirname(dbPath);
// Legacy paths, newest -> oldest. The DB has gone through three filenames:
//   payloads.db        — original (pre-2026-06)
//   ps5webmanager.db   — after the "PS5WebPayload Manager" rename
//   p5manager.db       — current, after the P5 Manager rebrand
// On first boot we look for any legacy file and rename it under the current
// name. We stop at the first match (newest legacy wins) so we never clobber
// a more recent migration with an older one.
const LEGACY_DB_NAMES = ['ps5webmanager.db', 'payloads.db'];

let db = null;
let SqlJs = null;

export async function initDatabase() {
  if (db) return db;

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // One-shot migration to p5manager.db from any older filename.
  if (!fs.existsSync(dbPath)) {
    for (const legacyName of LEGACY_DB_NAMES) {
      const legacyDbPath = path.join(dbDir, legacyName);
      if (!fs.existsSync(legacyDbPath)) continue;
      try {
        fs.renameSync(legacyDbPath, dbPath);
        console.log(`[db] migrated ${legacyDbPath} -> ${dbPath}`);
      } catch (e) {
        console.error('[db] migration rename failed, falling back to copy:', e.message);
        try {
          fs.copyFileSync(legacyDbPath, dbPath);
          console.log(`[db] migrated by copy ${legacyDbPath} -> ${dbPath}`);
        } catch (e2) {
          console.error('[db] copy fallback also failed:', e2.message);
        }
      }
      break;
    }
  }

  SqlJs = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SqlJs.Database(buffer);
  } else {
    db = new SqlJs.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      mac_address TEXT,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add mac_address column if it doesn't exist
  try {
    db.run(`ALTER TABLE profiles ADD COLUMN mac_address TEXT`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  // Add is_default column if it doesn't exist
  try {
    db.run(`ALTER TABLE profiles ADD COLUMN is_default INTEGER DEFAULT 0`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  // Add credential column if it doesn't exist
  try {
    db.run(`ALTER TABLE profiles ADD COLUMN credential TEXT`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  // Add port column if it doesn't exist
  try {
    db.run(`ALTER TABLE profiles ADD COLUMN port INTEGER DEFAULT 9021`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  // Remote Play identity. psn_account_id is the effective console account ID,
  // rp_user_profile holds the pairing profile dict (pyremoteplay's layout, kept) with registration
  // credentials (kept as JSON text). Only "duplicate column" is benign - any
  // other ALTER error (syntax, missing table, ...) should bubble up so we
  // don't silently corrupt the schema on a typo.
  try { db.run(`ALTER TABLE profiles ADD COLUMN psn_account_id TEXT`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.run(`ALTER TABLE profiles ADD COLUMN psn_online_id TEXT`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  // Username of the active local console user reported by the PS4 offact payload.
  try { db.run(`ALTER TABLE profiles ADD COLUMN console_user TEXT`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  // Imported Sony identity is separate from the account used on the console.
  for (const column of ['sony_account_id', 'sony_online_id']) {
    try { db.run(`ALTER TABLE profiles ADD COLUMN ${column} TEXT`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  try { db.run(`ALTER TABLE profiles ADD COLUMN rp_user_profile TEXT`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  // Platform: 'ps4' | 'ps5' | NULL (auto-detect via the Remote Play service's /discover).
  // Drives which payloads, autoload templates, FTP defaults and Convert
  // sub-tabs the UI shows for this profile. Filled in either at profile
  // creation (user picks in Settings) or by the periodic status poll
  // calling /api/ps5/status which already extracts host_type from the
  // sidecar discover response.
  try { db.run(`ALTER TABLE profiles ADD COLUMN console_type TEXT`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  // FTP port of this console; NULL = the default for its type (lib/ftpPort.js).
  try { db.run(`ALTER TABLE profiles ADD COLUMN ftp_port INTEGER`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

  db.run(`
    CREATE TABLE IF NOT EXISTS payloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      source_url TEXT,
      version TEXT,
      size INTEGER,
      sha256 TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add updated_at column if it doesn't exist (for existing databases)
  try {
    db.run(`ALTER TABLE payloads ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  // Platform tag for payloads: 'ps4' | 'ps5' | NULL (= any/unknown).
  // Lets the Payloads tab + Autoload "send payload" picker filter by
  // the active platform mode so PS4 mode never accidentally pushes a
  // PS5 LUA payload to a PS4 (different ports, different ABI).
  try {
    db.run(`ALTER TABLE payloads ADD COLUMN console_type TEXT`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS autoload_sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      steps TEXT NOT NULL,
      schedule_cron TEXT,
      schedule_enabled INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    )
  `);

  // Add schedule columns if they don't exist
  try {
    db.run(`ALTER TABLE autoload_sequences ADD COLUMN schedule_cron TEXT`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  try {
    db.run(`ALTER TABLE autoload_sequences ADD COLUMN schedule_enabled INTEGER DEFAULT 0`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  try {
    db.run(`ALTER TABLE autoload_sequences ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }

  // 'loader_down' = run by itself when the console is on but its payload
  // loader port is closed (see the watcher in routes/sequences.js).
  try { db.run(`ALTER TABLE autoload_sequences ADD COLUMN auto_trigger TEXT`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  // JSON settings of that trigger: { intervalS, port, closedForS, cooldownMin }.
  try { db.run(`ALTER TABLE autoload_sequences ADD COLUMN auto_trigger_config TEXT`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS input_scripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      script TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try { db.run('ALTER TABLE input_scripts ADD COLUMN console_type TEXT'); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

  // What came from the marketplace (store/ in the repository): which item,
  // which version. A script lives on in input_scripts (local_id); a
  // template is kept here whole (data) and listed beside the built-in ones.
  db.run(`
    CREATE TABLE IF NOT EXISTS store_installs (
      kind TEXT NOT NULL,
      store_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      local_id INTEGER,
      installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (kind, store_id)
    )
  `);

  migrateLegacySettings(db);

  // Source registry (SMB + FTP origins used by the file browser). Previously
  // named `micromount_sources`; renamed to `convert_sources` to match the
  // /api/convert URL surface. The migration below renames legacy tables so
  // existing installs keep their saved sources.
  try {
    const stmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('micromount_sources','convert_sources')");
    const present = new Set();
    while (stmt.step()) present.add(stmt.getAsObject().name);
    stmt.free();
    if (present.has('micromount_sources') && !present.has('convert_sources')) {
      db.run(`ALTER TABLE micromount_sources RENAME TO convert_sources`);
    }
  } catch (_) { /* best-effort; CREATE IF NOT EXISTS below handles fresh installs */ }

  db.run(`
    CREATE TABLE IF NOT EXISTS convert_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'local',
      path TEXT NOT NULL,
      smb_host TEXT,
      smb_share TEXT,
      smb_username TEXT,
      smb_password TEXT,
      smb_domain TEXT,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // FTP source columns (added when the source registry was extended to
  // support FTP origins alongside SMB). Wrapped in try/catch so older
  // databases pick them up via ALTER without re-creating the table.
  try { db.run(`ALTER TABLE convert_sources ADD COLUMN ftp_host TEXT`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.run(`ALTER TABLE convert_sources ADD COLUMN ftp_port INTEGER`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.run(`ALTER TABLE convert_sources ADD COLUMN ftp_username TEXT`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.run(`ALTER TABLE convert_sources ADD COLUMN ftp_password TEXT`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

  saveDatabase();
  return db;
}

// Settings that carried the name of a feature the app no longer has: the two
// still in use move to a name of their own, the other two are dropped. Run
// on start and after a backup is restored, which may bring the old names back.
const RENAMED_SETTINGS = { micromount_ftp: 'ftp_login', micromount_browser_prefs: 'file_browser_prefs' };
const DROPPED_SETTINGS = ['micromount_config', 'micromount_release_state'];
export function migrateLegacySettings(target = db) {
  try {
    for (const [old, now] of Object.entries(RENAMED_SETTINGS)) {
      target.run('INSERT OR IGNORE INTO settings (key, value) SELECT ?, value FROM settings WHERE key = ?', [now, old]);
      target.run('DELETE FROM settings WHERE key = ?', [old]);
    }
    for (const key of DROPPED_SETTINGS) target.run('DELETE FROM settings WHERE key = ?', [key]);
  } catch (_) { /* a database without the settings table yet */ }
}

export function getDatabase() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

// Batched variant: coalesces a burst of writeDatabase() calls into a
// single export+fsync. Lots of routes do a multi-step mutation
// (INSERT row + UPDATE settings + INSERT log) and call runAndSave()
// three times in a row - each one is a full db.export() and disk
// write. With many routes active at once those add up. Trailing-
// edge flush: any new call within `saveDbDebounceMs` re-arms the
// timer so a long burst stays coalesced, but the very last write
// still gets to disk.
let _saveDbTimer = null;
const saveDbDebounceMs = 50;
export function saveDatabaseDebounced() {
  if (!db) return;
  if (_saveDbTimer) return;
  _saveDbTimer = setTimeout(() => {
    _saveDbTimer = null;
    try { saveDatabase(); } catch (e) { console.error('[db] debounced save failed:', e.message); }
  }, saveDbDebounceMs);
}

// Force-flush any pending debounced save. Useful at end-of-request
// for callers that need on-disk durability before the response is
// acknowledged (e.g. the bootstrap path right after init).
export function flushPendingSave() {
  if (!_saveDbTimer) return;
  clearTimeout(_saveDbTimer);
  _saveDbTimer = null;
  try { saveDatabase(); } catch (_) { /* swallowed; the next save will retry */ }
}

// ───────────────────────────────────────────────────────────────────────────
// Repository facade — wraps the bare sql.js handle in three high-level
// helpers (queryOne / queryAll / run) so route handlers no longer have to
// write out the prepare → bind → step → getAsObject → free dance for every
// single query. Reduces ~5 LOC per query to 1.
//
// The raw sql.js handle is still reachable via getDatabase() for the rare
// callers that need cursor-style iteration (currently only the migration
// path in initDatabase()).
// ───────────────────────────────────────────────────────────────────────────
export class DatabaseRepo {
  constructor(handle) { this._db = handle; }

  // Fetch a single row, or null if the query yields nothing.
  queryOne(sql, params = []) {
    const stmt = this._db.prepare(sql);
    try {
      if (params && params.length) stmt.bind(params);
      return stmt.step() ? stmt.getAsObject() : null;
    } finally {
      stmt.free();
    }
  }

  // Fetch every row matching the query.
  queryAll(sql, params = []) {
    const stmt = this._db.prepare(sql);
    try {
      if (params && params.length) stmt.bind(params);
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }

  // Project a single scalar column (e.g. `COUNT(*)` or a single value lookup).
  // Returns undefined when the result set is empty.
  queryScalar(sql, params = []) {
    const row = this.queryOne(sql, params);
    if (!row) return undefined;
    const keys = Object.keys(row);
    return keys.length ? row[keys[0]] : undefined;
  }

  // Fire-and-forget statement (INSERT / UPDATE / DELETE / DDL). Returns
  // the auto-increment id for INSERTs (or 0 when not applicable).
  run(sql, params = []) {
    this._db.run(sql, params);
    const r = this.queryOne('SELECT last_insert_rowid() AS id');
    return r ? r.id : 0;
  }

  // Persist the in-memory db image back to disk. sql.js keeps everything
  // in RAM until export()d, so any mutation that has to survive a restart
  // must call this.
  save() { saveDatabase(); }

  // Run sql + immediately flush. Convenience for the dozens of routes that
  // INSERT/UPDATE one row and then call saveDatabase() right after.
  runAndSave(sql, params = []) {
    const id = this.run(sql, params);
    saveDatabase();
    return id;
  }
}

let _repo = null;
export function getRepo() {
  if (!_repo) _repo = new DatabaseRepo(getDatabase());
  return _repo;
}

export function openSqliteBuffer(buffer) {
  if (!SqlJs) throw new Error('Database is not initialized');
  return new SqlJs.Database(buffer);
}

export function log(level, message) {
  console.log(`[${level.toUpperCase()}] ${message}`);
  fileLog(level, message);
  if (!db) return;
  db.run('INSERT INTO logs (level, message) VALUES (?, ?)', [level, message]);
  // log() is the single highest-frequency write path (every route
  // call logs at least one line). Debounce the save so a request
  // that fires five sub-requests (each logging once) collapses to
  // one disk write instead of five. The 50 ms window is small
  // enough that nothing in the UI notices the lag.
  saveDatabaseDebounced();
}

export function getLogs(limit = 100) {
  if (!db) return [];
  return getRepo().queryAll('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?', [limit]);
}

export function clearLogs() {
  if (!db) return;
  db.run('DELETE FROM logs');
  saveDatabase();
}
