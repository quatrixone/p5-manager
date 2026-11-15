// Writing the row into a real SQLite index, with sql.js as the backend uses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.P5M_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-index-'));
const { initDatabase, openSqliteBuffer } = await import('../db/sqlite.js');
const { writeRow, saveRow } = await import('./ps5SaveIndex.js');
await initDatabase();

// The console's index, as it looks with one save the console wrote itself.
// The account id is past 2^53: a JavaScript number cannot hold it exactly.
const ACCOUNT = '2547189771886188225';
function consoleIndex() {
  const db = openSqliteBuffer();
  db.run(`CREATE TABLE savedata (id INTEGER PRIMARY KEY AUTOINCREMENT, title_id TEXT, dir_name TEXT,
    main_title TEXT, sub_title TEXT, detail TEXT, tmp_dir_name TEXT, is_broken INTEGER, user_param INTEGER,
    blocks INTEGER, free_blocks INTEGER, size_kib INTEGER, mtime TEXT, fake_broken INTEGER,
    account_id INTEGER, user_id INTEGER, faked_owner INTEGER, cloud_icon_url TEXT, cloud_revision INTEGER,
    game_title_id TEXT, account_id_in_usb_path TEXT)`);
  db.run(`INSERT INTO savedata (title_id, dir_name, main_title, account_id, user_id, game_title_id)
    VALUES ('CUSA11302', 'SAVEDATA00', 'Celeste Save Data', ${ACCOUNT}, 396299458, 'CUSA11302')`);
  return db;
}

const read = (db, sql) => db.exec(sql)[0]?.values?.[0];

test('the account id keeps every digit - it never passes through a JS number', () => {
  const db = consoleIndex();
  writeRow(db, saveRow({ title: 'CUSA36843', dir: 'RDR2SAVE0.SAV', sizeBytes: 46137344, userId: 396299458 }));
  const [kind, text] = read(db, "SELECT typeof(account_id), CAST(account_id AS TEXT) FROM savedata WHERE title_id = 'CUSA36843'");
  assert.equal(kind, 'integer');
  assert.equal(text, ACCOUNT);
  // The console's own row is left exactly as it was.
  assert.deepEqual(
    read(db, "SELECT typeof(account_id), CAST(account_id AS TEXT) FROM savedata WHERE title_id = 'CUSA11302'"),
    ['integer', ACCOUNT],
  );
  db.close();
});

test('writing the same save twice leaves one row', () => {
  const db = consoleIndex();
  const save = { title: 'CUSA36843', dir: 'RDR2SAVE0.SAV', sizeBytes: 46137344, userId: 396299458 };
  writeRow(db, saveRow(save));
  writeRow(db, saveRow({ ...save, sfo: { MAINTITLE: 'Red Dead Redemption' } }));
  assert.equal(read(db, "SELECT COUNT(*) FROM savedata WHERE title_id = 'CUSA36843'")[0], 1);
  assert.equal(read(db, "SELECT main_title FROM savedata WHERE title_id = 'CUSA36843'")[0], 'Red Dead Redemption');
  assert.equal(read(db, 'SELECT COUNT(*) FROM savedata')[0], 2);
  db.close();
});

test('an index with nothing to copy the account from still gets the row', () => {
  const db = consoleIndex();
  db.run('DELETE FROM savedata');
  writeRow(db, saveRow({ title: 'CUSA36843', dir: 'RDR2SAVE0.SAV', sizeBytes: 1024, userId: 396299458 }));
  assert.equal(read(db, "SELECT account_id FROM savedata WHERE title_id = 'CUSA36843'")[0], 0);
  db.close();
});
