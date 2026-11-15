import test from 'node:test';
import assert from 'node:assert/strict';
import { resignSfo, sfoFields, hasConsoleIdentity } from './ps4SaveResign.js';

// A param.sfo as a save carries it: a few names, the account id, and the
// PARAMS field with the console's signature inside.
function buildSfo({ account, hmac, userId, titleId, mainTitle }) {
  const fields = {
    ACCOUNT_ID: account,
    MAINTITLE: Buffer.from(`${mainTitle}\0`, 'utf8'),
    PARAMS: Buffer.alloc(0x400),
    TITLE_ID: Buffer.from(`${titleId}\0`, 'utf8'),
  };
  hmac.copy(fields.PARAMS, 0x08);
  fields.PARAMS.writeUInt32LE(userId, 0x28);
  fields.PARAMS.write(titleId, 0x2c, 'utf8');
  fields.PARAMS.write(titleId, 0x3c, 'utf8');

  const keys = Object.keys(fields);
  const keyTable = Buffer.concat(keys.map((k) => Buffer.from(`${k}\0`, 'utf8')));
  const entries = Buffer.alloc(keys.length * 16);
  let keyAt = 0;
  let dataAt = 0;
  keys.forEach((k, i) => {
    entries.writeUInt16LE(keyAt, i * 16);
    entries.writeUInt16LE(0x0204, i * 16 + 2);
    entries.writeUInt32LE(fields[k].length, i * 16 + 4);
    entries.writeUInt32LE(fields[k].length, i * 16 + 8);
    entries.writeUInt32LE(dataAt, i * 16 + 12);
    keyAt += k.length + 1;
    dataAt += fields[k].length;
  });
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46535000, 0);
  header.writeUInt32LE(0x0101, 4);
  header.writeUInt32LE(20 + entries.length, 8);
  header.writeUInt32LE(20 + entries.length + keyTable.length, 12);
  header.writeUInt32LE(keys.length, 16);
  return Buffer.concat([header, entries, keyTable, ...keys.map((k) => fields[k])]);
}

const ps4 = () => buildSfo({
  account: Buffer.from('\x67\x8fapollo\0'.slice(0, 8), 'binary'),
  hmac: Buffer.alloc(32, 0xaa),
  userId: 1,
  titleId: 'CUSA36843',
  mainTitle: 'Red Dead Redemption',
});
const ps5Donor = () => buildSfo({
  account: Buffer.from([0xc1, 0xd6, 0xc8, 0x18, 0x9a, 0x6f, 0x59, 0x23]),
  hmac: Buffer.alloc(32, 0x5c),
  userId: 396299458,
  titleId: 'CUSA11302',
  mainTitle: 'Celeste Save Data',
});

const paramsOf = (buf) => {
  const f = sfoFields(buf);
  return buf.subarray(f.PARAMS.offset, f.PARAMS.offset + f.PARAMS.length);
};
const accountOf = (buf) => {
  const f = sfoFields(buf);
  return buf.subarray(f.ACCOUNT_ID.offset, f.ACCOUNT_ID.offset + f.ACCOUNT_ID.length);
};
const textOf = (buf, key) => {
  const f = sfoFields(buf)[key];
  return buf.toString('utf8', f.offset, f.offset + f.length).replace(/\0.*$/, '');
};

test('the save takes the console identity of a save that console made', () => {
  const out = resignSfo(ps4(), ps5Donor(), 'CUSA36843');
  const params = paramsOf(out);
  const donor = paramsOf(ps5Donor());
  assert.deepEqual(params.subarray(0x08, 0x28), donor.subarray(0x08, 0x28)); // the console's HMAC
  assert.equal(params.readUInt32LE(0x28), 396299458);                        // its local user
  assert.deepEqual(accountOf(out), accountOf(ps5Donor()));                   // its account
});

test('the title stays the game the save is for, not the donor game', () => {
  const out = resignSfo(ps4(), ps5Donor(), 'CUSA36843');
  const params = paramsOf(out);
  assert.equal(params.toString('utf8', 0x2c, 0x35), 'CUSA36843');
  assert.equal(params.toString('utf8', 0x3c, 0x45), 'CUSA36843');
  assert.equal(params.readUInt8(0x35), 0); // and nothing of the old one is left
});

test('what the console lists the save by is left alone', () => {
  const out = resignSfo(ps4(), ps5Donor(), 'CUSA36843');
  assert.equal(textOf(out, 'MAINTITLE'), 'Red Dead Redemption');
  assert.equal(out.length, ps4().length);
});

test('a param.sfo without an identity to replace is refused, not mangled', () => {
  assert.throws(() => resignSfo(Buffer.from('rubbish'), ps5Donor(), 'CUSA36843'), /PARAMS/);
  assert.equal(hasConsoleIdentity(ps4()), true);
  assert.equal(hasConsoleIdentity(Buffer.from('rubbish')), false);
});
