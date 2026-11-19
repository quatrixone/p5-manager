// In-app updates from the releases on theghostonline.dev: the app zip replaces the app's
// folder and lz4-compression.elf replaces the engine in Payload Manager.
import {Archives, Downloads, FileSystem, Http, Platform} from '@ps5-react/core';
import {engineElf} from './api.js';
import {APP_VERSION} from './version.js';

const FEED = 'https://theghostonline.dev/api/v1/repos/theghostonline/PS5-LZ4-Compression/releases/latest';
const TITLE = 'PPSA99420';
const APP_ASSET = `LZ4-Compression-${TITLE}.zip`;
const ENGINE_ASSET = 'lz4-compression.elf';
const SUMS_ASSET = 'SHA256SUMS';
const onPs5 = Platform.OS === 'ps5';
const DATA = onPs5 ? '/data/LZ4Compression' : `${FileSystem.dataDir}/LZ4Compression`;
const WORK = `${DATA}/app-update`;
const SKIP_FILE = `${DATA}/update-skip`;
// A test feed (another release's API URL) can be dropped here, and
// update-test-auto starts the update without a button press (hardware tests).
const FEED_OVERRIDE = `${DATA}/update-feed`;
const AUTO_TEST = `${DATA}/update-test-auto`;

export function autoUpdateForTest() {
  try {
    return FileSystem.exists(AUTO_TEST);
  } catch (err) {
    return false;
  }
}

function parts(version) {
  return String(version || '').replace(/^v/i, '').split(/[.-]/).map(part => parseInt(part, 10) || 0);
}

