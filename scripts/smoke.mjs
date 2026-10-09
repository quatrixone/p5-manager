#!/usr/bin/env node
// End-to-end smoke test against a running P5 Manager instance. Runs on
// Linux and Windows alike; the Windows portable build's CI job uses it as
// the proof that the packaged app actually works there.
//
//   node scripts/smoke.mjs <base-url> <scratch-dir> [--sidecar]
//
// Touches only <scratch-dir> (created, then removed). Exits non-zero on the
// first failed check.
import fs from 'fs';
import path from 'path';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const [base = 'http://127.0.0.1:3001', scratchArg, ...flags] = process.argv.slice(2);
if (!scratchArg) { console.error('usage: smoke.mjs <base-url> <scratch-dir> [--sidecar]'); process.exit(2); }
const scratch = path.resolve(scratchArg);
const win = process.platform === 'win32';
const fwd = (p) => p.replace(/\\/g, '/');

const call = async (method, route, body, raw) => {
  const init = { method, headers: {} };
  if (raw !== undefined) { init.body = raw; init.headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(`${base}${route}`, init);
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}
  return { status: r.status, data, text };
};
const ok = async (method, route, body, raw) => {
  const r = await call(method, route, body, raw);
  assert.equal(r.status, 200, `${method} ${route} -> ${r.status} ${r.text.slice(0, 300)}`);
  return r.data;
};

