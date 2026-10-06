import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { buildExfatImage, listExfatImage, extractExfatImage } from './exfatImage.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p5m-exfat-'));

// A tree with the awkward cases: an empty file, a file of exactly one
// cluster, one that spans several, a name needing three name entries, a
// non-ASCII name, an empty folder, and a folder with more entries than fit
// into one cluster.
function makeTree(root) {
  const files = {};
  const put = (rel, data) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
    files[rel.split(path.sep).join('/')] = crypto.createHash('sha1').update(data).digest('hex');
  };
  put('eboot.bin', crypto.randomBytes(300_000));
  put('empty.txt', Buffer.alloc(0));
  put('one-cluster.dat', crypto.randomBytes(4096));
  put(path.join('sce_sys', 'param.json'), Buffer.from('{"titleId":"PPSA00000"}'));
  put(path.join('sce_sys', 'a name that is longer than thirty characters for sure.png'), crypto.randomBytes(9000));
  put(path.join('data', 'Príliš žltý kôň.txt'), Buffer.from('úpěl ďábelské ódy'));
  put(path.join('data', 'deep', 'er', 'file.bin'), crypto.randomBytes(70_000));
  for (let i = 0; i < 200; i++) put(path.join('many', `chunk-${String(i).padStart(4, '0')}.bin`), Buffer.from(`n${i}`));
  fs.mkdirSync(path.join(root, 'empty-folder'));
  return files;
}

const hashTree = (root) => {
  const out = {};
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else out[rel] = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root, '');
  return out;
};

test('a folder survives the trip into an exFAT image and back', async () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'src');
    const expected = makeTree(src);
    const image = path.join(dir, 'game.exfat');
    const built = await buildExfatImage({ src, out: image, label: 'TESTLABEL', sizeBytes: 64 * 1024 * 1024 });
    assert.equal(built.files, Object.keys(expected).length);
    assert.equal(fs.statSync(image).size, 64 * 1024 * 1024);

    const listed = await listExfatImage(image);
    assert.equal(listed.label, 'TESTLABEL');
    assert.deepEqual(
      listed.items.filter(i => !i.isDir).map(i => i.path).sort(),
      Object.keys(expected).sort(),
    );
    assert.ok(listed.items.some(i => i.isDir && i.path === 'empty-folder'));

    const back = path.join(dir, 'back');
    const res = await extractExfatImage({ image, dest: back });
    assert.equal(res.files, Object.keys(expected).length);
    assert.deepEqual(hashTree(back), expected);
    assert.ok(fs.statSync(path.join(back, 'empty-folder')).isDirectory());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the image grows when the content does not fit the wanted size', async () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    const data = crypto.randomBytes(20 * 1024 * 1024);
    fs.writeFileSync(path.join(src, 'big.bin'), data);
    const image = path.join(dir, 'big.exfat');
    const built = await buildExfatImage({ src, out: image, sizeBytes: 8 * 1024 * 1024 });
    assert.ok(built.sizeBytes > 20 * 1024 * 1024);
    const back = path.join(dir, 'back');
    await extractExfatImage({ image, dest: back });
    assert.ok(fs.readFileSync(path.join(back, 'big.bin')).equals(data));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a single file becomes the only entry of the image', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'solo.pkg');
    fs.writeFileSync(file, 'payload');
    const image = path.join(dir, 'solo.exfat');
    await buildExfatImage({ src: file, out: image });
    const listed = await listExfatImage(image);
    assert.deepEqual(listed.items.map(i => i.path), ['solo.pkg']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('names exFAT cannot hold are refused with the path', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'what?.txt'), 'x');
    await assert.rejects(buildExfatImage({ src, out: path.join(dir, 'x.exfat') }), /does not allow/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('something that is not exFAT is refused', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'not.exfat');
    fs.writeFileSync(file, Buffer.alloc(4096));
    await assert.rejects(listExfatImage(file), /not an exFAT image/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
