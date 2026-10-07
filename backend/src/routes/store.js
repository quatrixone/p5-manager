// Tools -> Marketplace: Autoload templates, input scripts and homebrew
// apps shared by users. They live in store/ of the repository
// (lib/storeItem.js says what an item is); the app reads store/index.json
// and the items from GitHub, installs them, and turns the user's own
// scripts and sequences into a prefilled GitHub issue to publish them -
// accepted ones are added by a workflow and listed after review.
//
// Homebrew is only linked: its files come from the author's release page,
// checked against the SHA-256 the listing pins. Payloads (.elf/.bin/.lua)
// go into the payload library; a PS5 .pkg into the install queue; a PS4
// .pkg to the console's Remote Package Installer, which fetches it from
// this server.
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable, Transform } from 'stream';
import { getRepo, log } from '../db/sqlite.js';
import { downloadsDir, payloadsDir } from '../lib/paths.js';
import { insertPayload } from '../lib/defaultPayloads.js';
import {
  STORE_REPO, STORE_BRANCH, validateStoreItem, storeDir, itemFromScript, itemFromSequence, slugify, homebrewFileName,
} from '../lib/storeItem.js';

const router = express.Router();

const STORE_BASE = (process.env.P5M_STORE_URL || `https://raw.githubusercontent.com/${STORE_REPO}/${STORE_BRANCH}/store/`).replace(/\/?$/, '/');
const INDEX_TTL_MS = 10 * 60 * 1000;
// GitHub refuses longer new-issue links; what does not fit is pasted.
const MAX_ISSUE_URL = 7500;

let indexCache = { at: 0, data: null };

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw Object.assign(new Error(`the marketplace answered ${r.status}`), { status: 502 });
  return r.json();
}

