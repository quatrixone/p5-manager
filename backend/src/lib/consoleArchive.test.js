import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consoleArchiveLocation, downloadConsoleArchive, uploadConsoleArchive } from './consoleArchive.js';

const check = () => {};
const location = name => consoleArchiveLocation('192.168.1.5', '/data/' + name);

test('console archives stay beside the original, with validated paths', () => {
  for (const name of ['game.zip', 'game.RAR', 'game.7z', 'game.part01.rar']) {
    assert.equal(location(name).dest, '/data/game');
  }
  for (const name of ['../game.zip', 'game.zip\nDELE /data', '..zip', 'game.exe']) {
    assert.throws(() => location(name));
  }
  assert.throws(() => consoleArchiveLocation('bad host', '/data/game.zip'));
});

test('downloads only the selected archive and its RAR volumes', async () => {
  for (const [name, names, expected] of [
    ['game.zip', ['game.zip', 'other.zip'], ['game.zip']],
    ['game.part01.rar', ['game.part01.rar', 'game.part02.rar', 'other.part01.rar'], ['game.part01.rar', 'game.part02.rar']],
    ['game.rar', ['game.rar', 'game.r00', 'other.rar'], ['game.rar', 'game.r00']],
  ]) {
    const downloaded = [];
    const client = {
      list: async () => names.map(name => ({ name })),
      downloadTo: async (local, remote) => downloaded.push(path.posix.basename(remote)),
    };
    assert.equal(await downloadConsoleArchive(client, location(name), '/tmp/stage', check), '/tmp/stage/' + name);
    assert.deepEqual(downloaded, expected);
  }
});

test('uploads extracted contents, rejects overwrites and links, and honours cancellation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-archive-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello');
  let uploaded = 0;
  const client = {
    list: async () => [],
    uploadFromDir: async (local, remote) => {
      assert.equal(local, dir);
      assert.equal(remote, '/data/game');
      uploaded++;
    },
  };
  await uploadConsoleArchive(client, location('game.zip'), dir, check);
  assert.equal(uploaded, 1);
  client.list = async () => [{ name: 'GAME' }];
  await assert.rejects(uploadConsoleArchive(client, location('game.zip'), dir, check), /already exists/);
  client.list = async () => [];
  await assert.rejects(uploadConsoleArchive(client, location('game.zip'), dir, () => { throw new Error('cancelled'); }), /cancelled/);
  await assert.rejects(downloadConsoleArchive(client, location('game.zip'), dir, () => { throw new Error('cancelled'); }), /cancelled/);
  fs.symlinkSync('/etc/passwd', path.join(dir, 'link'));
  await assert.rejects(uploadConsoleArchive(client, location('game.zip'), dir, check), /symbolic link/);
  assert.equal(uploaded, 1);
});
