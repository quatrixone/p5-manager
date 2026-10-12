// Marketplace: Autoload templates, input scripts and homebrew
// apps shared by users. They live in store/ of the repository
// (lib/storeItem.js says what an item is); the app reads store/index.json
// and the items from GitHub, installs them, and turns the user's own
// scripts and sequences into a prefilled GitHub issue to publish them -
// accepted ones are added by a workflow and listed after review.
//
// Homebrew is only linked: its files come from the author's release page,
// checked against the SHA-256 the listing pins. Payloads (.elf/.bin/.lua)
// go into the payload library; a PS5 .pkg into the install queue; a PS4
// .pkg to the console's Remote Package Installer, which fetches it from
// this server.
import express from 'express';
import { fpkgiCatalog, FPKGI_CATEGORIES, FPKGI_REPO, catalogPage } from '../lib/fpkgiCatalog.js';
import { catalogSources, decorateCatalogRows, normalizeSourceUrl, detectSourceFormat } from '../lib/catalogSource.js';
import { browse } from '../lib/marketplaceBrowse.js';
import { decorateInstalled, librarySnapshots } from '../lib/installedState.js';
import { createMarketplaceNews, NEWS_INTERVAL_MS } from '../lib/marketplaceNews.js';
import { prepareStoreDraft } from '../lib/storeOwnership.js';
import { STORE_BASE, fetchCatalogJson, readMarketplaceBuiltinList } from '../lib/marketplaceCatalog.js';
import { ps4HomebrewMetadata } from '../lib/ps4HomebrewMetadata.js';
import { homebrewIcons, matchHomebrewIcon } from '../lib/homebrewIcons.js';
import { encodeCatalog, decodeCatalog } from '../lib/catalogLinks.js';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { getRepo, log } from '../db/sqlite.js';
import { downloadsDir, payloadsDir, internalDataDir } from '../lib/paths.js';
import { insertPayload } from '../lib/defaultPayloads.js';
import {
  STORE_REPO, validateStoreItem, storeDir, itemFromScript, itemFromSequence, slugify, homebrewFileName,
} from '../lib/storeItem.js';

const router = express.Router();

const INDEX_TTL_MS = 10 * 60 * 1000;
// GitHub refuses longer new-issue links; what does not fit is pasted.
const MAX_ISSUE_URL = 7500;

let indexCache = { at: 0, data: null };

