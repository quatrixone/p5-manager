// Turns an accepted marketplace submission (the issue's body) into a file in
// store/: validates it, fills in the checksum and size of homebrew files by
// downloading them once, gives a changed item the next version, and rebuilds
// store/index.json. Used by .github/workflows/store.yml.
//
//   node scripts/store-accept.mjs <file with the issue body>
// Prints the path it wrote.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { validateStoreItem, storeDir } from '../backend/src/lib/storeItem.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const body = fs.readFileSync(process.argv[2], 'utf8');
const block = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(body);
if (!block) throw new Error('the issue has no JSON block');
const item = JSON.parse(block[1]);

const errors = validateStoreItem(item, { submission: true });
if (errors.length) throw new Error(errors.join('; '));

if (item.kind === 'homebrew') {
  for (const f of item.files) {
    const r = await fetch(f.url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`${f.url}: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const sum = crypto.createHash('sha256').update(buf).digest('hex');
    if (f.sha256 && f.sha256 !== sum) throw new Error(`${f.url}: checksum does not match the submitted one`);
    f.sha256 = sum;
    f.size = buf.length;
  }
}

const rel = `store/${storeDir(item.kind)}/${item.id}.json`;
const file = path.join(root, rel);
if (fs.existsSync(file)) {
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  const same = JSON.stringify({ ...old, version: 0 }) === JSON.stringify({ ...item, version: 0 });
  item.version = same ? old.version : Math.max(old.version + 1, item.version);
}
const final = validateStoreItem(item);
if (final.length) throw new Error(final.join('; '));
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(item, null, 2) + '\n');
execFileSync(process.execPath, [path.join(root, 'scripts/build-store-index.mjs')], { stdio: 'inherit' });
console.log(rel);
