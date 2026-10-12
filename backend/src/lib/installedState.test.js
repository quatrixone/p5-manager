import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLibrarySnapshots, titleIdsOf, decorateInstalled, installKey, compareVersions, localIndex } from './installedState.js';

const installs = [
  { kind: 'script', store_id: 'home', version: 1 },
  { kind: 'homebrew', store_id: 'cheats', version: 2 },
];

test('title ids are read from both console libraries and from package names', () => {
  assert.deepEqual([...titleIdsOf({ games: [{ title_id: 'CUSA00001' }, { titleId: 'CHTM00777' }] })].sort(), ['CHTM00777', 'CUSA00001']);
  assert.deepEqual([...titleIdsOf(null)], []);
});

test('our own records decide installed and update for the kinds we keep', () => {
  const [script] = decorateInstalled([{ kind: 'script', id: 'home', version: 3 }], { installs });
  assert.equal(script.installed, 1);
  assert.equal(script.update, true);
  assert.equal(script.installedFrom, 'records');
  const [same] = decorateInstalled([{ kind: 'script', id: 'home', version: 1 }], { installs });
  assert.equal(same.update, false);
  const [none] = decorateInstalled([{ kind: 'script', id: 'other', version: 1 }], { installs });
  assert.equal(none.installed, null);
  assert.equal(none.update, false);
});

test('homebrew the console already carries counts as installed even if we never installed it', () => {
  const titles = new Set(['CHTM00777']);
  const [item] = decorateInstalled([{ kind: 'homebrew', id: 'other-app', homebrew_id: 'CHTM00777', version: 1 }], { installs: [], titles, takenAt: '2026-10-12T07:00:00.000Z' });
  assert.equal(item.onConsole, true);
  assert.equal(item.installedFrom, 'console');
  assert.equal(item.libraryTakenAt, '2026-10-12T07:00:00.000Z');
  // Our records still provide the version, so Update stays possible.
  const [known] = decorateInstalled([{ kind: 'homebrew', id: 'cheats', homebrew_id: 'CHTM00777', version: 3 }], { installs, titles });
  assert.equal(known.update, true);
  assert.equal(known.onConsole, true);
});

test('without a console snapshot nothing is claimed about the console', () => {
  const [item] = decorateInstalled([{ kind: 'homebrew', id: 'cheats', homebrew_id: 'CHTM00777', version: 2 }], { installs });
  assert.equal(item.onConsole, null);
  assert.equal(item.libraryTakenAt, null);
});

test('a snapshot is written per profile and read back after a restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-lib-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshots = createLibrarySnapshots({ dir, now: () => 1_000 });
  assert.equal(snapshots.read(7), null);
  snapshots.write(7, { games: [{ title_id: 'CUSA00001' }] });
  const back = createLibrarySnapshots({ dir, now: () => 2_000 }).read(7);
  assert.deepEqual([...back.titles], ['CUSA00001']);
  assert.equal(back.takenAt, new Date(1_000).toISOString());
  assert.equal(snapshots.read(8), null);
});

test('a catalog package is remembered per catalog, not per id alone', () => {
  const item = { kind: 'catalog', id: 'abc', origin: 'fpkgi', version: 1 };
  assert.equal(installKey(item), 'catalog:fpkgi:abc');
  const [mine] = decorateInstalled([item], { installs: [{ kind: 'catalog', store_id: 'fpkgi:abc', version: 1 }] });
  assert.equal(mine.installed, 1);
  const [theirs] = decorateInstalled([{ ...item, origin: 'source:3' }], { installs: [{ kind: 'catalog', store_id: 'fpkgi:abc', version: 1 }] });
  assert.equal(theirs.installed, null);
});

test('versions compare on their numbers, and say so when they cannot', () => {
  assert.equal(compareVersions('1.11', 'v1.09'), 1);
  assert.equal(compareVersions('v1.09', '1.11'), -1);
  assert.equal(compareVersions('1.6beta16', '1.6beta16'), 0);
  assert.equal(compareVersions('2.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('', '1.0'), null);
  assert.equal(compareVersions('nightly', '1.0'), null);
});

test('what is already in Payloads, Autoload and Scripts counts as installed', () => {
  const local = localIndex({
    payloads: [{ filename: 'kstuff.elf', version: 'v1.09' }],
    scripts: [{ name: 'PS5: Return Home' }],
    sequences: [{ name: 'GoldHEN: load' }],
  });
  const [payload] = decorateInstalled([{ kind: 'payload', id: 'kstuff', name: 'kstuff.elf', version: 1 }], { local });
  assert.equal(payload.inLibrary, true);
  assert.equal(payload.installedFrom, 'library');
  assert.equal(payload.update, false);
  const [script] = decorateInstalled([{ kind: 'script', id: 'home', name: 'PS5: Return Home', version: 1 }], { local });
  assert.equal(script.inLibrary, true);
  const [template] = decorateInstalled([{ kind: 'template', id: 'gh', name: 'GoldHEN: load', version: 1 }], { local });
  assert.equal(template.inLibrary, true);
  const [absent] = decorateInstalled([{ kind: 'payload', id: 'other', name: 'other.elf', version: 1 }], { local });
  assert.equal(absent.inLibrary, false);
  assert.equal(absent.installedFrom, null);
});

test('a newer app version in the store is an update for a file already in the library', () => {
  const local = localIndex({ payloads: [{ filename: 'kstuff.elf', version: 'v1.09' }] });
  const [newer] = decorateInstalled([{ kind: 'payload', id: 'kstuff', name: 'kstuff.elf', version: 1, app_version: '1.11' }], { local });
  assert.equal(newer.update, true);
  assert.equal(newer.localVersion, 'v1.09');
  const [same] = decorateInstalled([{ kind: 'payload', id: 'kstuff', name: 'kstuff.elf', version: 1, app_version: '1.09' }], { local });
  assert.equal(same.update, false);
  // Nothing to compare against: already there, and we do not invent an update.
  const [unknown] = decorateInstalled([{ kind: 'payload', id: 'kstuff', name: 'kstuff.elf', version: 1 }], { local });
  assert.equal(unknown.update, false);
});

test('our own record still wins over a file that happens to share the name', () => {
  const local = localIndex({ payloads: [{ filename: 'kstuff.elf', version: 'v1.09' }] });
  const installs = [{ kind: 'payload', store_id: 'kstuff', version: 1 }];
  const [item] = decorateInstalled([{ kind: 'payload', id: 'kstuff', name: 'kstuff.elf', version: 2, app_version: '1.09' }], { installs, local });
  assert.equal(item.installedFrom, 'records');
  assert.equal(item.installed, 1);
  assert.equal(item.update, true);
});
