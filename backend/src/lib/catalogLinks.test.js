import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encodeCatalog, decodeCatalog, encryptLink, decryptLink, hasPlainLinks } from './catalogLinks.js';
import { validateStoreItem } from './storeItem.js';

test('nested URLs, scripts and descriptions survive catalog encryption', () => {
  const source = { homepage: 'https://example.org', steps: [{ url: 'https://example.org/file.bin' }], script: 'text https://example.org\nwait 300', description: 'See https://example.org', count: 2 };
  const stored = encodeCatalog(source);
  assert.equal(hasPlainLinks(stored), false);
  assert.deepEqual(decodeCatalog(stored), source);
  assert.deepEqual(encodeCatalog(stored), stored);
  assert.notEqual(encryptLink(source.homepage), encryptLink(source.homepage));
});

test('tampering and truncated ciphertext are rejected; legacy links still load', () => {
  const value = encryptLink('https://example.org');
  const packed = Buffer.from(value.slice('p5enc:v1:'.length), 'base64url');
  packed[15] ^= 1;
  assert.throws(() => decryptLink('p5enc:v1:' + packed.toString('base64url')));
  assert.throws(() => decryptLink('p5enc:v1:bad'));
  assert.equal(decryptLink('https://example.org'), 'https://example.org');
});

test('all shipped catalogs have encrypted links and valid payload items', () => {
  for (const name of ['payloads', 'templates', 'inputScripts']) {
    const stored = JSON.parse(fs.readFileSync(new URL(`../../../frontend/builtin/${name}.json`, import.meta.url)));
    assert.equal(hasPlainLinks(stored), false, name);
    assert.ok(Array.isArray(decodeCatalog(stored)));
  }
  const dir = new URL('../../../store/payloads/', import.meta.url);
  for (const file of fs.readdirSync(dir)) {
    const stored = JSON.parse(fs.readFileSync(new URL(file, dir)));
    assert.equal(hasPlainLinks(stored), false, file);
    const item = decodeCatalog(stored);
    assert.deepEqual(validateStoreItem(item), [], file);
    assert.ok(item.files.every(f => f.type !== 'pkg'));
  }
});
