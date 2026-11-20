import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import { internalDataDir } from './paths.js';

// The host side of PS5 Dump Forge: the same program that converts on the
// console, as a command line tool, so a conversion on this machine and one
// on the PS5 go through the same code and the same checks.
//
// It is not vendored: the release carries one 7 MB static binary per
// platform and the image would grow for every one of them. The pinned
// version is fetched once, verified against the checksum published with the
// release, and reused from then on. It lives in the app's own data directory
// rather than the user's: USER_DATA_DIR is a bind mount we may not create
// folders in, and this is the app's working copy of a tool, not user data.
export const FORGE_VERSION = '0.5.6';

// sha256 of the release asset, from the release's own SHA256SUMS.
const ASSETS = {
  'linux-x64': { name: `ps5-dump-forge-${FORGE_VERSION}-linux-x86-64-musl.tar.gz`,
    sha256: '0a13a4a61b3bbeb7ba73eb4ef543a35ba3717e739e0f986e136d6856cfbc735c', bin: 'ps5-dump-forge' },
  'linux-arm64': { name: `ps5-dump-forge-${FORGE_VERSION}-linux-arm64.tar.gz`,
    sha256: 'c7ddfe308d23051ec15de465a34ce6c8f7def152d801b0f310ec6e68454f8d6d', bin: 'ps5-dump-forge' },
  'win32-x64': { name: `ps5-dump-forge-${FORGE_VERSION}-windows-x86-64.zip`,
    sha256: '9944ef56709c668925e4134c8827cd47ab4247a9a61e09c6e3a3c071d952cf11', bin: 'ps5-dump-forge.exe' },
  'win32-arm64': { name: `ps5-dump-forge-${FORGE_VERSION}-windows-arm64.zip`,
    sha256: 'ca0bc140245c08a8189c1e6069665d7bccbc76807d324fc93e6b9e0df7744187', bin: 'ps5-dump-forge.exe' },
  'darwin-x64': { name: `ps5-dump-forge-${FORGE_VERSION}-macos-universal.zip`,
    sha256: '601d7a6f75ac92f7bf6b71b0c4b45ce62d855f7812441834757ce4eb70bc3276', bin: 'ps5-dump-forge' },
  'darwin-arm64': { name: `ps5-dump-forge-${FORGE_VERSION}-macos-universal.zip`,
    sha256: '601d7a6f75ac92f7bf6b71b0c4b45ce62d855f7812441834757ce4eb70bc3276', bin: 'ps5-dump-forge' },
};

const RELEASE_BASE = `https://github.com/quer3q/ps5-dump-forge/releases/download/v${FORGE_VERSION}`;

export function forgeAsset(platform = process.platform, arch = process.arch) {
  return ASSETS[`${platform}-${arch}`] || null;
}

export function forgeToolDir() {
  return path.join(internalDataDir, 'tools', `ps5-dump-forge-${FORGE_VERSION}`);
}

export function forgeCliPath() {
  if (process.env.P5M_FORGE_CLI) return process.env.P5M_FORGE_CLI;
  const asset = forgeAsset();
  return asset ? path.join(forgeToolDir(), asset.bin) : null;
}

/* The arguments for one conversion. `opts.format` is Forge's own target name
 * (folder, exfat, ffpkg, ffpfs, ffpfsc, pkg, lz4); the packs are flags, as in
 * its API, so a packed source is unpacked on the way by the same request. */
