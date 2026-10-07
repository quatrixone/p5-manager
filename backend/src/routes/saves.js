// File Ops -> Saves: save data on a PS5 - the console's own and PS4
// saves of backwards-compatible games - mounted read/write, backed up to
// this computer, and filled from a decrypted PS4 save.
//
// The PS5 side is save-mounter.elf (lib/saveMounter.js); the files go over
// FTP. A PS4 save leaves its console decrypted through Apollo Save Tool's
// "export decrypted save files", which writes a folder FTP can reach; that
// folder is copied into a save of the same game on the PS5.
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { Client as FtpClient } from 'basic-ftp';
import { getRepo, log } from '../db/sqlite.js';
import { userDataDir } from '../lib/paths.js';
import { getFtpPort } from '../lib/ftpPort.js';
import { VENDORED_PAYLOADS, vendoredSource } from '../lib/defaultPayloads.js';
import * as mounter from '../lib/saveMounter.js';
import { loadFtp, startZftpd, tcpPortOpen, sendElfPayload, ELF_LOADER_PORT } from './convert.js';

const router = express.Router();

export const savesBackupDir = path.join(userDataDir, 'saves');
// What the PS5 makes of a save's sce_sys is its own; a PS4's would carry
// the other console's account and keys.
const SKIP_DIRS = new Set(['sce_sys']);

function profileById(id) {
  const p = getRepo().queryOne('SELECT id, name, ip_address, console_type FROM profiles WHERE id = ?', [parseInt(id, 10)]);
  if (!p?.ip_address) throw Object.assign(new Error('no such console profile'), { status: 404 });
  return p;
}

async function startMounterPayload(ip) {
  if (!(await tcpPortOpen(ip, ELF_LOADER_PORT, 2000))) {
    throw Object.assign(new Error(`The ELF loader (port ${ELF_LOADER_PORT}) is not reachable on ${ip} - the console is off, asleep or not jailbroken yet`), { status: 409 });
  }
  const file = vendoredSource(VENDORED_PAYLOADS.find((e) => e.filename === 'save-mounter.elf'));
  if (!file) throw new Error('save-mounter.elf is not shipped with this installation');
  log('info', `sending save-mounter.elf to ${ip}`);
  await sendElfPayload(ip, ELF_LOADER_PORT, file);
}

async function connection(profile) {
  if (profile.console_type === 'ps4') {
    throw Object.assign(new Error('The save mounter runs on a PS5 - pick the PS5 profile'), { status: 400 });
  }
  return mounter.mounterFor(profile.ip_address, { start: startMounterPayload, portOpen: tcpPortOpen });
}

// What is mounted where, per console: { user, title, dir, mountPoint }.
const mounted = new Map();

const handle = (fn) => async (req, res) => {
  try {
    res.json({ success: true, ...(await fn(req, res)) });
  } catch (e) {
    res.status(e.status || 502).json({ success: false, error: e.message });
  }
};

function needUser(v) {
  if (!/^[0-9a-f]{1,8}$/i.test(String(v || ''))) throw Object.assign(new Error('user required'), { status: 400 });
  return String(v).toLowerCase();
}
function needTitle(v) {
  if (!mounter.validTitleId(v)) throw Object.assign(new Error('a title id like CUSA12345 or PPSA12345 is required'), { status: 400 });
  return v;
}
function needDir(v) {
  if (!mounter.validSaveDir(v)) throw Object.assign(new Error('a save name of letters, digits, - _ . (up to 31) is required'), { status: 400 });
  return v;
}

// ── PS5: browse, mount, create ──────────────────────────────────────────

router.get('/ps5/:pid/users', handle(async (req) => {
  const c = await connection(profileById(req.params.pid));
  return { firmware: await mounter.firmware(c), users: await mounter.users(c) };
}));

router.get('/ps5/:pid/titles', handle(async (req) => {
  const c = await connection(profileById(req.params.pid));
  return { titles: await mounter.titles(c, needUser(req.query.user)) };
}));

router.get('/ps5/:pid/saves', handle(async (req) => {
  const c = await connection(profileById(req.params.pid));
  return { saves: await mounter.saves(c, needUser(req.query.user), needTitle(req.query.title)) };
}));

router.get('/ps5/:pid/state', handle(async (req) => {
  const p = profileById(req.params.pid);
  return { mounted: mounted.get(p.ip_address) || null, running: await tcpPortOpen(p.ip_address, mounter.MOUNTER_PORT, 1200) };
}));

async function mountSave(p, user, title, dir) {
  const c = await connection(p);
  if (mounted.has(p.ip_address)) await unmountSave(p);
  const mountPoint = await mounter.mount(c, user, title, dir);
  mounted.set(p.ip_address, { user, title, dir, mountPoint });
  log('info', `save ${title}/${dir} mounted on ${p.ip_address} at ${mountPoint}`);
  return mountPoint;
}