async function storeIndex(force = false) {
  if (!force && indexCache.data && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.data;
  const data = await fetchCatalogJson(`${STORE_BASE}index.json`);
  if (!Array.isArray(data?.items) || data.items.some(i => !storeDir(i.kind) || typeof i.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(i.id) || !Number.isInteger(i.version) || i.version < 1)) throw Object.assign(new Error('the marketplace index is not usable'), { status: 502 });
  indexCache = { at: Date.now(), data };
  return data;
}

async function storeItem(kind, id) {
  const index = await storeIndex();
  const entry = index.items.find((i) => i.kind === kind && i.id === id);
  if (!entry) throw Object.assign(new Error('no such item in the marketplace'), { status: 404 });
  const item = await fetchCatalogJson(`${STORE_BASE}${storeDir(kind)}/${id}.json`);
  const errors = validateStoreItem(item);
  if (errors.length) throw Object.assign(new Error(`the item is not usable: ${errors.join('; ')}`), { status: 502 });
  if (item.kind !== kind || item.id !== id) throw Object.assign(new Error('the item does not match its listing'), { status: 502 });
  return item;
}

function installs() {
  return getRepo().queryAll('SELECT kind, store_id, version, name, local_id, installed_at FROM store_installs');
}

const handle = (fn) => async (req, res) => {
  try {
    res.json({ success: true, ...(await fn(req, res)) });
  } catch (e) {
    if (!e.status || e.status >= 500) log('error', `store: ${e.message}`);
    res.status(e.status || 502).json({ success: false, error: e.message });
  }
};

router.get('/catalog/categories', (_req, res) => res.json({ categories: FPKGI_CATEGORIES, repo: FPKGI_REPO }));
router.get('/catalog', handle(async req => {
  const catalog = await fpkgiCatalog.read(req.query.platform || 'ps4', req.query.category || 'homebrew', { refresh: req.query.refresh === '1' });
  return catalogPage(catalog, { query: req.query.q, page: req.query.page, limit: req.query.limit });
}));

const news = createMarketplaceNews({ file: path.join(internalDataDir, 'marketplace', 'news.json'), collect: async () => {
  const sources = [];
  try {
    const index = await storeIndex(true);
    sources.push({ key: 'marketplace', label: 'Marketplace', items: index.items.map(i => ({ ...i, id: `${i.kind}:${i.id}`, store_id: i.id, source: 'marketplace' })) });
  } catch (e) { sources.push({ key: 'marketplace', label: 'Marketplace', warning: e.message }); }
  const tasks = ['ps4', 'ps5'].flatMap(platform => FPKGI_CATEGORIES.map(category => ({ platform, category: category.id })));
  // At most four source requests at a time, including catalogs shared by PS5.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (tasks.length) {
      const { platform, category } = tasks.shift();
      const key = `fpkgi:${platform}:${category}`;
      try {
        const data = await fpkgiCatalog.read(platform, category, { refresh: true });
        sources.push({ key, label: `${platform.toUpperCase()} ${category}`, warning: data.warning,
          items: data.items.map(i => ({ ...i, kind: 'catalog', source: 'fpkgi', sourceUrl: data.sourceUrl })) });
      } catch (e) { sources.push({ key, warning: e.message }); }
    }
  }));
  return sources;
} });
const newsTimer = setInterval(() => {
  if (!news.hasStarted()) return;
  news.refresh({ force: true }).catch(e => log('error', `Marketplace news refresh: ${e.message}`));
  Promise.all(['inputScripts.json', 'templates.json', 'payloads.json'].map(name => readMarketplaceBuiltinList(name, { refresh: true })))
    .catch(e => log('error', `Marketplace script refresh: ${e.message}`));
}, NEWS_INTERVAL_MS);
newsTimer.unref();
router.get('/news', handle(async req => {
  const platform = req.query.platform || 'ps4';
  if (!['ps4', 'ps5'].includes(platform)) throw Object.assign(new Error('Unknown platform'), { status: 400 });
  const page = await news.page({ force: req.query.refresh === '1', platform, query: req.query.q, event: req.query.event || 'all', page: req.query.page });
  // The feed offers the same actions as the list, so it needs the same
  // answer about what is already installed.
  const profileId = activeProfileId(req.query.profileId);
  const snapshot = profileId ? librarySnapshots.read(profileId) : null;
  const decorated = decorateInstalled(
    page.items.map((i) => (i.source === 'marketplace'
      ? { ...i, id: i.store_id, newsId: i.newsId, origin: 'marketplace', installable: true, verified: true }
      : { ...i, origin: 'fpkgi', installable: !!i.package_url && /\.pkg$/i.test(i.package_url), verified: !!i.sha256 })),
    { installs: installs(), titles: snapshot?.titles || null, takenAt: snapshot?.takenAt || null },
  );
  return { ...page, items: decorated, libraryTakenAt: snapshot?.takenAt || null };
}));

router.get('/index', handle(async (req) => {
  const refresh = req.query.refresh === '1';
  const [index, icons, ps4] = await Promise.all([storeIndex(refresh), homebrewIcons({ refresh }), ps4HomebrewMetadata({ refresh })]);
  const mine = new Map(installs().map((i) => [`${i.kind}:${i.store_id}`, i]));
  return {
    generated: index.generated || null,
    iconWarning: [icons.warning, ps4.warning].filter(Boolean).join(' · ') || null,
    updates: index.items.filter(i => { const have = mine.get(`${i.kind}:${i.id}`); return have && i.version > have.version; }).length,
    repo: STORE_REPO,
    items: index.items.map((i) => {
      const have = mine.get(`${i.kind}:${i.id}`);
      return { ...i, icon: matchHomebrewIcon(i, [...ps4.rows, ...icons.rows.filter(r => !ps4.rows.some(p => p.id === r.id && p.name === r.name))]), installed: have ? have.version : null, update: !!have && i.version > have.version };
    }),
  };
}));

// ---------- sources the user added, and the one list they feed ----------

const sourceRows = () => getRepo().queryAll(
  'SELECT id, name, url, format, console_type, enabled, created_at, last_fetched_at, last_error FROM store_sources ORDER BY id',
).map((r) => ({ ...r, enabled: !!r.enabled }));

const sourceName = (value, url) => {
  const name = String(value || '').trim().slice(0, 80);
  if (name) return name;
  try { return new URL(url).hostname; } catch { return 'Catalog'; }
};

