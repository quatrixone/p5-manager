// Homebrew Store's public SQLite catalog uses homebrews.main_icon_path.
// Only icon metadata is consumed: Marketplace downloads keep pinned hashes.
import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { internalDataDir } from './paths.js';

const SOURCE = process.env.P5M_HOMEBREW_CATALOG_URL || 'https://api.pkg-zone.com/store.db';
const cacheFile = path.join(internalDataDir, 'marketplace', 'homebrew-icons.json');
const TTL = 60 * 60 * 1000;
const MAX_BYTES = 16 * 1024 * 1024;
let cache = null;
let checked = 0;
let pending;
let warning = null;

export function iconUrl(value) {
  try {
    const url = new URL(value);
    // Legacy catalog icons used http; upgrade known Homebrew Store hosts.
    if (url.protocol === 'http:' && ['api.pkg-zone.com', 'pkg-zone.com'].includes(url.hostname)) url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
const normalized = name => String(name || '').toLowerCase().replace(/\.(pkg|elf|bin|lua)$/i, '').replace(/[^a-z0-9]/g, '');

export function matchHomebrewIcon(item, rows) {
  if (item.icon) return iconUrl(item.icon);
  if (!['homebrew', 'payload'].includes(item.kind)) return null;
  rows = rows.filter(row => !row.console_type || row.console_type === item.console_type);
  let matches = item.homebrew_id
    ? rows.filter(row => row.id === item.homebrew_id)
    : rows.filter(row => normalized(row.name) === normalized(item.name));
  if (matches.length > 1 && item.homebrew_id) matches = matches.filter(row => normalized(row.name) === normalized(item.name));
  // Never guess between similarly named apps or platforms.
  return matches.length === 1 ? iconUrl(matches[0].icon) : null;
}

async function readSource() {
  const response = await fetch(SOURCE, { signal: AbortSignal.timeout(5000) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('Homebrew Store icon catalog is too large');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw new Error('Homebrew Store did not return its SQLite catalog');
  const SQL = await initSqlJs();
  const db = new SQL.Database(bytes);
  try {
    const result = db.exec('SELECT id, name, main_icon_path FROM homebrews')[0];
    return (result?.values || []).map(([id, name, icon]) => ({ id, name, icon: iconUrl(icon) })).filter(row => row.icon);
  } finally { db.close(); }
}

export async function homebrewIcons({ refresh = false } = {}) {
  if (!cache) {
    try {
      const stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      cache = Array.isArray(stored) ? stored.filter(row => row && typeof row.name === 'string' && iconUrl(row.icon)) : [];
    } catch { cache = []; }
  }
  if (refresh || Date.now() - checked > TTL) {
    if (!pending) pending = (async () => {
      try {
        const rows = await readSource();
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(rows));
        fs.renameSync(`${cacheFile}.tmp`, cacheFile);
        cache = rows;
        warning = null;
      } catch (error) { warning = `Homebrew Store icons unavailable: ${error.message}`; }
      finally { checked = Date.now(); }
    })().finally(() => { pending = null; });
    await pending;
  }
  return { rows: cache, warning };
}
