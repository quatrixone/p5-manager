import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordReader, h264ProfileLevelId, parseAudioFormat, acceptedVideoPayloadType } from './webrtc.js';

function record(kind, flags, timeUs, data) {
  const head = Buffer.alloc(14);
  head[0] = kind.charCodeAt(0);
  head[1] = flags;
  head.writeUInt32BE(data.length, 2);
  head.writeBigUInt64BE(BigInt(timeUs), 6);
  return Buffer.concat([head, data]);
}

test('RecordReader puts records together across any split', () => {
  const stream = Buffer.concat([
    record('H', 0, 0, Buffer.from('2 48000 480')),
    record('V', 1, 1234567, Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x1f])),
    record('A', 0, 1240000, Buffer.alloc(0)),
    record('A', 0, 1250000, Buffer.from([1, 2, 3])),
  ]);
  for (const step of [1, 3, 14, 15, 1000]) {
    const got = [];
    const r = new RecordReader((kind, flags, t, data) => got.push([kind, flags, t, [...data]]));
    for (let i = 0; i < stream.length; i += step) r.push(stream.subarray(i, i + step));
    assert.deepEqual(got, [
      ['H', 0, 0, [...Buffer.from('2 48000 480')]],
      ['V', 1, 1234567, [0, 0, 0, 1, 0x67, 0x64, 0, 0x1f]],
      ['A', 0, 1240000, []],
      ['A', 0, 1250000, [1, 2, 3]],
    ], `step ${step}`);
  }
});

test('h264ProfileLevelId reads the SPS, after an AUD too', () => {
  const frame = Buffer.from([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac, 0, 0, 1, 0x65, 0x88]);
  assert.equal(h264ProfileLevelId(frame), '640028');
  assert.equal(h264ProfileLevelId(Buffer.from([0, 0, 1, 0x65, 0x88, 0, 0])), null);
});

test('parseAudioFormat', () => {
  assert.deepEqual(parseAudioFormat(Buffer.from('2 48000 480')), { channels: 2, rate: 48000, frameSize: 480 });
  assert.equal(parseAudioFormat(Buffer.from('')), null);
});

test('acceptedVideoPayloadType follows the answer', () => {
  assert.equal(acceptedVideoPayloadType('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 97\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'), 97);
  assert.equal(acceptedVideoPayloadType('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97\r\n'), 96);
  assert.equal(acceptedVideoPayloadType('v=0\r\nm=video 0 UDP/TLS/RTP/SAVPF 0\r\n'), null);
  assert.equal(acceptedVideoPayloadType('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'), null);
});
