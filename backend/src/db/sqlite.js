import initSqlJs from 'sql.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// docker: /app/src/db/sqlite.js -> /app
// dev: /path/to/backend/src/db/sqlite.js -> /path/to
const isInDocker = __dirname.startsWith('/app');
const projectRoot = isInDocker ? '/app' : path.resolve(__dirname, '../..');
const dbPath = path.join(projectRoot, 'data', 'p5manager.db');
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

  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
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
    // Column already exists
  }

  // Add is_default column if it doesn't exist
  try {
    db.run(`ALTER TABLE profiles ADD COLUMN is_default INTEGER DEFAULT 0`);
  } catch (e) {
    // Column already exists
  }

  // Add credential column if it doesn't exist
  try {
    db.run(`ALTER TABLE profiles ADD COLUMN credential TEXT`);
  } catch (e) {
    // Column already exists
  }

  // Add port column if it doesn't exist
  try {
    db.run(`ALTER TABLE profiles ADD COLUMN port INTEGER DEFAULT 9021`);
  } catch (e) {
    // Column already exists
  }

  // Remote Play (pyremoteplay) identity. psn_account_id is the OAuth-derived ID,
  // rp_user_profile holds the pyremoteplay profile dict with registration
  // credentials (kept as JSON text).
  try { db.run(`ALTER TABLE profiles ADD COLUMN psn_account_id TEXT`); } catch (e) {}
  try { db.run(`ALTER TABLE profiles ADD COLUMN psn_online_id TEXT`); } catch (e) {}
  try { db.run(`ALTER TABLE profiles ADD COLUMN rp_user_profile TEXT`); } catch (e) {}
  // Platform: 'ps4' | 'ps5' | NULL (auto-detect via pyremoteplay /discover).
  // Drives which payloads, autoload templates, FTP defaults and Convert
  // sub-tabs the UI shows for this profile. Filled in either at profile
  // creation (user picks in Settings) or by the periodic status poll
  // calling /api/ps5/status which already extracts host_type from the
  // sidecar discover response.
  try { db.run(`ALTER TABLE profiles ADD COLUMN console_type TEXT`); } catch (e) {}

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
    // Column already exists
  }

  // Platform tag for payloads: 'ps4' | 'ps5' | NULL (= any/unknown).
  // Lets the Payloads tab + Autoload "send payload" picker filter by
  // the active platform mode so PS4 mode never accidentally pushes a
  // PS5 LUA payload to a PS4 (different ports, different ABI).
  try {
    db.run(`ALTER TABLE payloads ADD COLUMN console_type TEXT`);
  } catch (e) {
    // Column already exists
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
    // Column already exists
  }

  try {
    db.run(`ALTER TABLE autoload_sequences ADD COLUMN schedule_enabled INTEGER DEFAULT 0`);
  } catch (e) {
    // Column already exists
  }

  try {
    db.run(`ALTER TABLE autoload_sequences ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
  } catch (e) {
    // Column already exists
  }

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
  try { db.run(`ALTER TABLE convert_sources ADD COLUMN ftp_host TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE convert_sources ADD COLUMN ftp_port INTEGER`); } catch (_) {}
  try { db.run(`ALTER TABLE convert_sources ADD COLUMN ftp_username TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE convert_sources ADD COLUMN ftp_password TEXT`); } catch (_) {}

  saveDatabase();
  return db;
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

export function log(level, message) {
  console.log(`[${level.toUpperCase()}] ${message}`);
  if (!db) return;
  db.run('INSERT INTO logs (level, message) VALUES (?, ?)', [level, message]);
  saveDatabase();
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