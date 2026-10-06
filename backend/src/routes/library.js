import express from 'express';
import net from 'net';
import { getRepo, log } from '../db/sqlite.js';
import {
  isValidTitleId, isSafeConsoleDir, storageOf, buildVolumes, buildDestinations,
} from '../lib/libraryModel.js';

// Game Library: a thin proxy in front of the ShadowMountPlus HTTP API that
// runs on the console (default port 10101, POST + JSON under /api/v1,
// `status: 0` means OK). The browser never talks to the console directly:
// no CORS / mixed-content trouble, and destructive calls are validated here.
const router = express.Router();

function apiPort() {
  const raw = getRepo().queryScalar("SELECT value FROM settings WHERE key = 'shadowmount_port'");
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 10101;
}

class SmError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function sm(ip, route, body = {}, timeoutMs = 20_000) {
  const port = apiPort();
  let r;
  try {
    r = await fetch(`http://${ip}:${port}/api/v1${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (_) {
    throw new SmError(502, `ShadowMount API is not reachable on ${ip}:${port} - is ShadowMountPlus running on the console?`);
  }
  const data = await r.json().catch(() => null);
  if (!data) throw new SmError(502, `ShadowMount answered HTTP ${r.status} without JSON`);
  if (data.status !== 0) throw new SmError(r.status === 404 ? 404 : 400, data.error || `ShadowMount error ${data.status}`);
  return data;
}

const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });

router.param('ip', (req, res, next, ip) => {
  if (net.isIP(ip) === 0) return res.status(400).json({ error: 'Invalid console address' });
  next();
});
router.param('titleId', (req, res, next, id) => {
  if (!isValidTitleId(id)) return res.status(400).json({ error: 'Invalid title id' });
  next();
});

const iconPath = (ip, g) => {
  const v = /[?&]v=([^&]+)/.exec(g.icon_url || '');
  return g.icon_url ? `/api/library/${ip}/icon/${g.title_id}${v ? `?v=${encodeURIComponent(v[1])}` : ''}` : null;
};

// Everything the page needs in one round trip.
router.get('/:ip/overview', async (req, res) => {
  try {
    const { ip } = req.params;
    const [version, games, storage, job] = await Promise.all([
      sm(ip, '/version'),
      sm(ip, '/games', { include_size: true }),
      sm(ip, '/storage'),
      sm(ip, '/games/storage/status').catch(() => null),
    ]);
    const volumes = buildVolumes(storage.mounts);
    res.json({
      version: version.shadowmount_version,
      capabilities: version.capabilities || [],
      games: (games.games || []).map(g => ({
        ...g,
        icon: iconPath(ip, g),
        storage: storageOf(g.path),
      })),
      volumes,
      destinations: buildDestinations(volumes, storage.destinations),
      job,
    });
  } catch (e) { fail(res, e); }
});

// Icons change only when the title is reinstalled (the URL carries a `v`
// stamp), so they are kept in memory and cached hard by the browser.
const iconCache = new Map(); // key -> Buffer
const ICON_CACHE_MAX = 400;
router.get('/:ip/icon/:titleId', async (req, res) => {
  try {
    const { ip, titleId } = req.params;
    const key = `${ip}|${titleId}|${req.query.v || ''}`;
    let buf = iconCache.get(key);
    if (!buf) {
      const r = await fetch(`http://${ip}:${apiPort()}/api/v1/games/icon?title_id=${titleId}&size=thumb`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) return res.status(404).end();
      buf = Buffer.from(await r.arrayBuffer());
      if (iconCache.size >= ICON_CACHE_MAX) iconCache.delete(iconCache.keys().next().value);
      iconCache.set(key, buf);
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', req.query.v ? 'public, max-age=604800, immutable' : 'public, max-age=300');
    res.end(buf);
  } catch (_) { res.status(404).end(); }
});

router.get('/:ip/job', async (req, res) => {
  try { res.json(await sm(req.params.ip, '/games/storage/status')); } catch (e) { fail(res, e); }
});

router.post('/:ip/job/cancel', async (req, res) => {
  try {
    const jobId = parseInt(req.body?.job_id, 10);
    if (!Number.isFinite(jobId)) return res.status(400).json({ error: 'job_id required' });
    log('info', `library ${req.params.ip}: cancel storage job ${jobId}`);
    res.json(await sm(req.params.ip, '/games/storage/cancel', { job_id: jobId }));
  } catch (e) { fail(res, e); }
});

router.post('/:ip/scan', async (req, res) => {
  try {
    res.json(await sm(req.params.ip, '/scan', { reset_attempts: !!req.body?.reset_attempts }));
  } catch (e) { fail(res, e); }
});

// mount / unmount / uninstall act at once; move / copy / unpack / delete
// start ShadowMount's single storage job (poll /job for progress).
const OPS = new Set(['mount', 'unmount', 'uninstall', 'move', 'copy', 'unpack', 'delete']);
router.post('/:ip/games/:titleId/:op', async (req, res) => {
  try {
    const { ip, titleId, op } = req.params;
    if (!OPS.has(op)) return res.status(400).json({ error: 'Unknown operation' });
    const payload = { title_id: titleId };
    if (op === 'move' || op === 'copy' || op === 'unpack') {
      const dir = String(req.body?.destination_dir || '').replace(/\/+$/, '');
      if (!isSafeConsoleDir(dir)) return res.status(400).json({ error: 'destination_dir must be an absolute path on the console' });
      payload.destination_dir = dir;
      if (op === 'unpack') payload.delete_source = !!req.body?.delete_source;
    }
    if (op === 'delete') {
      // Deletes the game's files for good: the caller has to say so explicitly.
      if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm required' });
      payload.confirm = true;
    }
    log('info', `library ${ip}: ${op} ${titleId}${payload.destination_dir ? ` -> ${payload.destination_dir}` : ''}`);
    res.json(await sm(ip, `/games/${op}`, payload, 60_000));
  } catch (e) { fail(res, e); }
});

export default router;
