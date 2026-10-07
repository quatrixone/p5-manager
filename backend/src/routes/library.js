import express from 'express';
import net from 'net';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Writable } from 'node:stream';
import { Client as FtpClient } from 'basic-ftp';
import { getRepo, log } from '../db/sqlite.js';
import { isLocalPathAllowed } from '../lib/platform.js';
import { tcpPortOpen, sendElfPayload, ELF_LOADER_PORT } from './convert.js';
import { getFtpPort } from '../lib/ftpPort.js';
import { parsePs4Library } from '../lib/ps4Library.js';
import {
  isValidTitleId, isSafeConsoleDir, storageOf, buildVolumes, buildDestinations,
} from '../lib/libraryModel.js';

// Game Library: a thin proxy in front of the ShadowMountPlus HTTP API that
// runs on the console (default port 10101, POST + JSON under /api/v1,
// `status: 0` means OK). The browser never talks to the console directly:
// no CORS / mixed-content trouble, and destructive calls are validated here.
const router = express.Router();

// Short-lived capability URLs let the PS4's Remote Package Installer fetch a
// local PKG from this manager. RPI pulls the file itself, so the browser cannot
// stream the PKG directly to the console. Keep only a random token and a
// validated path; Range requests are supported because RPI may resume reads.
const ps4PkgLinks = new Map();
const PS4_PKG_LINK_TTL_MS = 6 * 60 * 60 * 1000;

function issuePs4PkgLink(filePath) {
  const now = Date.now();
  for (const [token, grant] of ps4PkgLinks) if (grant.expiresAt < now) ps4PkgLinks.delete(token);
  const token = crypto.randomBytes(24).toString('hex');
  ps4PkgLinks.set(token, { filePath, expiresAt: now + PS4_PKG_LINK_TTL_MS });
  return token;
}

function writePkgRange(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  let start = 0;
  let end = stat.size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return res.status(416).end();
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return res.status(416).end();
      start = Math.max(0, stat.size - suffix);
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : end;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    end = Math.min(end, stat.size - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath, { start, end }).on('error', () => res.destroy()).pipe(res);
}

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

// ShadowMountPlus payload from the payload library, newest name first.
function findShadowMountPayload() {
  const rows = getRepo().queryAll(
    "SELECT filename, filepath FROM payloads WHERE lower(filename) LIKE 'shadowmount%.elf'",
  );
  return rows
    .filter(r => r.filepath && fs.existsSync(r.filepath))
    .sort((a, b) => b.filename.localeCompare(a.filename, undefined, { numeric: true }))[0] || null;
}

// Why the API does not answer, so the page can say what to do about it
// instead of a bare "not reachable":
//   offline   nothing answers - console off, in rest mode or not jailbroken
//   stopped   the ELF loader is up but ShadowMount is not running
async function diagnose(ip) {
  const loader = await tcpPortOpen(ip, ELF_LOADER_PORT, 1500);
  return {
    reason: loader ? 'stopped' : 'offline',
    can_start: loader && !!findShadowMountPayload(),
    has_payload: !!findShadowMountPayload(),
  };
}

router.param('ip', (req, res, next, ip) => {
  if (net.isIP(ip) === 0) return res.status(400).json({ error: 'Invalid console address' });
  next();
});
router.param('titleId', (req, res, next, id) => {
  if (!isValidTitleId(id)) return res.status(400).json({ error: 'Invalid title id' });
  next();
});