function sourceById(id) {
  const row = getRepo().queryOne('SELECT id, name, url, format, console_type, enabled FROM store_sources WHERE id = ?', [Number(id)]);
  if (!row) throw Object.assign(new Error('no such source'), { status: 404 });
  return { ...row, enabled: !!row.enabled };
}

// Read a source and keep what happened on its row, so the panel can show
// when it was last read and why it is empty.
async function readSource(source, { refresh = false } = {}) {
  const result = await catalogSources.read(source, { refresh });
  getRepo().run('UPDATE store_sources SET last_fetched_at = ?, last_error = ? WHERE id = ?',
    [result.fetchedAt, result.warning || null, source.id]);
  getRepo().save();
  return result;
}

router.get('/sources', handle(async () => ({ sources: sourceRows() })));

router.post('/sources', handle(async (req) => {
  const url = normalizeSourceUrl(req.body?.url);
  const consoleType = req.body?.console_type || null;
  if (consoleType && !['ps4', 'ps5'].includes(consoleType)) throw Object.assign(new Error('a source is for PS4, PS5 or both'), { status: 400 });
  if (getRepo().queryOne('SELECT id FROM store_sources WHERE url = ?', [url])) throw Object.assign(new Error('that source is already in the list'), { status: 409 });
  const name = sourceName(req.body?.name, url);
  const id = getRepo().runAndSave(
    'INSERT INTO store_sources (name, url, console_type, enabled) VALUES (?, ?, ?, 1)', [name, url, consoleType],
  );
  // Read it once now: the user finds out here whether the URL is a catalog
  // at all, instead of wondering why the list did not change.
  const source = { id, name, url, console_type: consoleType };
  const result = await readSource(source, { refresh: true });
  if (result.warning) {
    getRepo().runAndSave('DELETE FROM store_sources WHERE id = ?', [id]);
    catalogSources.forget(id);
    throw Object.assign(new Error(result.warning), { status: 502 });
  }
  const format = detectFormatOf(result.items);
  getRepo().runAndSave('UPDATE store_sources SET format = ? WHERE id = ?', [format, id]);
  log('info', `marketplace: added source "${name}" (${format}, ${result.items.length} items)`);
  return { source: { ...source, format, enabled: true, items: result.items.length } };
}));

const detectFormatOf = (items) => (items.some((i) => i.kind === 'catalog') ? 'fpkgi' : 'store');

router.patch('/sources/:id', handle(async (req) => {
  const source = sourceById(req.params.id);
  const name = req.body?.name === undefined ? source.name : sourceName(req.body.name, source.url);
  const enabled = req.body?.enabled === undefined ? source.enabled : !!req.body.enabled;
  getRepo().runAndSave('UPDATE store_sources SET name = ?, enabled = ? WHERE id = ?', [name, enabled ? 1 : 0, source.id]);
  return { source: { ...source, name, enabled } };
}));

router.delete('/sources/:id', handle(async (req) => {
  const source = sourceById(req.params.id);
  getRepo().runAndSave('DELETE FROM store_sources WHERE id = ?', [source.id]);
  catalogSources.forget(source.id);
  fs.rmSync(path.join(internalDataDir, 'marketplace', 'sources', `${source.id}.json`), { force: true });
  log('info', `marketplace: removed source "${source.name}"`);
  return {};
}));

// The curated index as list items: same shape as a catalog row, so the one
// list does not have to know which half an item came from.
async function curatedItems(refresh) {
  const [index, icons, ps4] = await Promise.all([storeIndex(refresh), homebrewIcons({ refresh }), ps4HomebrewMetadata({ refresh })]);
  const rows = [...ps4.rows, ...icons.rows.filter((r) => !ps4.rows.some((p) => p.id === r.id && p.name === r.name))];
  return {
    items: index.items.map((i) => ({ ...i, icon: matchHomebrewIcon(i, rows), origin: 'marketplace', installable: true, verified: true })),
    warning: [icons.warning, ps4.warning].filter(Boolean).join(' · ') || null,
  };
}

async function fpkgiGroup(platform, category, refresh) {
  const wanted = category === 'all' ? FPKGI_CATEGORIES.map((c) => c.id) : [category];
  const items = [];
  const warnings = [];
  const queue = [...wanted];
  // Four at a time, as the news collector does: the hub is 22 files.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const data = await fpkgiCatalog.read(platform, id, { refresh });
        if (data.warning) warnings.push(data.warning);
        items.push(...decorateCatalogRows(data.items, { origin: 'fpkgi', author: 'FPKGi Catalog Hub' }));
      } catch (e) { warnings.push(`FPKGi ${id}: ${e.message}`); }
    }
  }));
  return { origin: 'fpkgi', label: 'FPKGi Catalog Hub', items, warning: warnings[0] || null };
}

