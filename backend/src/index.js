// Entry point. Deliberately tiny and free of dependencies: it is the one
// file an in-app update can never replace, and it decides which copy of
// the app runs.
//
// The app proper is src/main.js. "Update" in the app (routes/update.js)
// unpacks a newer copy of the code - src/ and dist/ - into
// <data dir>/app-update/current and exits; the container's restart policy
// (or the Windows launcher) starts this file again, and it loads main.js
// from there instead of from the image.
//
// A downloaded copy brings no node_modules; it runs on the image's. So it
// is used only while it is newer than the image, is meant for this platform
// (Docker or the Windows package), was built against the same dependencies
// (deps-hash.mjs) and the image is recent enough for it
// (backend/image-level). It gets two attempts to start: main.js clears the
// attempt counter once it is up, and a copy that used both is set aside so
// the image's own code runs again.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { depsHash } from '../deps-hash.mjs';

const baseRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), 'data');
const updateDir = path.join(dataDir, 'app-update');
const MAX_BOOT_ATTEMPTS = 2;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
const parts = (v) => String(v || '').replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
function newer(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

const baseVersion = readJson(path.join(baseRoot, 'package.json'))?.version || '0.0.0';
let imageLevel = 1;
try { imageLevel = parseInt(fs.readFileSync(path.join(baseRoot, 'image-level'), 'utf8'), 10) || 1; } catch (_) {}
let baseDeps = '';
try { baseDeps = depsHash(path.join(baseRoot, 'package-lock.json')); } catch (_) {}
// The Windows package (its launcher sets P5M_PORTABLE) also holds the Remote
// Play service; `pydeps` there names the Python packages it was built with.
const platform = process.env.P5M_PORTABLE === '1' ? 'windows' : 'docker';
let basePydeps = '';
// The Remote Play service's folder was called pyremoteplay in earlier
// packages.
for (const dir of ['remoteplay', 'pyremoteplay']) {
  try { basePydeps = fs.readFileSync(path.resolve(baseRoot, `../${dir}/pydeps`), 'utf8').trim(); break; } catch (_) {}
}

function pickDownloadedCopy() {
  const current = path.join(updateDir, 'current');
  const manifest = readJson(path.join(current, 'manifest.json'));
  if (!manifest?.version || !fs.existsSync(path.join(current, 'src', 'main.js'))) return null;
  if (!newer(manifest.version, baseVersion)) {
    // The image caught up (or was replaced by a newer one): the copy is stale.
    fs.rmSync(current, { recursive: true, force: true });
    return null;
  }
  if ((parseInt(manifest.image_level, 10) || 1) > imageLevel) return null;
  if (!baseDeps || manifest.deps !== baseDeps) return null;
  if ((manifest.platform || 'docker') !== platform) return null;
  if (manifest.pydeps && manifest.pydeps !== basePydeps) return null;

  const bootFile = path.join(updateDir, 'boot.json');
  const boot = readJson(bootFile);
  const attempts = boot?.version === manifest.version ? (boot.attempts || 0) : 0;
  if (attempts >= MAX_BOOT_ATTEMPTS) {
    // Set it aside and go back to what ran before it: the copy it replaced
    // if there is one, else the image's own code.
    const failed = path.join(updateDir, 'failed');
    const previous = path.join(updateDir, 'previous');
    fs.rmSync(failed, { recursive: true, force: true });
    fs.renameSync(current, failed);
    fs.rmSync(bootFile, { force: true });
    const back = fs.existsSync(previous) ? readJson(path.join(previous, 'manifest.json'))?.version : null;
    if (back) fs.renameSync(previous, current);
    fs.writeFileSync(path.join(updateDir, 'result.json'), JSON.stringify({
      ok: false,
      version: manifest.version,
      message: `Version ${manifest.version} did not start; running ${back || baseVersion} again`,
      finished_at: new Date().toISOString(),
    }));
    console.error(`[update] ${manifest.version} did not start ${attempts} times - back to ${back || baseVersion}`);
    return back ? pickDownloadedCopy() : null;
  }
  fs.writeFileSync(bootFile, JSON.stringify({ version: manifest.version, attempts: attempts + 1 }));
  // Its imports resolve through this link to the image's dependencies
  // (a junction on Windows, which needs no special rights).
  const link = path.join(current, 'node_modules');
  let linked = false;
  try { linked = fs.realpathSync(link) === fs.realpathSync(path.join(baseRoot, 'node_modules')); } catch (_) {}
  if (!linked) {
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(path.join(baseRoot, 'node_modules'), link, 'junction');
  }
  return { root: current, version: manifest.version };
}

let picked = null;
try { picked = pickDownloadedCopy(); } catch (e) { console.error(`[update] ignoring the downloaded copy: ${e.message}`); }

// What the running code needs to know about the image it sits on.
process.env.P5M_BASE_ROOT = baseRoot;
process.env.P5M_BASE_VERSION = baseVersion;
process.env.P5M_IMAGE_LEVEL = String(imageLevel);
process.env.P5M_DEPS_HASH = baseDeps;
process.env.P5M_PLATFORM = platform;
process.env.P5M_PYDEPS = basePydeps;
if (picked && !process.env.BUILTIN_DIR) {
  // main.js finds the built-in lists next to itself; a downloaded copy has
  // none of its own and uses the image's (or the folder mounted over it).
  for (const dir of [path.join(baseRoot, 'builtin'), path.resolve(baseRoot, '../frontend/builtin')]) {
    if (fs.existsSync(dir)) { process.env.BUILTIN_DIR = dir; break; }
  }
}
if (picked) console.log(`[update] running ${picked.version} from ${picked.root} (image has ${baseVersion})`);

await import(pathToFileURL(path.join(picked ? picked.root : baseRoot, 'src', 'main.js')).href);
