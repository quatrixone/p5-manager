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
import path from 'path';
import crypto from 'crypto';
import { Client as FtpClient } from 'basic-ftp';
import { getRepo, log } from '../db/sqlite.js';
import { userDataDir } from '../lib/paths.js';
import { getFtpPort } from '../lib/ftpPort.js';
import { VENDORED_PAYLOADS, vendoredSource } from '../lib/defaultPayloads.js';
import * as mounter from '../lib/saveMounter.js';
import { PS4_EXPORT_PAYLOAD, listPs4Saves, mountPs4Save, unmountPs4Save, validPs4User } from '../lib/ps4SaveExport.js';
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

// ── PS4: its own saves, exported by our payload ─────────────────────────

// The payload is not vendored with the app; it comes from the payload
// library, where the PS4 tab puts it.
function ps4ExportPayload() {
  const entry = VENDORED_PAYLOADS.find((e) => e.filename === PS4_EXPORT_PAYLOAD);
  const vendored = entry && vendoredSource(entry);
  if (vendored && fs.existsSync(vendored)) return fs.readFileSync(vendored);
  const row = getRepo().queryOne('SELECT filepath FROM payloads WHERE filename = ? ORDER BY id DESC LIMIT 1', [PS4_EXPORT_PAYLOAD]);
  if (row?.filepath && fs.existsSync(row.filepath)) return fs.readFileSync(row.filepath);
  throw Object.assign(new Error(`${PS4_EXPORT_PAYLOAD} is not in the payload library - add it under Payloads first`), { status: 409 });
}

// One export at a time per console: the payload keeps a single mount, and a
// second MOUNT or UMOUNT would pull it out from under the first.
const ps4Busy = new Set();

// Every save on the PS4, read off its drive - no payload, nothing to run on
// the console, and nothing on it is changed.
router.get('/ps4/:pid/saves', handle(async (req) => {
  const p = profileById(req.params.pid);
  return { saves: await withFtp(p.ip_address, (c) => listPs4Saves(c)) };
}));

// Mounts a save on the PS4, copies it off decrypted and unmounts again.
// The folder it writes is the backup of that save: nothing else on this
// computer can read the console's own copy.
async function exportPs4Save(job, say, profile, payload, save, dest) {
  const ip = profile.ip_address;
  if (ps4Busy.has(ip)) throw Object.assign(new Error(`${profile.name} is already exporting a save`), { status: 409 });
  ps4Busy.add(ip);
  try {
    await withFtp(ip, async (c) => {
      say(`Mounting ${save.title}/${save.dir} on ${profile.name}`);
      const m = await mountPs4Save(c, ip, payload, save);
      try {
        say(`Copying the decrypted save off ${profile.name}`);
        await downloadTree(c, m.mountPoint, dest, () => { job.files++; job.step = `Copied ${job.files} files from ${profile.name}`; });
      } finally {
        say(`Unmounting on ${profile.name}`);
        await unmountPs4Save(c, ip, payload).catch((e) => say(`Could not unmount: ${e.message}`));
      }
    });
  } finally {
    ps4Busy.delete(ip);
  }
  if (job.files === 0) throw new Error('the mounted PS4 save had no files in it');
  return dest;
}

// Copies a PS4 save to this computer, decrypted, with no PS5 involved.
router.post('/ps4/:pid/export', handle(async (req) => {
  const p = profileById(req.params.pid);
  const b = req.body || {};
  if (!validPs4User(b.user)) throw Object.assign(new Error('pick the PS4 user the save belongs to'), { status: 400 });
  const save = { user: String(b.user).toLowerCase(), title: needTitle(b.title), dir: needDir(b.dir) };
  const payload = ps4ExportPayload();
  const job = newJob('export', async (j, say) => ({
    folder: await exportPs4Save(j, say, p, payload, save, backupFolder(save.title, `${save.dir}-from-ps4`)),
  }));
  return { job: publicJob(job) };
}));

// ── PS4: the decrypted saves Apollo has exported ────────────────────────

// Where Apollo Save Tool writes "export decrypted save files": a USB drive,
// the external-HDD fakeusb, or its own data folder.
const APOLLO_DIRS = ['/mnt/usb0/PS4/APOLLO/', '/mnt/usb1/PS4/APOLLO/', '/data/fakeusb/PS4/APOLLO/', '/data/apollo/'];

