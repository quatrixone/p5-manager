// exFAT images written and read directly, without mounting anything.
//
// lib/exfat.js builds an image the way a person would: format a file, attach
// it as a loop device, mount it, copy the files in. That needs Linux and
// CAP_SYS_ADMIN. Windows has no equivalent without administrator rights, so
// the portable build could not make or open .exfat images at all.
//
// This module does the same job in plain file I/O: it lays the volume out in
// memory (which cluster every file and folder gets) and then writes the boot
// region, the FAT, the allocation bitmap, the up-case table, the directories
// and the file data straight into the image file. Reading goes the other
// way. It follows Microsoft's exFAT specification and the layout mkfs.exfat
// (exfatprogs) produces - same sector and cluster sizes, same 1 MiB
// alignment - so the result looks like an image made the usual way.
//
// What it does not do: change an existing image, or write fragmented files.
// Everything is allocated front to back in one pass.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { UPCASE_TABLE, UPCASE_TABLE_CHECKSUM } from './exfatUpcase.js';

const SECTOR = 512;
const MIB = 1024 * 1024;
const BOUNDARY = MIB; // FAT and cluster heap start on 1 MiB boundaries, like mkfs.exfat
const EOC = 0xFFFFFFFF; // end of a cluster chain in the FAT
const COPY_CHUNK = 4 * MIB;

const ENTRY = 32;
const TYPE_LABEL = 0x83;
const TYPE_BITMAP = 0x81;
const TYPE_UPCASE = 0x82;
const TYPE_FILE = 0x85;
const TYPE_STREAM = 0xC0;
const TYPE_NAME = 0xC1;
const ATTR_DIRECTORY = 0x10;
const ATTR_ARCHIVE = 0x20;
const FLAG_ALLOCATED = 0x01;
const FLAG_NO_FAT_CHAIN = 0x02;

// Cluster size by volume size, as mkfs.exfat picks it.
function clusterSizeFor(volumeBytes) {
  if (volumeBytes <= 256 * MIB) return 4 * 1024;
  if (volumeBytes <= 32 * 1024 * MIB) return 32 * 1024;
  return 128 * 1024;
}

const roundUp = (n, to) => Math.ceil(n / to) * to;

// The up-case table expanded to one entry per UTF-16 code unit. On disk it
// is run-length compressed: 0xFFFF followed by a count means "that many
// characters map to themselves".
const UPCASE = (() => {
  const map = new Uint16Array(0x10000);
  for (let i = 0; i < map.length; i++) map[i] = i;
  let ch = 0;
  for (let i = 0; i + 1 < UPCASE_TABLE.length && ch < 0x10000; i += 2) {
    const v = UPCASE_TABLE.readUInt16LE(i);
    if (v === 0xFFFF && i + 3 < UPCASE_TABLE.length) { ch += UPCASE_TABLE.readUInt16LE(i + 2); i += 2; }
    else map[ch++] = v;
  }
  return map;
})();

// The rotate-and-add checksums of the format, 16 and 32 bits wide.
function sum16(buf, skip, seed = 0) {
  let sum = seed;
  for (let i = 0; i < buf.length; i++) {
    if (skip && skip(i)) continue;
    sum = (((sum & 1) ? 0x8000 : 0) + (sum >>> 1) + buf[i]) & 0xFFFF;
  }
  return sum;
}
function sum32(buf, skip) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    if (skip && skip(i)) continue;
    sum = (((sum & 1) ? 0x80000000 : 0) + (sum >>> 1) + buf[i]) >>> 0;
  }
  return sum;
}

function nameHash(name) {
  const up = Buffer.alloc(name.length * 2);
  for (let i = 0; i < name.length; i++) up.writeUInt16LE(UPCASE[name.charCodeAt(i)], i * 2);
  return sum16(up);
}

// Timestamps are stored DOS style; we write them as UTC and say so in the
// offset byte (0x80 = "offset valid, zero").
function dosTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  return (((year - 1980) << 25) | ((d.getUTCMonth() + 1) << 21) | (d.getUTCDate() << 16)
    | (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)) >>> 0;
}
function fromDosTime(v) {
  return new Date(Date.UTC(1980 + (v >>> 25), ((v >>> 21) & 0xF) - 1, (v >>> 16) & 0x1F, (v >>> 11) & 0x1F, (v >>> 5) & 0x3F, (v & 0x1F) * 2));
}