function activeProfileId(value) {
  const asked = Number(value);
  if (Number.isSafeInteger(asked) && asked > 0) return asked;
  const row = getRepo().queryOne('SELECT id FROM profiles ORDER BY is_default DESC, id ASC LIMIT 1');
  return row?.id || null;
}

router.get('/browse', handle(async (req) => {
  const platform = ['ps4', 'ps5'].includes(req.query.platform) ? req.query.platform : 'ps5';
  const refresh = req.query.refresh === '1';
  const source = String(req.query.source || 'all');
  const category = String(req.query.category || 'all');
  const groups = [];
  if (source === 'all' || source === 'marketplace') {
    try {
      const curated = await curatedItems(refresh);
      groups.push({ origin: 'marketplace', label: 'Marketplace', items: curated.items, warning: curated.warning });
    } catch (e) { groups.push({ origin: 'marketplace', label: 'Marketplace', items: [], warning: `Marketplace unavailable: ${e.message}` }); }
  }
  if (source === 'all' || source === 'fpkgi') groups.push(await fpkgiGroup(platform, category, refresh));
  for (const row of sourceRows().filter((r) => r.enabled)) {
    const origin = `source:${row.id}`;
    if (source !== 'all' && source !== origin) continue;
    const result = await readSource(row, { refresh });
    groups.push({ origin, label: row.name, items: result.items, warning: result.warning });
  }
  const profileId = activeProfileId(req.query.profileId);
  const snapshot = profileId ? librarySnapshots.read(profileId) : null;
  const page = browse(groups, {
    platform, source, category, kind: String(req.query.kind || 'all'), query: req.query.q,
    updatesOnly: req.query.updates === '1', page: req.query.page, limit: req.query.limit,
  });
  return {
    ...page,
    items: decorateInstalled(page.items, { installs: installs(), titles: snapshot?.titles || null, takenAt: snapshot?.takenAt || null }),
    sources: [
      { id: 'marketplace', label: 'Marketplace' },
      { id: 'fpkgi', label: 'FPKGi Catalog Hub' },
      ...sourceRows().filter((r) => r.enabled).map((r) => ({ id: `source:${r.id}`, label: r.name })),
    ],
    categories: FPKGI_CATEGORIES,
    libraryTakenAt: snapshot?.takenAt || null,
  };
}));

router.post('/refresh-builtins', handle(async () => {
  await Promise.all(['inputScripts.json', 'templates.json', 'payloads.json'].map(name => readMarketplaceBuiltinList(name, { refresh: true })));
  return {};
}));

// The whole item, to look at before installing.
router.get('/item/:kind/:id', handle(async (req) => ({ item: await storeItem(req.params.kind, req.params.id) })));

