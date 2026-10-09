// Maintainer migration utility; does not compile or package the app.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { encodeCatalog, decodeCatalog } from '../backend/src/lib/catalogLinks.js';
const payloads = decodeCatalog(JSON.parse(fs.readFileSync(new URL('../frontend/builtin/payloads.json', import.meta.url))));
fs.mkdirSync(new URL('../store/payloads/', import.meta.url), { recursive: true });
for (const entry of payloads) {
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`${entry.filename}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const id = entry.filename.toLowerCase().replace(/\.(elf|bin|lua)$/, '').replace(/[^a-z0-9-]/g, '-');
  const author = new URL(entry.url).pathname.split('/')[1];
  const item = { kind: 'payload', id, name: entry.filename, description: entry.description, author,
    version: 1, console_type: entry.console_type, files: [{ type: entry.filename.split('.').pop(), name: entry.filename,
      url: entry.url, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), size: buffer.length }] };
  fs.writeFileSync(new URL(`../store/payloads/${id}.json`, import.meta.url), JSON.stringify(encodeCatalog(item), null, 2) + '\n');
  console.log(`${entry.filename}: checksum pinned`);
}
for (const file of ['payloads.json', 'templates.json', 'inputScripts.json']) {
  const url = new URL(`../frontend/builtin/${file}`, import.meta.url);
  fs.writeFileSync(url, JSON.stringify(encodeCatalog(JSON.parse(fs.readFileSync(url))), null, 2) + '\n');
}
