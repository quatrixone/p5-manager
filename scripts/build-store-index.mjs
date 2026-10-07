// Builds store/index.json from the items in store/templates, store/scripts
// and store/homebrew, after checking each one (backend/src/lib/storeItem.js).
//
//   node scripts/build-store-index.mjs          write store/index.json
//   node scripts/build-store-index.mjs --check  fail when it is out of date
//                                               or an item is not valid
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateStoreItem, indexEntry } from '../backend/src/lib/storeItem.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = path.join(root, 'store');
const check = process.argv.includes('--check');

const items = [];
const problems = [];
for (const [kind, dir] of [['template', 'templates'], ['script', 'scripts'], ['homebrew', 'homebrew']]) {
  const full = path.join(store, dir);
  if (!fs.existsSync(full)) continue;
  for (const file of fs.readdirSync(full).filter((f) => f.endsWith('.json')).sort()) {
    const rel = `${dir}/${file}`;
    let item;
    try {
      item = JSON.parse(fs.readFileSync(path.join(full, file), 'utf8'));
    } catch (e) {
      problems.push(`${rel}: not JSON (${e.message})`);
      continue;
    }
    const errors = validateStoreItem(item);
    if (item.kind !== kind) errors.push(`kind has to be "${kind}" in ${dir}/`);
    if (`${item.id}.json` !== file) errors.push(`the file has to be named ${item.id}.json`);
    if (errors.length) problems.push(`${rel}: ${errors.join('; ')}`);
    else items.push(indexEntry(item, rel));
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const indexFile = path.join(store, 'index.json');
const body = { items };
if (check) {
  const have = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
  if (JSON.stringify(have.items || []) !== JSON.stringify(items)) {
    console.error('store/index.json is out of date: run node scripts/build-store-index.mjs');
    process.exit(1);
  }
  console.log(`store: ${items.length} items, index up to date`);
} else {
  fs.writeFileSync(indexFile, JSON.stringify({ generated: new Date().toISOString(), ...body }, null, 2) + '\n');
  console.log(`store/index.json: ${items.length} items`);
}
