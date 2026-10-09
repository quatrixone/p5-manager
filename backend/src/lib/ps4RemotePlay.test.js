import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePs4RemotePlay } from './ps4RemotePlay.js';

test('PS4 PIN parsing preserves leading zeroes and separates local user from PSN online ID', () => {
  const result = parsePs4RemotePlay('User: Panda\nAccount ID: Z8JhcG9sbG8=\n\nPin code: 0001 0023\nTimeout: 120 seconds\n');
  assert.equal(result.pin, '0001 0023');
  assert.equal(result.account_id, 'Z8JhcG9sbG8=');
  assert.equal(result.user, 'Panda');
  assert.equal(result.online_id, undefined);
});

test('account-only output and generation failure never become a successful PIN', () => {
  const result = parsePs4RemotePlay('Account ID: Z8JhcG9sbG8=\nError: PIN generation rc=0x80fc0101\nDone\n');
  assert.equal(result.pin, null);
  assert.equal(result.error, 'PIN generation rc=0x80fc0101');
  assert.equal(parsePs4RemotePlay('Pin code: 123 4567\n').pin, null);
});

test('offline activation output is recognised independently of the PIN', () => {
  const result = parsePs4RemotePlay('Slot: 1\nAccount ID: Z8JhcG9sbG8=\nAccount ID hex: 6f6c6c6f7061c267\nActivated: already\nDone\n');
  assert.equal(result.activated, 'already');
  assert.equal(result.slot, 1);
  assert.equal(result.pin, null);
});
