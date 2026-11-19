import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { log, getRepo } from '../db/sqlite.js';
import { payloadsDir } from '../lib/paths.js';
import { placeVendoredPayload, vendoredSource } from '../lib/defaultPayloads.js';
import { tcpPortOpen, sendElfPayload, ELF_LOADER_PORT } from './convert.js';
import { engineUrl, ENGINE_PORT } from '../lib/engineProxy.js';

// P5 Converter: converting on the console itself. A pinned, locally bundled
// build of theghostonline's LZ4 Compression engine (GPL), kept separate from
// the MIT manager. "P5 Converter" is what the user sees; the payload file keeps
// its upstream name so an existing payload library does not grow a duplicate.
const RELEASE = {
  version: '1.6.2-p5manager',
  filename: 'lz4-compression.elf',
  sha256: '92b1ba5413f45864c2c2e97953d2cfa88cce65dc96b5148cfca4840b28524e07',
};
const UI_PORT = ENGINE_PORT;
const SHADOWMOUNT_PORT = 10101;
const START_TIMEOUT_MS = 40_000;

const router = express.Router();
const elfPath = () => path.join(payloadsDir, RELEASE.filename);
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const installedOk = () => {
  try { return sha256Of(elfPath()) === RELEASE.sha256; } catch (_) { return false; }
};

async function install() {
  if (installedOk()) return;
  const source = vendoredSource(RELEASE);
  if (!source) throw new Error('The built-in P5 Converter payload is missing from this P5 Manager installation');
  const got = sha256Of(source);
  if (got !== RELEASE.sha256) {
    throw new Error(`Built-in ${RELEASE.filename} does not match its pinned checksum (got ${got.slice(0, 12)}...)`);
  }
  fs.mkdirSync(payloadsDir, { recursive: true });
  placeVendoredPayload(source, elfPath());
  log('info', `P5 Converter engine ${RELEASE.version} installed into the payload library`);
}

router.param('ip', (req, res, next, ip) => {
  if (net.isIP(ip) === 0) return res.status(400).json({ error: 'Invalid console address' });
  next();
});

router.get('/:ip/status', async (req, res) => {
  const { ip } = req.params;
  const [running, loader, shadowmount] = await Promise.all([
    tcpPortOpen(ip, UI_PORT, 1500),
    tcpPortOpen(ip, ELF_LOADER_PORT, 1500),
    tcpPortOpen(ip, SHADOWMOUNT_PORT, 1500),
  ]);
  res.json({
    version: RELEASE.version,
    installed: installedOk(),
    running,
    loader,
    shadowmount,
    url: `http://${ip}:${UI_PORT}/`,
    source: 'https://theghostonline.dev/theghostonline/PS5-LZ4-Compression',
  });
});

// Send the engine and wait for its API. Returns null when it is up, or the
// {status, error} to answer with - shared by /start and the pass-through, so
// the first action on a cold console brings the engine up by itself.
async function ensureRunning(ip) {
  if (await tcpPortOpen(ip, UI_PORT, 1500)) return null;
  if (!(await tcpPortOpen(ip, ELF_LOADER_PORT, 2000))) {
    return { status: 409, error: `The ELF loader (port ${ELF_LOADER_PORT}) is not reachable on ${ip} - the console is off, asleep or not jailbroken yet` };
  }
  await install();
  if (!installedOk()) return { status: 500, error: 'Built-in P5 Converter payload failed its checksum - not sending it' };
  log('info', `sending ${RELEASE.filename} ${RELEASE.version} to ${ip}`);
  await sendElfPayload(ip, ELF_LOADER_PORT, elfPath());
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await tcpPortOpen(ip, UI_PORT, 1000)) return null;
    await new Promise(r => setTimeout(r, 700));
  }
  return { status: 504, error: `Sent P5 Converter but its API did not come up on port ${UI_PORT} within ${START_TIMEOUT_MS / 1000} s. It needs ShadowMountPlus and kstuff-lite 1.07+ running on the console.` };
}

router.post('/:ip/start', async (req, res) => {
  try {
    const { ip } = req.params;
    if (await tcpPortOpen(ip, UI_PORT, 1500)) return res.json({ success: true, already_running: true });
    const bad = await ensureRunning(ip);
    if (bad) return res.status(bad.status).json({ error: bad.error });
    res.json({ success: true });
  } catch (e) {
    log('error', `P5 Converter start failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Its own "terminate" action: removes the home-screen tile and exits. A
// running job keeps it alive on its side - we just pass the answer on.
router.post('/:ip/stop', async (req, res) => {
  try {
    const { ip } = req.params;
    // removeTile=1 also asks the upstream engine to remove its launcher tile.
    const r = await fetch(`http://${ip}:${UI_PORT}/api/control/shutdown?removeTile=1`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
    });
    const text = await r.text();
    if (!r.ok) return res.status(409).json({ error: `P5 Converter refused to stop: ${text.slice(0, 200) || `HTTP ${r.status}`}` });
    log('info', `P5 Converter stopped on ${ip}`);
    res.json({ success: true });
  } catch (e) {
    res.status(502).json({ error: `P5 Converter is not reachable on ${req.params.ip}:${UI_PORT}` });
  }
});

// The engine's own REST API, reachable through P5 Manager so our UI can drive
// every action without a route per action, and so an https:// page can reach
// an http:// console. Only consoles that are set up here, and only the
// engine's own paths.
router.all('/:ip/engine/*', async (req, res) => {
  const { ip } = req.params;
  if (!getRepo().queryOne('SELECT id FROM profiles WHERE ip_address = ? LIMIT 1', [ip])) {
    return res.status(404).json({ error: `No console with the address ${ip} is set up in P5 Manager` });
  }
  const q = String(req.originalUrl || '').indexOf('?');
  let url;
  try {
    url = engineUrl(ip, req.params[0], q >= 0 ? req.originalUrl.slice(q) : '');
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try {
    if (!(await tcpPortOpen(ip, UI_PORT, 1500))) {
      // Reading never starts the engine - the UI offers Start instead, so a
      // 2 s poll cannot kick off a 40 s payload send behind the user's back.
      if (req.method === 'GET') {
        return res.status(409).json({ error: `P5 Converter is not running on ${ip}`, needs_start: true });
      }
      const bad = await ensureRunning(ip);
      if (bad) return res.status(bad.status).json({ error: bad.error });
    }
    const r = await fetch(url, {
      method: req.method,
      redirect: 'manual',
      signal: AbortSignal.timeout(req.method === 'GET' ? 10_000 : 60_000),
    });
    const body = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type');
    if (type) res.type(type);
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: `P5 Converter is not reachable on ${ip}:${UI_PORT} (${e.message})` });
  }
});

export default router;