router.post('/install', handle(async (req) => {
  const { kind, id } = req.body || {};
  if (kind === 'homebrew' || kind === 'payload') return installHomebrew(kind, id, req.body?.profileId);
  const item = await storeItem(kind, id);
  const repo = getRepo();
  const have = repo.queryOne('SELECT local_id FROM store_installs WHERE kind = ? AND store_id = ?', [kind, id]);
  let localId = have?.local_id || null;
  if (kind === 'script') {
    const exists = localId && repo.queryOne('SELECT id FROM input_scripts WHERE id = ?', [localId]);
    if (exists) {
      repo.run('UPDATE input_scripts SET name = ?, script = ?, console_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [item.name, item.script, item.console_type || null, localId]);
    } else {
      localId = repo.runAndSave('INSERT INTO input_scripts (name, script, console_type) VALUES (?, ?, ?)', [item.name, item.script, item.console_type || null]);
    }
  }
  if (kind === 'template') {
    const profileId = item.requiresProfile === false ? null : Number(req.body?.profileId);
    if (item.requiresProfile !== false) {
      const profile = repo.queryOne('SELECT id, console_type FROM profiles WHERE id = ?', [profileId]);
      if (!profile) throw Object.assign(new Error('pick the console for this Autoload sequence'), { status: 400 });
      if (item.console_type && profile.console_type !== item.console_type) throw Object.assign(new Error(`this sequence requires ${item.console_type.toUpperCase()}`), { status: 400 });
    }
    const exists = localId && repo.queryOne('SELECT id FROM autoload_sequences WHERE id = ?', [localId]);
    if (exists) repo.run('UPDATE autoload_sequences SET name = ?, steps = ?, profile_id = ?, auto_trigger = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [item.name, JSON.stringify(item.steps), profileId, item.autoTrigger || null, localId]);
    else localId = repo.runAndSave('INSERT INTO autoload_sequences (name, steps, profile_id, auto_trigger) VALUES (?, ?, ?, ?)', [item.name, JSON.stringify(item.steps), profileId, item.autoTrigger || null]);
  }
  repo.run(
    `INSERT INTO store_installs (kind, store_id, version, name, data, local_id) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, store_id) DO UPDATE SET version = excluded.version, name = excluded.name, data = excluded.data,
       local_id = excluded.local_id, installed_at = CURRENT_TIMESTAMP`,
    [kind, id, item.version, item.name, JSON.stringify(encodeCatalog(item)), localId],
  );
  repo.save();
  log('info', `marketplace: installed ${kind} "${item.name}" v${item.version} by ${item.author}`);
  return { installed: item.version, localId };
}));

router.post('/uninstall', handle(async (req) => {
  const { kind, id } = req.body || {};
  const repo = getRepo();
  const have = repo.queryOne('SELECT local_id FROM store_installs WHERE kind = ? AND store_id = ?', [kind, id]);
  if (!have) throw Object.assign(new Error('not installed'), { status: 404 });
  if (kind === 'template' && have.local_id) repo.run('DELETE FROM autoload_sequences WHERE id = ?', [have.local_id]);
  if (kind === 'script' && have.local_id) repo.run('DELETE FROM input_scripts WHERE id = ?', [have.local_id]);
  repo.run('DELETE FROM store_installs WHERE kind = ? AND store_id = ?', [kind, id]);
  repo.save();
  return {};
}));

// Templates from the marketplace, in the shape of the built-in ones, for
// the Autoload template gallery.
export function installedTemplates() {
  try {
    return getRepo().queryAll("SELECT data FROM store_installs WHERE kind = 'template' ORDER BY name").map((r) => {
      const item = decodeCatalog(JSON.parse(r.data));
      return {
        id: `store:${item.id}`,
        name: item.name,
        description: item.description,
        ...(item.console_type ? { console_type: item.console_type } : {}),
        requiresProfile: item.requiresProfile !== false,
        ...(item.autoTrigger ? { autoTrigger: item.autoTrigger } : {}),
        steps: item.steps,
        store: { id: item.id, author: item.author, version: item.version },
      };
    });
  } catch (e) {
    log('error', `marketplace templates: ${e.message}`);
    return [];
  }
}

// A sequence's steps as another installation can run them: its own
// scripts and payloads are known there only by name, not by id.
function portableSteps(steps) {
  const repo = getRepo();
  return steps.map((s) => {
    const out = { ...s };
    if (s.type === 'input_script' && !s.script && s.scriptId && !String(s.scriptId).startsWith('builtin:')) {
      const row = repo.queryOne('SELECT script FROM input_scripts WHERE id = ?', [parseInt(s.scriptId, 10)]);
      if (!row) throw Object.assign(new Error(`step "${s.name || 'input script'}" uses a script that no longer exists`), { status: 400 });
      out.script = row.script;
      delete out.scriptId;
      delete out.builtin;
    }
    if (s.type === 'payload' && s.payloadId) {
      const row = repo.queryOne('SELECT filename FROM payloads WHERE id = ?', [parseInt(s.payloadId, 10)]);
      if (row?.filename) out.payloadName = row.filename;
      delete out.payloadId;
    }
    return out;
  });
}

// Builds the item for one of the user's scripts or sequences and the link
// to the GitHub issue that submits it.
router.post('/publish', handle(async (req) => {
  const { kind, localId, description, storeId, author, console_type: consoleType } = req.body || {};
  const repo = getRepo();
  const meta = { description: String(description || '').trim(), author: String(author || "").trim(), console_type: consoleType || undefined };
  let item;
  if (kind === 'script') {
    const row = repo.queryOne('SELECT name, script FROM input_scripts WHERE id = ?', [parseInt(localId, 10)]);
    if (!row) throw Object.assign(new Error('no such script'), { status: 404 });
    item = itemFromScript(row, { ...meta, id: slugify(row.name) });
  } else if (kind === 'template') {
    const row = repo.queryOne('SELECT name, steps, auto_trigger FROM autoload_sequences WHERE id = ?', [parseInt(localId, 10)]);
    if (!row) throw Object.assign(new Error('no such sequence'), { status: 404 });
    item = itemFromSequence({ ...row, steps: portableSteps(JSON.parse(row.steps)) }, { ...meta, id: slugify(row.name) });
  } else if (kind === 'homebrew' || kind === 'payload') {
    const submitted = req.body?.item;
    if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) throw Object.assign(new Error('Provide the homebrew item JSON'), { status: 400 });
    item = { ...decodeCatalog(submitted), kind, id: slugify(submitted.name), ...meta, console_type: consoleType || submitted.console_type, version: 1 };
  } else {
    throw Object.assign(new Error('Choose script, template, homebrew or payload'), { status: 400 });
  }
  if (storeId) {
    const old = await storeItem(kind, storeId);
    item = prepareStoreDraft({ ...item, id: old.id }, old, meta.author);
  } else {
    const index = await storeIndex(true);
    const collision = index.items.find(i => i.kind === kind && i.id === item.id);
    if (collision) throw Object.assign(new Error('This item id already exists; choose Update my item or use a different name'), { status: 409 });
    item = prepareStoreDraft(item, null, meta.author);
  }
  const errors = validateStoreItem(item, { submission: true });
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400 });

  const json = JSON.stringify(encodeCatalog(item), null, 2);
  const base = `https://github.com/${STORE_REPO}/issues/new?template=store-submission.yml`
    + `&title=${encodeURIComponent(`[store] ${storeId ? 'Update ' : ''}${item.name} v${item.version}`)}&labels=store-submission`;
  const full = `${base}&item=${encodeURIComponent(json)}`;
  const fits = full.length <= MAX_ISSUE_URL;
  return { identityVerified: false, item, json, issueUrl: fits ? full : base, prefilled: fits };
}));