async function storeIndex(force = false) {
  if (!force && indexCache.data && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.data;
  const data = await fetchJson(`${STORE_BASE}index.json`);
  if (!Array.isArray(data?.items)) throw Object.assign(new Error('the marketplace index is not usable'), { status: 502 });
  indexCache = { at: Date.now(), data };
  return data;
}

async function storeItem(kind, id) {
  const index = await storeIndex();
  const entry = index.items.find((i) => i.kind === kind && i.id === id);
  if (!entry) throw Object.assign(new Error('no such item in the marketplace'), { status: 404 });
  const item = await fetchJson(`${STORE_BASE}${storeDir(kind)}/${id}.json`);
  const errors = validateStoreItem(item);
  if (errors.length) throw Object.assign(new Error(`the item is not usable: ${errors.join('; ')}`), { status: 502 });
  if (item.kind !== kind || item.id !== id) throw Object.assign(new Error('the item does not match its listing'), { status: 502 });
  return item;
}

function installs() {
  return getRepo().queryAll('SELECT kind, store_id, version, name, local_id, installed_at FROM store_installs');
}

const handle = (fn) => async (req, res) => {
  try {
    res.json({ success: true, ...(await fn(req, res)) });
  } catch (e) {
    if (!e.status || e.status >= 500) log('error', `store: ${e.message}`);
    res.status(e.status || 502).json({ success: false, error: e.message });
  }
};

router.get('/index', handle(async (req) => {
  const index = await storeIndex(req.query.refresh === '1');
  const mine = new Map(installs().map((i) => [`${i.kind}:${i.store_id}`, i]));
  return {
    generated: index.generated || null,
    repo: STORE_REPO,
    items: index.items.map((i) => {
      const have = mine.get(`${i.kind}:${i.id}`);
      return { ...i, installed: have ? have.version : null, update: !!have && i.version > have.version };
    }),
  };
}));

// The whole item, to look at before installing.
router.get('/item/:kind/:id', handle(async (req) => ({ item: await storeItem(req.params.kind, req.params.id) })));

router.post('/install', handle(async (req) => {
  const { kind, id } = req.body || {};
  if (kind === 'homebrew') return installHomebrew(id, req.body?.profileId);
  const item = await storeItem(kind, id);
  const repo = getRepo();
  const have = repo.queryOne('SELECT local_id FROM store_installs WHERE kind = ? AND store_id = ?', [kind, id]);
  let localId = have?.local_id || null;
  if (kind === 'script') {
    const exists = localId && repo.queryOne('SELECT id FROM input_scripts WHERE id = ?', [localId]);
    if (exists) {
      repo.run('UPDATE input_scripts SET name = ?, script = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [item.name, item.script, localId]);
    } else {
      localId = repo.runAndSave('INSERT INTO input_scripts (name, script) VALUES (?, ?)', [item.name, item.script]);
    }
  }
  repo.run(
    `INSERT INTO store_installs (kind, store_id, version, name, data, local_id) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, store_id) DO UPDATE SET version = excluded.version, name = excluded.name, data = excluded.data,
       local_id = excluded.local_id, installed_at = CURRENT_TIMESTAMP`,
    [kind, id, item.version, item.name, JSON.stringify(item), localId],
  );
  repo.save();
  log('info', `marketplace: installed ${kind} "${item.name}" v${item.version} by ${item.author}`);
  return { installed: item.version, localId };
}));

router.post('/uninstall', handle(async (req) => {
  const { kind, id } = req.body || {};
  const repo = getRepo();
  const have = repo.queryOne('SELECT local_id FROM store_installs WHERE kind = ? AND store_id = ?', [kind, id]);
  if (!have) throw Object.assign(new Error('not installed'), { status: 404 });
  if (kind === 'script' && have.local_id) repo.run('DELETE FROM input_scripts WHERE id = ?', [have.local_id]);
  repo.run('DELETE FROM store_installs WHERE kind = ? AND store_id = ?', [kind, id]);
  repo.save();
  return {};
}));

// Templates from the marketplace, in the shape of the built-in ones, for
// the Autoload template gallery.
export function installedTemplates() {
  try {
    return getRepo().queryAll("SELECT data FROM store_installs WHERE kind = 'template' ORDER BY name").map((r) => {
      const item = JSON.parse(r.data);
      return {
        id: `store:${item.id}`,
        name: item.name,
        description: item.description,
        ...(item.console_type ? { console_type: item.console_type } : {}),
        requiresProfile: item.requiresProfile !== false,
        ...(item.autoTrigger ? { autoTrigger: item.autoTrigger } : {}),
        steps: item.steps,
        store: { id: item.id, author: item.author, version: item.version },
      };
    });
  } catch (e) {
    log('error', `marketplace templates: ${e.message}`);
    return [];
  }
}

// A sequence's steps as another installation can run them: its own
// scripts and payloads are known there only by name, not by id.
function portableSteps(steps) {
  const repo = getRepo();
  return steps.map((s) => {
    const out = { ...s };
    if (s.type === 'input_script' && !s.script && s.scriptId && !String(s.scriptId).startsWith('builtin:')) {
      const row = repo.queryOne('SELECT script FROM input_scripts WHERE id = ?', [parseInt(s.scriptId, 10)]);
      if (!row) throw Object.assign(new Error(`step "${s.name || 'input script'}" uses a script that no longer exists`), { status: 400 });
      out.script = row.script;
      delete out.scriptId;
      delete out.builtin;
    }
    if (s.type === 'payload' && s.payloadId) {
      const row = repo.queryOne('SELECT filename FROM payloads WHERE id = ?', [parseInt(s.payloadId, 10)]);
      if (row?.filename) out.payloadName = row.filename;
      delete out.payloadId;
    }
    return out;
  });
}

// Builds the item for one of the user's scripts or sequences and the link
// to the GitHub issue that submits it.
router.post('/publish', handle(async (req) => {
  const { kind, localId, description, author, console_type: consoleType } = req.body || {};
  const repo = getRepo();
  const meta = { description: String(description || '').trim(), author: String(author || '').trim(), console_type: consoleType || undefined };
  let item;
  if (kind === 'script') {
    const row = repo.queryOne('SELECT name, script FROM input_scripts WHERE id = ?', [parseInt(localId, 10)]);
    if (!row) throw Object.assign(new Error('no such script'), { status: 404 });
    item = itemFromScript(row, { ...meta, id: slugify(row.name) });
  } else if (kind === 'template') {
    const row = repo.queryOne('SELECT name, steps, auto_trigger FROM autoload_sequences WHERE id = ?', [parseInt(localId, 10)]);
    if (!row) throw Object.assign(new Error('no such sequence'), { status: 404 });
    item = itemFromSequence({ ...row, steps: portableSteps(JSON.parse(row.steps)) }, { ...meta, id: slugify(row.name) });
  } else {
    throw Object.assign(new Error('kind has to be "script" or "template"'), { status: 400 });
  }
  const errors = validateStoreItem(item);
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400 });

  const json = JSON.stringify(item, null, 2);
  const base = `https://github.com/${STORE_REPO}/issues/new?template=store-submission.yml`
    + `&title=${encodeURIComponent(`[store] ${item.name}`)}&labels=store-submission`;
  const full = `${base}&item=${encodeURIComponent(json)}`;
  const fits = full.length <= MAX_ISSUE_URL;
  return { item, json, issueUrl: fits ? full : base, prefilled: fits };
}));

