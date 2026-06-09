import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const dlScratchDir = path.join(projectRoot, 'data', 'mkpfs', '.tmp');

function getDlScratch() {
  try { fs.mkdirSync(dlScratchDir, { recursive: true }); return dlScratchDir; }
  catch (_) { return os.tmpdir(); }
}
import { getDatabase, log } from '../db/sqlite.js';
import { buildSmbArgs, runSmbClient, smbClientError, getSmbSource, listSmbSources, uploadDirToSmb } from '../lib/smb.js';

const router = express.Router();

const BLOCKED_LOCAL_PREFIXES = [
  '/etc', '/root', '/sys', '/proc', '/boot', '/usr', '/bin', '/sbin',
  '/lib', '/lib32', '/lib64', '/dev', '/run', '/var/run', '/var/cache',
  '/var/lib/docker', '/var/lib/containers', '/var/lib/snapd', '/snap',
];

function isLocalPathAllowed(absPath) {
  const norm = path.resolve(absPath);
  for (const prefix of BLOCKED_LOCAL_PREFIXES) {
    if (norm === prefix || norm.startsWith(prefix + path.sep)) return false;
  }
  return true;
}

const MAX_JOBS = 50;
const jobs = new Map();
const jobOrder = [];

// Queue is paused by default so adding a download does not auto-start it.
// User explicitly starts the queue from the Queue tab.
let downloaderPaused = true;
let downloaderWorkerRunning = false;

function newJobId() { return crypto.randomBytes(8).toString('hex'); }

function recordJob(job) {
  jobs.set(job.id, job);
  jobOrder.push(job.id);
  while (jobOrder.length > MAX_JOBS) {
    const removed = jobOrder.shift();
    jobs.delete(removed);
  }
}

function appendLog(job, chunk) {
  const text = typeof chunk === 'string' ? chunk : chunk.toString();
  job.log = (job.log || '') + text;
  if (job.log.length > 200_000) job.log = job.log.slice(-200_000);
}

function publicJob(job, { includeLog = true } = {}) {
  if (!job) return null;
  const { controller, _torrent, _tmpDir, _plan, log: jobLog, ...pub } = job;
  // derive a percentage progress for consistent UI rendering across queues
  if (pub.bytes_total && pub.bytes_total > 0) {
    pub.progress = Math.min(100, Math.round((pub.bytes_downloaded / pub.bytes_total) * 100));
  } else if (pub.status === 'completed') {
    pub.progress = 100;
  } else {
    pub.progress = pub.progress != null ? pub.progress : 0;
  }
  // Always advertise log size so the queue UI can decide whether to show the
  // "Show log" toggle. Only inline the full log when explicitly requested
  // (the per-job GET /api/downloader/:id endpoint) so the list response
  // stays small even with many noisy jobs.
  pub.log_size = jobLog ? jobLog.length : 0;
  if (includeLog && jobLog) pub.log = jobLog;
  return pub;
}

function deriveFilenameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return last || 'download.bin';
  } catch (_) { return 'download.bin'; }
}

function deriveFilenameFromHeaders(headers) {
  const cd = headers.get('content-disposition');
  if (!cd) return null;
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  if (m) return decodeURIComponent(m[1]).replace(/[\\/]/g, '_');
  return null;
}

