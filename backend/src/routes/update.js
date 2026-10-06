import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../db/sqlite.js';
import { internalDataDir } from '../lib/paths.js';

// "A new version is out" notice plus the Update button.
//
// The app only looks at GitHub Releases and tells the browser. It cannot
// replace its own container, and is deliberately not given the Docker socket
// for that. Instead the Update button drops a request file into the data
// directory, which scripts/p5-update.sh picks up on the host (run from cron,
// see that script) - it pulls the released image and swaps the container.
// The script also leaves a heartbeat there, which is how the app knows the
// button can work at all.

const router = express.Router();

const REPO = 'quatrixone/p5-manager';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_MAX_AGE_MS = 5 * 60 * 1000;
const REQUEST_FILE = path.join(internalDataDir, 'update-request.json');
const RESULT_FILE = path.join(internalDataDir, 'update-result.json');
const HEARTBEAT_FILE = path.join(internalDataDir, 'updater-heartbeat');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CURRENT_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
})();

const parseVersion = (v) => String(v || '').replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
export function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

let latest = null; // { version, url, name, notes, published_at }
let checkedAt = 0;
let checkError = null;

async function checkLatest(force = false) {
  if (!force && checkedAt && Date.now() - checkedAt < CHECK_INTERVAL_MS) return;
  checkedAt = Date.now();
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'p5-manager' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = await res.json();
    latest = {
      version: String(rel.tag_name || '').replace(/^v/i, ''),
      url: rel.html_url,
      name: rel.name || rel.tag_name,
      notes: String(rel.body || '').slice(0, 4000),
      published_at: rel.published_at,
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

function updaterReady() {
  try {
    return Date.now() - fs.statSync(HEARTBEAT_FILE).mtimeMs < HEARTBEAT_MAX_AGE_MS;
  } catch (_) {
    return false;
  }
}

router.get('/status', async (req, res) => {
  await checkLatest(req.query.refresh === '1');
  res.json({
    current: CURRENT_VERSION,
    latest,
    update_available: !!latest?.version && isNewerVersion(latest.version, CURRENT_VERSION),
    can_apply: updaterReady(),
    pending: readJson(REQUEST_FILE),
    last_result: readJson(RESULT_FILE),
    checked_at: checkedAt ? new Date(checkedAt).toISOString() : null,
    check_error: checkError,
  });
});

router.post('/apply', async (req, res) => {
  await checkLatest();
  if (!latest?.version || !isNewerVersion(latest.version, CURRENT_VERSION)) {
    return res.status(400).json({ error: 'No newer version to install' });
  }
  if (!updaterReady()) {
    return res.status(409).json({ error: 'The updater is not set up on this host - see scripts/p5-update.sh' });
  }
  try {
    fs.writeFileSync(REQUEST_FILE, JSON.stringify({
      version: latest.version,
      from: CURRENT_VERSION,
      requested_at: new Date().toISOString(),
    }));
    log('info', `Update to ${latest.version} requested`);
    res.json({ success: true, version: latest.version });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
