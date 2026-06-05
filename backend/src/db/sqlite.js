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
const dbPath = path.join(projectRoot, 'data', 'ps5webmanager.db');
const dbDir = path.dirname(dbPath);
// Legacy path. Existing installs have everything in data/payloads.db; we
// auto-migrate it on first boot under the new name and leave a *.bak copy
// of the original on disk in case the user needs to roll back.
const legacyDbPath = path.join(projectRoot, 'data', 'payloads.db');

let db = null;

export async function initDatabase() {
  if (db) return db;

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // One-shot migration: payloads.db -> ps5webmanager.db
  if (!fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
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

  db.run(`
    CREATE TABLE IF NOT EXISTS micromount_sources (
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
  try { db.run(`ALTER TABLE micromount_sources ADD COLUMN ftp_host TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE micromount_sources ADD COLUMN ftp_port INTEGER`); } catch (_) {}
  try { db.run(`ALTER TABLE micromount_sources ADD COLUMN ftp_username TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE micromount_sources ADD COLUMN ftp_password TEXT`); } catch (_) {}

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

export function log(level, message) {
  console.log(`[${level.toUpperCase()}] ${message}`);
  if (!db) return;
  db.run('INSERT INTO logs (level, message) VALUES (?, ?)', [level, message]);
  saveDatabase();
}

export function getLogs(limit = 100) {
  if (!db) return [];
  const stmt = db.prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?');
  stmt.bind([limit]);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

export function clearLogs() {
  if (!db) return;
  db.run('DELETE FROM logs');
  saveDatabase();
}