// ── homebrew ────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const API = `http://127.0.0.1:${PORT}/api`;
const RPI_PORT = 12800; // Remote Package Installer on a PS4
const jobs = new Map(); // id -> { id, state, step, log[], error, result }
const pkgLinks = new Map(); // token -> { file, until }

function newJob(run) {
  const job = { id: crypto.randomBytes(6).toString('hex'), state: 'running', step: '', log: [], error: null, result: null };
  const say = (step) => { job.step = step; job.log.push(step); };
  jobs.set(job.id, job);
  (async () => {
    try {
      job.result = await run(job, say);
      job.state = 'done';
    } catch (e) {
      job.state = 'failed';
      job.error = e.message;
      say(`Failed: ${e.message}`);
      log('error', `marketplace install failed: ${e.message}`);
    }
    setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000).unref?.();
  })();
  return job;
}

router.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'no such job' });
  res.json({ success: true, job });
});

// Downloads `f` into `dir`, checking its SHA-256 (and size) on the way.
async function downloadChecked(f, dir, onProgress, { allowUnverified = false } = {}) {
  const name = homebrewFileName(f);
  const dest = path.join(dir, name);
  // A curated listing always pins a checksum. A catalog entry often does
  // not, and the caller has to say out loud that it accepts that.
  if (!f.sha256 && !allowUnverified) throw new Error(`${name} has no checksum to check it against`);
  if (fs.existsSync(dest) && f.sha256) {
    const have = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    if (have === f.sha256) return dest;
  }
  fs.mkdirSync(dir, { recursive: true });
  const r = await fetch(f.url, { redirect: 'follow', signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (!r.ok || !r.body) throw new Error(`download of ${name} failed: HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || f.size || 0;
  const hash = crypto.createHash('sha256');
  let got = 0;
  const tmp = `${dest}.part`;
  await pipeline(
    Readable.fromWeb(r.body),
    new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        got += chunk.length;
        onProgress?.(got, total);
        cb(null, chunk);
      },
    }),
    fs.createWriteStream(tmp),
  );
  const sum = hash.digest('hex');
  if ((f.sha256 && sum !== f.sha256) || (f.sha256 && f.size && got !== f.size)) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${name} is not the file the marketplace lists (checksum ${sum.slice(0, 12)}…) - not installing it`);
  }
  fs.renameSync(tmp, dest);
  return dest;
}

// This server's address as the console sees it.
function localAddressTowards(ip, port) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: ip, port });
    s.setTimeout(3000, () => { s.destroy(); reject(new Error(`the console does not answer on port ${port}`)); });
    s.once('connect', () => { const a = s.localAddress; s.destroy(); resolve(a.replace(/^::ffff:/, '')); });
    s.once('error', () => reject(new Error(`nothing answers on ${ip}:${port}`)));
  });
}