const BAD_NAME_CHARS = /["*/:<>?\\|\u0000-\u001f]/;
function checkName(name, where) {
  if (!name || name.length > 255) throw new Error(`"${where}": exFAT names are 1 to 255 characters long`);
  if (BAD_NAME_CHARS.test(name)) throw new Error(`"${where}": exFAT does not allow " * / : < > ? \\ | in a name`);
}

// How many 32-byte entries a file or folder takes in its parent directory:
// file entry + stream entry + one name entry per 15 characters.
const entriesFor = (name) => 2 + Math.ceil(name.length / 15);

// ─── Writing ──────────────────────────────────────────────────────────────

// Read the source into a tree of { name, isDir, size, mtime, srcPath, children }.
function scan(src) {
  const st = fs.statSync(src);
  const root = { name: '', isDir: true, children: [], mtime: st.mtime };
  if (!st.isDirectory()) {
    // A single file becomes the only entry of the image's root.
    root.children.push({ name: path.basename(src), isDir: false, size: st.size, mtime: st.mtime, srcPath: src });
    checkName(path.basename(src), src);
    return root;
  }
  const walk = (dir, node) => {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      const full = path.join(dir, name);
      let s;
      try { s = fs.statSync(full); } catch (_) { continue; } // vanished or a dangling link
      if (s.isDirectory()) {
        checkName(name, full);
        const child = { name, isDir: true, children: [], mtime: s.mtime };
        node.children.push(child);
        walk(full, child);
      } else if (s.isFile()) {
        checkName(name, full);
        node.children.push({ name, isDir: false, size: s.size, mtime: s.mtime, srcPath: full });
      }
    }
  };
  walk(src, root);
  return root;
}

// Give every node its clusters. Returns the number of the first free cluster.
function allocate(root, clusterSize, firstFree) {
  let next = firstFree;
  const take = (count) => { const first = next; next += count; return first; };
  const place = (dir, isRoot) => {
    // Root also holds the volume label, bitmap and up-case entries.
    const entries = (isRoot ? 3 : 0) + dir.children.reduce((n, c) => n + entriesFor(c.name), 0);
    dir.clusters = Math.max(1, Math.ceil((entries * ENTRY) / clusterSize));
    dir.firstCluster = take(dir.clusters);
    for (const c of dir.children) {
      if (c.isDir) continue;
      c.clusters = Math.ceil(c.size / clusterSize);
      c.firstCluster = c.clusters ? take(c.clusters) : 0;
    }
    for (const c of dir.children) if (c.isDir) place(c, false);
  };
  place(root, true);
  return next;
}

function clustersNeeded(root, clusterSize) {
  let total = 0;
  const count = (dir, isRoot) => {
    const entries = (isRoot ? 3 : 0) + dir.children.reduce((n, c) => n + entriesFor(c.name), 0);
    total += Math.max(1, Math.ceil((entries * ENTRY) / clusterSize));
    for (const c of dir.children) {
      if (c.isDir) count(c, false);
      else total += Math.ceil(c.size / clusterSize);
    }
  };
  count(root, true);
  return total;
}

// FAT offset / length, heap offset and cluster count for a volume size.
function geometry(volumeBytes, clusterSize) {
  const fatOffset = BOUNDARY;
  const fatBytes = roundUp(Math.floor((volumeBytes - fatOffset) / clusterSize) * 4, clusterSize);
  const heapOffset = roundUp(fatOffset + fatBytes, BOUNDARY);
  const clusterCount = Math.floor((volumeBytes - heapOffset) / clusterSize);
  return { fatOffset, fatBytes, heapOffset, clusterCount };
}

