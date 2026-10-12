import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeSourceUrl, detectSourceFormat, parseSourceCatalog, createCatalogSource } from './catalogSource.js';

const fpkgi = { DATA: { 'https://example.org/app.pkg': { name: 'Test app', title_id: 'TEST00001', version: '1.0', size: 500, sha256: 'a'.repeat(64) } } };
const store = { generated: '2026-10-10T00:00:00.000Z', items: [{ kind: 'script', id: 'home-ps5', name: 'Home', description: 'Press home', author: 'Someone', version: 2, console_type: 'ps5' }] };
const source = { id: 'src1', name: 'My catalog', url: 'https://example.org/catalog.json', console_type: null };

test('only plain https URLs are accepted as a source', () => {
  assert.equal(normalizeSourceUrl('https://example.org/c.json'), 'https://example.org/c.json');
  for (const bad of ['http://example.org/c.json', 'https://user:pw@example.org/c.json', 'file:///etc/passwd', 'javascript:alert(1)', '', 'not a url']) {
    assert.throws(() => normalizeSourceUrl(bad), /https/i, `accepted ${bad}`);
  }
});

test('the format is read from the content, and anything else says what was expected', () => {
  assert.equal(detectSourceFormat(fpkgi), 'fpkgi');
  assert.equal(detectSourceFormat(store), 'store');
  assert.throws(() => detectSourceFormat({ hello: 'world' }), /DATA|items/);
  assert.throws(() => detectSourceFormat([]), /DATA|items/);
});

test('a custom FPKGi catalog becomes catalog items that carry their source', () => {
  const items = parseSourceCatalog(fpkgi, source);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'catalog');
  assert.equal(items[0].origin, 'source:src1');
  assert.equal(items[0].installable, true);
  assert.equal(items[0].verified, true);
  assert.equal(items[0].package_url, 'https://example.org/app.pkg');
  // Without a checksum the item may still be installed, but not as verified.
  const bare = parseSourceCatalog({ DATA: { 'https://example.org/b.pkg': { name: 'B' } } }, source)[0];
  assert.equal(bare.verified, false);
  assert.equal(bare.installable, true);
  // A link we cannot use is not an install.
  const unusable = parseSourceCatalog({ DATA: { 'magnet:?xt=1': { name: 'C' } } }, source)[0];
  assert.equal(unusable.installable, false);
});

test('a custom store index keeps its kinds and versions', () => {
  const items = parseSourceCatalog(store, source);
  assert.equal(items[0].kind, 'script');
  assert.equal(items[0].version, 2);
  assert.equal(items[0].origin, 'source:src1');
  assert.equal(items[0].console_type, 'ps5');
  assert.throws(() => parseSourceCatalog({ items: [{ kind: 'virus', id: 'x', name: 'x', version: 1 }] }, source), /kind/i);
  assert.throws(() => parseSourceCatalog({ items: [{ kind: 'script', id: '../x', name: 'x', version: 1 }] }, source), /id/i);
});

test('a source the user declared as PS4 only labels its items', () => {
  const items = parseSourceCatalog(fpkgi, { ...source, console_type: 'ps4' });
  assert.equal(items[0].console_type, 'ps4');
});

test('a source is fetched once per TTL, cached on disk and survives the network going away', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 0, calls = 0, offline = false;
  const fetchImpl = async () => { calls++; return offline ? new Response('', { status: 503 }) : Response.json(fpkgi); };
  const options = { cacheDir: dir, fetchImpl, now: () => clock };
  const reader = createCatalogSource(options);
  const [a, b] = await Promise.all([reader.read(source), reader.read(source)]);
  assert.equal(calls, 1);
  assert.deepEqual(a.items, b.items);
  assert.equal(a.warning, null);
  clock = 899_999; await reader.read(source); assert.equal(calls, 1);
  clock++; await reader.read(source); assert.equal(calls, 2);
  offline = true;
  const restarted = createCatalogSource(options);
  const cached = await restarted.read(source);
  assert.deepEqual(cached.items, a.items);
  assert.match(cached.warning, /503/);
  const unknown = await restarted.read({ ...source, id: 'src2', url: 'https://example.org/other.json' });
  assert.deepEqual(unknown.items, []);
  assert.match(unknown.warning, /503/);
});

test('a source larger than the cap is refused instead of filling the disk', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const huge = new Uint8Array(1024 * 1024);
  const fetchImpl = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(huge); },
  }), { status: 200 });
  const reader = createCatalogSource({ cacheDir: dir, fetchImpl, now: () => 0, maxBytes: 4 * 1024 * 1024 });
  const result = await reader.read(source);
  assert.deepEqual(result.items, []);
  assert.match(result.warning, /too large|exceeds/i);
});
