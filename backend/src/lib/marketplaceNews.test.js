import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMarketplaceNews, NEWS_INTERVAL_MS } from './marketplaceNews.js';

test('news detects additions and updates every 15 minutes, preserving activity across restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-news-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'news.json');
  let at = 1, calls = 0;
  let items = [{ id: 'one', name: 'One', version: 1, console_type: 'ps4' }];
  const collect = async () => { calls++; return [{ key: 'marketplace', items }]; };
  const options = { file, collect, now: () => at };
  let news = createMarketplaceNews(options);
  const [a, b] = await Promise.all([news.page(), news.page()]); assert.deepEqual(a, b); assert.equal(calls, 1);
  assert.equal(a.items[0].event, 'new'); assert.equal(a.intervalMs, 900_000);
  at += NEWS_INTERVAL_MS - 1; await news.page(); assert.equal(calls, 1);
  items = [{ ...items[0], version: 2 }, { id: 'two', name: 'Two', version: 1, console_type: 'ps5' }];
  at++;
  const updated = await news.page(); assert.equal(calls, 2); assert.equal(updated.items[0].event, 'updated'); assert.equal(updated.items[0].version, 2);
  assert.equal((await news.page({ platform: 'ps5' })).items[0].event, 'new');
  news = createMarketplaceNews(options);
  const saved = await news.page(); assert.equal(calls, 2); assert.equal(saved.items[0].detectedAt, at); assert.equal(saved.items[0].event, 'updated');
  at += NEWS_INTERVAL_MS;
  const unchanged = await news.page(); assert.equal(unchanged.items[0].detectedAt, saved.items[0].detectedAt);
});
test('failed sources retain activity while successful sources remove deleted entries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-news-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let sources = [{ key: 'one', items: [{ id: 'a', name: 'Alpha' }] }, { key: 'two', items: [{ id: 'b', name: 'Beta' }] }];
  const news = createMarketplaceNews({ file: path.join(dir, 'news.json'), collect: async () => sources });
  assert.equal((await news.page()).total, 2);
  sources = [{ key: 'one', warning: 'offline' }, { key: 'two', items: [] }];
  const data = await news.page({ force: true }); assert.equal(data.total, 1); assert.equal(data.items[0].name, 'Alpha'); assert.equal(data.warnings.length, 1);
  assert.equal((await news.page({ query: 'alpha', event: 'new' })).total, 1);
  assert.equal((await news.page({ event: 'updated' })).total, 0);
});

test('snapshots of sources that are no longer offered disappear from New', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'news-')), 'news.json');
  fs.writeFileSync(file, JSON.stringify({ checkedAt: 1, warnings: [], records: {
    'fpkgi:ps4:games:a': { sourceKey: 'fpkgi:ps4:games', fingerprint: 'x', event: 'new', detectedAt: 1, item: { id: 'a', name: 'A retail game', console_type: 'ps4' } },
    'fpkgi:ps4:homebrew:b': { sourceKey: 'fpkgi:ps4:homebrew', fingerprint: 'y', event: 'new', detectedAt: 1, item: { id: 'b', name: 'A homebrew app', console_type: 'ps4' } },
  } }));
  const news = createMarketplaceNews({ file, now: () => 2, knownSource: (key) => key !== 'fpkgi:ps4:games',
    collect: async () => [{ key: 'fpkgi:ps4:homebrew', items: [{ id: 'b', name: 'A homebrew app', console_type: 'ps4' }] }] });
  const first = await news.page({});
  assert.deepEqual(first.items.map(i => i.name), ['A homebrew app']);
  assert.ok(!JSON.parse(fs.readFileSync(file, 'utf8')).records['fpkgi:ps4:games:a'], 'the snapshot is pruned on disk too');
});