function sanitizeName(name) {
  return name.replace(/[\x00-\x1f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').replace(/[\\/]/g, '_') || 'download.bin';
}

router.get('/sources', (req, res) => {
  try {
    const db = getDatabase();
    const sources = listSmbSources(db);
    res.json({ smb: sources });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/local-roots', (req, res) => {
  // Keep this list in sync with the bind mounts in docker-compose.yml ->
  // services.app.volumes — every entry here MUST be mounted from the host
  // into the container, otherwise the corresponding "quick tab" in the
  // FileBrowser will silently resolve to an empty in-container directory.
  // /tmp is intentionally excluded: the container has its own ephemeral
  // tmpfs there, and mounting host /tmp would break that isolation while
  // giving the user nothing useful to browse.
  const candidates = ['/mnt', '/home', '/data', '/media', '/srv'];
  const found = [];
  for (const r of candidates) {
    try {
      if (fs.existsSync(r) && fs.statSync(r).isDirectory()) found.push(r);
    } catch (_) {}
  }
  res.json({ roots: found });
});

router.post('/local-browse', (req, res) => {
  try {
    const { path: reqPath = '/mnt' } = req.body || {};
    const target = path.resolve(reqPath || '/mnt');
    if (!isLocalPathAllowed(target)) return res.status(403).json({ error: `Path not allowed: ${target}` });
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Path not found' });
    if (!fs.statSync(target).isDirectory()) return res.status(400).json({ error: 'Not a directory' });

    const entries = fs.readdirSync(target, { withFileTypes: true });
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const s = fs.statSync(path.join(target, e.name));
        dirs.push({ name: e.name, isDir: true, mtime: s.mtimeMs });
      } catch (_) {}
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, path: target, parent: target === '/' ? null : path.dirname(target), dirs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function downloadHttp(job, url, destPath) {
  appendLog(job, `[http] GET ${url}\n`);
  const r = await fetch(url, { signal: job.controller.signal, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  const headerName = deriveFilenameFromHeaders(r.headers);
  if (headerName && !job.filename_locked) {
    const newName = sanitizeName(headerName);
    if (newName !== path.basename(destPath)) {
      const dir = path.dirname(destPath);
      destPath = path.join(dir, newName);
      job.filename = newName;
      appendLog(job, `[http] Filename from server: ${newName}\n`);
    }
  }
  const total = parseInt(r.headers.get('content-length') || '0', 10);
  job.bytes_total = total || 0;
  appendLog(job, `[http] Size: ${total ? (total / 1024 / 1024).toFixed(1) + ' MB' : 'unknown'}\n`);
  appendLog(job, `[http] -> ${destPath}\n`);

  const out = fs.createWriteStream(destPath);
  let downloaded = 0;
  let lastTime = Date.now();
  let lastBytes = 0;
  let lastReportTime = 0;

  try {
    for await (const chunk of r.body) {
      out.write(chunk);
      downloaded += chunk.length;
      job.bytes_downloaded = downloaded;
      const now = Date.now();
      if (now - lastReportTime > 1500) {
        const dt = (now - lastTime) / 1000;
        const speed = dt > 0 ? (downloaded - lastBytes) / dt : 0;
        const pct = total ? `${((downloaded / total) * 100).toFixed(1)}%` : '';
        appendLog(job, `[http] ${(downloaded / 1024 / 1024).toFixed(1)} MB ${pct} @ ${(speed / 1024 / 1024).toFixed(2)} MB/s\n`);
        lastTime = now;
        lastBytes = downloaded;
        lastReportTime = now;
      }
    }
    await new Promise((resolve, reject) => {
      out.end(err => err ? reject(err) : resolve());
    });
  } catch (e) {
    out.destroy();
    throw e;
  }
  appendLog(job, `[http] Downloaded ${(downloaded / 1024 / 1024).toFixed(2)} MB\n`);
  return destPath;
}

async function uploadToSmb(job, src, localFile, smbSubdir, remoteName) {
  const args = buildSmbArgs(src);
  const cmds = [];
  if (smbSubdir) cmds.push(`cd "${smbSubdir.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')}"`);
  cmds.push(`lcd "${path.dirname(localFile)}"`);
  cmds.push(`put "${path.basename(localFile)}" "${remoteName}"`);
  args.push('-c', cmds.join('; '));
  appendLog(job, `[smb] put -> //${src.smb_host}/${src.smb_share}${smbSubdir ? '/' + smbSubdir : ''}/${remoteName}\n`);
  const { stdout, stderr, code } = await runSmbClient(args);
  const out = stdout + stderr;
  const err = smbClientError(out, code);
  if (err) throw new Error(`SMB upload failed: ${err.message}`);
  appendLog(job, `[smb] OK\n`);
}

let webtorrentClient = null;
async function getTorrentClient() {
  if (webtorrentClient) return webtorrentClient;
  const mod = await import('webtorrent');
  const WebTorrent = mod.default || mod;
  webtorrentClient = new WebTorrent({ tracker: { wrtc: false } });
  webtorrentClient.on('error', (err) => log('error', `webtorrent: ${err.message || err}`));
  return webtorrentClient;
}

function isMagnet(s) { return /^magnet:\?/i.test((s || '').trim()); }
function isTorrentUrl(s) { return /\.torrent(\?.*)?$/i.test((s || '').trim()); }

async function downloadTorrent(job, src, destDir) {
  const client = await getTorrentClient();
  appendLog(job, `[torrent] Adding ${isMagnet(src) ? 'magnet' : 'torrent file'}...\n`);

  let torrentInput = src;
  if (isTorrentUrl(src)) {
    appendLog(job, `[torrent] Fetching .torrent file ${src}\n`);
    const r = await fetch(src, { signal: job.controller.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    torrentInput = Buffer.from(await r.arrayBuffer());
  }

  return new Promise((resolve, reject) => {
    const torrent = client.add(torrentInput, { path: destDir }, (t) => {
      job.filename = t.name;
      job.bytes_total = t.length;
      appendLog(job, `[torrent] Name: ${t.name}\n`);
      appendLog(job, `[torrent] Files: ${t.files.length}, total ${(t.length / 1024 / 1024).toFixed(1)} MB\n`);
      appendLog(job, `[torrent] Info hash: ${t.infoHash}\n`);
    });

    job._torrent = torrent;

    let lastReport = 0;
    torrent.on('download', () => {
      job.bytes_downloaded = torrent.downloaded;
      const now = Date.now();
      if (now - lastReport > 2000) {
        const pct = torrent.length ? (torrent.downloaded / torrent.length * 100).toFixed(1) : '?';
        const speed = (torrent.downloadSpeed / 1024 / 1024).toFixed(2);
        const peers = torrent.numPeers;
        appendLog(job, `[torrent] ${(torrent.downloaded / 1024 / 1024).toFixed(1)} MB ${pct}% @ ${speed} MB/s · ${peers} peers · ETA ${torrent.timeRemaining ? Math.round(torrent.timeRemaining / 1000) + 's' : '?'}\n`);
        lastReport = now;
      }
    });

    const onAbort = () => {
      appendLog(job, `[torrent] Aborting...\n`);
      torrent.destroy(() => reject(new Error('aborted')));
    };
    job.controller.signal.addEventListener('abort', onAbort);

    torrent.on('error', err => {
      job.controller.signal.removeEventListener('abort', onAbort);
      reject(new Error(`torrent: ${err.message || err}`));
    });
    torrent.on('done', () => {
      job.controller.signal.removeEventListener('abort', onAbort);
      job.bytes_downloaded = torrent.length;
      appendLog(job, `[torrent] Download complete (${(torrent.length / 1024 / 1024).toFixed(1)} MB)\n`);
      const localPath = path.join(destDir, torrent.name);
      torrent.destroy(() => resolve({ localPath, isDir: torrent.files.length > 1 || (torrent.files[0] && torrent.files[0].path !== torrent.name) }));
    });
  });
}

async function runDownloadJob(job, trimmed, isTorrent, localDestDir, finalLocal, smbSource, smb_subdir) {
  try {
    if (isTorrent) {
      const { localPath, isDir } = await downloadTorrent(job, trimmed, localDestDir);
      if (job.dest_kind === 'smb') {
        const cleanRemote = (smb_subdir || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
        const remoteSubdir = cleanRemote ? `${cleanRemote}/${job.filename}` : job.filename;
        const sourceDir = isDir ? localPath : localDestDir;
        appendLog(job, `[smb] uploading torrent contents...\n`);
        const r = await uploadDirToSmb(smbSource, sourceDir, isDir ? remoteSubdir : cleanRemote, (t) => appendLog(job, t));
        if (r.code !== 0) throw new Error(r.error || `SMB upload exit ${r.code}`);
        appendLog(job, `[smb] OK\n`);
      }
    } else {
      const downloadedPath = await downloadHttp(job, trimmed, finalLocal);
      if (job.dest_kind === 'smb') {
        await uploadToSmb(job, smbSource, downloadedPath, smb_subdir, job.filename);
      }
    }
    job.status = 'completed';
    job.finished_at = new Date().toISOString();
    log('info', `download ${job.id} completed: ${trimmed}`);
  } catch (e) {
    if (job.controller.signal.aborted) {
      job.status = 'cancelled';
      job.error = 'cancelled';
      appendLog(job, `[manager] Cancelled\n`);
    } else {
      job.status = 'failed';
      job.error = e.message;
      appendLog(job, `[manager] ERROR: ${e.message}\n`);
    }
    job.finished_at = new Date().toISOString();
    log('error', `download ${job.id} failed: ${e.message}`);
  } finally {
    if (job._tmpDir) {
      try { fs.rmSync(job._tmpDir, { recursive: true, force: true }); }
      catch (_) {}
    }
  }
}

function downloaderWorkerTick() {
  if (downloaderWorkerRunning) return;
  if (downloaderPaused) return;
  // run downloads one at a time so the queue order is meaningful
  const anyRunning = Array.from(jobs.values()).some(j => j.status === 'running');
  if (anyRunning) return;
  const next = Array.from(jobs.values()).find(j => j.status === 'queued');
  if (!next || !next._plan) return;

  downloaderWorkerRunning = true;
  next.status = 'running';
  next.started_at = new Date().toISOString();
  const plan = next._plan;
  delete next._plan;
  runDownloadJob(next, plan.trimmed, plan.isTorrent, plan.localDestDir, plan.finalLocal, plan.smbSource, plan.smb_subdir)
    .finally(() => {
      downloaderWorkerRunning = false;
      setTimeout(downloaderWorkerTick, 100);
    });
}

setInterval(downloaderWorkerTick, 2000);

router.post('/start', async (req, res) => {
  try {
    const {
      url,
      filename,
      dest_kind,
      dest_path,
      smb_source_id,
      smb_subdir,
      overwrite = false,
    } = req.body || {};

    const trimmed = (url || '').trim();
    const isTorrent = isMagnet(trimmed) || isTorrentUrl(trimmed);
    if (!trimmed || (!/^https?:\/\//i.test(trimmed) && !isMagnet(trimmed))) {
      return res.status(400).json({ error: 'url must be http(s) or magnet:?' });
    }
    if (!dest_kind || (dest_kind !== 'local' && dest_kind !== 'smb')) {
      return res.status(400).json({ error: 'dest_kind must be local or smb' });
    }

    let smbSource = null;
    let localDestDir;

    if (dest_kind === 'local') {
      if (!dest_path) return res.status(400).json({ error: 'dest_path required for local downloads' });
      localDestDir = path.resolve(dest_path);
      if (!isLocalPathAllowed(localDestDir)) return res.status(403).json({ error: `Path not allowed: ${localDestDir}` });
      if (!fs.existsSync(localDestDir)) {
        try { fs.mkdirSync(localDestDir, { recursive: true }); }
        catch (e) { return res.status(400).json({ error: `Cannot create dir: ${e.message}` }); }
      }
      if (!fs.statSync(localDestDir).isDirectory()) return res.status(400).json({ error: 'dest_path must be a directory' });
    } else {
      if (!smb_source_id) return res.status(400).json({ error: 'smb_source_id required' });
      const db = getDatabase();
      smbSource = getSmbSource(db, parseInt(smb_source_id));
      if (!smbSource) return res.status(404).json({ error: 'SMB source not found' });
      localDestDir = fs.mkdtempSync(path.join(getDlScratch(), 'dl-'));
    }

    let resolvedName = isTorrent
      ? (filename ? sanitizeName(filename) : 'torrent')
      : sanitizeName(filename || deriveFilenameFromUrl(trimmed));
    const finalLocal = path.join(localDestDir, resolvedName);
    if (!isTorrent && dest_kind === 'local' && fs.existsSync(finalLocal) && !overwrite) {
      return res.status(409).json({ error: `File exists: ${finalLocal}. Set overwrite=true.` });
    }

    const jobId = newJobId();
    const controller = new AbortController();
    const job = {
      id: jobId,
      type: isTorrent ? 'torrent' : 'download',
      status: 'queued',
      url: trimmed,
      filename: resolvedName,
      filename_locked: !!filename,
      dest_kind,
      dest_path: dest_kind === 'local' ? localDestDir : `//${smbSource.smb_host}/${smbSource.smb_share}${smb_subdir ? '/' + smb_subdir : ''}`,
      smb_source_id: smbSource ? smbSource.id : null,
      smb_subdir: smb_subdir || null,
      log: '',
      bytes_total: 0,
      bytes_downloaded: 0,
      added_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      error: null,
      controller,
      _tmpDir: dest_kind === 'smb' ? localDestDir : null,
      _plan: { trimmed, isTorrent, localDestDir, finalLocal, smbSource, smb_subdir },
    };
    recordJob(job);
    log('info', `download ${jobId} queued: ${trimmed}`);
    res.json({ success: true, job_id: jobId, type: job.type, status: job.status });
    setTimeout(downloaderWorkerTick, 50);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/queue', (req, res) => {
  res.json({ paused: downloaderPaused });
});

router.post('/queue/pause', (req, res) => {
  downloaderPaused = true;
  log('info', 'download queue paused');
  res.json({ success: true, paused: true });
});

router.post('/queue/resume', (req, res) => {
  downloaderPaused = false;
  log('info', 'download queue resumed');
  setTimeout(downloaderWorkerTick, 50);
  res.json({ success: true, paused: false });
});

router.post('/queue/clear-finished', (req, res) => {
  let removed = 0;
  for (const id of [...jobOrder]) {
    const j = jobs.get(id);
    if (j && ['completed', 'failed', 'cancelled'].includes(j.status)) {
      jobs.delete(id);
      const idx = jobOrder.indexOf(id);
      if (idx >= 0) jobOrder.splice(idx, 1);
      removed++;
    }
  }
  res.json({ success: true, removed });
});

router.get('/', (req, res) => {
  const list = jobOrder.slice().reverse().map(id => publicJob(jobs.get(id), { includeLog: false }));
  res.json(list);
});

router.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(publicJob(job));
});

router.post('/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.status !== 'running') return res.status(400).json({ error: `job is ${job.status}` });
  try { job.controller.abort(); } catch (_) {}
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.status === 'running') {
    try { job.controller.abort(); } catch (_) {}
    job.status = 'cancelled';
    job.error = 'cancelled';
    job.finished_at = new Date().toISOString();
  }
  jobs.delete(req.params.id);
  const idx = jobOrder.indexOf(req.params.id);
  if (idx >= 0) jobOrder.splice(idx, 1);
  res.json({ success: true });
});

export default router;
