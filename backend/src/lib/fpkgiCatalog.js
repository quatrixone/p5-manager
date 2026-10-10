// Independent reader for the public FPKGi Catalog Hub. Package references
// are external listings, not SHA-256-pinned, reviewed Marketplace installs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { internalDataDir } from './paths.js';
import { encodeCatalog, decodeCatalog } from './catalogLinks.js';

export const FPKGI_REPO = 'https://github.com/Dinos17/FPKGi-Catalog-Hub';
export const FPKGI_CATEGORIES = [
  ['games', 'Games'], ['apps', 'Applications'], ['updates', 'Game updates'],
  ['dlc', 'DLC'], ['demos', 'Demos'], ['homebrew', 'Homebrew'],
  ['emulators', 'Emulators'], ['themes', 'Themes'], ['ps1', 'PS1'],
  ['ps2', 'PS2'], ['psp', 'PSP'],
].map(([id, label]) => ({ id, label }));
export function catalogPath(platform, category) {
  if (!['ps4', 'ps5'].includes(platform) || !FPKGI_CATEGORIES.some(c => c.id === category)) throw Object.assign(new Error('Unknown platform or catalog category'), { status: 400 });
  if (platform === 'ps4' || ['ps1', 'ps2'].includes(category)) return `ps4/${category}.json`;
  return category === 'psp' ? 'ps5/psp.json' : `ps5/ps5-${category}.json`;
}
export function externalUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}
const text = (v, max = 500) => typeof v === 'string' && v.trim() ? v.slice(0, max) : null;
export function parseFpkgiCatalog(data, platform, category) {
  const source = catalogPath(platform, category);
  if (!data?.DATA || typeof data.DATA !== 'object' || Array.isArray(data.DATA)) throw new Error('Invalid FPKGi catalog DATA');
  if (Object.keys(data.DATA).length > 100_000) throw new Error('FPKGi catalog has too many entries');
  return Object.entries(data.DATA).filter(([, row]) => row && typeof row === 'object' && !Array.isArray(row)).map(([url, row]) => ({
    id: createHash('sha256').update(`${source}\n${url}`).digest('hex').slice(0, 24),
    name: text(row.name, 300) || text(row.title_id, 80) || 'Unnamed package',
    title_id: text(row.title_id, 80), version: text(row.version, 80),
    region: text(row.region, 80), min_fw: text(row.min_fw, 80), release: text(row.release, 200),
    size: Number.isSafeInteger(row.size) && row.size > 0 ? row.size : null,
    icon: externalUrl(row.cover_url), package_url: externalUrl(url),
    sha256: typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(row.sha256) ? row.sha256.toLowerCase() : null,
    category, console_type: platform, source_path: source,
  }));
}

export function createFpkgiCatalog({ baseUrl = process.env.P5M_FPKGI_CATALOG_URL || 'https://raw.githubusercontent.com/Dinos17/FPKGi-Catalog-Hub/main/', cacheDir = path.join(internalDataDir, 'marketplace', 'fpkgi'), fetchImpl = fetch, now = Date.now } = {}) {
  const base = baseUrl.replace(/\/?$/, '/');
  const cache = new Map(), pending = new Map();
  const ttl = 15 * 60 * 1000;
  async function read(platform, category, { refresh = false } = {}) {
    const source = catalogPath(platform, category), key = `${platform}-${category}`;
    const file = path.join(cacheDir, `${key}.json`);
    if (!cache.has(key)) {
      let entry = { items: [], fetchedAt: null, checked: -Infinity, warning: null };
      try {
        const stored = decodeCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
        entry.items = parseFpkgiCatalog(stored.data, platform, category); entry.fetchedAt = stored.fetchedAt || null;
      } catch { /* First run requires network. */ }
      cache.set(key, entry);
    }
    if (refresh || now() - cache.get(key).checked >= ttl) {
      if (!pending.has(key)) pending.set(key, (async () => {
        const entry = cache.get(key);
        try {
          const response = await fetchImpl(`${base}${source}`, { signal: AbortSignal.timeout(15_000) });
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
          const chunks = []; let bytes = 0;
          for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new Error('Catalog exceeds 32 MiB'); chunks.push(Buffer.from(chunk)); }
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const items = parseFpkgiCatalog(data, platform, category);
          const fetchedAt = new Date(now()).toISOString();
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(`${file}.tmp`, JSON.stringify(encodeCatalog({ fetchedAt, data })));
          fs.renameSync(`${file}.tmp`, file);
          Object.assign(entry, { items, fetchedAt, warning: null });
        } catch (e) { entry.warning = `FPKGi catalog unavailable: ${e.message}`; }
        finally { entry.checked = now(); }
      })().finally(() => pending.delete(key)));
      await pending.get(key);
    }
    const entry = cache.get(key);
    return { ...entry, sourceUrl: `${FPKGI_REPO}/blob/main/${source}`, sharedCatalog: source.startsWith('ps4/') && platform === 'ps5' };
  }
  return { read };
}
export const fpkgiCatalog = createFpkgiCatalog();

export function catalogPage(catalog, { query = '', page = 1, limit = 48 } = {}) {
  const q = String(query).trim().toLowerCase().slice(0, 200);
  limit = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 48));
  const items = catalog.items.filter(i => !q || `${i.name} ${i.title_id || ''} ${i.region || ''} ${i.version || ''}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(items.length / limit));
  page = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  return { items: items.slice((page - 1) * limit, page * limit), total: items.length, catalogTotal: catalog.items.length, page, pages, limit,
    fetchedAt: catalog.fetchedAt, warning: catalog.warning, sourceUrl: catalog.sourceUrl, sharedCatalog: catalog.sharedCatalog };
}
