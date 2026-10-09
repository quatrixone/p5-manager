import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferPayloadPlatform, payloadMatchesPlatform } from './payloadPlatform.js';

test('explicit payload platform tags are normalized', () => {
  assert.equal(inferPayloadPlatform({ console_type: 'PS4', filename: 'homebrew.elf' }), 'ps4');
  assert.equal(inferPayloadPlatform({ console_type: 'ps5', filename: 'payload.bin' }), 'ps5');
});

test('legacy payloads are classified from their names and source URLs', () => {
  assert.equal(inferPayloadPlatform({ filename: 'goldhen.bin' }), 'ps4');
  assert.equal(inferPayloadPlatform({ filename: 'kstuff.elf', source_url: 'https://github.com/ps5-payload-dev/kstuff' }), 'ps5');
  assert.equal(inferPayloadPlatform({ filename: 'exploit.lua' }), 'ps5');
  assert.equal(inferPayloadPlatform({ filename: 'mystery.elf' }), 'ps5');
});

test('platform-specific lists exclude opposite-platform payloads and default legacy rows to PS5', () => {
  const ps5 = { filename: 'payload.elf', console_type: 'ps5' };
  const ps4 = { filename: 'payload.bin', console_type: 'ps4' };
  const unknown = { filename: 'mystery.elf' };
  assert.equal(payloadMatchesPlatform(ps5, 'ps4'), false);
  assert.equal(payloadMatchesPlatform(ps4, 'ps4'), true);
  assert.equal(payloadMatchesPlatform(unknown, 'ps4'), false);
  assert.equal(payloadMatchesPlatform(unknown, 'ps5'), true);
  assert.equal(payloadMatchesPlatform(unknown, 'all'), true);
});
