import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { log } from '../db/sqlite.js';
import { payloadsDir } from '../lib/paths.js';
import { tcpPortOpen, sendElfPayload, ELF_LOADER_PORT } from './convert.js';

// "Convert on console": PS5 Game Compressor by Juma Sayeh
// (https://github.com/juma-sayeh/PS5-Game-Compressor) - a payload that
// compresses, unpacks, validates and repairs ShadowMountPlus titles on the
// console itself and brings its own web UI on port 5910.
//
// We do not redistribute it: the pinned release is downloaded from the
// author's GitHub release into the payload library on first use and its
// SHA-256 is checked every time before it is sent to a console. This module
// only installs, starts and stops it - the operations themselves are driven
// from its own UI, which the Convert tab embeds.
const RELEASE = {
  version: 'v1.0.4',
  filename: 'game-compressor.elf',
  url: 'https://github.com/juma-sayeh/PS5-Game-Compressor/releases/download/v1.0.4/game-compressor.elf',
  sha256: 'e55e90aaade13b6e0d4316c1597ef90a21b67a06475c3e25de054224bc1e941b',
};
const UI_PORT = 5910;
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
  const r = await fetch(RELEASE.url, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`Download failed: HTTP ${r.status} from ${RELEASE.url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== RELEASE.sha256) {
    throw new Error(`Downloaded ${RELEASE.filename} does not match the pinned checksum (got ${got.slice(0, 12)}...) - not installing it`);
  }
  fs.mkdirSync(payloadsDir, { recursive: true });
  const tmp = `${elfPath()}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, elfPath());
  log('info', `game compressor ${RELEASE.version} installed into the payload library`);
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
    source: 'https://github.com/juma-sayeh/PS5-Game-Compressor',
  });
});

router.post('/:ip/start', async (req, res) => {
  try {
    const { ip } = req.params;
    if (await tcpPortOpen(ip, UI_PORT, 1500)) return res.json({ success: true, already_running: true });
    if (!(await tcpPortOpen(ip, ELF_LOADER_PORT, 2000))) {
      return res.status(409).json({ error: `The ELF loader (port ${ELF_LOADER_PORT}) is not reachable on ${ip} - the console is off, asleep or not jailbroken yet` });
    }
    await install();
    if (!installedOk()) return res.status(500).json({ error: 'Game Compressor file failed its checksum - not sending it' });
    log('info', `sending ${RELEASE.filename} ${RELEASE.version} to ${ip}`);
    await sendElfPayload(ip, ELF_LOADER_PORT, elfPath());
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await tcpPortOpen(ip, UI_PORT, 1000)) return res.json({ success: true });
      await new Promise(r => setTimeout(r, 700));
    }
    res.status(504).json({ error: `Sent Game Compressor but its web UI did not come up on port ${UI_PORT} within ${START_TIMEOUT_MS / 1000} s. It needs ShadowMountPlus and kstuff-lite 1.07+ running on the console.` });
  } catch (e) {
    log('error', `game compressor start failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Its own "terminate" action: removes the home-screen tile and exits. A
// running job keeps it alive on its side - we just pass the answer on.
router.post('/:ip/stop', async (req, res) => {
  try {
    const { ip } = req.params;
    const r = await fetch(`http://${ip}:${UI_PORT}/api/control/shutdown`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
    });
    const text = await r.text();
    if (!r.ok) return res.status(409).json({ error: `Game Compressor refused to stop: ${text.slice(0, 200) || `HTTP ${r.status}`}` });
    log('info', `game compressor stopped on ${ip}`);
    res.json({ success: true });
  } catch (e) {
    res.status(502).json({ error: `Game Compressor is not reachable on ${req.params.ip}:${UI_PORT}` });
  }
});

export default router;
