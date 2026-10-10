import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { encodeCatalog, decodeCatalog } from './catalogLinks.js';
export const NEWS_INTERVAL_MS = 15 * 60 * 1000;

// Successful sources replace their snapshots; unavailable sources retain
// their last entries. Each item keeps its latest observed change across restarts.
export function createMarketplaceNews({ file, collect, now = Date.now }) {
  let records = {}, checkedAt = null, warnings = [], pending = null, started = false;
  try {
    const saved = decodeCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (saved.records && typeof saved.records === 'object' && !Array.isArray(saved.records)) records = saved.records;
    checkedAt = Number.isFinite(saved.checkedAt) ? saved.checkedAt : null;
    warnings = Array.isArray(saved.warnings) ? saved.warnings.filter(w => typeof w === 'string') : [];
  } catch { /* No previous snapshot. */ }
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
            event: !old ? 'new' : fingerprint !== old.fingerprint ? 'updated' : old.event,
            detectedAt: !old || fingerprint !== old.fingerprint ? at : old.detectedAt };
        }
        for (const [key, record] of Object.entries(next)) if (record.sourceKey === source.key && !present.has(key)) delete next[key];
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(encodeCatalog({ records: next, checkedAt: at, warnings })));
      fs.renameSync(`${file}.tmp`, file);
      records = next; checkedAt = at;
    })().finally(() => { pending = null; });
    return pending;
  }
  async function page({ force = false, platform = 'ps4', query = '', event = 'all', page = 1, limit = 48 } = {}) {
    await refresh({ force });
    const q = String(query).trim().toLowerCase().slice(0, 200);
    const list = Object.entries(records).map(([id, r]) => ({ ...r.item, newsId: id, event: r.event, detectedAt: r.detectedAt }))
      .filter(i => !i.console_type || i.console_type === platform)
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
