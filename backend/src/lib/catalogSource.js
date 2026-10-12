// Catalogs the user points us at. The Marketplace reads its own curated
// index and the FPKGi Catalog Hub through the same shape, so a source
// added here behaves like the ones that ship with the app: fetched on a
// timer, cached on disk, and never able to take the list down with it.
import fs from 'node:fs';
import path from 'node:path';
import { internalDataDir } from './paths.js';
import { encodeCatalog, decodeCatalog } from './catalogLinks.js';
import { parseFpkgiRows, externalUrl } from './fpkgiCatalog.js';

export const SOURCE_KINDS = new Set(['script', 'template', 'homebrew', 'payload']);
const MAX_ITEMS = 2000;
const bad = (message) => Object.assign(new Error(message), { status: 400 });

// A source is a URL we fetch unattended, so it has to be plain https: no
// credentials to leak into a log, no file:// to read the server's disk.
export function normalizeSourceUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw bad('The source has to be an https URL'); }
  if (url.protocol !== 'https:') throw bad('The source has to be an https URL');
  if (url.username || url.password) throw bad('An https URL with a username or password cannot be a source');
  if (url.href.length > 2048) throw bad('The source URL is too long');
  return url.href;
}

export function detectSourceFormat(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (data.DATA && typeof data.DATA === 'object' && !Array.isArray(data.DATA)) return 'fpkgi';
    if (Array.isArray(data.items)) return 'store';
  }
  throw bad('Not a catalog: expected an FPKGi file with DATA, or a P5 Manager index with items');
}

const slug = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v);

// One shape for every origin, so the card does not have to know where an
// item came from - only what it may do with it.
function storeItems(data, source, origin) {
  if (data.items.length > MAX_ITEMS) throw bad(`A catalog may list at most ${MAX_ITEMS} items`);
  return data.items.map((item) => {
    if (!item || typeof item !== 'object') throw bad('A catalog item has to be an object');
    if (!SOURCE_KINDS.has(item.kind)) throw bad(`Unknown item kind "${item.kind}"`);
    if (!slug(item.id)) throw bad(`Unusable item id "${item.id}"`);
    if (typeof item.name !== 'string' || !item.name.trim()) throw bad('A catalog item needs a name');
    if (!Number.isSafeInteger(item.version) || item.version < 1) throw bad(`Item "${item.id}" has no usable version`);
    if (item.console_type && !['ps4', 'ps5'].includes(item.console_type)) throw bad(`Item "${item.id}" names an unknown console`);
    return {
      ...item,
      name: item.name.slice(0, 300),
      description: typeof item.description === 'string' ? item.description.slice(0, 2000) : '',
      author: typeof item.author === 'string' ? item.author.slice(0, 200) : 'Unknown',
      console_type: item.console_type || source.console_type || null,
      origin,
      // Curated-shaped items are fetched whole before anything is written,
      // and that fetch checks the listed checksum.
      installable: true,
      verified: true,
    };
  });
}

// Catalog rows as the Marketplace list wants them, whether they came from
// the FPKGi hub or from a source the user added.
export function decorateCatalogRows(rows, { origin, author = 'Catalog' }) {
  return rows.map((row) => ({
    ...row,
    kind: 'catalog',
    origin,
    description: row.title_id ? `${row.title_id}${row.region ? ` · ${row.region}` : ''}` : '',
    author,
    // Only a .pkg is something this app can put on a console; anything else
    // in a catalog stays a link.
    installable: !!row.package_url && /\.pkg$/i.test(new URL(row.package_url).pathname),
    verified: !!row.sha256,
  }));
}

function catalogItems(data, source, origin) {
  return decorateCatalogRows(
    parseFpkgiRows(data, { source: origin, console_type: source.console_type || null }),
    { origin, author: source.name || 'Catalog' },
  );
}

export function parseSourceCatalog(data, source) {
  const origin = `source:${source.id}`;
  return detectSourceFormat(data) === 'fpkgi' ? catalogItems(data, source, origin) : storeItems(data, source, origin);
}

export function createCatalogSource({
  cacheDir = path.join(internalDataDir, 'marketplace', 'sources'),
  fetchImpl = fetch,
  now = Date.now,
  ttl = 15 * 60 * 1000,
  maxBytes = 32 * 1024 * 1024,
} = {}) {
  const cache = new Map(), pending = new Map();

  async function download(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`the catalog exceeds ${Math.round(maxBytes / 1024 / 1024)} MiB`);
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function read(source, { refresh = false } = {}) {
    const key = String(source.id);
    const file = path.join(cacheDir, `${key}.json`);
    if (!cache.has(key)) {
      const entry = { items: [], fetchedAt: null, checked: -Infinity, warning: null };
      try {
        const stored = decodeCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (stored.url === source.url) {
          entry.items = parseSourceCatalog(stored.data, source);
          entry.fetchedAt = stored.fetchedAt || null;
        }
      } catch { /* No usable copy yet: the first read needs the network. */ }
      cache.set(key, entry);
    }
    const entry = cache.get(key);
    if (refresh || now() - entry.checked >= ttl) {
      if (!pending.has(key)) pending.set(key, (async () => {
        try {
          const data = await download(normalizeSourceUrl(source.url));
          const items = parseSourceCatalog(data, source);
          const fetchedAt = new Date(now()).toISOString();
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(`${file}.tmp`, JSON.stringify(encodeCatalog({ url: source.url, fetchedAt, data })));
          fs.renameSync(`${file}.tmp`, file);
          Object.assign(entry, { items, fetchedAt, warning: null });
        } catch (e) {
          // Keep whatever we last read: a source that is down should cost
          // the user a warning, not their list.
          entry.warning = `${source.name || source.url} unavailable: ${e.message}`;
        } finally { entry.checked = now(); }
      })().finally(() => pending.delete(key)));
      await pending.get(key);
    }
    return { items: entry.items, fetchedAt: entry.fetchedAt, warning: entry.warning };
  }

  return { read, forget: (id) => cache.delete(String(id)) };
}

export const catalogSources = createCatalogSource();
export { externalUrl };
