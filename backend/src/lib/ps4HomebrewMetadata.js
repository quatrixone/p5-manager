// Supplemental PS4 app metadata. This source never authorizes downloads:
// installable listings still come from the reviewed SHA-256-pinned store items.
import fs from 'node:fs';
import path from 'node:path';
import { internalDataDir } from './paths.js';
import { iconUrl } from './homebrewIcons.js';
const SOURCE = process.env.P5M_PS4_HOMEBREW_URL || 'https://raw.githubusercontent.com/Dinos17/FPKGi-Catalog-Hub/main/ps4/homebrew.json';
const target = path.join(internalDataDir, 'marketplace', 'ps4-homebrew-metadata.json');
const TTL = 60 * 60 * 1000;
let cache = null, checked = 0, pending = null, warning = null;
export function parsePs4HomebrewMetadata(data) {
  if (!data?.DATA || typeof data.DATA !== 'object' || Array.isArray(data.DATA)) throw new Error('Invalid PS4 homebrew catalog');
  return Object.values(data.DATA).filter(row => row && typeof row.name === 'string' && /^[A-Z0-9]{9}$/.test(row.title_id || '')).map(row => ({
    id: row.title_id, name: row.name, icon: iconUrl(row.cover_url), console_type: 'ps4',
    version: typeof row.version === 'string' ? row.version : null,
    min_fw: typeof row.min_fw === 'string' ? row.min_fw : null,
  }));
}
export async function ps4HomebrewMetadata({ refresh = false } = {}) {
  if (!cache) {
    try { const stored = JSON.parse(fs.readFileSync(target, 'utf8')); cache = Array.isArray(stored) ? stored : []; } catch { cache = []; }
  }
  if (refresh || Date.now() - checked > TTL) {
    if (!pending) pending = (async () => {
      try {
        const response = await fetch(SOURCE, { signal: AbortSignal.timeout(5000) });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 1024 * 1024) throw new Error('PS4 metadata catalog is too large');
          chunks.push(Buffer.from(chunk));
        }
        const rows = parsePs4HomebrewMetadata(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(`${target}.tmp`, JSON.stringify(rows)); fs.renameSync(`${target}.tmp`, target);
        cache = rows; warning = null;
      } catch (e) { warning = `PS4 homebrew metadata unavailable: ${e.message}`; }
      finally { checked = Date.now(); }
    })().finally(() => { pending = null; });
    await pending;
  }
  return { rows: cache, warning };
}