function bootRegion({ volumeBytes, clusterSize, geo, rootCluster, percentInUse, serial }) {
  const region = Buffer.alloc(12 * SECTOR);
  const b = region.subarray(0, SECTOR);
  b.set([0xEB, 0x76, 0x90], 0);
  b.write('EXFAT   ', 3, 'ascii');
  b.writeBigUInt64LE(0n, 64);                                 // PartitionOffset
  b.writeBigUInt64LE(BigInt(volumeBytes / SECTOR), 72);       // VolumeLength
  b.writeUInt32LE(geo.fatOffset / SECTOR, 80);
  b.writeUInt32LE(geo.fatBytes / SECTOR, 84);
  b.writeUInt32LE(geo.heapOffset / SECTOR, 88);
  b.writeUInt32LE(geo.clusterCount, 92);
  b.writeUInt32LE(rootCluster, 96);
  b.writeUInt32LE(serial, 100);
  b.writeUInt16LE(0x0100, 104);                               // FileSystemRevision 1.00
  b.writeUInt16LE(0, 106);                                    // VolumeFlags
  b[108] = Math.log2(SECTOR);
  b[109] = Math.log2(clusterSize / SECTOR);
  b[110] = 1;                                                 // NumberOfFats
  b[111] = 0x80;                                              // DriveSelect
  b[112] = percentInUse;
  b.writeUInt16LE(0xAA55, 510);
  // Sectors 1-8: extended boot sectors, empty but signed. 9-10 stay zero.
  for (let s = 1; s <= 8; s++) region.writeUInt32LE(0xAA550000, s * SECTOR + SECTOR - 4);
  // Sector 11: the checksum of sectors 0-10, repeated. VolumeFlags and
  // PercentInUse are left out of it because they change while mounted.
  const checksum = sum32(region.subarray(0, 11 * SECTOR), (i) => i === 106 || i === 107 || i === 112);
  for (let o = 11 * SECTOR; o < 12 * SECTOR; o += 4) region.writeUInt32LE(checksum, o);
  return region;
}

// The entries one child takes in its parent directory.
function childEntries(node, clusterSize) {
  const nameEntries = Math.ceil(node.name.length / 15);
  const set = Buffer.alloc((2 + nameEntries) * ENTRY);
  const stamp = dosTime(node.mtime);
  set[0] = TYPE_FILE;
  set[1] = 1 + nameEntries;                                   // SecondaryCount
  set.writeUInt16LE(node.isDir ? ATTR_DIRECTORY : ATTR_ARCHIVE, 4);
  set.writeUInt32LE(stamp, 8);                                // created
  set.writeUInt32LE(stamp, 12);                               // modified
  set.writeUInt32LE(stamp, 16);                               // accessed
  set[22] = 0x80; set[23] = 0x80; set[24] = 0x80;             // times are UTC

  const s = set.subarray(ENTRY, 2 * ENTRY);
  const length = node.isDir ? node.clusters * clusterSize : node.size;
  s[0] = TYPE_STREAM;
  // Everything here is written in one piece, so "no FAT chain" is true; the
  // FAT is filled in as well, which keeps tools happy that ignore the flag.
  s[1] = length ? (FLAG_ALLOCATED | FLAG_NO_FAT_CHAIN) : FLAG_ALLOCATED;
  s[3] = node.name.length;
  s.writeUInt16LE(nameHash(node.name), 4);
  s.writeBigUInt64LE(BigInt(length), 8);                      // ValidDataLength
  s.writeUInt32LE(node.firstCluster, 20);
  s.writeBigUInt64LE(BigInt(length), 24);                     // DataLength

  for (let n = 0; n < nameEntries; n++) {
    const e = set.subarray((2 + n) * ENTRY, (3 + n) * ENTRY);
    e[0] = TYPE_NAME;
    const part = node.name.slice(n * 15, n * 15 + 15);
    for (let i = 0; i < part.length; i++) e.writeUInt16LE(part.charCodeAt(i), 2 + i * 2);
  }
  set.writeUInt16LE(sum16(set, (i) => i === 2 || i === 3), 2); // SetChecksum
  return set;
}

function directoryData(dir, clusterSize, rootExtras) {
  const data = Buffer.alloc(dir.clusters * clusterSize);
  let at = 0;
  if (rootExtras) { rootExtras.copy(data, 0); at = rootExtras.length; }
  for (const c of dir.children) {
    const set = childEntries(c, clusterSize);
    set.copy(data, at);
    at += set.length;
  }
  return data;
}

function rootHead({ label, bitmapCluster, bitmapBytes, upcaseCluster }) {
  const head = Buffer.alloc(3 * ENTRY);
  head[0] = TYPE_LABEL;
  head[1] = label.length;
  for (let i = 0; i < label.length; i++) head.writeUInt16LE(label.charCodeAt(i), 2 + i * 2);
  const bm = head.subarray(ENTRY);
  bm[0] = TYPE_BITMAP;
  bm.writeUInt32LE(bitmapCluster, 20);
  bm.writeBigUInt64LE(BigInt(bitmapBytes), 24);
  const up = head.subarray(2 * ENTRY);
  up[0] = TYPE_UPCASE;
  up.writeUInt32LE(UPCASE_TABLE_CHECKSUM, 4);
  up.writeUInt32LE(upcaseCluster, 20);
  up.writeBigUInt64LE(BigInt(UPCASE_TABLE.length), 24);
  return head;
}

