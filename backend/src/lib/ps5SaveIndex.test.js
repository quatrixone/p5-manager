import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSfo, saveRow } from './ps5SaveIndex.js';

// The smallest param.sfo the console would write: a header, one entry per
// field, the keys, then the values.
function buildSfo(fields) {
  const keys = Object.keys(fields);
  const keyTable = Buffer.concat(keys.map((k) => Buffer.from(`${k}\0`, 'utf8')));
  const values = [];
  const entries = Buffer.alloc(keys.length * 16);
  let keyAt = 0;
  let dataAt = 0;
  keys.forEach((k, i) => {
    const v = fields[k];
    const isInt = typeof v === 'number';
    const buf = isInt ? Buffer.alloc(4) : Buffer.from(`${v}\0`, 'utf8');
    if (isInt) buf.writeUInt32LE(v, 0);
    entries.writeUInt16LE(keyAt, i * 16);
    entries.writeUInt16LE(isInt ? 0x0404 : 0x0204, i * 16 + 2);
    entries.writeUInt32LE(buf.length, i * 16 + 4);
    entries.writeUInt32LE(buf.length, i * 16 + 8);
    entries.writeUInt32LE(dataAt, i * 16 + 12);
    keyAt += k.length + 1;
    dataAt += buf.length;
    values.push(buf);
  });
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46535000, 0);
  header.writeUInt32LE(0x0101, 4);
  header.writeUInt32LE(20 + entries.length, 8);
  header.writeUInt32LE(20 + entries.length + keyTable.length, 12);
  header.writeUInt32LE(keys.length, 16);
  return Buffer.concat([header, entries, keyTable, ...values]);
}

test('reads the fields the console lists a save by', () => {
  const sfo = parseSfo(buildSfo({
    MAINTITLE: 'Red Dead Redemption',
    SUBTITLE: 'Chapter 2',
    DETAIL: '58%',
    SAVEDATA_BLOCKS: 300,
    TITLE_ID: 'CUSA36843',
  }));
  assert.equal(sfo.MAINTITLE, 'Red Dead Redemption');
  assert.equal(sfo.SUBTITLE, 'Chapter 2');
  assert.equal(sfo.SAVEDATA_BLOCKS, 300);
  assert.equal(sfo.TITLE_ID, 'CUSA36843');
});

test('anything that is not a param.sfo reads as no fields', () => {
  assert.deepEqual(parseSfo(Buffer.from('not an sfo at all')), {});
  assert.deepEqual(parseSfo(Buffer.alloc(0)), {});
  assert.deepEqual(parseSfo(null), {});
});

test('a row the console would accept, named after the save', () => {
  const row = saveRow({
    title: 'CUSA36843',
    dir: 'RDR2SAVE0.SAV',
    sizeBytes: 46137344,
    usedBytes: 226142,
    sfo: { MAINTITLE: 'Red Dead Redemption', SUBTITLE: 'Chapter 2', SAVEDATA_BLOCKS: 300 },
    accountId: 2547189771886188225n,
    userId: 396299458,
  });
  assert.equal(row.title_id, 'CUSA36843');
  assert.equal(row.dir_name, 'RDR2SAVE0.SAV');       // never the sdimg_ name
  assert.equal(row.main_title, 'Red Dead Redemption');
  assert.equal(row.blocks, 300);                      // what the save itself says
  assert.equal(row.size_kib, 9600);
  assert.equal(row.free_blocks, 293);
  assert.equal(row.is_broken, 0);
  assert.equal(row.user_id, 396299458);
  assert.match(row.mtime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.00Z$/);
});

test('without a param.sfo the size of the image decides the blocks', () => {
  const row = saveRow({ title: 'CUSA11993', dir: 'i20-prefs', sizeBytes: 32 * 1024 * 10 });
  assert.equal(row.blocks, 10);
  assert.equal(row.main_title, 'Saved Data');
  assert.equal(row.free_blocks, 10);
});
