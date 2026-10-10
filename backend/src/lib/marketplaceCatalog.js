// Shared marketplace transport. Curated macros are data fetched at runtime,
// never shipped in the frontend or Docker image. Last good data works offline.
import fs from 'node:fs';
import path from 'node:path';
import { internalDataDir } from './paths.js';
import { encodeCatalog, decodeCatalog } from './catalogLinks.js';
import { STORE_REPO, STORE_BRANCH } from './storeItem.js';
import { validateSequenceSteps } from './sequenceChecks.js';

export const STORE_BASE = (process.env.P5M_STORE_URL || `https://raw.githubusercontent.com/${STORE_REPO}/${STORE_BRANCH}/store/`).replace(/\/?$/, '/');
export const MARKETPLACE_BUILTINS = new Set(['inputScripts.json', 'templates.json']);
const dir = path.join(internalDataDir, 'marketplace');
const pending = new Map();
const checked = new Map();
const TTL = 10 * 60 * 1000;

export async function fetchCatalogJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw Object.assign(new Error(`the marketplace answered ${r.status}`), { status: 502 });
  return decodeCatalog(await r.json());
}

function file(name) {
  if (!MARKETPLACE_BUILTINS.has(name)) throw new Error('Unknown marketplace catalog');
  return path.join(dir, name);
}
function atomicWrite(target, data) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(encodeCatalog(data), null, 2) + '\n');
  fs.renameSync(tmp, target);
}
export function validateBuiltinCatalog(name, list) {
  if (!Array.isArray(list) || list.length > 200) throw new Error('Invalid marketplace built-in catalog');
  const ids = new Set();
  if (!MARKETPLACE_BUILTINS.has(name)) throw new Error('Unknown marketplace catalog');
  for (const entry of list) {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || typeof entry.name !== 'string') throw new Error('Invalid or duplicate marketplace built-in id');
    if (name === 'inputScripts.json' && (!/^builtin:[a-z0-9-]+$/.test(entry.id) || typeof entry.script !== 'string' || !entry.script.trim() || entry.script.length > 20000)) throw new Error('Invalid marketplace input script');
    if (name === 'templates.json' && (!Array.isArray(entry.steps) || !entry.steps.length)) throw new Error('Invalid marketplace template');
    if (name === 'templates.json') {
      if (!/^tpl-[a-z0-9-]+$/.test(entry.id)) throw new Error('Invalid marketplace template id');
      validateSequenceSteps(entry.steps);
    }
    if (entry.console_type && !['ps4', 'ps5'].includes(entry.console_type)) throw new Error('Invalid marketplace platform');
    ids.add(entry.id);
  }
  return list;
}

export async function readMarketplaceBuiltinList(name, { refresh = false } = {}) {
  const target = file(name);
  if (refresh || !fs.existsSync(target) || Date.now() - (checked.get(name) || 0) > TTL) {
    if (!pending.has(name)) pending.set(name, (async () => {
      try {
        const list = validateBuiltinCatalog(name, await fetchCatalogJson(`${STORE_BASE}builtin/${name}`));
        atomicWrite(target, list);
      } catch (error) {
        if (refresh || !fs.existsSync(target)) throw error;
      } finally { checked.set(name, Date.now()); }
    })().finally(() => pending.delete(name)));
    await pending.get(name);
  }
  const list = validateBuiltinCatalog(name, decodeCatalog(JSON.parse(fs.readFileSync(target, 'utf8'))));
  const overrides = readOverrides(name);
  return list.map(entry => overrides[entry.id] ? { ...entry, ...overrides[entry.id] } : entry);
}
function readOverrides(name) {
  const target = `${file(name)}.overrides`;
  return fs.existsSync(target) ? decodeCatalog(JSON.parse(fs.readFileSync(target, 'utf8'))) : {};
}
export async function writeMarketplaceBuiltinList(name, list) {
  validateBuiltinCatalog(name, list);
  await readMarketplaceBuiltinList(name);
  const base = decodeCatalog(JSON.parse(fs.readFileSync(file(name), 'utf8')));
  const overrides = {};
  // Store only changed fields, so upstream updates still reach unedited fields.
  for (const entry of list) {
    const original = base.find(e => e.id === entry.id);
    if (!original) throw new Error('Create new scripts in My Scripts or publish them to Marketplace');
    const changed = Object.fromEntries(Object.entries(entry).filter(([k, v]) => k !== 'id' && k !== 'store' && JSON.stringify(v) !== JSON.stringify(original[k])));
    if (Object.keys(changed).length) overrides[entry.id] = changed;
  }
  if (list.length !== base.length) throw new Error('Remove curated items through Marketplace, not the catalog editor');
  const target = `${file(name)}.overrides`;
  if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`);
  else atomicWrite(`${target}.bak`, {});
  atomicWrite(target, overrides);
}
export function restoreMarketplaceBuiltinBackup(name) {
  const target = `${file(name)}.overrides`;
  if (!fs.existsSync(`${target}.bak`)) throw Object.assign(new Error('No backup available'), { status: 404 });
  fs.copyFileSync(`${target}.bak`, target);
}
