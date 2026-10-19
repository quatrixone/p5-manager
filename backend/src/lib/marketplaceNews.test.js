import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMarketplaceNews, NEWS_INTERVAL_MS } from './marketplaceNews.js';

test('the first check is a baseline and only later arrivals and changes are news', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-news-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'news.json');
  let at = 1, calls = 0;
  let items = [{ id: 'one', name: 'One', version: 1, console_type: 'ps4' }];
  const collect = async () => { calls++; return [{ key: 'marketplace', items }]; };
  const options = { file, collect, now: () => at };
  let news = createMarketplaceNews(options);
  // What was already in the catalogue the first time we looked is not news.
  const [a, b] = await Promise.all([news.page(), news.page()]); assert.deepEqual(a, b); assert.equal(calls, 1);
  assert.deepEqual(a.items, []); assert.equal(a.intervalMs, 900_000);
  at += NEWS_INTERVAL_MS - 1; await news.page(); assert.equal(calls, 1);
  items = [{ ...items[0], version: 2 }, { id: 'two', name: 'Two', version: 1, console_type: 'ps5' }];
  at++;
  const updated = await news.page(); assert.equal(calls, 2);
  assert.equal(updated.items[0].event, 'updated'); assert.equal(updated.items[0].version, 2);
  assert.equal((await news.page({ platform: 'ps5' })).items[0].event, 'new');
  news = createMarketplaceNews(options);
  const saved = await news.page(); assert.equal(calls, 2); assert.equal(saved.items[0].detectedAt, at); assert.equal(saved.items[0].event, 'updated');
  at += NEWS_INTERVAL_MS;
  const unchanged = await news.page(); assert.equal(unchanged.items[0].detectedAt, saved.items[0].detectedAt);
});
test('a snapshot from before the baseline rule is rebaselined once, not announced', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-news-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'news.json');
  // Written by the version that marked everything new on its first check.
  fs.writeFileSync(file, JSON.stringify({ checkedAt: 1, warnings: [], records: {
    'marketplace:a': { sourceKey: 'marketplace', fingerprint: 'x', event: 'new', detectedAt: 1, item: { id: 'a', name: 'Alpha', version: 1 } },
    'marketplace:b': { sourceKey: 'marketplace', fingerprint: 'y', event: 'updated', detectedAt: 1, item: { id: 'b', name: 'Beta', version: 1 } },
  } }));
  const news = createMarketplaceNews({ file, now: () => 2, collect: async () => [{ key: 'marketplace', items: [{ id: 'a', name: 'Alpha', version: 1 }, { id: 'b', name: 'Beta', version: 1 }] }] });
  assert.deepEqual((await news.page()).items, []);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.schema, 2);
  assert.equal(written.records['marketplace:a'].detectedAt, 1, 'when it was first seen is not rewritten');
});
test('an item already installed shows as an update whenever the catalogue is ahead', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-news-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'news.json');
  const items = [{ id: 'mine', name: 'Mine', version: 3 }, { id: 'theirs', name: 'Theirs', version: 1 }];
  const news = createMarketplaceNews({ file, now: () => 1, collect: async () => [{ key: 'marketplace', items }] });
  // Baseline: nothing is news, but the one I have an older copy of is still
  // an update waiting for me.
  const isPendingUpdate = (item) => item.id === 'mine';
  assert.deepEqual((await news.page({ isPendingUpdate })).items.map(i => i.id), ['mine']);
  assert.equal((await news.page({ isPendingUpdate })).items[0].event, 'updated');
  assert.deepEqual((await news.page({ isPendingUpdate, event: 'new' })).items, []);
  assert.deepEqual((await news.page({ isPendingUpdate, event: 'updated' })).items.map(i => i.id), ['mine']);
  assert.deepEqual((await news.page()).items, []);
});
test('failed sources retain activity while successful sources remove deleted entries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-news-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // An empty catalogue first, so the two entries below are arrivals rather
  // than part of the baseline.
  let sources = [{ key: 'one', items: [] }, { key: 'two', items: [] }];
  const news = createMarketplaceNews({ file: path.join(dir, 'news.json'), collect: async () => sources });
  assert.equal((await news.page()).total, 0);
  sources = [{ key: 'one', items: [{ id: 'a', name: 'Alpha' }] }, { key: 'two', items: [{ id: 'b', name: 'Beta' }] }];
  assert.equal((await news.page({ force: true })).total, 2);
  sources = [{ key: 'one', warning: 'offline' }, { key: 'two', items: [] }];
  const data = await news.page({ force: true }); assert.equal(data.total, 1); assert.equal(data.items[0].name, 'Alpha'); assert.equal(data.warnings.length, 1);
  assert.equal((await news.page({ query: 'alpha', event: 'new' })).total, 1);
  assert.equal((await news.page({ event: 'updated' })).total, 0);
});

test('snapshots of sources that are no longer offered disappear from New', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'news-')), 'news.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 2, checkedAt: 1, warnings: [], records: {
    'fpkgi:ps4:games:a': { sourceKey: 'fpkgi:ps4:games', fingerprint: 'x', event: 'new', detectedAt: 1, item: { id: 'a', name: 'A retail game', console_type: 'ps4' } },
    'fpkgi:ps4:homebrew:b': { sourceKey: 'fpkgi:ps4:homebrew', fingerprint: 'y', event: 'new', detectedAt: 1, item: { id: 'b', name: 'A homebrew app', console_type: 'ps4' } },
  } }));
  const news = createMarketplaceNews({ file, now: () => 2, knownSource: (key) => key !== 'fpkgi:ps4:games',
    collect: async () => [{ key: 'fpkgi:ps4:homebrew', items: [{ id: 'b', name: 'A homebrew app', console_type: 'ps4' }] }] });
  const first = await news.page({});
  assert.deepEqual(first.items.map(i => i.name), ['A homebrew app']);
  assert.ok(!JSON.parse(fs.readFileSync(file, 'utf8')).records['fpkgi:ps4:games:a'], 'the snapshot is pruned on disk too');
});
