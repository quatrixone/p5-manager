import test from 'node:test';
import assert from 'node:assert/strict';
import { pickBundle, isNewerVersion } from './updateFeed.js';

const DEPS = '13f602c16733';
const PY = '6c9f0d177a1b';
const asset = (name) => ({ name, size: 1000, browser_download_url: `https://example.invalid/${name}` });
const bundle = (version, platform, { level = 1, sum = true } = {}) => {
  const name = `p5-manager-app-${version}-${platform}-level${level}-deps${DEPS}${platform === 'windows' ? `-py${PY}` : ''}.zip`;
  return sum ? [asset(name), asset(`${name}.sha256`)] : [asset(name)];
};

test('takes the bundle of its own platform', () => {
  const assets = [...bundle('1.1.3', 'docker'), ...bundle('1.1.3', 'windows')];
  const docker = pickBundle(assets, 'docker');
  assert.equal(docker.version, '1.1.3');
  assert.equal(docker.bundle.name, `p5-manager-app-1.1.3-docker-level1-deps${DEPS}.zip`);
  assert.equal(docker.bundle.sha256_url, `https://example.invalid/${docker.bundle.name}.sha256`);
  assert.equal(docker.bundle.deps, DEPS);
  assert.equal(docker.bundle.pydeps, '');
  const windows = pickBundle(assets, 'windows');
  assert.equal(windows.bundle.pydeps, PY);
  assert.equal(windows.bundle.image_level, 1);
});

test('the newest version wins, whatever the order', () => {
  const assets = [...bundle('1.1.10', 'docker'), ...bundle('1.1.9', 'docker'), ...bundle('1.2.0', 'windows')];
  assert.equal(pickBundle(assets, 'docker').version, '1.1.10');
  assert.equal(pickBundle(assets.reverse(), 'docker').version, '1.1.10');
});

test('a bundle without its checksum is not offered yet', () => {
  const assets = [...bundle('1.1.3', 'docker'), ...bundle('1.1.4', 'docker', { sum: false })];
  assert.equal(pickBundle(assets, 'docker').version, '1.1.3');
  assert.equal(pickBundle(bundle('1.1.4', 'docker', { sum: false }), 'docker'), null);
});

test('nothing for the platform, other files, no assets', () => {
  assert.equal(pickBundle(bundle('1.1.3', 'windows'), 'docker'), null);
  assert.equal(pickBundle([asset('P5Manager-windows-x64.zip'), asset('notes.txt')], 'windows'), null);
  assert.equal(pickBundle(undefined, 'docker'), null);
});

test('isNewerVersion compares numerically', () => {
  assert.equal(isNewerVersion('1.1.10', '1.1.9'), true);
  assert.equal(isNewerVersion('v1.2', '1.1.9'), true);
  assert.equal(isNewerVersion('1.1.3', '1.1.3'), false);
  assert.equal(isNewerVersion('1.1.2', '1.1.3'), false);
});