// The Remote Package Installer fetches a .pkg itself, over HTTP, from here.
router.get('/pkg/:token/:name', (req, res) => {
  const link = pkgLinks.get(req.params.token);
  if (!link || link.until < Date.now() || path.basename(link.file) !== req.params.name) {
    return res.status(404).json({ error: 'no such package' });
  }
  res.sendFile(link.file);
});

async function rpi(ip, endpoint, body) {
  const r = await fetch(`http://${ip}:${RPI_PORT}/api/${endpoint}`, {
    method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error(`Remote Package Installer answered: ${text.slice(0, 200)}`); }
  if (data.status && data.status !== 'success') throw new Error(`Remote Package Installer: ${data.error || data.status}`);
  return data;
}

async function installPs4Pkg(ip, file, say) {
  const local = await localAddressTowards(ip, RPI_PORT).catch(() => {
    throw new Error(`Remote Package Installer is not open on the PS4 (${ip}:${RPI_PORT}) - start it from the home screen (GoldHEN), then try again`);
  });
  const token = crypto.randomBytes(12).toString('hex');
  pkgLinks.set(token, { file, until: Date.now() + 6 * 60 * 60 * 1000 });
  const url = `http://${local}:${PORT}/api/store/pkg/${token}/${encodeURIComponent(path.basename(file))}`;
  say(`Asking the PS4 to install ${path.basename(file)}`);
  const started = await rpi(ip, 'install', { type: 'direct', packages: [url] });
  const taskId = started.task_id;
  if (!taskId) return { queued: true };
  for (let i = 0; i < 3600; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let p;
    try { p = await rpi(ip, 'get_task_progress', { task_id: taskId }); } catch (_) { continue; }
    const total = Number(p.length || p.length_total || 0);
    const done = Number(p.transferred || p.transferred_total || 0);
    if (total) say(`Installing on the PS4: ${Math.floor((done / total) * 100)} %`);
    if (p.error && Number(p.error) !== 0) throw new Error(`the PS4 reported error ${p.error}`);
    if (total && done >= total) return { installed: true };
  }
  return { queued: true };
}

async function installHomebrew(kind, id, profileId) {
  const item = await storeItem(kind, id);
  const needsConsole = item.files.some((f) => f.type === 'pkg');
  let profile = null;
  if (needsConsole) {
    profile = getRepo().queryOne('SELECT id, name, ip_address, console_type FROM profiles WHERE id = ?', [parseInt(profileId, 10)]);
    if (!profile?.ip_address) throw Object.assign(new Error('pick the console to install it on'), { status: 400 });
    if ((profile.console_type || 'ps5') !== item.console_type) {
      throw Object.assign(new Error(`this is a ${item.console_type.toUpperCase()} app and ${profile.name} is not one`), { status: 400 });
    }
  }
  const job = newJob(async (j, say) => {
    const dir = path.join(downloadsDir, 'store', item.id);
    const done = [];
    for (const f of item.files) {
      const name = homebrewFileName(f);
      say(`Downloading ${name}`);
      const file = await downloadChecked(f, dir, (got, total) => {
        j.step = total ? `Downloading ${name}: ${Math.floor((got / total) * 100)} %` : `Downloading ${name}: ${(got / 1e6).toFixed(1)} MB`;
      });
      if (f.type === 'pkg') {
        if (item.console_type === 'ps5') {
          say(`Adding ${name} to the install queue`);
          const r = await fetch(`${API}/convert/install/queue`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: profile.ip_address, source_kind: 'local', local_path: file }),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || `install queue answered ${r.status}`);
          done.push(`${name}: in the install queue (File Ops → Tasks)`);
        } else {
          await installPs4Pkg(profile.ip_address, file, say);
          done.push(`${name}: installed on ${profile.name}`);
        }
      } else {
        const dest = path.join(payloadsDir, name);
        fs.mkdirSync(payloadsDir, { recursive: true });
        fs.copyFileSync(file, dest);
        insertPayload({ name, filename: name, filepath: dest, source_url: f.url, size: fs.statSync(dest).size, version: item.app_version, console_type: item.console_type });
        done.push(`${name}: in the payload library`);
      }
    }
    getRepo().run(
      `INSERT INTO store_installs (kind, store_id, version, name, data, local_id) VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(kind, store_id) DO UPDATE SET version = excluded.version, name = excluded.name, data = excluded.data,
         installed_at = CURRENT_TIMESTAMP`,
      [kind, item.id, item.version, item.name, JSON.stringify(encodeCatalog(item))],
    );
    getRepo().save();
    log('info', `marketplace: installed homebrew "${item.name}" ${item.app_version || ''} (${done.join('; ')})`);
    say(done.join(' · '));
    return { done };
  });
  return { job };
}

