import test from 'node:test';
import assert from 'node:assert/strict';
import { qrSvg } from './qr.js';

test('a QR of the server address is drawable and not empty', () => {
  const { path, size } = qrSvg('http://10.0.0.5:3001', { size: 160 });
  assert.equal(size, 160);
  assert.match(path, /^M[\d.]+,[\d.]+h/);
  assert.ok(path.length > 500, 'the code should have many modules');
});

test('a longer address still fits, in a denser code', () => {
  const short = qrSvg('http://10.0.0.5:3001').path.length;
  const long = qrSvg('http://p5-manager.example.org:3001/some/where').path.length;
  assert.ok(long > short);
});