export function forgeArgs(opts = {}) {
  const { source, output, format } = opts;
  if (!source || !output || !format) throw new Error('source, output and format are required');
  const args = ['convert', source, '--to', format];
  if (opts.inner) args.push('--inner', opts.inner);
  if (opts.zstd_pack) {
    args.push('--zstd-pack');
    if (opts.zstd_level) args.push('--zstd-level', String(opts.zstd_level));
  }
  if (opts.zstd_unpack) args.push('--zstd-unpack');
  // `--to lz4` already means "packed with LZ4"; --lz4-pack is the other way
  // of asking for it, on another target, and the two are alternatives.
  if (opts.lz4 === 'pack' && format !== 'lz4') args.push('--lz4-pack');
  if (opts.lz4 === 'pack' || format === 'lz4') {
    if (opts.lz4_level !== undefined && opts.lz4_level !== null) args.push('--lz4-level', String(opts.lz4_level));
  }
  if (opts.lz4 === 'unpack') args.push('--lz4-unpack');
  if (opts.threads) args.push('--threads', String(opts.threads));
  if (opts.remove_backport) args.push('--remove-backport');
  if (opts.pack_profile) args.push('--pack-profile', opts.pack_profile);
  if (opts.ffpfsc_level !== undefined && opts.ffpfsc_level !== null && format === 'ffpfsc') {
    args.push('--level', String(opts.ffpfsc_level));
  }
  if (opts.kraken_level && format === 'pkg') args.push('--kraken', opts.kraken_level);
  if (opts.full_verify) args.push('--full-verify');
  if (opts.delete_source) args.push('--delete-source');
  args.push('-o', output);
  return args;
}

/* One NDJSON line from the CLI, or null for anything that is not one. */
export function parseForgeLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch (_) { return null; }
  if (!ev || typeof ev !== 'object') return null;
  if (ev.kind === 'progress') {
    return { kind: 'progress', stage: String(ev.stage || ''), done: Number(ev.done) || 0, total: Number(ev.total) || 0 };
  }
  if (ev.kind === 'log') return { kind: 'log', line: String(ev.line || '') };
  if (ev.kind === 'done') {
    const r = ev.result || {};
    if (r.Ok) return { kind: 'done', ok: true, output: r.Ok.output, bytes: r.Ok.bytes, checks: r.Ok.checks || [] };
    return { kind: 'done', ok: false, error: typeof r.Err === 'string' ? r.Err : JSON.stringify(r.Err ?? 'failed') };
  }
  return null;
}

const sha256File = (file) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
});

/* Fetches the pinned CLI once, verifying it against the release checksum.
 * Returns its path. `onLog` gets a line per step. */
export async function ensureForgeCli({ onLog = () => {} } = {}) {
  const existing = forgeCliPath();
  if (existing && fs.existsSync(existing)) return existing;
  const asset = forgeAsset();
  if (!asset) throw new Error(`PS5 Dump Forge has no build for ${process.platform}/${process.arch}`);
  const dir = forgeToolDir();
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, asset.name);
  if (!fs.existsSync(archive) || (await sha256File(archive)) !== asset.sha256) {
    onLog(`downloading ${asset.name}`);
    const res = await fetch(`${RELEASE_BASE}/${asset.name}`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`cannot download ${asset.name}: HTTP ${res.status}`);
    await pipeline(res.body, fs.createWriteStream(`${archive}.part`));
    fs.renameSync(`${archive}.part`, archive);
  }
  const got = await sha256File(archive);
  if (got !== asset.sha256) {
    fs.rmSync(archive, { force: true });
    throw new Error(`${asset.name} does not match its published checksum (got ${got.slice(0, 12)}...)`);
  }
  onLog(`unpacking ${asset.name}`);
  await new Promise((resolve, reject) => {
    const cmd = asset.name.endsWith('.zip')
      ? spawn('unzip', ['-o', '-j', archive, `*/${asset.bin}`, asset.bin, '-d', dir], { stdio: 'ignore' })
      : spawn('tar', ['xzf', archive, '-C', dir, '--strip-components=1'], { stdio: 'ignore' });
    cmd.once('error', reject);
    cmd.once('close', code => (code === 0 ? resolve() : reject(new Error(`unpacking ${asset.name} failed`))));
  });
  const bin = path.join(dir, asset.bin);
  if (!fs.existsSync(bin)) throw new Error(`${asset.name} did not contain ${asset.bin}`);
  if (os.platform() !== 'win32') fs.chmodSync(bin, 0o755);
  onLog(`PS5 Dump Forge ${FORGE_VERSION} is ready at ${bin}`);
  return bin;
}
