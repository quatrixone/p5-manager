// Turns an accepted marketplace submission (the issue's body) into a file in
// store/: validates it, fills in the checksum and size of homebrew files by
// downloading them once, gives a changed item the next version, and rebuilds
// store/index.json. Used by .github/workflows/store.yml.
//
//   node scripts/store-accept.mjs <file with the issue body>
// Prints the path it wrote.
import crypto from 'crypto';
import { encodeCatalog, decodeCatalog } from '../backend/src/lib/catalogLinks.js';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { prepareStoreSubmission } from '../backend/src/lib/storeOwnership.js';
import { validateStoreItem, storeDir } from '../backend/src/lib/storeItem.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const body = fs.readFileSync(process.argv[2], 'utf8');
const block = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(body);
if (!block) throw new Error('the issue has no JSON block');
let item = decodeCatalog(JSON.parse(block[1]));

const errors = validateStoreItem(item, { submission: true });
if (errors.length) throw new Error(errors.join('; '));

const rel = `store/${storeDir(item.kind)}/${item.id}.json`;
const file = path.join(root, rel);
const old = fs.existsSync(file) ? decodeCatalog(JSON.parse(fs.readFileSync(file, 'utf8'))) : null;
// Values are set from github.event.issue.user in the workflow, never the JSON.
item = prepareStoreSubmission(item, old, { login: process.env.SUBMITTER_LOGIN, id: Number(process.env.SUBMITTER_ID) });

if (['homebrew', 'payload'].includes(item.kind)) {
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

const final = validateStoreItem(item);
if (final.length) throw new Error(final.join('; '));
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(encodeCatalog(item), null, 2) + '\n');
execFileSync(process.execPath, [path.join(root, 'scripts/build-store-index.mjs')], { stdio: 'inherit' });
console.log(rel);
