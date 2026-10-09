import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ps4PayloadLock } from './ps4PayloadLock.js';

test('PS4 reservation and captured PIN survive a new backend instance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps4-lock-'));
  try {
    const first = ps4PayloadLock('10.0.0.180', dir);
    assert.equal(first.acquire('get-pin', 1000), null);
    first.save({ pin: '0001 0023', expires_at: 121000 });
    const restarted = ps4PayloadLock('10.0.0.180', dir);
    assert.equal(restarted.acquire('get-pin', 2000).result.pin, '0001 0023');
    assert.equal(ps4PayloadLock('10.0.0.181', dir).acquire('offact', 2000), null);
    first.release();
    assert.equal(restarted.acquire('offact', 3000), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('expired PS4 reservations can be replaced without losing the new operation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps4-lock-'));
  try {
    const lock = ps4PayloadLock('10.0.0.180', dir);
    lock.acquire('get-pin', 1000);
    assert.equal(lock.acquire('offact', 201001), null);
    assert.equal(lock.read().operation, 'offact');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
