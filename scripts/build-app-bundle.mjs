#!/usr/bin/env node
// Builds the app bundle that the in-app Update installs (see
// backend/src/routes/update.js): the backend sources and the built web UI,
// without node_modules - an updated app runs on the dependencies of the
// image it sits in.
//
//   node scripts/build-app-bundle.mjs <out-dir> [--no-build]
//
// Needs `npm ci` done in backend/ (for adm-zip) and, unless --no-build, in
// frontend/. Writes p5-manager-app-<version>-level<n>-deps<hash>.zip and
// the matching .sha256 into <out-dir>.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { depsHash } from '../backend/deps-hash.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.join(root, 'backend');
const [outArg = 'dist-bundle', ...flags] = process.argv.slice(2);
const out = path.resolve(outArg);

if (!flags.includes('--no-build')) execSync('npm run build', { cwd: path.join(root, 'frontend'), stdio: 'inherit' });
if (!fs.existsSync(path.join(backend, 'dist', 'index.html'))) throw new Error('backend/dist is missing - build the frontend first');

const AdmZip = createRequire(path.join(backend, 'package.json'))('adm-zip');
const version = JSON.parse(fs.readFileSync(path.join(backend, 'package.json'), 'utf8')).version;
const level = parseInt(fs.readFileSync(path.join(backend, 'image-level'), 'utf8'), 10);
const deps = depsHash(path.join(backend, 'package-lock.json'));

const zip = new AdmZip();
zip.addLocalFolder(path.join(backend, 'src'), 'src', (name) => !name.endsWith('.test.js'));
zip.addLocalFolder(path.join(backend, 'dist'), 'dist');
zip.addLocalFile(path.join(backend, 'package.json'));
zip.addFile('manifest.json', Buffer.from(JSON.stringify({ version, image_level: level, deps }, null, 2)));

fs.mkdirSync(out, { recursive: true });
const name = `p5-manager-app-${version}-level${level}-deps${deps}.zip`;
const file = path.join(out, name);
zip.writeZip(file);
const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.writeFileSync(`${file}.sha256`, `${sum}  ${name}\n`);
console.log(`${name}  ${(fs.statSync(file).size / 1e6).toFixed(1)} MB  sha256 ${sum}`);
