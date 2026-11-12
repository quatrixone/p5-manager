import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePs4SaveLog, listPs4Saves, validPs4User } from './ps4SaveExport.js';

test('reads what the PS4 save payload printed', () => {
  const ok = parsePs4SaveLog('Source: /user/home/1234abcd/savedata/CUSA00900/sdimg_SAVEDATA00\nCopying source save; original is unchanged\nMount point: /mnt/pfs/p5manager_ps4_export\n');
  assert.equal(ok.mountPoint, '/mnt/pfs/p5manager_ps4_export');
  assert.equal(ok.error, null);
  assert.equal(parsePs4SaveLog('Unmounted\n').unmounted, true);
  assert.equal(parsePs4SaveLog('Error: sealed key could not be read\n').error, 'sealed key could not be read');
  // Nothing written yet is not an answer.
  assert.deepEqual(
    { ...parsePs4SaveLog(''), log: [] },
    { mountPoint: null, source: null, unmounted: false, error: null, log: [] },
  );
});

test('a user id is hex, at most eight digits', () => {
  assert.ok(validPs4User('1234abcd'));
  assert.ok(!validPs4User('../etc'));
  assert.ok(!validPs4User('123456789'));
  assert.ok(!validPs4User(''));
});

test('lists the saves on a PS4 drive and skips what is not one', async () => {
  const tree = {
    '/user/home': [
      { name: '1234abcd', isDirectory: true },
      { name: 'notauser!', isDirectory: true },
      { name: 'readme.txt', isDirectory: false },
    ],
    '/user/home/1234abcd/savedata': [
      { name: 'CUSA00900', isDirectory: true },
      { name: 'sce_sys', isDirectory: true }, // not a title id
    ],
    '/user/home/1234abcd/savedata/CUSA00900': [
      { name: 'sdimg_SAVEDATA00', isDirectory: false, size: 1048576, modifiedAt: new Date('2026-01-02T03:04:05Z') },
      { name: 'SAVEDATA00.bin', isDirectory: false, size: 96 }, // the sealed key, not a save
    ],
  };
  const ftp = {
    list: async (dir) => {
      if (!(dir in tree)) throw Object.assign(new Error('550 no such dir'), { code: 550 });
      return tree[dir];
    },
  };
  assert.deepEqual(await listPs4Saves(ftp), [{
    user: '1234abcd', title: 'CUSA00900', dir: 'SAVEDATA00',
    size: 1048576, modified: '2026-01-02T03:04:05.000Z',
  }]);
});

test('a console with no /user/home answers with no saves', async () => {
  const ftp = { list: async () => { throw Object.assign(new Error('550'), { code: 550 }); } };
  assert.deepEqual(await listPs4Saves(ftp), []);
});