async function createSave(p, user, title, dir, sizeMb) {
  const c = await connection(p);
  if (mounted.has(p.ip_address)) await unmountSave(p);
  const blocks = Math.max(1, Math.ceil((Number(sizeMb) || 32) * 1024 / 32));
  const mountPoint = await mounter.create(c, user, title, dir, blocks);
  mounted.set(p.ip_address, { user, title, dir, mountPoint });
  log('info', `save ${title}/${dir} created on ${p.ip_address} (${sizeMb} MB) at ${mountPoint}`);
  return mountPoint;
}

async function unmountSave(p) {
  const c = await connection(p);
  await mounter.unmount(c);
  mounted.delete(p.ip_address);
  log('info', `save unmounted on ${p.ip_address}`);
}

router.post('/ps5/:pid/mount', handle(async (req) => {
  const p = profileById(req.params.pid);
  const { user, title, dir } = req.body || {};
  return { mountPoint: await mountSave(p, needUser(user), needTitle(title), needDir(dir)) };
}));

router.post('/ps5/:pid/create', handle(async (req) => {
  const p = profileById(req.params.pid);
  const { user, title, dir, sizeMb } = req.body || {};
  const mb = Math.min(8192, Math.max(1, Number(sizeMb) || 32));
  return { mountPoint: await createSave(p, needUser(user), needTitle(title), needDir(dir), mb) };
}));

router.post('/ps5/:pid/unmount', handle(async (req) => {
  await unmountSave(profileById(req.params.pid));
  return {};
}));

router.post('/ps5/:pid/stop', handle(async (req) => {
  const p = profileById(req.params.pid);
  if (mounted.has(p.ip_address)) await unmountSave(p).catch(() => {});
  return { stopped: await mounter.stopMounter(p.ip_address) };
}));

// ── FTP ─────────────────────────────────────────────────────────────────

async function withFtp(ip, fn) {
  const opts = loadFtp();
  const port = getFtpPort(ip);
  const client = new FtpClient(30_000);
  client.ftp.verbose = false;
  try {
    try {
      await client.access({ host: ip, port, user: opts.username || 'anonymous', password: opts.password || '', secure: false });
    } catch (e) {
      if (!/ECONNREFUSED/.test(e.message || '')) throw e;
      await startZftpd(ip, port);
      await client.access({ host: ip, port, user: opts.username || 'anonymous', password: opts.password || '', secure: false });
    }
    return await fn(client);
  } finally {
    client.close();
  }
}

// A folder on a console, for picking the decrypted PS4 save.
router.get('/ftp/:pid/list', handle(async (req) => {
  const p = profileById(req.params.pid);
  const dir = String(req.query.path || '/');
  if (!dir.startsWith('/') || dir.includes('..')) throw Object.assign(new Error('bad path'), { status: 400 });
  const entries = await withFtp(p.ip_address, (c) => c.list(dir));
  return {
    path: dir,
    entries: entries
      .filter((e) => e.name !== '.' && e.name !== '..')
      .map((e) => ({ name: e.name, dir: e.isDirectory, size: e.size }))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name)),
  };
}));

async function downloadTree(client, remote, local, onFile) {
  fs.mkdirSync(local, { recursive: true });
  for (const e of await client.list(remote)) {
    if (e.name === '.' || e.name === '..') continue;
    const r = path.posix.join(remote, e.name);
    const l = path.join(local, e.name);
    if (e.isDirectory) await downloadTree(client, r, l, onFile);
    else { await client.downloadTo(l, r); onFile?.(r, e.size); }
  }
}

async function uploadTree(client, local, remote, onFile, top = true) {
  await client.ensureDir(remote);
  for (const name of fs.readdirSync(local)) {
    const l = path.join(local, name);
    const r = path.posix.join(remote, name);
    if (fs.statSync(l).isDirectory()) {
      if (top && SKIP_DIRS.has(name)) continue;
      await uploadTree(client, l, r, onFile, false);
    } else {
      await client.uploadFrom(l, r);
      onFile?.(r, fs.statSync(l).size);
    }
  }
}

function countFiles(dir, top = true) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    if (!fs.statSync(f).isDirectory()) n += 1;
    else if (!(top && SKIP_DIRS.has(name))) n += countFiles(f, false);
  }
  return n;
}

// ── jobs: transfer and backup ───────────────────────────────────────────

const jobs = new Map(); // id -> { id, kind, state, step, log[], error, result }

function newJob(kind, run) {
  const job = { id: crypto.randomBytes(6).toString('hex'), kind, state: 'running', step: '', log: [], files: 0, bytes: 0, error: null, result: null, started: Date.now() };
  const say = (step) => { job.step = step; job.log.push(step); if (job.log.length > 200) job.log.shift(); };
  job.say = say;
  jobs.set(job.id, job);
  (async () => {
    try {
      job.result = await run(job, say);
      job.state = 'done';
      say('Done');
    } catch (e) {
      job.state = 'failed';
      job.error = e.message;
      say(`Failed: ${e.message}`);
      log('error', `save ${kind} failed: ${e.message}`);
    }
    setTimeout(() => jobs.delete(job.id), 60 * 60 * 1000).unref?.();
  })();
  return job;
}

