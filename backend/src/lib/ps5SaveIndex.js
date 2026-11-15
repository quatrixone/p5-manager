// Telling the PS5 that a PS4 save is there.
//
// Putting the files under /user/home/<user>/savedata/<title>/ is not enough:
// the console keeps what PS4 saves it has in a SQLite file of its own,
// /system_data/savedata/<user>/db/user/savedata.db, and what is not a row in
// there does not exist as far as the console is concerned - not in Saved Data
// (PS4), and not to a game offering to import a PS4 save.
//
// The database is read, changed and written back over FTP, which is safe
// enough in the moment right after we created the save: the console only
// touches the file when a save is made or deleted. It is also the one place
// where this can be done from outside; MacheteSVG (GPL-3.0), which is where
// this was found, does the same from a homebrew app on the console.
import { Writable, Readable } from 'node:stream';
import { openSqliteBuffer } from '../db/sqlite.js';

const dbPath = (user) => `/system_data/savedata/${String(user).toLowerCase().padStart(8, '0')}/db/user/savedata.db`;
const BLOCK = 32 * 1024; // a save block, as the console counts them

// param.sfo: a header, a table of entries, then the keys and the values.
// Only the handful of fields the console's list shows are of interest.
export function parseSfo(buf) {
  const out = {};
  if (!buf || buf.length < 20 || buf.readUInt32LE(0) !== 0x46535000) return out;
  const keys = buf.readUInt32LE(8);
  const data = buf.readUInt32LE(12);
  const count = buf.readUInt32LE(16);
  for (let i = 0; i < count; i++) {
    const e = 20 + i * 16;
    if (e + 16 > buf.length) break;
    const keyAt = keys + buf.readUInt16LE(e);
    const format = buf.readUInt16LE(e + 2);
    const length = buf.readUInt32LE(e + 4);
    const at = data + buf.readUInt32LE(e + 12);
    if (keyAt >= buf.length || at + length > buf.length) continue;
    const end = buf.indexOf(0, keyAt);
    const key = buf.toString('utf8', keyAt, end < 0 ? buf.length : end);
    if (format === 0x0404) out[key] = buf.readUInt32LE(at);
    else out[key] = buf.toString('utf8', at, at + length).replace(/\0.*$/, '');
  }
  return out;
}

// The console writes its times like 2026-10-23T22:15:37.00Z.
const consoleTime = (d = new Date()) => `${d.toISOString().slice(0, 19)}.00Z`;

async function download(ftp, remote) {
  const chunks = [];
  await ftp.downloadTo(new Writable({ write(c, _e, next) { chunks.push(Buffer.from(c)); next(); } }), remote);
  return Buffer.concat(chunks);
}

// What one PS4 save looks like as a row. `sfo` is the save's own param.sfo,
// which is where the console's list takes the names it shows from.
export function saveRow({ title, dir, sizeBytes = 0, usedBytes = 0, sfo = {}, accountId = 0, userId = 0 }) {
  const blocks = Number(sfo.SAVEDATA_BLOCKS) || Math.max(1, Math.ceil(sizeBytes / BLOCK));
  const used = Math.min(blocks, Math.ceil(usedBytes / BLOCK));
  return {
    title_id: title,
    dir_name: dir,
    main_title: sfo.MAINTITLE || 'Saved Data',
    sub_title: sfo.SUBTITLE || '',
    detail: sfo.DETAIL || '',
    tmp_dir_name: '',
    is_broken: 0,
    user_param: Number(sfo.SAVEDATA_LIST_PARAM) || 0,
    blocks,
    free_blocks: Math.max(0, blocks - used),
    size_kib: Math.round((blocks * BLOCK) / 1024),
    mtime: consoleTime(),
    fake_broken: 0,
    account_id: accountId,
    user_id: userId,
    faked_owner: 0,
    cloud_icon_url: '',
    cloud_revision: 0,
    game_title_id: title,
    account_id_in_usb_path: '0000000000000000',
  };
}

// Adds (or refreshes) the row for one save. `ftp` is an open client for the
// PS5. Returns what it wrote, or null when the console has no such database.
export async function registerPs4Save(ftp, user, save) {
  const remote = dbPath(user);
  let buffer;
  try {
    buffer = await download(ftp, remote);
  } catch (e) {
    if (e.code === 550) return null; // no index for this user
    throw e;
  }
  const db = openSqliteBuffer(buffer);
  try {
    // The console's own rows carry the account this user signs in with;
    // copying it from one of them beats guessing it.
    const existing = db.exec('SELECT user_id, account_id FROM savedata WHERE user_id IS NOT NULL LIMIT 1')[0]?.values?.[0];
    const row = saveRow({
      ...save,
      userId: save.userId || existing?.[0] || parseInt(String(user), 16),
      accountId: save.accountId ?? existing?.[1] ?? 0,
    });
    db.run('DELETE FROM savedata WHERE title_id = ? AND dir_name = ?', [row.title_id, row.dir_name]);
    const columns = Object.keys(row);
    db.run(
      `INSERT INTO savedata (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((c) => row[c]),
    );
    await ftp.uploadFrom(Readable.from([Buffer.from(db.export())]), remote);
    return row;
  } finally {
    db.close();
  }
}
