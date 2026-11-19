import test from 'node:test';
import assert from 'node:assert/strict';
import { engineUrl, ENGINE_PORT } from './engineProxy.js';

test('engine proxy builds a url for an engine path', () => {
  assert.equal(engineUrl('192.0.2.5', 'lzc/games', ''), `http://192.0.2.5:${ENGINE_PORT}/api/lzc/games`);
  assert.equal(engineUrl('192.0.2.5', 'lzc/compress', '?titleId=PPSA01234&format=exfat'),
    `http://192.0.2.5:${ENGINE_PORT}/api/lzc/compress?titleId=PPSA01234&format=exfat`);
  assert.equal(engineUrl('192.0.2.5', 'lzc/job/cancel', ''), `http://192.0.2.5:${ENGINE_PORT}/api/lzc/job/cancel`);
  assert.equal(engineUrl('192.0.2.5', 'status', ''), `http://192.0.2.5:${ENGINE_PORT}/api/status`);
});

test('engine proxy refuses anything that is not an engine path', () => {
  for (const tail of ['lzc/../../etc/passwd', '..%2f..%2fetc', '/lzc/games', 'lzc//evil.host/x',
                      'control/shutdown', 'other', 'lzc/games?x=1', 'lzc/' + 'a'.repeat(300)]) {
    assert.throws(() => engineUrl('192.0.2.5', tail, ''), /not an engine path/i, tail);
  }
});

test('engine proxy refuses an address that is not an IP', () => {
  for (const ip of ['evil.host', '192.0.2.5:80', '', '192.0.2.5/x']) {
    assert.throws(() => engineUrl(ip, 'lzc/games', ''), /console address/i, ip);
  }
});
