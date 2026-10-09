#!/usr/bin/env node
// Builds the app bundles that the in-app Update installs (see
// backend/src/routes/update.js), one per platform:
//
//   p5-manager-app-<version>-docker-level<n>-deps<hash>.zip
//       backend sources + built web UI + the app's own payloads
//   p5-manager-app-<version>-windows-level<n>-deps<hash>-py<hash>.zip
//       the same plus the Remote Play service, which in the portable
//       Windows package lives next to the app (in Docker it is its own
//       image and is updated with it)
//
// Neither carries node_modules or Python packages - an updated app runs on
// the ones of the image / package it sits in, and the hashes in the name
// say which ones it was built against.
//
//   node scripts/build-app-bundle.mjs <out-dir> [--no-build] [--version X]
//
// Needs `npm ci` done in backend/ (for adm-zip) and, unless --no-build, in
// frontend/. --version overrides the version written into the bundle; CI
// uses it to test an update without publishing a release.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { depsHash, fileHash } from '../backend/deps-hash.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.join(root, 'backend');
const sidecar = path.join(root, 'remoteplay');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args.splice(i, 2)[1]; };
const versionOverride = flag('--version');
const noBuild = args.includes('--no-build');
const out = path.resolve(args.find(a => !a.startsWith('--')) || 'dist-bundle');

if (!noBuild) execSync('npm run build', { cwd: path.join(root, 'frontend'), stdio: 'inherit' });
if (!fs.existsSync(path.join(backend, 'dist', 'index.html'))) throw new Error('backend/dist is missing - build the frontend first');

const AdmZip = createRequire(path.join(backend, 'package.json'))('adm-zip');
const pkg = JSON.parse(fs.readFileSync(path.join(backend, 'package.json'), 'utf8'));
const version = versionOverride || pkg.version;
const level = parseInt(fs.readFileSync(path.join(backend, 'image-level'), 'utf8'), 10);
const deps = depsHash(path.join(backend, 'package-lock.json'));
const pydeps = fileHash(path.join(sidecar, 'requirements.txt'));

fs.mkdirSync(out, { recursive: true });
for (const platform of ['docker', 'windows']) {
  const zip = new AdmZip();
  zip.addLocalFolder(path.join(backend, 'src'), 'src', (name) => !name.endsWith('.test.js'));
  zip.addLocalFolder(path.join(backend, 'dist'), 'dist');
  // The app's own payloads (see backend/src/lib/defaultPayloads.js).
  for (const name of ['rp-get-pin', 'offact', 'pkg-install', 'save-mounter']) zip.addLocalFile(path.join(root, 'p5managerclient', name, `${name}.elf`), 'vendored');
  for (const name of ['rp-get-pin-ps4', 'offact-ps4']) zip.addLocalFile(path.join(root, 'p5managerclient', name, `${name}.bin`), 'vendored');
  zip.addFile('package.json', Buffer.from(JSON.stringify({ ...pkg, version }, null, 2)));
  const manifest = { version, platform, image_level: level, deps };
  let name = `p5-manager-app-${version}-${platform}-level${level}-deps${deps}`;
  if (platform === 'windows') {
    for (const f of ['server.py', 'chiaki_engine.py', 'ddp.py', 'psn_oauth.py']) zip.addLocalFile(path.join(sidecar, f), 'remoteplay');
    manifest.pydeps = pydeps;
    name += `-py${pydeps}`;
  }
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  const file = path.join(out, `${name}.zip`);
  zip.writeZip(file);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(`${file}.sha256`, `${sum}  ${name}.zip\n`);
  console.log(`${name}.zip  ${(fs.statSync(file).size / 1e6).toFixed(1)} MB  sha256 ${sum}`);
}
