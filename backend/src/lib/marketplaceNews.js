import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { encodeCatalog, decodeCatalog } from './catalogLinks.js';
export const NEWS_INTERVAL_MS = 15 * 60 * 1000;
// Snapshots written before the baseline rule marked the whole catalogue as
// newly discovered on their first check. A snapshot without this number is
// rebaselined once, so New says what has happened since, not what exists.
export const NEWS_SCHEMA = 2;

// Successful sources replace their snapshots; unavailable sources retain
// their last entries. Each item keeps its latest observed change across restarts.
export function createMarketplaceNews({ file, collect, now = Date.now, knownSource = () => true }) {
  let records = {}, checkedAt = null, warnings = [], pending = null, started = false, pruned = false, baseline = true;
  function persist(recordsToSave, at, warns) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(encodeCatalog({ schema: NEWS_SCHEMA, records: recordsToSave, checkedAt: at, warnings: warns })));
    fs.renameSync(`${file}.tmp`, file);
  }
  try {
    const saved = decodeCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (saved.records && typeof saved.records === 'object' && !Array.isArray(saved.records)) {
      // A source we no longer collect would otherwise keep its entries for
      // ever, because only its own refresh can replace them.
      records = Object.fromEntries(Object.entries(saved.records).filter(([, r]) => knownSource(r?.sourceKey)));
      baseline = false;
      pruned = Object.keys(records).length !== Object.keys(saved.records).length;
      if (saved.schema !== NEWS_SCHEMA) {
        // Keep when each entry was first seen; drop only the claim that it
        // is news.
        records = Object.fromEntries(Object.entries(records).map(([k, r]) => [k, { ...r, event: 'seen' }]));
        pruned = true;
      }
    }
    checkedAt = Number.isFinite(saved.checkedAt) ? saved.checkedAt : null;
    warnings = Array.isArray(saved.warnings) ? saved.warnings.filter(w => typeof w === 'string') : [];
  } catch { /* No previous snapshot. */ }
  if (pruned) try { persist(records, checkedAt, warnings); } catch { /* A read-only data directory prunes again next start. */ }
  async function refresh({ force = false } = {}) {
    started = true;
    if (pending) return pending;
    if (!force && checkedAt !== null && now() - checkedAt < NEWS_INTERVAL_MS) return;
    pending = (async () => {
      const sources = await collect();
      const at = now(), next = { ...records };
      warnings = sources.flatMap(s => s.warning ? [`${s.label || s.key}: ${s.warning}`] : []);
      for (const source of sources) {
        if (!Array.isArray(source.items) || source.warning) continue;
        const present = new Set();
        for (const item of source.items) {
          const key = `${source.key}:${item.id}`;
          present.add(key);
          const fingerprint = createHash('sha256').update(JSON.stringify(item)).digest('hex');
          const old = records[key];
          next[key] = { sourceKey: source.key, item, fingerprint,
            event: !old ? (baseline ? 'seen' : 'new') : fingerprint !== old.fingerprint ? 'updated' : old.event,
            detectedAt: !old || fingerprint !== old.fingerprint ? at : old.detectedAt };
        }
        for (const [key, record] of Object.entries(next)) if (record.sourceKey === source.key && !present.has(key)) delete next[key];
      }
      persist(next, at, warnings);
      records = next; checkedAt = at; baseline = false;
    })().finally(() => { pending = null; });
    return pending;
  }
  async function page({ force = false, platform = 'ps4', query = '', event = 'all', page = 1, limit = 48, isPendingUpdate = () => false } = {}) {
    await refresh({ force });
    const q = String(query).trim().toLowerCase().slice(0, 200);
    const list = Object.entries(records).map(([id, r]) => ({ ...r.item, newsId: id, event: r.event, detectedAt: r.detectedAt }))
      .filter(i => !i.console_type || i.console_type === platform)
      // An item already installed with a newer version in the catalogue is
      // an update whatever the feed last saw happen to it.
      .map(i => (i.event !== 'new' && isPendingUpdate(i) ? { ...i, event: 'updated' } : i))
      .filter(i => i.event === 'new' || i.event === 'updated')
      .filter(i => event === 'all' || i.event === event)
      .filter(i => !q || `${i.name} ${i.author || ''} ${i.title_id || ''} ${i.category || i.kind}`.toLowerCase().includes(q))
      .sort((a, b) => b.detectedAt - a.detectedAt || a.newsId.localeCompare(b.newsId));
    limit = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 48));
    const pages = Math.max(1, Math.ceil(list.length / limit));
    page = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
    return { items: list.slice((page - 1) * limit, page * limit), total: list.length, page, pages,
      checkedAt, nextCheckAt: checkedAt === null ? null : checkedAt + NEWS_INTERVAL_MS, intervalMs: NEWS_INTERVAL_MS, warnings };
  }
  return { refresh, page, hasStarted: () => started };
}