/**
 * Write an exFAT image holding the contents of a folder (or one file).
 *
 * @param {object}   o
 * @param {string}   o.src         folder whose contents become the image root, or a single file
 * @param {string}   o.out         image file to create (replaced if it exists)
 * @param {string}  [o.label]      volume label, up to 11 characters
 * @param {number}  [o.sizeBytes]  wanted image size; grown when the content needs more
 * @param {(done:number, total:number) => void} [o.onProgress] bytes of file data written so far
 * @param {() => boolean} [o.cancelled] checked between chunks; true stops the build
 * @returns {Promise<{ sizeBytes:number, clusterSize:number, files:number, folders:number }>}
 */
export async function buildExfatImage({ src, out, label = 'PS5DATA', sizeBytes = 0, onProgress, cancelled }) {
  const root = scan(src);
  label = String(label).slice(0, 11);

  // Size and cluster size depend on each other: start from the wanted size,
  // see what the content needs at that cluster size, and grow until it fits.
  let volumeBytes = Math.max(roundUp(sizeBytes || 0, MIB), 8 * MIB);
  let clusterSize, geo, bitmapBytes, bitmapClusters, upcaseClusters, need;
  for (;;) {
    clusterSize = clusterSizeFor(volumeBytes);
    geo = geometry(volumeBytes, clusterSize);
    bitmapBytes = Math.ceil(geo.clusterCount / 8);
    bitmapClusters = Math.ceil(bitmapBytes / clusterSize);
    upcaseClusters = Math.ceil(UPCASE_TABLE.length / clusterSize);
    need = bitmapClusters + upcaseClusters + clustersNeeded(root, clusterSize);
    if (need <= geo.clusterCount) break;
    volumeBytes = roundUp(geo.heapOffset + (need + 1) * clusterSize, MIB);
  }
  if (geo.clusterCount > 0xFFFFFFF5) throw new Error('the image would be larger than exFAT allows');

  const bitmapCluster = 2;
  const upcaseCluster = bitmapCluster + bitmapClusters;
  const firstFree = allocate(root, clusterSize, upcaseCluster + upcaseClusters);
  const used = firstFree - 2;
  const offsetOf = (cluster) => geo.heapOffset + (cluster - 2) * clusterSize;

  let files = 0, folders = 0, totalData = 0;
  const everyNode = (dir, fn) => { for (const c of dir.children) { fn(c); if (c.isDir) everyNode(c, fn); } };
  everyNode(root, (n) => { if (n.isDir) folders++; else { files++; totalData += n.size; } });

  fs.rmSync(out, { force: true });
  const fd = await fs.promises.open(out, 'w+');
  try {
    // The size first: the file is sparse, only what is written below takes space.
    await fd.truncate(volumeBytes);

    const boot = bootRegion({
      volumeBytes, clusterSize, geo, rootCluster: root.firstCluster,
      percentInUse: Math.min(100, Math.floor((used * 100) / geo.clusterCount)),
      serial: crypto.randomBytes(4).readUInt32LE(0),
    });
    await fd.write(boot, 0, boot.length, 0);
    await fd.write(boot, 0, boot.length, 12 * SECTOR);        // backup boot region

    // FAT: entry 0 is the media type, entry 1 is reserved, then one chain
    // per allocation. Only the used part is written; the rest stays zero.
    const fat = Buffer.alloc((firstFree) * 4);
    fat.writeUInt32LE(0xFFFFFFF8, 0);
    fat.writeUInt32LE(EOC, 4);
    const chain = (first, count) => {
      for (let i = 0; i < count; i++) fat.writeUInt32LE(i === count - 1 ? EOC : first + i + 1, (first + i) * 4);
    };
    chain(bitmapCluster, bitmapClusters);
    chain(upcaseCluster, upcaseClusters);
    chain(root.firstCluster, root.clusters);
    everyNode(root, (n) => { if (n.clusters) chain(n.firstCluster, n.clusters); });
    await fd.write(fat, 0, fat.length, geo.fatOffset);

    // Allocation bitmap: clusters are handed out front to back, so the used
    // ones are simply the first `used` bits.
    const bitmap = Buffer.alloc(Math.ceil(used / 8));
    bitmap.fill(0xFF, 0, Math.floor(used / 8));
    if (used % 8) bitmap[bitmap.length - 1] = (1 << (used % 8)) - 1;
    await fd.write(bitmap, 0, bitmap.length, offsetOf(bitmapCluster));

    await fd.write(UPCASE_TABLE, 0, UPCASE_TABLE.length, offsetOf(upcaseCluster));

    const head = rootHead({ label, bitmapCluster, bitmapBytes, upcaseCluster });
    const writeDir = async (dir, extras) => {
      const data = directoryData(dir, clusterSize, extras);
      await fd.write(data, 0, data.length, offsetOf(dir.firstCluster));
      for (const c of dir.children) if (c.isDir) await writeDir(c, null);
    };
    await writeDir(root, head);

    // File data, one file after another.
    const chunk = Buffer.allocUnsafe(COPY_CHUNK);
    let done = 0;
    const copy = async (node) => {
      if (!node.size) return;
      const input = await fs.promises.open(node.srcPath, 'r');
      try {
        let pos = offsetOf(node.firstCluster);
        let left = node.size;
        while (left > 0) {
          if (cancelled?.()) throw new Error('cancelled');
          const { bytesRead } = await input.read(chunk, 0, Math.min(COPY_CHUNK, left), null);
          if (!bytesRead) throw new Error(`${node.srcPath} got shorter while it was being copied`);
          await fd.write(chunk, 0, bytesRead, pos);
          pos += bytesRead; left -= bytesRead; done += bytesRead;
          onProgress?.(done, totalData);
        }
      } finally { await input.close(); }
    };
    const copyAll = async (dir) => {
      for (const c of dir.children) if (!c.isDir) await copy(c);
      for (const c of dir.children) if (c.isDir) await copyAll(c);
    };
    await copyAll(root);
    await fd.sync();
  } finally {
    await fd.close();
  }
  return { sizeBytes: volumeBytes, clusterSize, files, folders };
}

