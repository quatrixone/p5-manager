import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDir, joinPath, isSameOrInside, destDirFor } from './transferPaths.js';

test('cleanDir keeps root and strips trailing slashes', () => {
  assert.equal(cleanDir('/'), '/');
  assert.equal(cleanDir(''), '/');
  assert.equal(cleanDir('/data//homebrew/'), '/data/homebrew');
});

test('joinPath handles a root base', () => {
  assert.equal(joinPath('/', 'a'), '/a');
  assert.equal(joinPath('/data/', 'a.pkg'), '/data/a.pkg');
});

test('isSameOrInside catches a folder dropped into itself or a child', () => {
  assert.equal(isSameOrInside('/a/b', '/a/b'), true);
  assert.equal(isSameOrInside('/a/b', '/a/b/c/d'), true);
  assert.equal(isSameOrInside('/', '/anything'), true);
});

test('isSameOrInside is not fooled by a shared name prefix', () => {
  assert.equal(isSameOrInside('/a/b', '/a/bc'), false);
  assert.equal(isSameOrInside('/a/b', '/a'), false);
});

test('destDirFor keeps the folder structure under the dropped folder', () => {
  assert.equal(destDirFor('/data/homebrew', 'game', 'eboot.bin'), '/data/homebrew/game');
  assert.equal(destDirFor('/data/homebrew', 'game', 'sce_sys/param.json'), '/data/homebrew/game/sce_sys');
  assert.equal(destDirFor('/', 'game', 'a/b/c.bin'), '/game/a/b');
});
