import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStoreItem, indexEntry, homebrewFileName, slugify, itemFromSequence, uninstallableFiles, STORE_REPO, STORE_BRANCH } from './storeItem.js';

const base = { id: 'my-item', name: 'My item', description: 'Does a thing', author: 'me', version: 1 };

test('a script and a template pass', () => {
  assert.deepEqual(validateStoreItem({ ...base, kind: 'script', script: 'ps\nwait 300' }), []);
  assert.deepEqual(validateStoreItem({ ...base, kind: 'template', console_type: 'ps5', steps: [{ type: 'rp_session', action: 'start' }] }), []);
});

test('unknown step types and bad ids are refused', () => {
  const errors = validateStoreItem({ ...base, id: 'Bad Id', kind: 'template', steps: [{ type: 'rm_rf' }] });
  assert.ok(errors.some((e) => e.startsWith('id ')));
  assert.ok(errors.some((e) => e.includes('unknown type "rm_rf"')));
});

test('homebrew needs a console, https links and, once listed, checksums', () => {
  const hb = { ...base, kind: 'homebrew', console_type: 'ps4', files: [{ type: 'pkg', url: 'https://example.org/releases/App.pkg' }] };
  assert.deepEqual(validateStoreItem(hb, { submission: true }), []);
  assert.ok(validateStoreItem(hb).some((e) => e.includes('sha256')));
  assert.ok(validateStoreItem({ ...hb, console_type: undefined }, { submission: true }).some((e) => e.includes('console_type')));
  assert.ok(validateStoreItem({ ...hb, files: [{ type: 'pkg', url: 'http://example.org/App.pkg' }] }, { submission: true }).some((e) => e.includes('https')));
  const listed = { ...hb, files: [{ ...hb.files[0], sha256: 'a'.repeat(64), size: 1000 }] };
  assert.deepEqual(validateStoreItem(listed), []);
  assert.deepEqual(indexEntry(listed, 'homebrew/my-item.json').files, ['pkg']);
  assert.equal(homebrewFileName(hb.files[0]), 'App.pkg');
});

test('a sequence becomes a template item', () => {
  const item = itemFromSequence({ name: 'Jailbreak', steps: [{ type: 'wait', duration: 1 }], auto_trigger: 'loader_down' }, { id: slugify('Jailbreak!'), description: 'x', author: 'me' });
  assert.equal(item.id, 'jailbreak');
  assert.equal(item.autoTrigger, 'loader_down');
  assert.deepEqual(validateStoreItem(item), []);
});

test('payload items install ELF/BIN/LUA but refuse packages and missing checksums', () => {
  const payload = { ...base, kind: 'payload', console_type: 'ps5', files: [{ type: 'elf', url: 'https://example.org/tool.elf', sha256: 'a'.repeat(64), size: 12 }] };
  assert.deepEqual(validateStoreItem(payload), []);
  assert.deepEqual(indexEntry(payload, 'payloads/my-item.json').files, ['elf']);
  assert.ok(validateStoreItem({ ...payload, files: [{ ...payload.files[0], type: 'pkg', url: 'https://example.org/tool.pkg' }] }).some(e => e.includes('cannot contain pkg')));
  assert.ok(validateStoreItem({ ...payload, files: [{ ...payload.files[0], sha256: undefined }] }).some(e => e.includes('sha256')));
  assert.ok(validateStoreItem({ ...base, kind: 'constructor' }).length);
});


test('icons and curated ids are validated and kept in the listing', () => {
  const item = { ...base, kind: 'script', script: 'home', builtin_id: 'builtin:my-item', icon: 'https://api.pkg-zone.com/storedata/app.png', homebrew_id: 'TEST00001' };
  assert.deepEqual(validateStoreItem(item), []);
  const entry = indexEntry(item, 'scripts/my-item.json');
  assert.equal(entry.icon, item.icon);
  assert.equal(entry.homebrew_id, item.homebrew_id);
  assert.equal(entry.builtin_id, item.builtin_id);
  assert.ok(validateStoreItem({ ...item, icon: 'javascript:alert(1)' }).some(e => e.startsWith('icon')));
  assert.ok(validateStoreItem({ ...item, builtin_id: '../bad' }).some(e => e.startsWith('builtin_id')));
});

test('the catalog the app reads is the marketplace repository', () => {
  assert.equal(STORE_REPO, 'quatrixone/p5-marketplace');
  assert.equal(STORE_BRANCH, 'main');
});

test('the catalog native archives and coming-soon entries are readable, and only some types install', () => {
  const archive = { kind: 'homebrew', id: 'hb-ppsa99997', name: 'Archive app', description: 'd', author: 'dev', version: 1,
    console_type: 'ps5', title_id: 'PPSA99997',
    files: [{ type: 'zip', url: 'https://example.org/PPSA99997.zip', sha256: 'a'.repeat(64) }] };
  assert.deepEqual(validateStoreItem(archive), []);
  assert.deepEqual(validateStoreItem({ ...archive, files: [{ ...archive.files[0], type: 'ffpfsc', url: 'https://example.org/PPSA99997.ffpfsc' }] }), []);
  // An archive is PS5-only and needs its title id, and the extension has to
  // match the declared type.
  assert.ok(validateStoreItem({ ...archive, console_type: 'ps4' }).some(e => e.includes('native archives')));
  assert.ok(validateStoreItem({ ...archive, title_id: undefined }).some(e => e.includes('native archives')));
  assert.ok(validateStoreItem({ ...archive, title_id: 'CUSA12345' }).some(e => e.includes('title_id')));
  assert.ok(validateStoreItem({ ...archive, files: [{ ...archive.files[0], url: 'https://example.org/PPSA99997.pkg' }] }).some(e => e.includes('extension')));
  // A coming-soon listing carries no files at all.
  assert.deepEqual(validateStoreItem({ ...archive, comingSoon: true, files: [] }), []);
  assert.ok(validateStoreItem({ ...archive, comingSoon: true }).some(e => e.includes('coming-soon')));
  // What the app can actually put somewhere.
  assert.deepEqual(uninstallableFiles(archive), ['PPSA99997.zip']);
  assert.deepEqual(uninstallableFiles({ ...archive, files: [{ type: 'pkg', url: 'https://example.org/a.pkg' }] }), []);
});