// ─── Reading ──────────────────────────────────────────────────────────────

async function openVolume(image) {
  const fd = await fs.promises.open(image, 'r');
  const boot = Buffer.alloc(SECTOR);
  await fd.read(boot, 0, SECTOR, 0);
  if (boot.toString('ascii', 3, 11) !== 'EXFAT   ' || boot.readUInt16LE(510) !== 0xAA55) {
    await fd.close();
    throw new Error('not an exFAT image');
  }
  const sector = 1 << boot[108];
  const clusterSize = sector << boot[109];
  const vol = {
    fd, clusterSize,
    fatOffset: boot.readUInt32LE(80) * sector,
    heapOffset: boot.readUInt32LE(88) * sector,
    clusterCount: boot.readUInt32LE(92),
    rootCluster: boot.readUInt32LE(96),
  };
  vol.offsetOf = (cluster) => vol.heapOffset + (cluster - 2) * clusterSize;
  vol.next = async (cluster) => {
    const b = Buffer.alloc(4);
    await fd.read(b, 0, 4, vol.fatOffset + cluster * 4);
    return b.readUInt32LE(0);
  };
  // The clusters of an allocation, in order. Contiguous allocations carry the
  // "no FAT chain" flag and are simply counted off; others follow the FAT.
  vol.clusters = async function* (first, count, contiguous) {
    let c = first;
    for (let i = 0; (count == null || i < count) && c >= 2 && c < vol.clusterCount + 2; i++) {
      yield c;
      c = contiguous ? c + 1 : await vol.next(c);
      if (i > vol.clusterCount) throw new Error('cluster chain loops');
    }
  };
  return vol;
}

async function readDirectory(vol, first, lengthBytes, contiguous) {
  const count = lengthBytes == null ? null : Math.ceil(lengthBytes / vol.clusterSize);
  const parts = [];
  for await (const c of vol.clusters(first, count, contiguous)) {
    const b = Buffer.alloc(vol.clusterSize);
    await vol.fd.read(b, 0, b.length, vol.offsetOf(c));
    parts.push(b);
  }
  const data = Buffer.concat(parts);
  const out = { label: '', entries: [] };
  for (let at = 0; at + ENTRY <= data.length; at += ENTRY) {
    const type = data[at];
    if (type === 0) break;                                    // end of directory
    if (type === TYPE_LABEL) {
      out.label = data.toString('utf16le', at + 2, at + 2 + data[at + 1] * 2);
    } else if (type === TYPE_FILE) {
      const secondary = data[at + 1];
      const stream = data.subarray(at + ENTRY, at + 2 * ENTRY);
      if (stream[0] !== TYPE_STREAM) continue;
      let name = '';
      for (let n = 2; n <= secondary; n++) {
        const e = data.subarray(at + n * ENTRY, at + (n + 1) * ENTRY);
        if (e[0] === TYPE_NAME) name += e.toString('utf16le', 2, 32);
      }
      out.entries.push({
        name: name.slice(0, stream[3]),
        isDir: !!(data.readUInt16LE(at + 4) & ATTR_DIRECTORY),
        mtime: fromDosTime(data.readUInt32LE(at + 12)),
        contiguous: !!(stream[1] & FLAG_NO_FAT_CHAIN),
        firstCluster: stream.readUInt32LE(20),
        size: Number(stream.readBigUInt64LE(8)),              // ValidDataLength
        allocated: Number(stream.readBigUInt64LE(24)),
      });
      at += secondary * ENTRY;
    }
  }
  return out;
}