let n = 0;
const step = async (name, fn) => {
  try { await fn(); n++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n     ${e.message}`); process.exit(1); }
};

fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(path.join(scratch, 'src', 'game', 'sys'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'dst'), { recursive: true });
fs.writeFileSync(path.join(scratch, 'src', 'game', 'eboot.bin'), Buffer.alloc(300_000, 7));
fs.writeFileSync(path.join(scratch, 'src', 'game', 'sys', 'param.json'), '{"a":1}');
fs.writeFileSync(path.join(scratch, 'src', 'single.pkg'), Buffer.alloc(50_000, 3));

await step('health', async () => {
  const d = await ok('GET', '/api/health');
  assert.equal(d.status, 'ok');
});

await step('platform matches the host', async () => {
  const d = await ok('GET', '/api/platform');
  assert.equal(d.os, process.platform);
  assert.equal(d.features.exfat, !win);
});

await step('web UI is served', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<div id="root">/);
});

await step('local roots exist and can be browsed', async () => {
  const d = await ok('GET', '/api/convert/local/roots');
  assert.ok(d.roots.length > 0, 'no roots');
  for (const root of d.roots) {
    assert.ok(!root.includes('\\'), `root has a backslash: ${root}`);
    const b = await ok('POST', '/api/convert/local/browse', { path: root });
    assert.equal(typeof b.path, 'string');
  }
  if (win) assert.ok(d.roots.some(r => /^[A-Za-z]:\/$/.test(r)), `no drive in ${d.roots}`);
});

await step("the UI's POSIX default paths open somewhere", async () => {
  for (const p of ['/mnt', '/data/downloads', '/data/mkpfs']) {
    const r = await call('POST', '/api/convert/local/browse', { path: p });
    // Linux hosts without that folder may 404; Windows must always map it.
    if (win) assert.equal(r.status, 200, `${p} -> ${r.status} ${r.text}`);
    else assert.ok([200, 404].includes(r.status), `${p} -> ${r.status}`);
  }
});

await step('browse a folder: forward slashes, parent, entries', async () => {
  const b = await ok('POST', '/api/convert/local/browse', { path: path.join(scratch, 'src') });
  assert.equal(b.path, fwd(path.join(scratch, 'src')));
  assert.equal(b.parent, fwd(scratch));
  assert.deepEqual(b.files.map(f => f.name).sort(), ['game', 'single.pkg']);
  // The same folder addressed the way the UI does it (forward slashes).
  const again = await ok('POST', '/api/convert/local/browse', { path: fwd(path.join(scratch, 'src')) });
  assert.equal(again.path, b.path);
});

await step('filesystem root has no parent', async () => {
  const b = await ok('POST', '/api/convert/local/browse', { path: path.parse(scratch).root });
  assert.equal(b.parent, null);
});

await step('system folders are blocked', async () => {
  const blocked = win ? `${process.env.SystemRoot}\\System32` : '/etc';
  const r = await call('POST', '/api/convert/local/browse', { path: blocked });
  assert.equal(r.status, 403);
});

await step('new folder', async () => {
  await ok('POST', '/api/convert/local/mkdir', { path: `${fwd(scratch)}/dst/made` });
  assert.ok(fs.statSync(path.join(scratch, 'dst', 'made')).isDirectory());
});

await step('upload from the browser keeps the folder structure', async () => {
  const q = new URLSearchParams({ kind: 'local', path: `${fwd(scratch)}/dst`, rel: 'up/deep/file.bin' });
  await ok('PUT', `/api/convert/upload?${q}`, undefined, Buffer.alloc(70_000, 9));
  assert.equal(fs.statSync(path.join(scratch, 'dst', 'up', 'deep', 'file.bin')).size, 70_000);
  const again = await call('PUT', `/api/convert/upload?${q}`, undefined, Buffer.alloc(10, 1));
  assert.equal(again.status, 409);
  const evil = new URLSearchParams({ kind: 'local', path: `${fwd(scratch)}/dst`, rel: '../escape.bin' });
  assert.equal((await call('PUT', `/api/convert/upload?${evil}`, undefined, Buffer.alloc(1))).status, 400);
});

await step('copy, move and delete on the server disk', async () => {
  const s = (p) => `${fwd(scratch)}/${p}`;
  await ok('POST', '/api/convert/local/copy', { src: s('src/single.pkg'), dst: s('dst/copy.pkg'), isDir: false });
  await ok('POST', '/api/convert/local/move', { src: s('dst/copy.pkg'), dst: s('dst/moved.pkg'), isDir: false });
  assert.equal(fs.statSync(path.join(scratch, 'dst', 'moved.pkg')).size, 50_000);
  assert.equal(fs.existsSync(path.join(scratch, 'dst', 'copy.pkg')), false);
  await ok('POST', '/api/convert/local/delete', { path: s('dst/moved.pkg'), isDir: false });
  assert.equal(fs.existsSync(path.join(scratch, 'dst', 'moved.pkg')), false);
});

await step('transfer queue copies a folder tree', async () => {
  const d = await ok('POST', '/api/convert/transfer/queue', {
    op: 'copy',
    src: { kind: 'local', items: [{ path: `${fwd(scratch)}/src/game`, is_dir: true }] },
    dst: { kind: 'local', path: `${fwd(scratch)}/dst` },
  });
  assert.equal(d.count, 2);
  await ok('POST', '/api/convert/ftp/upload/queue/resume');
  for (let i = 0; i < 60; i++) {
    const q = await ok('GET', '/api/convert/queue/all');
    const mine = q.upload.items.filter(it => it.batch_id === d.batch_id);
    const failed = mine.filter(it => it.status === 'failed');
    assert.equal(failed.length, 0, `failed: ${failed.map(f => f.error).join('; ')}`);
    if (mine.length && mine.every(it => it.status === 'completed')) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(fs.statSync(path.join(scratch, 'dst', 'game', 'eboot.bin')).size, 300_000);
  assert.equal(fs.readFileSync(path.join(scratch, 'dst', 'game', 'sys', 'param.json'), 'utf8'), '{"a":1}');
});

await step('a folder cannot be copied into itself', async () => {
  const r = await call('POST', '/api/convert/transfer/queue', {
    op: 'copy',
    src: { kind: 'local', items: [{ path: `${fwd(scratch)}/src/game`, is_dir: true }] },
    dst: { kind: 'local', path: `${fwd(scratch)}/src/game/sys` },
  });
  assert.equal(r.status, 400, r.text);
});

await step('payloads, profiles, settings and the user-data paths answer', async () => {
  // The app's own payloads come with it and are there without a download.
  const payloads = await ok('GET', '/api/payloads');
  assert.ok(Array.isArray(payloads));
  for (const name of ['rp-get-pin.elf', 'offact.elf', 'pkg-install.elf', 'rp-get-pin-ps4.bin', 'offact-ps4.bin']) {
    assert.ok(payloads.some(p => p.filename === name), `${name} is not among the payloads`);
  }
  assert.ok(Array.isArray(await ok('GET', '/api/profiles')));
  await ok('GET', '/api/settings');
  const p = await ok('GET', '/api/convert/paths');
  for (const k of ['payloads', 'mkpfs', 'downloads']) {
    assert.ok(!p[k].includes('\\'), `${k} has a backslash`);
    await ok('POST', '/api/convert/local/browse', { path: p[k] });
  }
});

await step('an archive is extracted to a folder of the user\'s choice', async () => {
  // Any folder the local browser may use, not just the app's own ones.
  const AdmZip = createRequire(new URL('../backend/package.json', import.meta.url))('adm-zip');
  const zip = new AdmZip();
  zip.addFile('inner/hello.txt', Buffer.from('hello'));
  const archive = path.join(scratch, 'src', 'smoke-archive.zip');
  zip.writeZip(archive);
  const dest = path.join(scratch, 'dst');
  const started = await ok('POST', '/api/convert/extract', { source: 'local-fs', local_path: fwd(archive), dest_kind: 'local-fs', dest_local_path: fwd(dest) });
  let job;
  for (let i = 0; i < 60; i++) {
    job = await ok('GET', `/api/convert/extract/${started.job_id}`);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(job.status, 'completed', `${job.status}: ${job.error || ''} ${String(job.log || '').slice(-400)}`);
  assert.equal(job.progress, 100, 'a finished job is at 100 %');
  const out = path.join(dest, 'smoke-archive', 'inner', 'hello.txt');
  assert.equal(fs.readFileSync(out, 'utf8'), 'hello');
});

await step('library reports an unreachable console cleanly', async () => {
  const r = await call('GET', '/api/library/127.0.0.1/overview');
  assert.equal(r.status, 502, r.text);
  assert.ok(['offline', 'stopped'].includes(r.data.reason), r.text);
  assert.equal(typeof r.data.error, 'string');
});

if (flags.includes('--sidecar')) {
  await step('Remote Play service is up and reachable through the backend', async () => {
    let last;
    for (let i = 0; i < 40; i++) {
      last = await call('GET', '/api/remoteplay/health');
      if (last.status === 200 && last.data && last.data.success !== false) return;
      await new Promise(r => setTimeout(r, 1000));
    }
    assert.fail(`sidecar not healthy: ${last.status} ${last.text.slice(0, 300)}`);
  });
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${n} checks passed on ${process.platform}`);
