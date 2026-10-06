import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsPath, crumbsOf } from './localPath.js';

test('absolute paths on Linux and Windows', () => {
  assert.equal(isAbsPath('/mnt/games'), true);
  assert.equal(isAbsPath('C:/Games'), true);
  assert.equal(isAbsPath('d:\\iso'), true);
  assert.equal(isAbsPath('//nas/share'), true);
  assert.equal(isAbsPath('GAME1234.iso'), false);
  assert.equal(isAbsPath(''), false);
});

test('POSIX breadcrumbs are unchanged', () => {
  assert.deepEqual(crumbsOf('/mnt/usb/games'), [
    { label: 'mnt', path: '/mnt' },
    { label: 'usb', path: '/mnt/usb' },
    { label: 'games', path: '/mnt/usb/games' },
  ]);
  assert.deepEqual(crumbsOf('/'), []);
  assert.deepEqual(crumbsOf(''), []);
});

test('Windows breadcrumbs start at the drive root, without a leading slash', () => {
  assert.deepEqual(crumbsOf('C:/Users/me'), [
    { label: 'C:', path: 'C:/' },
    { label: 'Users', path: 'C:/Users' },
    { label: 'me', path: 'C:/Users/me' },
  ]);
  assert.deepEqual(crumbsOf('D:/'), [{ label: 'D:', path: 'D:/' }]);
});
