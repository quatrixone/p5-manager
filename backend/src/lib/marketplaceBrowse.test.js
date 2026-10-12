import test from 'node:test';
import assert from 'node:assert/strict';
import { browse } from './marketplaceBrowse.js';

const curated = [
  { kind: 'homebrew', id: 'cheats', name: 'Cheats Manager', description: '', author: 'bucanero', version: 2, console_type: 'ps4', origin: 'marketplace', installable: true, verified: true },
  { kind: 'script', id: 'home', name: 'Home button', description: '', author: 'P5', version: 1, console_type: 'ps5', origin: 'marketplace', installable: true, verified: true },
];
const catalog = [
  { kind: 'catalog', id: 'c1', name: 'Alpha pack', title_id: 'CUSA00001', console_type: 'ps4', origin: 'fpkgi', category: 'games', installable: true, verified: false },
  { kind: 'catalog', id: 'c2', name: 'Beta pack', title_id: 'CUSA00002', console_type: 'ps4', origin: 'fpkgi', category: 'games', installable: true, verified: false },
];
const groups = [
  { origin: 'marketplace', label: 'Marketplace', items: curated },
  { origin: 'fpkgi', label: 'FPKGi', items: catalog },
  { origin: 'source:1', label: 'Mine', warning: 'Mine unavailable: HTTP 503' },
];

test('curated items come first and catalogs follow by name', () => {
  const page = browse(groups, { platform: 'ps4' });
  assert.deepEqual(page.items.map(i => i.id), ['cheats', 'c1', 'c2']);
  assert.equal(page.total, 3);
});

test('a source that is down is a warning, not an empty list', () => {
  const page = browse(groups, { platform: 'ps4' });
  assert.deepEqual(page.warnings, ['Mine unavailable: HTTP 503']);
  assert.equal(page.items.length, 3);
});

test('the platform decides what is listed, and items for both consoles always are', () => {
  const both = { ...curated[1], id: 'any', console_type: null };
  assert.deepEqual(browse([{ origin: 'marketplace', items: [...curated, both] }], { platform: 'ps4' }).items.map(i => i.id), ['cheats', 'any']);
  assert.deepEqual(browse([{ origin: 'marketplace', items: curated }], { platform: 'ps5' }).items.map(i => i.id), ['home']);
});

test('search covers name, title id and author; filters cover source, kind and updates', () => {
  assert.deepEqual(browse(groups, { platform: 'ps4', query: 'alpha' }).items.map(i => i.id), ['c1']);
  assert.deepEqual(browse(groups, { platform: 'ps4', query: 'CUSA00002' }).items.map(i => i.id), ['c2']);
  assert.deepEqual(browse(groups, { platform: 'ps4', query: 'bucanero' }).items.map(i => i.id), ['cheats']);
  assert.deepEqual(browse(groups, { platform: 'ps4', source: 'fpkgi' }).items.map(i => i.id), ['c1', 'c2']);
  assert.deepEqual(browse(groups, { platform: 'ps4', kind: 'homebrew' }).items.map(i => i.id), ['cheats']);
  const withUpdate = [{ origin: 'marketplace', items: [{ ...curated[0], update: true }, curated[1]] }];
  assert.deepEqual(browse(withUpdate, { platform: 'ps4', updatesOnly: true }).items.map(i => i.id), ['cheats']);
});

test('pages are bounded and report how many there are', () => {
  const page = browse(groups, { platform: 'ps4', limit: 2, page: 99 });
  assert.equal(page.pages, 2);
  assert.equal(page.page, 2);
  assert.equal(page.items.length, 1);
  assert.equal(browse(groups, { platform: 'ps4', limit: 1e6 }).limit, 100);
});

test('a filter on a source that does not exist says so instead of showing everything', () => {
  const page = browse(groups, { platform: 'ps4', source: 'source:9' });
  assert.deepEqual(page.items, []);
  assert.equal(page.total, 0);
});
