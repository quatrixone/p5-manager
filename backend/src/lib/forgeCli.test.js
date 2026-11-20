import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeArgs, parseForgeLine, forgeAsset, FORGE_VERSION } from './forgeCli.js';

test('forge args: a plain target', () => {
  assert.deepEqual(forgeArgs({ source: '/a', output: '/b', format: 'exfat' }),
    ['convert', '/a', '--to', 'exfat', '-o', '/b']);
});

test('forge args: packs are flags, not formats', () => {
  assert.deepEqual(forgeArgs({ source: '/a', output: '/b', format: 'folder', zstd_pack: true, zstd_level: 9 }),
    ['convert', '/a', '--to', 'folder', '--zstd-pack', '--zstd-level', '9', '-o', '/b']);
  // --to lz4 and --lz4-pack are two ways of asking, never both at once.
  assert.deepEqual(forgeArgs({ source: '/a', output: '/b', format: 'lz4', lz4_level: 12 }),
    ['convert', '/a', '--to', 'lz4', '--lz4-level', '12', '-o', '/b']);
  assert.deepEqual(forgeArgs({ source: '/a', output: '/b', format: 'lz4', lz4: 'pack', lz4_level: 12 }),
    ['convert', '/a', '--to', 'lz4', '--lz4-level', '12', '-o', '/b']);
  assert.deepEqual(forgeArgs({ source: '/a', output: '/b', format: 'exfat', lz4: 'pack', lz4_level: 9 }),
    ['convert', '/a', '--to', 'exfat', '--lz4-pack', '--lz4-level', '9', '-o', '/b']);
  assert.deepEqual(forgeArgs({ source: '/a', output: '/b', format: 'folder', zstd_unpack: true }),
    ['convert', '/a', '--to', 'folder', '--zstd-unpack', '-o', '/b']);
});

test('forge args: the options that belong to one target only', () => {
  const ffpfsc = forgeArgs({ source: '/a', output: '/b', format: 'ffpfsc', inner: 'exfat', ffpfsc_level: 9, kraken_level: 'smallest' });
  assert.ok(ffpfsc.includes('--inner') && ffpfsc.includes('exfat'));
  assert.deepEqual(ffpfsc.filter(x => x === '--level' || x === '9'), ['--level', '9']);
  assert.ok(!ffpfsc.includes('--kraken'), 'kraken belongs to .pkg only');
  const pkg = forgeArgs({ source: '/a', output: '/b', format: 'pkg', kraken_level: 'smallest', ffpfsc_level: 9 });
  assert.ok(pkg.includes('--kraken') && pkg.includes('smallest'));
  assert.ok(!pkg.includes('--level'), 'the zlib level belongs to .ffpfsc only');
});

test('forge args: verification and deleting the source are opt in', () => {
  const a = forgeArgs({ source: '/a', output: '/b', format: 'folder', full_verify: true, delete_source: true });
  assert.ok(a.includes('--full-verify') && a.includes('--delete-source'));
  const b = forgeArgs({ source: '/a', output: '/b', format: 'folder' });
  assert.ok(!b.includes('--full-verify') && !b.includes('--delete-source'));
});

test('forge args: refuses an incomplete request', () => {
  for (const o of [{}, { source: '/a' }, { source: '/a', output: '/b' }, { output: '/b', format: 'folder' }]) {
    assert.throws(() => forgeArgs(o), /required/);
  }
});

test('forge output: progress, log and both endings', () => {
  assert.deepEqual(parseForgeLine('{"kind":"progress","stage":"write","done":5,"total":10}'),
    { kind: 'progress', stage: 'write', done: 5, total: 10 });
  assert.deepEqual(parseForgeLine('{"kind":"log","line":"title id: PPSA01234"}'),
    { kind: 'log', line: 'title id: PPSA01234' });
  const ok = parseForgeLine('{"kind":"done","result":{"Ok":{"output":"/out","bytes":7,"checks":["a","b"]}}}');
  assert.deepEqual(ok, { kind: 'done', ok: true, output: '/out', bytes: 7, checks: ['a', 'b'] });
  const bad = parseForgeLine('{"kind":"done","result":{"Err":"preflight failed"}}');
  assert.deepEqual(bad, { kind: 'done', ok: false, error: 'preflight failed' });
});

test('forge output: anything that is not an event is ignored', () => {
  for (const l of ['', 'ps5-dump-forge: tree -> out', '{', 'null', '{"kind":"other"}', '[]']) {
    assert.equal(parseForgeLine(l), null, l);
  }
});

test('forge has a build for this machine, pinned by checksum', () => {
  const a = forgeAsset('linux', 'x64');
  assert.match(a.name, new RegExp(`${FORGE_VERSION}-linux-x86-64-musl`));
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.equal(forgeAsset('plan9', 'x64'), null);
});
