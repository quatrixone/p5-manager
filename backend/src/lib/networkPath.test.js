import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNetworkPath, toUncPath } from './networkPath.js';

test('an address copied from Explorer', () => {
  assert.deepEqual(parseNetworkPath('\\\\nas\\games\\ps5\\dumps'), { host: 'nas', share: 'games', subPath: 'ps5/dumps' });
  assert.deepEqual(parseNetworkPath(' "\\\\192.168.1.10\\share" '), { host: '192.168.1.10', share: 'share', subPath: '' });
});

test('smb:// and forward slashes', () => {
  assert.deepEqual(parseNetworkPath('smb://nas/games/ps5/'), { host: 'nas', share: 'games', subPath: 'ps5' });
  assert.deepEqual(parseNetworkPath('//nas/my share/a b'), { host: 'nas', share: 'my share', subPath: 'a b' });
});

test('what is not a network folder', () => {
  assert.equal(parseNetworkPath('C:\\games'), null);
  assert.equal(parseNetworkPath('\\\\nas'), null);
  assert.equal(parseNetworkPath('nas/games'), null);
  assert.equal(parseNetworkPath(''), null);
});

test('back to the form Windows opens', () => {
  assert.equal(toUncPath({ host: 'nas', share: 'games', subPath: 'ps5/dumps' }), '\\\\nas\\games\\ps5\\dumps');
  assert.equal(toUncPath({ host: 'nas', share: 'games' }), '\\\\nas\\games');
});
