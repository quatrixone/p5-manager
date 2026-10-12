import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { placeVendoredPayload, sameContent } from './defaultPayloads.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vendored-'));
}

test('a writable destination is overwritten', () => {
  const dir = tmpdir();
  const source = path.join(dir, 'src.bin');
  const dest = path.join(dir, 'dest.bin');
  fs.writeFileSync(source, 'new');
  fs.writeFileSync(dest, 'old');
  assert.equal(placeVendoredPayload(source, dest), 'copied');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'new');
});

test('a read-only destination with the same bytes is kept', () => {
  const dir = tmpdir();
  const source = path.join(dir, 'src.bin');
  const dest = path.join(dir, 'dest.bin');
  fs.writeFileSync(source, 'same');
  fs.writeFileSync(dest, 'same', { mode: 0o444 });
  assert.equal(placeVendoredPayload(source, dest), 'kept');
});

test('a read-only destination with other bytes says what to do', () => {
  const dir = tmpdir();
  const source = path.join(dir, 'src.bin');
  const dest = path.join(dir, 'dest.bin');
  fs.writeFileSync(source, 'new');
  fs.writeFileSync(dest, 'old', { mode: 0o444 });
  assert.throws(() => placeVendoredPayload(source, dest), /owned by another user/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'old');
});

test('a missing destination directory is still an error', () => {
  const dir = tmpdir();
  const source = path.join(dir, 'src.bin');
  fs.writeFileSync(source, 'new');
  assert.throws(() => placeVendoredPayload(source, path.join(dir, 'gone', 'dest.bin')), { code: 'ENOENT' });
});

test('sameContent compares sizes and bytes, and survives a missing file', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  fs.writeFileSync(a, 'abc');
  fs.writeFileSync(b, 'abd');
  assert.equal(sameContent(a, b), false);
  fs.writeFileSync(b, 'abc');
  assert.equal(sameContent(a, b), true);
  assert.equal(sameContent(a, path.join(dir, 'missing')), false);
});