export function isNewer(tag, current) {
  const a = parts(tag);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function readText(path) {
  try {
    return FileSystem.exists(path) ? FileSystem.readFile(path).trim() : '';
  } catch (err) {
    return '';
  }
}

// Forgejo lists no digests, so each file's SHA-256 comes from the release's
// SHA256SUMS ("<hash>  <name>" lines).
function parseSums(text) {
  const sums = {};
  for (const line of String(text || '').split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (match) sums[match[2]] = match[1].toLowerCase();
  }
  return sums;
}

function assetOf(release, name, sums) {
  const file = (release.assets || []).find(item => item.name === name);
  const sha256 = file && sums[name];
  return file && sha256 ? {url: file.browser_download_url, size: file.size, sha256} : null;
}

async function sumsOf(release) {
  const file = (release.assets || []).find(item => item.name === SUMS_ASSET);
  if (!file) return {};
  const response = await Http.request(file.browser_download_url, {maxBytes: 64 * 1024});
  if (!response.ok) throw new Error(`${SUMS_ASSET} answered HTTP ${response.status}`);
  return parseSums(await response.text());
}

export async function checkForUpdate() {
  const feed = readText(FEED_OVERRIDE) || FEED;
  const response = await Http.request(feed, {
    headers: {Accept: 'application/json', 'User-Agent': 'LZ4-Compression'},
    maxBytes: 1024 * 1024,
  });
  if (!response.ok) throw new Error(`Update check answered HTTP ${response.status}`);
  const release = await response.json();
  const version = String(release.tag_name || '').replace(/^v/i, '');
  if (!version || !isNewer(version, APP_VERSION)) return null;
  if (readText(SKIP_FILE) === version) return null;
  const sums = await sumsOf(release);
  const app = assetOf(release, APP_ASSET, sums);
  if (!app) return null;
  return {version, app, engine: assetOf(release, ENGINE_ASSET, sums)};
}

export function skipVersion(version) {
  try {
    FileSystem.mkdir(DATA, {recursive: true});
    FileSystem.writeFile(SKIP_FILE, version);
  } catch (err) {
    // Only means the dialog comes back next time.
  }
}

function installDir() {
  if (!onPs5) return `${FileSystem.dataDir}/homebrew/${TITLE}`;
  const roots = ['/data', '/mnt/ext0', '/mnt/ext1', '/mnt/usb0', '/mnt/usb1', '/mnt/usb2', '/mnt/usb3'];
  for (const root of roots) {
    const dir = `${root}/homebrew/${TITLE}`;
    if (FileSystem.exists(`${dir}/sce_sys/param.json`)) return dir;
  }
  throw new Error(`App folder not found: no ${TITLE}/sce_sys/param.json under ${roots.map(root => `${root}/homebrew`).join(', ')}`);
}

const entriesOf = dir => FileSystem.readDir(dir).filter(entry => !entry.name.startsWith('.ps5-react-'));

// The zip holds one PPSA99420 folder; go into it.
function contentOf(dir) {
  const entries = entriesOf(dir);
  return entries.length === 1 && entries[0].isDirectory ? contentOf(`${dir}/${entries[0].name}`) : dir;
}

function openUp(path) {
  FileSystem.chmod(path, 0o777);
  for (const entry of FileSystem.readDir(path)) {
    if (entry.isDirectory) openUp(`${path}/${entry.name}`);
    else FileSystem.chmod(`${path}/${entry.name}`, 0o777);
  }
}

// Renames keep the running app's files alive until it closes; on any failure
// everything moved so far goes back.
function swapInto(staged, target, backup) {
  FileSystem.mkdir(backup, {recursive: true});
  const done = [];
  try {
    for (const {name} of entriesOf(staged)) {
      const replaced = FileSystem.exists(`${target}/${name}`);
      if (replaced) FileSystem.rename(`${target}/${name}`, `${backup}/${name}`);
      done.push({name, replaced});
      FileSystem.rename(`${staged}/${name}`, `${target}/${name}`);
    }
  } catch (err) {
    for (const {name, replaced} of done.reverse()) {
      if (FileSystem.exists(`${target}/${name}`)) FileSystem.rename(`${target}/${name}`, `${staged}/${name}`);
      if (replaced) FileSystem.rename(`${backup}/${name}`, `${target}/${name}`);
    }
    throw err;
  }
}

const reason = err => (err && err.message) || String(err);

async function download(name, asset, destination, onProgress, offset, total) {
  try {
    const task = Downloads.enqueue({
      url: asset.url, destination, sha256: asset.sha256, expectedBytes: asset.size, rejectHtml: true,
    });
    const off = task.subscribe(({written}) => onProgress({state: 'downloading', written: offset + (written || 0), total}));
    try {
      await task.done;
    } finally {
      off();
    }
  } catch (err) {
    throw new Error(`Download failed (${name}): ${reason(err)}`);
  }
}

export function cleanupUpdate() {
  try {
    if (FileSystem.exists(WORK)) FileSystem.removeTree(WORK);
  } catch (err) {
    // A leftover folder is harmless.
  }
}

// Returns whether the engine was replaced too.
export async function installUpdate(update, onProgress = () => {}) {
  const target = installDir();
  const engine = onPs5 ? engineElf() : null;
  const withEngine = !!update.engine && !!engine;
  const total = update.app.size + (withEngine ? update.engine.size : 0);
  cleanupUpdate();
  FileSystem.mkdir(WORK, {recursive: true});
  const zip = `${WORK}/${update.version}.zip`;
  const elf = `${WORK}/${ENGINE_ASSET}`;
  await download(APP_ASSET, update.app, zip, onProgress, 0, total);
  if (withEngine) await download(ENGINE_ASSET, update.engine, elf, onProgress, update.app.size, total);
  onProgress({state: 'installing', written: total, total});
  const extracted = `${WORK}/${update.version}`;
  try {
    await Archives.extract({sources: [zip], destination: extracted, maxBytes: 1024 * 1024 * 1024}).done;
  } catch (err) {
    throw new Error(`Unzip failed (${APP_ASSET}): ${reason(err)}`);
  }
  const staged = contentOf(extracted);
  for (const needed of ['eboot.bin', 'sce_sys/param.json']) {
    if (!FileSystem.exists(`${staged}/${needed}`)) throw new Error(`${APP_ASSET} has no ${needed}`);
  }
  try {
    openUp(staged);
    swapInto(staged, target, `${WORK}/previous-app`);
  } catch (err) {
    throw new Error(`Couldn't replace the app in ${target}: ${reason(err)}`);
  }
  if (withEngine) {
    try {
      FileSystem.chmod(elf, 0o777);
      FileSystem.mkdir(`${WORK}/previous-engine`, {recursive: true});
      FileSystem.rename(engine, `${WORK}/previous-engine/${ENGINE_ASSET}`);
      FileSystem.rename(elf, engine);
    } catch (err) {
      throw new Error(`App updated, but the engine couldn't be replaced at ${engine}: ${reason(err)}`);
    }
  }
  return withEngine;
}
