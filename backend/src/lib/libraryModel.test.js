import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTitleId, isSafeConsoleDir, storageOf, buildVolumes, buildDestinations } from './libraryModel.js';

const MOUNTS = [
  { mount_point: '/', total_bytes: 7, available_bytes: 1, read_only: true },
  { mount_point: '/user', total_bytes: 937e9, available_bytes: 669e9, read_only: false },
  { mount_point: '/mnt/ext1', total_bytes: 2000e9, available_bytes: 1453e9, read_only: false },
  { mount_point: '/mnt/shadowmnt/pfsc/x', total_bytes: 0, available_bytes: 0, read_only: true },
];

test('title ids', () => {
  assert.equal(isValidTitleId('PPSA02225'), true);
  assert.equal(isValidTitleId('CUSA00001'), true);
  assert.equal(isValidTitleId('ppsa02225'), false);
  assert.equal(isValidTitleId('PPSA0222'), false);
  assert.equal(isValidTitleId('PPSA02225/../x'), false);
});

test('destination paths must be absolute and free of traversal', () => {
  assert.equal(isSafeConsoleDir('/mnt/usb0/homebrew'), true);
  assert.equal(isSafeConsoleDir('mnt/usb0'), false);
  assert.equal(isSafeConsoleDir('/data/../system'), false);
  assert.equal(isSafeConsoleDir('/data/\nx'), false);
  assert.equal(isSafeConsoleDir(''), false);
});

test('storageOf maps console paths to a storage', () => {
  assert.equal(storageOf('/data/homebrew/a.ffpfsc').id, 'internal');
  assert.equal(storageOf('/user/app/x').id, 'internal');
  assert.equal(storageOf('/mnt/ext1/homebrew/a.exfat').id, 'ext1');
  assert.equal(storageOf('/mnt/usb0/homebrew/a.exfat').id, 'usb0');
  assert.equal(storageOf('/mnt/usb3').label, 'USB 3');
  assert.equal(storageOf('/mnt/shadowmnt/pfsc/x/y.exfat').id, 'other');
  assert.equal(storageOf('/database').id, 'other');
});

test('volumes: internal comes from /user, system mounts are dropped', () => {
  const v = buildVolumes(MOUNTS);
  assert.deepEqual(v.map(x => x.id), ['internal', 'ext1']);
  assert.equal(v[0].path, '/data');
  assert.equal(v[0].available_bytes, 669e9);
});

test('destinations: homebrew on every volume, usb0 listed but not connected', () => {
  const d = buildDestinations(buildVolumes(MOUNTS), [{ path: '/mnt/ext1' }, { path: '/mnt/ext1/homebrew' }]);
  assert.deepEqual(d.map(x => x.path), ['/data/homebrew', '/mnt/ext1/homebrew', '/mnt/usb0/homebrew', '/mnt/ext1']);
  assert.equal(d.find(x => x.path === '/mnt/usb0/homebrew').connected, false);
  assert.equal(d.find(x => x.path === '/data/homebrew').available_bytes, 669e9);
});

test('destinations: a plugged-in usb0 is connected and not duplicated', () => {
  const vols = buildVolumes([...MOUNTS, { mount_point: '/mnt/usb0', total_bytes: 500e9, available_bytes: 100e9, read_only: false }]);
  const d = buildDestinations(vols, []);
  const usb = d.filter(x => x.storage === 'usb0');
  assert.equal(usb.length, 1);
  assert.equal(usb[0].connected, true);
});
