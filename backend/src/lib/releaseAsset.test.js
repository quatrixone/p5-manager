import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickReleaseAsset, stripVersion, renamedDisplayName } from './releaseAsset.js';

const assets = (...names) => names.map(name => ({ name }));
const ZFTPD_160 = assets(
  'SHA256SUMS.txt', 'zftpd-linux-ftp.tar.gz',
  'zftpd-ps4-v1.6.0.bin', 'zftpd-ps4-v1.6.0.elf', 'zftpd-ps4-zhttp-v1.6.0.elf',
  'zftpd-ps5-v1.6.0.bin', 'zftpd-ps5-v1.6.0.elf', 'zftpd-ps5-zhttp-v1.6.0.elf',
);

test('stripVersion removes the version but keeps platform and variant', () => {
  assert.equal(stripVersion('zftpd-ps5-v1.5.0.elf'), 'zftpd-ps5.elf');
  assert.equal(stripVersion('zftpd-ps5-zhttp-v1.6.0.elf'), 'zftpd-ps5-zhttp.elf');
  assert.equal(stripVersion('shadowmountplus-1.7beta3.elf'), 'shadowmountplus.elf');
  assert.equal(stripVersion('kstuff.elf'), 'kstuff.elf');
});

test('a PS5 payload is replaced by the PS5 build, not the first .elf', () => {
  assert.equal(pickReleaseAsset(ZFTPD_160, 'zftpd-ps5-v1.5.0.elf').name, 'zftpd-ps5-v1.6.0.elf');
});

test('the variant is kept across versions', () => {
  assert.equal(pickReleaseAsset(ZFTPD_160, 'zftpd-ps5-zhttp-v1.5.0.elf').name, 'zftpd-ps5-zhttp-v1.6.0.elf');
  assert.equal(pickReleaseAsset(ZFTPD_160, 'zftpd-ps4-v1.4.0.elf').name, 'zftpd-ps4-v1.6.0.elf');
});

test('an unversioned asset name still matches exactly', () => {
  assert.equal(pickReleaseAsset(assets('kstuff.elf', 'kstuff-ps4.elf'), 'kstuff.elf').name, 'kstuff.elf');
});

test('a single compatible asset with the same extension is accepted', () => {
  assert.equal(pickReleaseAsset(assets('notes.txt', 'payload-new.elf'), 'payload.elf').name, 'payload-new.elf');
});

test('never crosses platforms', () => {
  assert.equal(pickReleaseAsset(assets('tool-ps4.elf'), 'tool-ps5.elf'), null);
});

test('refuses to guess between several candidates', () => {
  assert.equal(pickReleaseAsset(assets('a.elf', 'b.elf'), 'renamed-by-user.elf'), null);
});

test('a lone zip is accepted when no file with the extension exists', () => {
  assert.equal(pickReleaseAsset(assets('release-ps5.zip', 'readme.md'), 'tool-ps5.elf').name, 'release-ps5.zip');
});

test('display name follows the file only when it mirrored the file name', () => {
  assert.equal(renamedDisplayName('zftpd-ps5-v1.5.0.elf', 'zftpd-ps5-v1.5.0.elf', 'zftpd-ps5-v1.6.0.elf'), 'zftpd-ps5-v1.6.0.elf');
  assert.equal(renamedDisplayName('zftpd-ps5-v1.5.0', 'zftpd-ps5-v1.5.0.elf', 'zftpd-ps5-v1.6.0.elf'), 'zftpd-ps5-v1.6.0');
  assert.equal(renamedDisplayName('My FTP server', 'zftpd-ps5-v1.5.0.elf', 'zftpd-ps5-v1.6.0.elf'), 'My FTP server');
});