// ---------- installing a package a catalog listed ----------

// Catalog rows live in the readers' caches, so an install resolves the
// same row the list showed instead of trusting what the browser sends.
async function findCatalogItem(origin, id, platform) {
  if (origin === 'fpkgi') {
    for (const category of FPKGI_CATEGORIES) {
      const data = await fpkgiCatalog.read(platform, category.id, {});
      const row = data.items.find((i) => i.id === id);
      if (row) return decorateCatalogRows([row], { origin, author: 'FPKGi Catalog Hub' })[0];
    }
    throw Object.assign(new Error('that package is no longer in the catalog'), { status: 404 });
  }
  const sourceId = /^source:(\d+)$/.exec(origin)?.[1];
  if (!sourceId) throw Object.assign(new Error('unknown catalog'), { status: 400 });
  const result = await readSource(sourceById(sourceId));
  const item = result.items.find((i) => i.id === id);
  if (!item) throw Object.assign(new Error('that package is no longer in the source'), { status: 404 });
  return item;
}

router.post('/install-catalog', handle(async (req) => {
  const { origin, id, profileId } = req.body || {};
  const profile = getRepo().queryOne('SELECT id, name, ip_address, console_type FROM profiles WHERE id = ?', [Number(profileId)]);
  if (!profile?.ip_address) throw Object.assign(new Error('pick the console to install it on'), { status: 400 });
  const platform = profile.console_type || 'ps5';
  const item = await findCatalogItem(String(origin), String(id), platform);
  if (!item.installable) throw Object.assign(new Error('this listing has no package this app can install'), { status: 400 });
  if (item.console_type && item.console_type !== platform) {
    throw Object.assign(new Error(`this is a ${item.console_type.toUpperCase()} package and ${profile.name} is not one`), { status: 400 });
  }
  // A catalog rarely pins a checksum. Installing anyway is the user's call,
  // and it is theirs to make explicitly.
  if (!item.verified && req.body?.acknowledgeUnverified !== true) {
    throw Object.assign(new Error('this package has no checksum; confirm that you want to install it unverified'), { status: 428 });
  }
  const name = `${(item.title_id || item.id)}.pkg`;
  const job = newJob(async (j, say) => {
    say(`Downloading ${item.name}`);
    const file = await downloadChecked(
      { url: item.package_url, name, size: item.size || 0, sha256: item.sha256 || null },
      path.join(downloadsDir, 'store', 'catalog'),
      (got, total) => { j.step = total ? `Downloading ${item.name}: ${Math.floor((got / total) * 100)} %` : `Downloading ${item.name}: ${(got / 1e6).toFixed(1)} MB`; },
      { allowUnverified: !item.verified },
    );
    let done;
    if (platform === 'ps5') {
      say(`Adding ${item.name} to the install queue`);
      const r = await fetch(`${API}/convert/install/queue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: profile.ip_address, source_kind: 'local', local_path: file }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `install queue answered ${r.status}`);
      done = `${item.name}: in the install queue (File Ops → Tasks)`;
    } else {
      await installPs4Pkg(profile.ip_address, file, say);
      done = `${item.name}: installed on ${profile.name}`;
    }
    getRepo().run(
      `INSERT INTO store_installs (kind, store_id, version, name, data, local_id) VALUES ('catalog', ?, 1, ?, ?, NULL)
       ON CONFLICT(kind, store_id) DO UPDATE SET name = excluded.name, data = excluded.data, installed_at = CURRENT_TIMESTAMP`,
      [`${item.origin}:${item.id}`, item.name, JSON.stringify(encodeCatalog(item))],
    );
    getRepo().save();
    log('info', `marketplace: installed ${item.verified ? '' : 'unverified '}catalog package "${item.name}" from ${item.origin} (${done})`);
    say(done);
    return { done: [done] };
  });
  return { job, unverified: !item.verified };
}));

export default router;
