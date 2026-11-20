import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { log, getRepo } from '../db/sqlite.js';
import { payloadsDir } from '../lib/paths.js';
import { placeVendoredPayload, vendoredSource } from '../lib/defaultPayloads.js';
import { tcpPortOpen, sendElfPayload, ELF_LOADER_PORT } from './convert.js';
import { forgeUrl, FORGE_PORT } from '../lib/forgeProxy.js';

// Converting on the console: a pinned, locally bundled build of PS5 Dump
// Forge (GPL-3.0-or-later, quer3q). It converts between a folder, .exfat,
// .ffpkg, .ffpfs, .ffpfsc, .pkg and LZ4 or zstd asset packs, reads .zip,
// .7z and .rar sources without unpacking them, verifies every job against
// its source, and installs the AMPR runtime a packed title needs. It reads
// the drives on its own, so ShadowMountPlus is not required to convert.
const RELEASE = {
  version: '0.5.6',
  filename: 'ps5-dump-forge.elf',
  dir: 'forge',
  sha256: 'f0415aab6ded1cdf875418b6683ab56aeae3721492af99fba71b08c2c351f82f',
};
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
  if (!source) throw new Error('The built-in PS5 Dump Forge payload is missing from this P5 Manager installation');
  const got = sha256Of(source);
  if (got !== RELEASE.sha256) {
    throw new Error(`Built-in ${RELEASE.filename} does not match its pinned checksum (got ${got.slice(0, 12)}...)`);
  }
  fs.mkdirSync(payloadsDir, { recursive: true });
  placeVendoredPayload(source, elfPath());
  log('info', `PS5 Dump Forge ${RELEASE.version} installed into the payload library`);
}

router.param('ip', (req, res, next, ip) => {
  if (net.isIP(ip) === 0) return res.status(400).json({ error: 'Invalid console address' });
  next();
});

// Returns null once the API answers, or the {status, error} to answer with.
async function ensureRunning(ip) {
  if (await tcpPortOpen(ip, FORGE_PORT, 1500)) return null;
  if (!(await tcpPortOpen(ip, ELF_LOADER_PORT, 2000))) {
    return { status: 409, error: `The ELF loader (port ${ELF_LOADER_PORT}) is not reachable on ${ip} - the console is off, asleep or not jailbroken yet` };
  }
  await install();
  if (!installedOk()) return { status: 500, error: 'Built-in PS5 Dump Forge payload failed its checksum - not sending it' };
  log('info', `sending ${RELEASE.filename} ${RELEASE.version} to ${ip}`);
  await sendElfPayload(ip, ELF_LOADER_PORT, elfPath());
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await tcpPortOpen(ip, FORGE_PORT, 1000)) return null;
    await new Promise(r => setTimeout(r, 700));
  }
  return { status: 504, error: `Sent PS5 Dump Forge but its API did not come up on port ${FORGE_PORT} within ${START_TIMEOUT_MS / 1000} s` };
}

router.get('/:ip/status', async (req, res) => {
  const { ip } = req.params;
  const [running, loader] = await Promise.all([
    tcpPortOpen(ip, FORGE_PORT, 1500),
    tcpPortOpen(ip, ELF_LOADER_PORT, 1500),
  ]);
  let session = null;
  if (running) {
    try {
      const r = await fetch(forgeUrl(ip, 'session'), { signal: AbortSignal.timeout(5000) });
      if (r.ok) session = await r.json();
    } catch (_) { /* answered the port but not the API yet */ }
  }
  res.json({
    version: RELEASE.version,
    installed: installedOk(),
    running,
    loader,
    url: `http://${ip}:${FORGE_PORT}/`,
    session,
    source: 'https://github.com/quer3q/ps5-dump-forge',
  });
});

router.post('/:ip/start', async (req, res) => {
  try {
    const { ip } = req.params;
    if (await tcpPortOpen(ip, FORGE_PORT, 1500)) return res.json({ success: true, already_running: true });
    const bad = await ensureRunning(ip);
    if (bad) return res.status(bad.status).json({ error: bad.error });
    res.json({ success: true });
  } catch (e) {
    log('error', `PS5 Dump Forge start failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Its own handover: quit only when idle, so a running conversion is never
// cut off by closing the panel.
router.post('/:ip/stop', async (req, res) => {
  const { ip } = req.params;
  try {
    const r = await fetch(`http://${ip}:${FORGE_PORT}/api/quit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ if_idle: true }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    if (!r.ok) return res.status(409).json({ error: `PS5 Dump Forge did not stop: ${text.slice(0, 200) || `HTTP ${r.status}`}` });
    log('info', `PS5 Dump Forge stopped on ${ip}`);
    res.json({ success: true });
  } catch (e) {
    res.status(502).json({ error: `PS5 Dump Forge is not reachable on ${ip}:${FORGE_PORT}` });
  }
});

// The API itself, reachable through P5 Manager so our own screens can drive
// it and an https:// page can reach an http:// console. Only consoles that
// are set up here, and only the endpoints the app uses.
router.all('/:ip/api/:tail', async (req, res) => {
  const { ip, tail } = req.params;
  if (!getRepo().queryOne('SELECT id FROM profiles WHERE ip_address = ? LIMIT 1', [ip])) {
    return res.status(404).json({ error: `No console with the address ${ip} is set up in P5 Manager` });
  }
  let url;
  try {
    url = forgeUrl(ip, tail);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try {
    if (!(await tcpPortOpen(ip, FORGE_PORT, 1500))) {
      // Reading never starts the payload: a poll must not kick off a send.
      if (req.method === 'GET') {
        return res.status(409).json({ error: `PS5 Dump Forge is not running on ${ip}`, needs_start: true });
      }
      const bad = await ensureRunning(ip);
      if (bad) return res.status(bad.status).json({ error: bad.error });
    }
    const body = req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {});
    const r = await fetch(url, {
      method: req.method,
      redirect: 'manual',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body,
      // A library scan of a full console takes its time; a job start does not.
      signal: AbortSignal.timeout(req.method === 'GET' ? 15_000 : 120_000),
    });
    const out = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type');
    if (type) res.type(type);
    res.status(r.status).send(out);
  } catch (e) {
    res.status(502).json({ error: `PS5 Dump Forge is not reachable on ${ip}:${FORGE_PORT} (${e.message})` });
  }
});

export default router;
