import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import initSqlJs from 'sql.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-marketplace-'));
process.env.DATA_DIR = process.env.P5M_DB_DIR = dir;
process.env.USER_DATA_DIR = path.join(dir, 'user');
const root = new URL('../../../', import.meta.url);
let offline = false, revision = 1, requests = 0;
const SQL = await initSqlJs();
const db = new SQL.Database();
db.run('CREATE TABLE homebrews (id TEXT, name TEXT, main_icon_path TEXT)');
db.run('INSERT INTO homebrews VALUES (?, ?, ?)', ['TEST00001', 'Test App', 'http://api.pkg-zone.com/storedata/test.png']);
const iconBytes = Buffer.from(db.export()); db.close();
const { encodeCatalog, decodeCatalog } = await import('./catalogLinks.js');
const source = http.createServer((req, res) => {
  requests++;
  if (offline) { res.writeHead(503); res.end(); return; }
  if (req.url.startsWith('/fpkgi/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ DATA: { 'https://example.org/app.pkg': { name: 'External App', title_id: 'TEST00001', version: String(revision), region: 'EUR' } } })); return; }
  if (req.url === '/ps4.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ DATA: { 'https://example.org/test.pkg': { title_id: 'TEST00001', name: 'Test App', cover_url: 'https://example.org/icon.png', version: '1.0' } } })); return; }
  if (req.url === '/icons.db') { res.end(iconBytes); return; }
  const rel = req.url.replace(/^\//, '');
  let body;
  if (rel === 'store/scripts/owned-script.json' || rel === 'store/scripts/other-script.json') {
    const own = rel.includes('owned-script');
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ kind: 'script', id: own ? 'owned-script' : 'other-script', name: 'Published script', description: 'Shared script', author: own ? 'old-name' : 'other', github_owner_id: own ? 123 : 999, version: own ? 3 : 2, script: 'home' })); return;
  }
  try { body = decodeCatalog(JSON.parse(fs.readFileSync(new URL(rel, root), 'utf8'))); }
  catch { res.writeHead(404); res.end(); return; }
  if (rel === 'store/builtin/inputScripts.json') {
    const entry = body.find(i => i.id === 'builtin:home-ps5');
    entry.script = `home\nwait ${revision * 1200}`;
    entry.description = `Revision ${revision}`; entry.store.version = revision;
  }
  if (rel === 'store/index.json') { body.items.find(i => i.id === 'home-ps5').version = revision; body.items.push({ kind: 'script', id: 'owned-script', name: 'Owned script', author: 'old-name', github_owner_id: 123, version: 3 }, { kind: 'script', id: 'other-script', name: 'Other script', author: 'other', github_owner_id: 999, version: 2 }); }
  if (rel === 'store/scripts/home-ps5.json') { body.version = revision; body.script = `home\nwait ${revision * 1200}`; }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(encodeCatalog(body)));
});
await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${source.address().port}`;
process.env.P5M_STORE_URL = `${origin}/store/`;
process.env.P5M_HOMEBREW_CATALOG_URL = `${origin}/icons.db`;
process.env.P5M_PS4_HOMEBREW_URL = `${origin}/ps4.json`;
process.env.P5M_FPKGI_CATALOG_URL = `${origin}/fpkgi/`;
const catalog = await import('./marketplaceCatalog.js');
const icons = await import('./homebrewIcons.js');
const { initDatabase, getRepo, saveDatabase, flushPendingSave } = await import('../db/sqlite.js');
await initDatabase();
const app = express(); app.use(express.json());
app.use('/store', (await import('../routes/store.js')).default);
app.use('/api/store', (await import('../routes/store.js')).default);
app.use('/sequences', (await import('../routes/sequences.js')).default);
app.use('/builtin', (await import('../routes/builtin.js')).default);
app.use('/input-scripts', (await import('../routes/inputScripts.js')).default);
const apiServer = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
const apiOrigin = `http://127.0.0.1:${apiServer.address().port}`;
async function request(route, body) {
  const response = await fetch(`${apiOrigin}${route}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  assert.equal(response.status, 200, route); return response.json();
}
test('curated macros coalesce reads and retain local edits across refresh/restart/offline', async () => {
  const before = requests;
  const [a, b] = await Promise.all([catalog.readMarketplaceBuiltinList('inputScripts.json'), catalog.readMarketplaceBuiltinList('inputScripts.json')]);
  assert.deepEqual(a, b); assert.equal(requests - before, 1);
  const original = a.find(i => i.id === 'builtin:home-ps5');
  original.script = 'home\nwait 999'; await catalog.writeMarketplaceBuiltinList('inputScripts.json', a);
  revision = 2;
  const updated = await catalog.readMarketplaceBuiltinList('inputScripts.json', { refresh: true });
  const edited = updated.find(i => i.id === original.id);
  assert.equal(edited.script, 'home\nwait 999'); assert.equal(edited.description, 'Revision 2'); assert.equal(edited.store.version, 2);
  offline = true;
  const restarted = await import('./marketplaceCatalog.js?restart');
  assert.deepEqual(await restarted.readMarketplaceBuiltinList('inputScripts.json'), updated);
  await assert.rejects(restarted.readMarketplaceBuiltinList('inputScripts.json', { refresh: true }), /503/);
  assert.deepEqual(await restarted.readMarketplaceBuiltinList('inputScripts.json'), updated);
  offline = false; catalog.restoreMarketplaceBuiltinBackup('inputScripts.json');
  assert.equal((await catalog.readMarketplaceBuiltinList('inputScripts.json')).find(i => i.id === original.id).script, 'home\nwait 2400');
});
test('Homebrew Store icons use exact ids or unambiguous titles, with offline cache', async () => {
  const data = await icons.homebrewIcons({ refresh: true }); assert.equal(data.warning, null);
  assert.equal(icons.matchHomebrewIcon({ kind: 'homebrew', homebrew_id: 'TEST00001' }, data.rows), 'https://api.pkg-zone.com/storedata/test.png');
  assert.equal(icons.matchHomebrewIcon({ kind: 'payload', name: 'Test App.elf' }, data.rows), 'https://api.pkg-zone.com/storedata/test.png');
  assert.equal(icons.matchHomebrewIcon({ kind: 'payload', name: 'Other' }, data.rows), null);
  assert.equal(icons.matchHomebrewIcon({ kind: 'payload', name: 'Test App' }, [...data.rows, ...data.rows]), null);
  assert.equal(icons.iconUrl('javascript:alert(1)'), null);
  offline = true; const cached = await icons.homebrewIcons({ refresh: true });
  assert.deepEqual(cached.rows, data.rows); assert.match(cached.warning, /503/); offline = false;
});
test('imports update an existing script and clear its update badge', async () => {
  revision = 1; let index = await request('/store/index?refresh=1');
  assert.equal(index.items.find(i => i.id === 'home-ps5').installed, null);
  const first = await request('/store/install', { kind: 'script', id: 'home-ps5' });
  revision = 2; index = await request('/store/index?refresh=1');
  assert.equal(index.items.find(i => i.id === 'home-ps5').update, true); assert.equal(index.updates, 1);
  const second = await request('/store/install', { kind: 'script', id: 'home-ps5' });
  assert.equal(second.localId, first.localId); assert.equal(getRepo().queryScalar('SELECT COUNT(*) FROM input_scripts'), 1);
  assert.equal(getRepo().queryOne('SELECT script FROM input_scripts WHERE id = ?', [first.localId]).script, 'home\nwait 2400');
  index = await request('/store/index'); assert.equal(index.items.find(i => i.id === 'home-ps5').update, false); assert.equal(index.updates, 0);
  await request('/store/refresh-builtins', {});
  const scripts = await request('/input-scripts/builtin?console_type=ps4'); assert.ok(scripts.length); assert.ok(scripts.every(i => !i.console_type || i.console_type === 'ps4'));
});
test('template imports retain console compatibility and do not duplicate the curated gallery', async () => {
  const profileId = getRepo().runAndSave('INSERT INTO profiles (name, ip_address, console_type) VALUES (?, ?, ?)', ['Test PS4', '192.0.2.4', 'ps4']);
  const body = { kind: 'template', id: 'goldhen-load', profileId };
  const first = await request('/store/install', body);
  const second = await request('/store/install', body);
  assert.equal(first.localId, second.localId);
  assert.equal(getRepo().queryScalar('SELECT COUNT(*) FROM autoload_sequences'), 1);
  const list = await request('/sequences/templates/list');
  assert.equal(list.filter(t => t.store?.id === 'goldhen-load').length, 1);
  assert.ok(list.some(t => t.id === 'tpl-userguide-jailbreak-autoload'));
  const scripts = await request('/builtin/files/inputScripts.json');
  assert.equal(scripts.source, 'marketplace');
  assert.ok(JSON.parse(scripts.content).some(s => s.id === 'builtin:open-user-guide'));
});
test('invalid remote macros and template steps are refused', () => {
  assert.throws(() => catalog.validateBuiltinCatalog('inputScripts.json', [{ id: 'bad', name: 'Bad', script: 'home' }]), /Invalid/);
  assert.throws(() => catalog.validateBuiltinCatalog('templates.json', [{ id: 'tpl-bad', name: 'Bad', steps: [{ type: 'wait', duration: -1 }] }]), /duration/);
});
test('PS4 metadata keeps cached covers and distinguishes apps with duplicate title ids', async () => {
  const ps4 = await import('./ps4HomebrewMetadata.js');
  const data = await ps4.ps4HomebrewMetadata({ refresh: true });
  assert.equal(data.warning, null); assert.equal(data.rows[0].console_type, 'ps4');
  const duplicate = [...data.rows, { ...data.rows[0], name: 'Another app', icon: 'https://example.org/other.png' }];
  assert.equal(icons.matchHomebrewIcon({ kind: 'homebrew', console_type: 'ps4', homebrew_id: 'TEST00001', name: 'Test App' }, duplicate), 'https://example.org/icon.png');
  assert.equal(icons.matchHomebrewIcon({ kind: 'homebrew', console_type: 'ps5', homebrew_id: 'TEST00001', name: 'Test App' }, duplicate), null);
  assert.throws(() => ps4.parsePs4HomebrewMetadata({ DATA: [] }), /Invalid/);
  offline = true; const cached = await ps4.ps4HomebrewMetadata({ refresh: true });
  assert.deepEqual(cached.rows, data.rows); assert.match(cached.warning, /503/); offline = false;
});
test('issue drafts work without OAuth and never claim to verify the author', async () => {
  const publish = body => fetch(`${apiOrigin}/api/store/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const localId = getRepo().runAndSave('INSERT INTO input_scripts (name, script) VALUES (?, ?)', ['Renamed script', 'home\nwait 500']);
  const body = { kind: 'script', localId, description: 'New script content', storeId: 'owned-script', author: 'owner', console_type: 'ps5' };
  assert.equal((await publish({ ...body, author: '' })).status, 400);
  assert.equal((await publish({ ...body, author: 'invalid user' })).status, 400);
  const r = await publish(body); assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.identityVerified, false); assert.equal(data.item.github_owner_id, undefined);
  assert.equal(data.item.id, 'owned-script'); assert.equal(data.item.version, 4); assert.equal(data.item.author, 'owner');
  assert.equal(data.item.script, 'home\nwait 500'); assert.match(new URL(data.issueUrl).searchParams.get('title'), /Update Renamed script v4/);
  // A draft for another owner's item is harmless: acceptance must reject it.
  const other = await publish({ ...body, storeId: 'other-script' }); assert.equal(other.status, 200);
  const { prepareStoreSubmission } = await import('./storeOwnership.js');
  const otherItem = (await other.json()).item;
  assert.throws(() => prepareStoreSubmission(otherItem, { github_owner_id: 999, version: 2 }, { id: 123, login: 'owner' }), /Only the owner/);
  const pkg = await publish({ kind: 'homebrew', author: 'owner', description: 'My package', item: { name: 'New PS4 app', console_type: 'ps4', author: 'fake', github_owner_id: 999, version: 999, files: [{ type: 'pkg', url: 'https://example.org/app.pkg' }] } });
  assert.equal(pkg.status, 200); const submitted = (await pkg.json()).item;
  assert.equal(submitted.console_type, 'ps4'); assert.equal(submitted.version, 1); assert.equal(submitted.github_owner_id, undefined);
  const collisionId = getRepo().runAndSave('INSERT INTO input_scripts (name, script) VALUES (?, ?)', ['Owned Script', 'home']);
  assert.equal((await publish({ kind: 'script', author: 'owner', localId: collisionId, description: 'Collision' })).status, 409);
});
test('catalog API exposes the offered categories and news shows refreshed versions for both sources', async () => {
  const categories = await request('/store/catalog/categories');
  assert.deepEqual(categories.categories.map(c => c.id), ['apps', 'homebrew', 'emulators']);
  const listing = await request('/store/catalog?platform=ps5&category=apps');
  assert.equal(listing.total, 1); assert.equal(listing.items[0].console_type, 'ps5');
  const invalid = await fetch(`${apiOrigin}/store/catalog?platform=ps4&category=bad`); assert.equal(invalid.status, 400);
  const first = await request('/store/news?platform=ps4');
  assert.equal(first.intervalMs, 900000); assert.ok(first.items.some(i => i.source === 'fpkgi')); assert.ok(first.items.some(i => i.source === 'marketplace')); assert.equal(first.warnings.length, 0);
  revision++;
  const changed = await request('/store/news?platform=ps5&refresh=1&event=updated');
  assert.ok(changed.items.some(i => i.source === 'marketplace' && i.store_id === 'home-ps5'));
  assert.ok(changed.items.some(i => i.source === 'fpkgi'));
});
test.after(async () => {
  await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => apiServer.close(resolve))]);
  flushPendingSave(); saveDatabase(); fs.rmSync(dir, { recursive: true, force: true });
});

