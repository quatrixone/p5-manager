import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeUrl, FORGE_PORT } from './forgeProxy.js';

test('forge proxy builds a url for an endpoint it knows', () => {
  assert.equal(forgeUrl('192.0.2.5', 'jobs'), `http://192.0.2.5:${FORGE_PORT}/api/jobs`);
  assert.equal(forgeUrl('192.0.2.5', 'start_job'), `http://192.0.2.5:${FORGE_PORT}/api/start_job`);
  assert.equal(forgeUrl('192.0.2.5', 'library_scan'), `http://192.0.2.5:${FORGE_PORT}/api/library_scan`);
});

test('forge proxy refuses anything else, the dangerous ones included', () => {
  for (const tail of ['crash', 'quit', 'set', 'bench', 'debug', '../session', 'jobs/', '', 'JOBS']) {
    assert.throws(() => forgeUrl('192.0.2.5', tail), /not a Forge endpoint/i, tail);
  }
});

test('forge proxy refuses an address that is not an IP', () => {
  for (const ip of ['evil.host', '192.0.2.5:80', '', '192.0.2.5/x']) {
    assert.throws(() => forgeUrl(ip, 'jobs'), /console address/i, ip);
  }
});