const publicJob = ({ say, ...j }) => j;

router.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'no such job' });
  res.json({ success: true, job: publicJob(job) });
});

function backupFolder(title, dir) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  return path.join(savesBackupDir, title, `${dir}_${stamp}`);
}

// Copies a save from the PS5 to this computer: mount, download, unmount.
router.post('/backup', handle(async (req) => {
  const p = profileById(req.body?.pid);
  const user = needUser(req.body?.user);
  const title = needTitle(req.body?.title);
  const dir = needDir(req.body?.dir);
  const job = newJob('backup', async (j, say) => {
    say(`Mounting ${title}/${dir}`);
    const mp = await mountSave(p, user, title, dir);
    const dest = backupFolder(title, dir);
    try {
      say(`Downloading to ${dest}`);
      await withFtp(p.ip_address, (c) => downloadTree(c, mp, dest, (f, size) => { j.files++; j.bytes += size || 0; j.step = `Downloaded ${j.files} files`; }));
    } finally {
      say('Unmounting');
      await unmountSave(p);
    }
    return { folder: dest };
  });
  return { job: publicJob(job) };
}));

// Saves backed up on this computer, newest first - also a source for
// "copy into a PS5 save".
router.get('/backups', handle(async () => {
  const out = [];
  if (fs.existsSync(savesBackupDir)) {
    for (const title of fs.readdirSync(savesBackupDir)) {
      const tdir = path.join(savesBackupDir, title);
      if (!fs.statSync(tdir).isDirectory()) continue;
      for (const name of fs.readdirSync(tdir)) {
        const f = path.join(tdir, name);
        if (fs.statSync(f).isDirectory()) out.push({ title, name, folder: f, modified: fs.statSync(f).mtime.toISOString() });
      }
    }
  }
  return { folder: savesBackupDir, backups: out.sort((a, b) => b.modified.localeCompare(a.modified)) };
}));

// Fills a PS5 save from a decrypted one: a folder on another console (the
// PS4's Apollo export, over FTP) or a backup on this computer. The PS5 save
// is mounted - or created first, when `create` gives its size - the files
// go in (not sce_sys), and it is unmounted, which writes it back.
router.post('/transfer', handle(async (req) => {
  const b = req.body || {};
  const target = profileById(b.toPid);
  const user = needUser(b.user);
  const title = needTitle(b.title);
  const dir = needDir(b.dir);
  let source;
  if (b.fromPid) {
    const from = profileById(b.fromPid);
    const remote = String(b.fromPath || '');
    if (!remote.startsWith('/') || remote.includes('..')) throw Object.assign(new Error('pick the folder of the decrypted save'), { status: 400 });
    source = { kind: 'console', profile: from, remote };
  } else {
    const local = path.resolve(String(b.fromFolder || ''));
    if (!local.startsWith(path.resolve(savesBackupDir) + path.sep) || !fs.existsSync(local)) {
      throw Object.assign(new Error('pick a backup from the list'), { status: 400 });
    }
    source = { kind: 'server', local };
  }
  const createMb = b.create ? Math.min(8192, Math.max(1, Number(b.create.sizeMb) || 32)) : 0;

  const job = newJob('transfer', async (j, say) => {
    let local = source.local;
    let temp = null;
    if (source.kind === 'console') {
      temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p5m-save-'));
      local = temp;
      say(`Downloading ${source.remote} from ${source.profile.name}`);
      await withFtp(source.profile.ip_address, (c) => downloadTree(c, source.remote, temp, () => { j.files++; j.step = `Downloaded ${j.files} files from ${source.profile.name}`; }));
      if (j.files === 0) throw new Error(`${source.remote} has no files - is it the folder of the decrypted save?`);
    }
    try {
      const total = countFiles(local);
      say(createMb ? `Creating ${title}/${dir} (${createMb} MB) on ${target.name}` : `Mounting ${title}/${dir} on ${target.name}`);
      const mp = createMb ? await createSave(target, user, title, dir, createMb) : await mountSave(target, user, title, dir);
      let sent = 0;
      try {
        say(`Copying ${total} files into the save`);
        await withFtp(target.ip_address, (c) => uploadTree(c, local, mp, () => { sent++; j.step = `Copied ${sent} of ${total} files`; }));
      } finally {
        say('Unmounting (writes the save back)');
        await unmountSave(target);
      }
      log('info', `save ${title}/${dir} on ${target.name} filled with ${sent} files`);
      return { files: sent };
    } finally {
      if (temp) fs.rmSync(temp, { recursive: true, force: true });
    }
  });
  return { job: publicJob(job) };
}));

export default router;