/** List an image: its label and every file and folder with its size. */
export async function listExfatImage(image) {
  const vol = await openVolume(image);
  try {
    const root = await readDirectory(vol, vol.rootCluster, null, false);
    const items = [];
    const walk = async (entries, prefix) => {
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        items.push({ path: rel, isDir: e.isDir, size: e.isDir ? 0 : e.size, mtime: e.mtime });
        if (e.isDir) await walk((await readDirectory(vol, e.firstCluster, e.allocated, e.contiguous)).entries, rel);
      }
    };
    await walk(root.entries, '');
    return { label: root.label, clusterSize: vol.clusterSize, items };
  } finally {
    await vol.fd.close();
  }
}

/**
 * Copy everything in an image out into a folder.
 *
 * @param {object}   o
 * @param {string}   o.image
 * @param {string}   o.dest        created if missing; existing files of the same name are replaced
 * @param {(done:number, total:number) => void} [o.onProgress]
 * @param {() => boolean} [o.cancelled]
 * @returns {Promise<{ files:number, folders:number, bytes:number }>}
 */
export async function extractExfatImage({ image, dest, onProgress, cancelled }) {
  const { items } = await listExfatImage(image);
  const total = items.reduce((n, i) => n + i.size, 0);
  const vol = await openVolume(image);
  const destRoot = path.resolve(dest);
  let files = 0, folders = 0, done = 0;
  try {
    fs.mkdirSync(destRoot, { recursive: true });
    const walk = async (first, length, contiguous, dir) => {
      const { entries } = await readDirectory(vol, first, length, contiguous);
      for (const e of entries) {
        // A name from the image never gets to leave the destination folder.
        if (!e.name || e.name === '.' || e.name === '..' || /[\\/]/.test(e.name)) continue;
        const target = path.join(dir, e.name);
        if (e.isDir) {
          fs.mkdirSync(target, { recursive: true });
          folders++;
          await walk(e.firstCluster, e.allocated, e.contiguous, target);
          continue;
        }
        const output = await fs.promises.open(target, 'w');
        try {
          let left = e.size;
          const count = Math.ceil(e.size / vol.clusterSize);
          // Read runs of neighbouring clusters in one go.
          let runStart = 0, runLen = 0;
          const flush = async () => {
            let offset = vol.offsetOf(runStart);
            let bytes = Math.min(left, runLen * vol.clusterSize);
            while (bytes > 0) {
              if (cancelled?.()) throw new Error('cancelled');
              const n = Math.min(bytes, COPY_CHUNK);
              const b = Buffer.allocUnsafe(n);
              await vol.fd.read(b, 0, n, offset);
              await output.write(b, 0, n, null);
              offset += n; bytes -= n; left -= n; done += n;
              onProgress?.(done, total);
            }
            runLen = 0;
          };
          for await (const c of vol.clusters(e.firstCluster, count, e.contiguous)) {
            if (runLen && c === runStart + runLen && runLen * vol.clusterSize < COPY_CHUNK * 8) { runLen++; continue; }
            if (runLen) await flush();
            runStart = c; runLen = 1;
          }
          if (runLen) await flush();
          if (left > 0) throw new Error(`${e.name}: the image ends before the file does`);
        } finally { await output.close(); }
        try { fs.utimesSync(target, e.mtime, e.mtime); } catch (_) { /* cosmetic */ }
        files++;
      }
    };
    await walk(vol.rootCluster, null, false, destRoot);
  } finally {
    await vol.fd.close();
  }
  return { files, folders, bytes: done };
}