// ── homebrew ────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
const API = `http://127.0.0.1:${PORT}/api`;
const RPI_PORT = 12800; // Remote Package Installer on a PS4
const jobs = new Map(); // id -> { id, state, step, log[], error, result }
const pkgLinks = new Map(); // token -> { file, until }

function newJob(run) {
  const job = { id: crypto.randomBytes(6).toString('hex'), state: 'running', step: '', log: [], error: null, result: null };
  const say = (step) => { job.step = step; job.log.push(step); };
  jobs.set(job.id, job);
  (async () => {
    try {
      job.result = await run(job, say);
      job.state = 'done';
    } catch (e) {
      job.state = 'failed';
      job.error = e.message;
      say(`Failed: ${e.message}`);
      log('error', `marketplace install failed: ${e.message}`);
    }
    setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000).unref?.();
  })();
  return job;
}

router.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'no such job' });
  res.json({ success: true, job });
});

// Downloads `f` into `dir`, checking its SHA-256 (and size) on the way.
async function downloadChecked(f, dir, onProgress) {
  const name = homebrewFileName(f);
  const dest = path.join(dir, name);
  if (fs.existsSync(dest)) {
    const have = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    if (have === f.sha256) return dest;
  }
  fs.mkdirSync(dir, { recursive: true });
  const r = await fetch(f.url, { redirect: 'follow', signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (!r.ok || !r.body) throw new Error(`download of ${name} failed: HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || f.size || 0;
  const hash = crypto.createHash('sha256');
  let got = 0;
  const tmp = `${dest}.part`;
  await pipeline(
    Readable.fromWeb(r.body),
    new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        got += chunk.length;
        onProgress?.(got, total);
        cb(null, chunk);
      },
    }),
    fs.createWriteStream(tmp),
  );
  const sum = hash.digest('hex');
  if (sum !== f.sha256 || (f.size && got !== f.size)) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${name} is not the file the marketplace lists (checksum ${sum.slice(0, 12)}…) - not installing it`);
  }
  fs.renameSync(tmp, dest);
  return dest;
}

// This server's address as the console sees it.
function localAddressTowards(ip, port) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: ip, port });
    s.setTimeout(3000, () => { s.destroy(); reject(new Error(`the console does not answer on port ${port}`)); });
    s.once('connect', () => { const a = s.localAddress; s.destroy(); resolve(a.replace(/^::ffff:/, '')); });
    s.once('error', () => reject(new Error(`nothing answers on ${ip}:${port}`)));
  });
}

// The Remote Package Installer fetches a .pkg itself, over HTTP, from here.
router.get('/pkg/:token/:name', (req, res) => {
  const link = pkgLinks.get(req.params.token);
  if (!link || link.until < Date.now() || path.basename(link.file) !== req.params.name) {
    return res.status(404).json({ error: 'no such package' });
  }
  res.sendFile(link.file);
});