// Stream a one-time-authorized local PKG to Remote Package Installer. The
// token expires automatically; no filesystem path is exposed in the URL.
const servePs4Pkg = (req, res) => {
  const grant = ps4PkgLinks.get(req.params.token);
  if (!grant || grant.expiresAt < Date.now()) {
    ps4PkgLinks.delete(req.params.token);
    return res.status(404).end();
  }
  if (!fs.existsSync(grant.filePath) || !fs.statSync(grant.filePath).isFile()) {
    ps4PkgLinks.delete(req.params.token);
    return res.status(404).end();
  }
  const safeName = path.basename(grant.filePath).replace(/[^\x20-\x7E]/g, '_').replace(/[\r\n"]+/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  writePkgRange(req, res, grant.filePath);
};
router.get('/ps4/pkg/:token/:filename', servePs4Pkg);
router.head('/ps4/pkg/:token/:filename', servePs4Pkg);

// Ask the PS4 Remote Package Installer app to fetch and install a local PKG.
// The console downloads from this manager over HTTP; RPI must be open on the
// PS4 and the URL used to open the manager must be reachable from that console.
router.post('/:ip/ps4/install', async (req, res) => {
  let token = null;
  try {
    const { ip } = req.params;
    const abs = path.resolve(String(req.body?.local_path || ''));
    if (!req.body?.local_path || !isLocalPathAllowed(abs) || !fs.existsSync(abs)) {
      return res.status(400).json({ error: 'Select an existing local .pkg file' });
    }
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size < 1 || !/\.pkg$/i.test(abs)) return res.status(400).json({ error: 'Install expects a non-empty .pkg file' });

    const profile = getRepo().queryOne('SELECT console_type FROM profiles WHERE ip_address = ?', [ip]);
    if (String(profile?.console_type || '').toLowerCase() !== 'ps4') {
      return res.status(400).json({ error: 'The selected console profile is not a PS4' });
    }

    let baseUrl;
    try {
      baseUrl = new URL(String(req.body?.manager_url || ''));
    } catch (_) {
      return res.status(400).json({ error: 'Open P5 Manager using a URL reachable from the PS4' });
    }
    if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)) {
      return res.status(400).json({ error: 'Manager URL must be an HTTP(S) address reachable from the PS4, not localhost' });
    }

    token = issuePs4PkgLink(abs);
    const pkgUrl = new URL(`/api/library/ps4/pkg/${token}/${encodeURIComponent(path.basename(abs))}`, baseUrl).toString();
    const response = await fetch(`http://${ip}:12800/api/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'direct', packages: [pkgUrl] }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.error || result?.success === false) {
      ps4PkgLinks.delete(token);
      return res.status(502).json({ error: result?.error || `Remote Package Installer returned HTTP ${response.status}. Make sure RPI is open on the PS4.` });
    }
    log('info', `PS4 RPI install requested: ${path.basename(abs)} -> ${ip}`);
    res.json({ success: true, filename: path.basename(abs), result });
  } catch (e) {
    if (token) ps4PkgLinks.delete(token);
    res.status(502).json({ error: `PS4 install failed: ${e.message}. Make sure Remote Package Installer is open on the console.` });
  }
});

// PS4's installed titles are listed in app.db. This endpoint only downloads
// and reads that database over GoldHEN FTP; it never modifies console data.
router.get('/:ip/ps4', async (req, res) => {
  const ftp = new FtpClient(12_000);
  const chunks = [];
  let total = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) return callback(new Error('PS4 app.db is unexpectedly large'));
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  try {
    await ftp.access({ host: req.params.ip, port: getFtpPort(req.params.ip), user: 'anonymous', password: '', secure: false });
    await ftp.downloadTo(sink, '/system_data/priv/mms/app.db');
    const games = parsePs4Library(Buffer.concat(chunks)).map(g => ({
      ...g,
      icon: `/api/library/${req.params.ip}/icon/${g.title_id}`,
    }));
    res.json({ platform: 'ps4', source: 'app.db', games, count: games.length });
  } catch (e) {
    log('warn', `PS4 library ${req.params.ip}: ${e.message}`);
    res.status(502).json({ error: `Could not read the PS4 library over FTP: ${e.message}. Make sure GoldHEN FTP is enabled.` });
  } finally { ftp.close(); }
});

// Use Remote Package Installer's supported app removal endpoint. Never delete
// /user/app files through FTP because that would leave the PS4 app database
// inconsistent.
router.post('/:ip/ps4/:titleId/uninstall', async (req, res) => {
  try {
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm required' });
    const response = await fetch(`http://${req.params.ip}:12800/api/uninstall_game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title_id: req.params.titleId }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.error || body?.success === false) {
      throw new Error(body?.error || `Remote Package Installer returned HTTP ${response.status}`);
    }
    res.json({ success: true, title_id: req.params.titleId, result: body });
  } catch (e) {
    res.status(502).json({ error: `PS4 uninstall failed: ${e.message}. Make sure Remote Package Installer is running on the console.` });
  }
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
  } catch (e) {
    if (e.status !== 502) return fail(res, e);
    const why = await diagnose(req.params.ip);
    res.status(502).json({
      error: why.reason === 'offline'
        ? `The console at ${req.params.ip} is not answering - it is off, in rest mode, or the jailbreak has not been run since it was turned on.`
        : 'ShadowMountPlus is not running on the console.',
      ...why,
    });
  }
});

// Sends ShadowMountPlus from the payload library and waits for its API.
router.post('/:ip/start', async (req, res) => {
  try {
    const { ip } = req.params;
    const port = apiPort();
    if (await tcpPortOpen(ip, port, 1500)) return res.json({ success: true, already_running: true });
    if (!(await tcpPortOpen(ip, ELF_LOADER_PORT, 2000))) {
      return res.status(409).json({ error: `The ELF loader (port ${ELF_LOADER_PORT}) is not reachable on ${ip}` });
    }
    const payload = findShadowMountPayload();
    if (!payload) return res.status(409).json({ error: 'No ShadowMountPlus payload in the payload library - add shadowmountplus.elf under Payloads first' });
    log('info', `library ${ip}: sending ${payload.filename}`);
    await sendElfPayload(ip, ELF_LOADER_PORT, payload.filepath);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await tcpPortOpen(ip, port, 1000)) return res.json({ success: true });
      await new Promise(r => setTimeout(r, 700));
    }
    res.status(504).json({ error: `Sent ${payload.filename} but its API did not come up on port ${port} within 30 s. Check that "Allow local network access" is enabled in ShadowMount's settings.` });
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
      const profile = getRepo().queryOne('SELECT console_type FROM profiles WHERE TRIM(ip_address) = ? LIMIT 1', [ip]);
      if (String(profile?.console_type || '').toLowerCase() === 'ps4') {
        const ftp = new FtpClient(10_000);
        const chunks = [];
        let total = 0;
        const sink = new Writable({
          write(chunk, _encoding, callback) {
            total += chunk.length;
            if (total > 8 * 1024 * 1024) return callback(new Error('PS4 title icon is unexpectedly large'));
            chunks.push(Buffer.from(chunk));
            callback();
          },
        });
        try {
          await ftp.access({ host: ip, port: getFtpPort(ip), user: 'anonymous', password: '', secure: false });
          await ftp.downloadTo(sink, `/user/appmeta/${titleId}/icon0.png`);
          buf = Buffer.concat(chunks);
        } finally { ftp.close(); }
      } else {
        const r = await fetch(`http://${ip}:${apiPort()}/api/v1/games/icon?title_id=${titleId}&size=thumb`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) return res.status(404).end();
        buf = Buffer.from(await r.arrayBuffer());
      }
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