// An export folder is named after the game and the save and nothing inside
// says which game it is, so the name is all there is to go on.
export function parseApolloFolder(name) {
  const m = /^([A-Z]{4}\d{5})[-_ ]?(.*)$/i.exec(String(name || ''));
  if (!m) return null;
  return {
    title: m[1].toUpperCase(),
    dir: (m[2] || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 31) || 'SAVEDATA00',
  };
}

router.get('/ps4/:pid/exports', handle(async (req) => {
  const p = profileById(req.params.pid);
  const out = [];
  await withFtp(p.ip_address, async (c) => {
    for (const base of APOLLO_DIRS) {
      let entries;
      try { entries = await c.list(base); } catch (_) { continue; } // no such drive
      for (const e of entries) {
        const parsed = e.isDirectory && parseApolloFolder(e.name);
        if (parsed) out.push({ ...parsed, name: e.name, path: base + e.name });
      }
    }
  });
  return { dirs: APOLLO_DIRS, exports: out };
}));

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
// Both sides are backed up to this computer first, always: the PS4 export
// because it is the only decrypted copy, the PS5 save because the files
// going in replace it.
router.post('/transfer', handle(async (req) => {
  const b = req.body || {};
  const target = profileById(b.toPid);
  const user = needUser(b.user);
  const title = needTitle(b.title);
  const dir = needDir(b.dir);
  let source;
  if (b.fromSave) {
    // The PS4's own save: our payload mounts it decrypted, no Apollo run.
    const from = profileById(b.fromSave.pid);
    if (!validPs4User(b.fromSave.user)) throw Object.assign(new Error('pick the PS4 user the save belongs to'), { status: 400 });
    source = {
      kind: 'ps4save',
      profile: from,
      save: { user: String(b.fromSave.user).toLowerCase(), title: needTitle(b.fromSave.title), dir: needDir(b.fromSave.dir) },
      payload: ps4ExportPayload(),
    };
  } else if (b.fromPid) {
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
    let ps4Backup = null;
    if (source.kind === 'ps4save') {
      // The decrypted copy is kept, exactly as an Apollo export would be:
      // it is the only readable copy of that save on this computer.
      ps4Backup = await exportPs4Save(j, say, source.profile, source.payload, source.save,
        backupFolder(title, `${dir}-from-ps4`));
      local = ps4Backup;
    } else if (source.kind === 'console') {
      // The PS4's export is backed up here, not staged in a temp dir: it is
      // the only decrypted copy of that save, and the transfer overwrites
      // nothing on this computer by keeping it.
      ps4Backup = backupFolder(title, `${dir}-from-ps4`);
      local = ps4Backup;
      say(`Backing up ${source.remote} from ${source.profile.name}`);
      await withFtp(source.profile.ip_address, (c) => downloadTree(c, source.remote, ps4Backup, () => { j.files++; j.step = `Copied ${j.files} files from ${source.profile.name}`; }));
      if (j.files === 0) throw new Error(`${source.remote} has no files - is it the folder of the decrypted save?`);
    }
    const total = countFiles(local);
    say(createMb ? `Creating ${title}/${dir} (${createMb} MB) on ${target.name}` : `Mounting ${title}/${dir} on ${target.name}`);
    const mp = createMb ? await createSave(target, user, title, dir, createMb) : await mountSave(target, user, title, dir);
    let sent = 0;
    let ps5Backup = null;
    try {
      if (!createMb) {
        // Never overwrite a save without a copy of what was in it.
        ps5Backup = backupFolder(title, dir);
        say('Backing up the PS5 save it replaces');
        await withFtp(target.ip_address, (c) => downloadTree(c, mp, ps5Backup));
      }
      say(`Copying ${total} files into the save`);
      await withFtp(target.ip_address, (c) => uploadTree(c, local, mp, () => { sent++; j.step = `Copied ${sent} of ${total} files`; }));
    } finally {
      say('Unmounting (writes the save back)');
      await unmountSave(target);
    }
    log('info', `save ${title}/${dir} on ${target.name} filled with ${sent} files`);
    return { files: sent, ps4Backup, ps5Backup };
  });
  return { job: publicJob(job) };
}));

export default router;