test('the default payload list is a marketplace catalog of its own, keyed by file name', () => {
  const list = [{ filename: 'klogsrv-ps5.elf', url: 'https://example.org/k.elf', console_type: 'ps5', port: 9021 }];
  assert.deepEqual(catalog.validateBuiltinCatalog('payloads.json', list), list);
  assert.equal(catalog.builtinKey(list[0]), 'klogsrv-ps5.elf');
  assert.throws(() => catalog.validateBuiltinCatalog('payloads.json', [{ filename: '../escape.elf', url: 'https://example.org/e' }]), /file name/);
  assert.throws(() => catalog.validateBuiltinCatalog('payloads.json', [{ filename: 'a.elf' }]), /URL/);
  assert.throws(() => catalog.validateBuiltinCatalog('payloads.json', [...list, ...list]), /Duplicate/);
  assert.throws(() => catalog.validateBuiltinCatalog('payloads.json', [{ filename: 'a.elf', url: 'https://example.org/a', port: 'nine' }]), /port/);
  assert.throws(() => catalog.validateBuiltinCatalog('payloads.json', [{ filename: 'a.elf', url: 'https://example.org/a', console_type: 'ps3' }]), /platform/);
});

test('a catalog without the curated manifest keeps the last copy instead of emptying the list', async () => {
  const known = await catalog.readMarketplaceBuiltinList('inputScripts.json');
  assert.ok(known.length, 'a persisted copy exists from the earlier reads');
  const storeUrl = process.env.P5M_STORE_URL;
  process.env.P5M_STORE_URL = `${origin}/no-such-store/`;
  try {
    const missing = await import('./marketplaceCatalog.js?missing');
    // A 404 is reported, never answered with an empty curated list.
    await assert.rejects(missing.readMarketplaceBuiltinList('inputScripts.json', { refresh: true }), /404/);
    assert.deepEqual(await missing.readMarketplaceBuiltinList('inputScripts.json'), known);
  } finally {
    process.env.P5M_STORE_URL = storeUrl;
  }
});
