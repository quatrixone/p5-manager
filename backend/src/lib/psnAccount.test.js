import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePsnAccountId } from './psnAccount.js';

test('the decimal number is kept', () => {
  assert.equal(parsePsnAccountId(' 1234567890123456789 '), '1234567890123456789');
});

test('the base64 form of Remote Play clients gives the same number', () => {
  const b64 = Buffer.from([0x15, 0x81, 0xe9, 0x7d, 0xf4, 0x10, 0x22, 0x11]).toString('base64');
  assert.equal(parsePsnAccountId(b64), '1234567890123456789');
});

test('anything else is refused', () => {
  for (const bad of ['', '0', 'my-psn-name', '12345678901234567890123', 'AAAA', 'AAAAAAAAAAA=']) {
    assert.equal(parsePsnAccountId(bad), null, bad);
  }
});
