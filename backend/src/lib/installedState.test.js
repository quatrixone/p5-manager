import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLibrarySnapshots, titleIdsOf, decorateInstalled } from './installedState.js';

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
