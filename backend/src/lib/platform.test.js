import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { toClientPath, mapPosixDefault, isFsRoot, isLocalPathAllowed, isInsideRoots } from './platform.js';

const W = path.win32;

test('client paths use forward slashes on Windows, untouched elsewhere', () => {
  assert.equal(toClientPath('C:\\Users\\me\\Games', true), 'C:/Users/me/Games');
  assert.equal(toClientPath('/mnt/usb\\odd', false), '/mnt/usb\\odd');
});

test('POSIX defaults are left alone on Linux', () => {
  assert.equal(mapPosixDefault('/mnt', { win: false }), '/mnt');
  assert.equal(mapPosixDefault('/data/downloads', { win: false }), '/data/downloads');
});

test('on Windows /data maps into the app data folder, other defaults to home', () => {
  const o = { win: true, userDataDir: 'D:\\P5\\data', home: 'C:\\Users\\me' };
  assert.equal(mapPosixDefault('/data/downloads', o), 'D:\\P5\\data/downloads');
  assert.equal(mapPosixDefault('/data', o), 'D:\\P5\\data');
  assert.equal(mapPosixDefault('/mnt', o), 'C:\\Users\\me');
  assert.equal(mapPosixDefault('', o), 'C:\\Users\\me');
  assert.equal(mapPosixDefault('/database', o), 'C:\\Users\\me');
});

test('real Windows paths and network shares pass through', () => {
  const o = { win: true, userDataDir: 'D:\\P5\\data', home: 'C:\\Users\\me' };
  assert.equal(mapPosixDefault('C:/Games/x', o), 'C:/Games/x');
  assert.equal(mapPosixDefault('e:\\iso', o), 'e:\\iso');
  assert.equal(mapPosixDefault('\\\\nas\\share\\games', o), '\\\\nas\\share\\games');
  assert.equal(mapPosixDefault('//nas/share', o), '//nas/share');
});

test('filesystem roots', () => {
  assert.equal(isFsRoot('C:\\', W), true);
  assert.equal(isFsRoot('C:\\Users', W), false);
  assert.equal(isFsRoot('/', path.posix), true);
  assert.equal(isFsRoot('/mnt', path.posix), false);
});

test('blocked folders: system trees on Linux, the Windows directory on Windows', () => {
  assert.equal(isLocalPathAllowed('/etc/passwd', { win: false, pathMod: path.posix }), false);
  assert.equal(isLocalPathAllowed('/etcetera', { win: false, pathMod: path.posix }), true);
  assert.equal(isLocalPathAllowed('/mnt/games', { win: false, pathMod: path.posix }), true);
  const w = { win: true, pathMod: W, systemRoot: 'C:\\Windows' };
  assert.equal(isLocalPathAllowed('C:\\Windows\\System32', w), false);
  assert.equal(isLocalPathAllowed('c:\\windows', w), false);
  assert.equal(isLocalPathAllowed('C:\\WindowsApps', w), true);
  assert.equal(isLocalPathAllowed('D:\\Games', w), true);
});

test('job roots: a list on Linux, any usable drive on Windows', () => {
  const roots = ['/data', '/mnt', '/data/downloads'];
  const l = { win: false, pathMod: path.posix };
  assert.equal(isInsideRoots('/mnt/usb/PS5', roots, l), true);
  assert.equal(isInsideRoots('/data', roots, l), true);
  assert.equal(isInsideRoots('/mntx/games', roots, l), false);
  assert.equal(isInsideRoots('/home/me/games', roots, l), false);
  assert.equal(isInsideRoots('/mnt/../etc', roots, l), false);
  const w = { win: true, pathMod: W, systemRoot: 'C:\\Windows' };
  assert.equal(isInsideRoots('F:\\PS5', roots, w), true);
  assert.equal(isInsideRoots('F:/PS5/games', roots, w), true);
  assert.equal(isInsideRoots('C:\\Windows\\Temp', roots, w), false);
});
