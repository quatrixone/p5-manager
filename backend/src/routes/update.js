import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { log, saveDatabase } from '../db/sqlite.js';
import { internalDataDir } from '../lib/paths.js';

// "A new version is out" notice plus the Update button.
//
// The app updates its own code, not its container. Every release carries
// one "app bundle" per platform - Docker and the Windows package - named
// p5-manager-app-<version>-<platform>-level<n>-deps<hash>[-py<hash>].zip
// (src/ and dist/, on Windows also the Remote Play service; built by
// scripts/build-app-bundle.mjs). Update downloads
// it, checks it against the published SHA-256, unpacks it into
// <data dir>/app-update/current and exits; the restart policy starts the
// app again and src/index.js loads the new copy from there. Nothing outside
// the data directory is touched and no access to Docker is needed.
//
// What a bundle cannot change is the image underneath it: system tools, the
// Node runtime, node_modules, the Remote Play service. Its name says which
// image it fits - `level` is the image level it needs (backend/image-level)
// and `deps` the fingerprint of the dependencies it was built against
// (backend/deps-hash.mjs); `py`, on Windows, the same for the Remote Play
// service's Python packages. A bundle that does not fit the running image
// is reported, not installed.

const router = express.Router();

const REPO = 'quatrixone/p5-manager';
// P5M_UPDATE_FEED: another URL answering like GitHub's "latest release"
// API, for a mirror or for testing an update without publishing one.
const FEED_URL = process.env.P5M_UPDATE_FEED || `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_DIR = path.join(internalDataDir, 'app-update');
const RESULT_FILE = path.join(UPDATE_DIR, 'result.json');
const BUNDLE_NAME = /^p5-manager-app-(\d[0-9A-Za-z.]*)-(docker|windows)-level(\d+)-deps([0-9a-f]{12})(?:-py([0-9a-f]{12}))?\.zip$/;
// Asked of whatever restarts the process: Docker restarts on any exit, the
// Windows launcher only on this code.
export const RESTART_EXIT_CODE = 75;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CURRENT_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
})();
// Set by src/index.js. Absent when main.js is started directly (tests, an
// older image): then nothing would load a downloaded copy, so none is taken.
const SELF_UPDATE = !!process.env.P5M_BASE_ROOT;
const IMAGE_LEVEL = parseInt(process.env.P5M_IMAGE_LEVEL, 10) || 1;
const DEPS_HASH = process.env.P5M_DEPS_HASH || '';
const PLATFORM = process.env.P5M_PLATFORM || 'docker';
const PYDEPS = process.env.P5M_PYDEPS || '';

const parseVersion = (v) => String(v || '').replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
export function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

let latest = null; // { version, url, name, notes, published_at, bundle }
let checkedAt = 0;
let checkError = null;
let job = null; // { version, state: 'downloading' | 'installing' | 'restarting' | 'failed', error? }

async function checkLatest(force = false) {
  if (!force && checkedAt && Date.now() - checkedAt < CHECK_INTERVAL_MS) return;
  checkedAt = Date.now();
  try {
    const res = await fetch(FEED_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'p5-manager' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = await res.json();
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const zip = assets.find(a => a.name.match(BUNDLE_NAME)?.[2] === PLATFORM);
    const sum = zip && assets.find(a => a.name === `${zip.name}.sha256`);
    latest = {
      version: String(rel.tag_name || '').replace(/^v/i, ''),
      url: rel.html_url,
      name: rel.name || rel.tag_name,
      notes: String(rel.body || '').slice(0, 4000),
      published_at: rel.published_at,
      bundle: zip && sum ? {
        name: zip.name,
        url: zip.browser_download_url,
        sha256_url: sum.browser_download_url,
        size: zip.size,
        image_level: parseInt(zip.name.match(BUNDLE_NAME)[3], 10),
        deps: zip.name.match(BUNDLE_NAME)[4],
        pydeps: zip.name.match(BUNDLE_NAME)[5] || '',
      } : null,
    };
    checkError = null;
  } catch (e) {
    checkError = e.message;
    log('warn', `Update check failed: ${e.message}`);
  }
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
};

// Why Update cannot be offered here, or null when it can.
function blocker() {
  if (!latest?.version || !isNewerVersion(latest.version, CURRENT_VERSION)) return 'No newer version to install';
  if (!SELF_UPDATE) return 'This installation cannot update itself';
  if (!latest.bundle) return `This release has no app bundle for ${PLATFORM === 'windows' ? 'the Windows package' : 'Docker'}`;
  if (latest.bundle.image_level > IMAGE_LEVEL || latest.bundle.deps !== DEPS_HASH || (latest.bundle.pydeps && latest.bundle.pydeps !== PYDEPS)) {
    return 'This version needs a newer image - pull it (docker compose pull && docker compose up -d) or download the new Windows package';
  }
  return null;
}

router.get('/status', async (req, res) => {
  await checkLatest(req.query.refresh === '1');
  const why = blocker();
  const available = !!latest?.version && isNewerVersion(latest.version, CURRENT_VERSION);
  res.json({
    current: CURRENT_VERSION,
    image_version: process.env.P5M_BASE_VERSION || CURRENT_VERSION,
    latest: latest && { version: latest.version, url: latest.url, name: latest.name, notes: latest.notes, published_at: latest.published_at },
    update_available: available,
    can_apply: !why,
    blocked_reason: available ? why : null,
    job,
    last_result: readJson(RESULT_FILE),
    checked_at: checkedAt ? new Date(checkedAt).toISOString() : null,
    check_error: checkError,
  });
});

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'p5-manager' }, signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  for await (const chunk of res.body) {
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
  }
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  return hash.digest('hex');
}

async function install(bundle, version) {
  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  const zipFile = path.join(UPDATE_DIR, 'download.zip');
  const staging = path.join(UPDATE_DIR, 'staging');
  const current = path.join(UPDATE_DIR, 'current');
  const previous = path.join(UPDATE_DIR, 'previous');
  try {
    const sumRes = await fetch(bundle.sha256_url, { headers: { 'User-Agent': 'p5-manager' }, signal: AbortSignal.timeout(30000) });
    if (!sumRes.ok) throw new Error(`checksum download failed: ${sumRes.status}`);
    const expected = (await sumRes.text()).trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('the published checksum is not a SHA-256');
    const actual = await download(bundle.url, zipFile);
    if (actual !== expected) throw new Error('the download does not match its published checksum');

    job = { version, state: 'installing' };
    fs.rmSync(staging, { recursive: true, force: true });
    const zip = new AdmZip(zipFile);
    for (const entry of zip.getEntries()) {
      // Nothing may land outside the staging folder.
      const target = path.resolve(staging, entry.entryName);
      if (target !== staging && !target.startsWith(staging + path.sep)) throw new Error(`unsafe path in the bundle: ${entry.entryName}`);
    }
    zip.extractAllTo(staging, true);
    const manifest = readJson(path.join(staging, 'manifest.json'));
    if (manifest?.version !== version) throw new Error(`the bundle says version ${manifest?.version}, expected ${version}`);
    if ((manifest.platform || 'docker') !== PLATFORM) throw new Error(`the bundle is for ${manifest.platform}`);
    if ((parseInt(manifest.image_level, 10) || 1) > IMAGE_LEVEL || manifest.deps !== DEPS_HASH || (manifest.pydeps && manifest.pydeps !== PYDEPS)) throw new Error('the bundle needs a newer image');
    for (const need of ['src/main.js', 'dist/index.html', 'package.json']) {
      if (!fs.existsSync(path.join(staging, need))) throw new Error(`the bundle is incomplete: ${need} is missing`);
    }

    fs.rmSync(previous, { recursive: true, force: true });
    if (fs.existsSync(current)) fs.renameSync(current, previous);
    fs.renameSync(staging, current);
    fs.rmSync(path.join(UPDATE_DIR, 'boot.json'), { force: true });
    fs.rmSync(path.join(UPDATE_DIR, 'failed'), { recursive: true, force: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify({
      ok: true, version, message: `Updated to ${version}`, finished_at: new Date().toISOString(),
    }));
    fs.rmSync(zipFile, { force: true });

    job = { version, state: 'restarting' };
    log('info', `Update ${version} installed - restarting`);
    setTimeout(() => {
      try { process.emit('SIGTERM'); } catch (_) {}
      try { saveDatabase(); } catch (_) {}
      process.exit(RESTART_EXIT_CODE);
    }, 500);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(zipFile, { force: true });
    job = { version, state: 'failed', error: e.message };
    log('error', `Update to ${version} failed: ${e.message}`);
  }
}

router.post('/apply', async (req, res) => {
  await checkLatest();
  const why = blocker();
  if (why) return res.status(400).json({ error: why });
  if (job && job.state !== 'failed') return res.status(409).json({ error: 'An update is already running' });
  job = { version: latest.version, state: 'downloading' };
  log('info', `Updating to ${latest.version}`);
  install(latest.bundle, latest.version);
  res.json({ success: true, version: latest.version });
});

// Called by main.js once the app is up: the downloaded copy started, so the
// loader (src/index.js) stops counting attempts against it.
export function markBootOk() {
  try { fs.rmSync(path.join(UPDATE_DIR, 'boot.json'), { force: true }); } catch (_) {}
}

export default router;
