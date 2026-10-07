#!/usr/bin/env node
// End-to-end check of the in-app update against a running instance, without
// publishing a release. Serves the bundles in <bundle-dir> the way GitHub
// serves the `updates` release, tells the app to update and waits for it to
// come back as <version>.
//
//   node scripts/update-check.mjs <base-url> <bundle-dir> <version> [--sidecar]
//
// The instance has to be started with
//   P5M_UPDATE_FEED=http://127.0.0.1:39918/latest
// and by something that starts it again when it exits with code 75 (the
// Windows launcher; in CI on Linux a shell loop). Bundles for the check come
// from `node scripts/build-app-bundle.mjs <bundle-dir> --version <version>`.
// --sidecar also waits for the Remote Play service to answer afterwards.
import fs from 'fs';
import http from 'http';
import path from 'path';

const [base, bundleDir, version, ...flags] = process.argv.slice(2);
if (!base || !bundleDir || !version) {
  console.error('usage: update-check.mjs <base-url> <bundle-dir> <version> [--sidecar]');
  process.exit(2);
}
const FEED_PORT = 39918;
const dir = path.resolve(bundleDir);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

http.createServer((req, res) => {
  if (req.url === '/latest') {
    const assets = fs.readdirSync(dir).filter(f => f.startsWith('p5-manager-app-')).map(name => ({
      name, size: fs.statSync(path.join(dir, name)).size, browser_download_url: `http://127.0.0.1:${FEED_PORT}/${name}`,
    }));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ tag_name: 'updates', assets }));
  }
  const file = path.join(dir, path.basename(req.url));
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  fs.createReadStream(file).pipe(res);
}).listen(FEED_PORT, '127.0.0.1');

const get = async (p) => {
  try { const r = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(5000) }); return r.ok ? await r.json() : null; }
  catch (_) { return null; }
};
async function until(what, seconds, fn) {
  for (let i = 0; i < seconds; i++) { const v = await fn(); if (v) return v; await sleep(1000); }
  throw new Error(`timed out waiting for ${what}`);
}

try {
  await until('the app to answer', 120, () => get('/api/health'));
  const before = await until('the update check', 30, () => get('/api/update/status?refresh=1'));
  console.log(`running ${before.current}, offered ${before.latest?.version}`);
  if (!before.update_available || !before.can_apply) throw new Error(`update not offered: ${before.blocked_reason || before.check_error || 'no newer version seen'}`);
  const applied = await fetch(`${base}/api/update/apply`, { method: 'POST' });
  if (!applied.ok) throw new Error(`apply answered ${applied.status}: ${await applied.text()}`);
  const after = await until(`version ${version}`, 180, async () => {
    const s = await get('/api/update/status');
    if (s?.job?.state === 'failed') throw new Error(`update failed: ${s.job.error}`);
    return s?.current === version ? s : null;
  });
  console.log(`now running ${after.current} on image ${after.image_version}: ${after.last_result?.message}`);
  if (flags.includes('--sidecar')) {
    await until('the Remote Play service', 90, async () => (await get('/api/remoteplay/health'))?.success);
    console.log('Remote Play service answers');
  }
  // Long enough for the app to call this copy good (it clears the loader's
  // attempt counter after 15 s) and still be up.
  await sleep(17000);
  if (!(await get('/api/health'))) throw new Error('the updated app stopped answering');
  console.log('ok');
  process.exit(0);
} catch (e) {
  console.error(`update check failed: ${e.message}`);
  process.exit(1);
}
