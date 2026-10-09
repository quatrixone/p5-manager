import { openSqliteBuffer } from '../db/sqlite.js';

const TITLE_ID = /^[A-Z]{4}\d{5}$/;

// PS4 keeps the home-screen app list in app.db, with a browse table per
// console user. Read every browse table and merge by title ID so the view
// includes installed games without changing the console database.
export function parsePs4Library(buffer) {
  const db = openSqliteBuffer(buffer);
  try {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tbl_appbrowse_%'")[0]?.values || [];
    const games = new Map();
    for (const [table] of tables) {
      if (!/^tbl_appbrowse_\d+$/i.test(table)) continue;
      const escaped = `"${table.replaceAll('"', '""')}"`;
      const rows = db.exec(`SELECT titleId, titleName FROM ${escaped}`)[0]?.values || [];
      for (const [rawId, rawName] of rows) {
        const titleId = String(rawId || '').toUpperCase();
        if (!TITLE_ID.test(titleId)) continue;
        const titleName = String(rawName || '').trim();
        const current = games.get(titleId);
        if (!current || (!current.title_name && titleName)) games.set(titleId, { title_id: titleId, title_name: titleName });
      }
    }

    // Some titles have a row in appinfo but are absent from an account's
    // browse table. Recover their human-readable name from appinfo key/value.
    const appInfoRows = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tbl_appinfo'")[0]?.values || [];
    if (appInfoRows.length) {
      const rows = db.exec('SELECT titleId, val FROM tbl_appinfo WHERE key = \'TITLE\'')[0]?.values || [];
      for (const [rawId, rawName] of rows) {
        const titleId = String(rawId || '').toUpperCase();
        if (TITLE_ID.test(titleId) && !games.has(titleId)) games.set(titleId, { title_id: titleId, title_name: String(rawName || '').trim() });
      }
    }
    return Array.from(games.values()).sort((a, b) => (a.title_name || a.title_id).localeCompare(b.title_name || b.title_id));
  } finally { db.close(); }
}