async function rpi(ip, endpoint, body) {
  const r = await fetch(`http://${ip}:${RPI_PORT}/api/${endpoint}`, {
    method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error(`Remote Package Installer answered: ${text.slice(0, 200)}`); }
  if (data.status && data.status !== 'success') throw new Error(`Remote Package Installer: ${data.error || data.status}`);
  return data;
}

async function installPs4Pkg(ip, file, say) {
  const local = await localAddressTowards(ip, RPI_PORT).catch(() => {
    throw new Error(`Remote Package Installer is not open on the PS4 (${ip}:${RPI_PORT}) - start it from the home screen (GoldHEN), then try again`);
  });
  const token = crypto.randomBytes(12).toString('hex');
  pkgLinks.set(token, { file, until: Date.now() + 6 * 60 * 60 * 1000 });
  const url = `http://${local}:${PORT}/api/store/pkg/${token}/${encodeURIComponent(path.basename(file))}`;
  say(`Asking the PS4 to install ${path.basename(file)}`);
  const started = await rpi(ip, 'install', { type: 'direct', packages: [url] });
  const taskId = started.task_id;
  if (!taskId) return { queued: true };
  for (let i = 0; i < 3600; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let p;
    try { p = await rpi(ip, 'get_task_progress', { task_id: taskId }); } catch (_) { continue; }
    const total = Number(p.length || p.length_total || 0);
    const done = Number(p.transferred || p.transferred_total || 0);
    if (total) say(`Installing on the PS4: ${Math.floor((done / total) * 100)} %`);
    if (p.error && Number(p.error) !== 0) throw new Error(`the PS4 reported error ${p.error}`);
    if (total && done >= total) return { installed: true };
  }
  return { queued: true };
}

async function installHomebrew(id, profileId) {
  const item = await storeItem('homebrew', id);
  const needsConsole = item.files.some((f) => f.type === 'pkg');
  let profile = null;
  if (needsConsole) {
    profile = getRepo().queryOne('SELECT id, name, ip_address, console_type FROM profiles WHERE id = ?', [parseInt(profileId, 10)]);
    if (!profile?.ip_address) throw Object.assign(new Error('pick the console to install it on'), { status: 400 });
    if ((profile.console_type || 'ps5') !== item.console_type) {
      throw Object.assign(new Error(`this is a ${item.console_type.toUpperCase()} app and ${profile.name} is not one`), { status: 400 });
    }
  }
  const job = newJob(async (j, say) => {
    const dir = path.join(downloadsDir, 'store', item.id);
    const done = [];
    for (const f of item.files) {
      const name = homebrewFileName(f);
      say(`Downloading ${name}`);
      const file = await downloadChecked(f, dir, (got, total) => {
        j.step = total ? `Downloading ${name}: ${Math.floor((got / total) * 100)} %` : `Downloading ${name}: ${(got / 1e6).toFixed(1)} MB`;
      });
      if (f.type === 'pkg') {
        if (item.console_type === 'ps5') {
          say(`Adding ${name} to the install queue`);
          const r = await fetch(`${API}/convert/install/queue`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: profile.ip_address, source_kind: 'local', local_path: file }),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || `install queue answered ${r.status}`);
          done.push(`${name}: in the install queue (File Ops → Tasks)`);
        } else {
          await installPs4Pkg(profile.ip_address, file, say);
          done.push(`${name}: installed on ${profile.name}`);
        }
      } else {
        const dest = path.join(payloadsDir, name);
        fs.copyFileSync(file, dest);
        insertPayload({ name, filename: name, filepath: dest, source_url: f.url, size: fs.statSync(dest).size, version: item.app_version, console_type: item.console_type });
        done.push(`${name}: in the payload library`);
      }
    }
    getRepo().run(
      `INSERT INTO store_installs (kind, store_id, version, name, data, local_id) VALUES ('homebrew', ?, ?, ?, ?, NULL)
       ON CONFLICT(kind, store_id) DO UPDATE SET version = excluded.version, name = excluded.name, data = excluded.data,
         installed_at = CURRENT_TIMESTAMP`,
      [item.id, item.version, item.name, JSON.stringify(item)],
    );
    getRepo().save();
    log('info', `marketplace: installed homebrew "${item.name}" ${item.app_version || ''} (${done.join('; ')})`);
    say(done.join(' · '));
    return { done };
  });
  return { job };
}

export default router;
