// Remote Play to the browser over WebRTC.
//
// The Remote Play service hands on the session's video as the console
// encoded it (H.264, Annex B) and its sound (Opus) in p5rp's records - see
// rpnative/README.md. Here each viewer gets a peer connection with one video
// and one audio track, and the records go into them as RTP without being
// decoded: the browser does the decoding, so this costs next to nothing.
//
// Signalling is two requests: the backend makes the offer (it knows what it
// sends - the profile comes from the stream's own parameter sets), the
// browser answers. Both sides gather their candidates before they speak, which
// on a local network takes milliseconds, so there is no trickle.
//
// A data channel `ctl` carries what the browser has to say during the
// stream; for now that is `idr`, a request for a key frame when its picture
// broke.

const RECORD_HEAD = 14; // kind(1) flags(1) length(4) time(8)
const FLAG_KEY = 1;
const VIDEO_PT = 96;
const VIDEO_PT_BASELINE = 97;
const AUDIO_PT = 111;
const VIDEO_CLOCK = 90000;
const AUDIO_CLOCK = 48000;
const FIRST_KEY_TIMEOUT_MS = 8000;
const GATHER_TIMEOUT_MS = 3000;
const ANSWER_TIMEOUT_MS = 20000;
const CONNECT_TIMEOUT_MS = 20000;

let ndcPromise = null;
// node-datachannel is a native module; a platform without a prebuilt one
// still runs the rest of the app, and the browser falls back to MJPEG.
function loadNdc() {
  if (!ndcPromise) {
    ndcPromise = import('node-datachannel')
      .then((m) => m.default || m)
      .catch((e) => { ndcPromise = null; throw new Error(`WebRTC is not available here: ${e.message}`); });
  }
  return ndcPromise;
}

// ─── p5rp records ─────────────────────────────────────────────────────────

// Splits a byte stream into records. Feed it chunks; it calls onRecord with
// (kind, flags, timeUs, data) for every whole record.
export class RecordReader {
  constructor(onRecord) {
    this.onRecord = onRecord;
    this.chunks = [];
    this.size = 0;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size >= RECORD_HEAD) {
      const head = this.peek(RECORD_HEAD);
      const length = head.readUInt32BE(2);
      if (this.size < RECORD_HEAD + length) return;
      const all = this.take(RECORD_HEAD + length);
      this.onRecord(
        String.fromCharCode(all[0]),
        all[1],
        Number(all.readBigUInt64BE(6)),
        all.subarray(RECORD_HEAD),
      );
    }
  }

  peek(n) {
    if (this.chunks[0].length >= n) return this.chunks[0];
    const joined = Buffer.concat(this.chunks);
    this.chunks = [joined];
    return joined;
  }

  take(n) {
    const joined = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = joined.subarray(0, n);
    const rest = joined.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    return out;
  }
}

// profile-level-id (six hex digits) from the first SPS in an Annex B frame,
// or null. That is what the offer has to name for the browser to take it.
export function h264ProfileLevelId(frame) {
  for (let i = 0; i + 6 < frame.length; i++) {
    if (frame[i] !== 0 || frame[i + 1] !== 0) continue;
    let s = 0;
    if (frame[i + 2] === 1) s = i + 3;
    else if (frame[i + 2] === 0 && frame[i + 3] === 1) s = i + 4;
    if (!s || s + 3 >= frame.length) continue;
    if ((frame[s] & 0x1f) === 7) {
      return Buffer.from([frame[s + 1], frame[s + 2], frame[s + 3]]).toString('hex');
    }
    i = s;
  }
  return null;
}

// The H.264 payload type the browser took in its answer (the first it lists
// on the video line), or null when it turned the video down.
export function acceptedVideoPayloadType(sdp) {
  const m = /^m=video (\d+) [^ ]+ ([\d ]+)/m.exec(sdp);
  if (!m || m[1] === '0') return null;
  for (const pt of m[2].trim().split(/\s+/).map(Number)) {
    if (pt === VIDEO_PT || pt === VIDEO_PT_BASELINE) return pt;
  }
  return null;
}

// "channels rate frame_size" as the 'H' record has it.
export function parseAudioFormat(data) {
  const [channels, rate, frameSize] = String(data).trim().split(/\s+/).map(Number);
  if (!channels || !rate || !frameSize) return null;
  return { channels, rate, frameSize };
}

// ─── viewers ──────────────────────────────────────────────────────────────

const viewers = new Map(); // id -> Viewer
let nextId = 1;

function iceServers() {
  return String(process.env.P5M_WEBRTC_ICE || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function portRange() {
  const m = /^(\d+)-(\d+)$/.exec(String(process.env.P5M_WEBRTC_PORTS || '').trim());
  return m ? { portRangeBegin: Number(m[1]), portRangeEnd: Number(m[2]) } : {};
}

function waitFor(check, subscribe, timeoutMs) {
  return new Promise((resolve) => {
    if (check()) return resolve(true);
    const t = setTimeout(() => resolve(false), timeoutMs);
    subscribe(() => { if (check()) { clearTimeout(t); resolve(true); } });
  });
}

class Viewer {
  constructor({ id, sid, upstreamUrl, onClose, log }) {
    this.id = id;
    this.sid = sid;
    this.upstreamUrl = upstreamUrl;
    this.onCloseCb = onClose;
    this.log = log;
    this.abort = new AbortController();
    this.closed = false;
    this.pc = null;
    this.video = null;
    this.audio = null;
    this.videoConfig = null;
    this.audioConfig = null;
    this.ctl = null;
    this.audioFormat = null;
    this.firstKey = null;
    this.pending = []; // records that came while the browser was answering
    this.connected = false;
    this.videoStartUs = null;
    this.videoBaseTs = 0;
    this.audioTs = 0;
    this.audioStartUs = null;
  }

  // Opens the stream from the Remote Play service and reads until the first
  // key frame, which tells what the video is.
  async openUpstream() {
    const res = await fetch(this.upstreamUrl, { signal: this.abort.signal });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.detail || ''; } catch (_) {}
      const e = new Error(detail || `Remote Play service answered ${res.status}`);
      e.status = res.status === 404 ? 404 : res.status === 501 ? 501 : 502;
      throw e;
    }
    this.resolution = res.headers.get('x-stream-resolution') || null;
    let gotKey;
    const firstKey = new Promise((r) => { gotKey = r; });
    const reader = new RecordReader((kind, flags, timeUs, data) => {
      if (kind === 'H') {
        this.audioFormat = parseAudioFormat(data);
        return;
      }
      if (!this.firstKey) {
        if (kind === 'V' && (flags & FLAG_KEY)) {
          this.firstKey = { flags, timeUs, data: Buffer.from(data) };
          gotKey();
        }
        return;
      }
      if (!this.connected) {
        // Keep what comes while the browser answers, so it starts from the
        // key frame and not from a hole - but not without limit.
        if (this.pending.length < 600) this.pending.push([kind, flags, timeUs, Buffer.from(data)]);
        return;
      }
      this.forward(kind, flags, timeUs, data);
    });
    this.pump = (async () => {
      try {
        for await (const chunk of res.body) reader.push(Buffer.from(chunk));
      } catch (_) { /* aborted, or the session ended */ }
      this.close('the Remote Play stream ended');
    })();
    const ok = await Promise.race([
      firstKey.then(() => true),
      new Promise((r) => setTimeout(() => r(false), FIRST_KEY_TIMEOUT_MS)),
    ]);
    if (!ok) throw Object.assign(new Error('The console sent no picture to start from'), { status: 504 });
  }

  async offer() {
    const ndc = await loadNdc();
    const profile = h264ProfileLevelId(this.firstKey.data) || '42e01f';
    this.pc = new ndc.PeerConnection(`rp-${this.id}`, {
      iceServers: iceServers(),
      ...portRange(),
    });
    this.pc.onStateChange((state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.close(`connection ${state}`);
      }
    });

    const cname = `p5m-${this.id}`;
    const msid = `rp-${this.id}`;
    const videoSsrc = (Math.random() * 0xfffffff0) >>> 0 || 1;
    const audioSsrc = (videoSsrc + 1) >>> 0;

    // The stream's own profile first; not every browser lists every
    // profile (one without High would turn the video down), so Constrained
    // Baseline is offered beside it - the decoders behind it take High too.
    // Which one the browser took shows in its answer.
    const video = new ndc.Video('video', 'SendOnly');
    video.addH264Codec(VIDEO_PT, `profile-level-id=${profile};packetization-mode=1;level-asymmetry-allowed=1`);
    if (!profile.startsWith('42e0')) {
      video.addH264Codec(VIDEO_PT_BASELINE, 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1');
    }
    video.addSSRC(videoSsrc, cname, msid, 'video');
    this.video = this.pc.addTrack(video);
    // The track opens once the media transport is up - from then on what is
    // sent arrives.
    this.video.onOpen(() => this.onConnected());
    this.videoSsrc = videoSsrc;
    this.cname = cname;
    this.ndc = ndc;

    const audio = new ndc.Audio('audio', 'SendOnly');
    audio.addOpusCodec(AUDIO_PT);
    audio.addSSRC(audioSsrc, cname, msid, 'audio');
    this.audio = this.pc.addTrack(audio);
    this.audioConfig = new ndc.RtpPacketizationConfig(audioSsrc, cname, AUDIO_PT, AUDIO_CLOCK);
    const audioPacketizer = new ndc.RtpPacketizer(this.audioConfig);
    audioPacketizer.addToChain(new ndc.RtcpSrReporter(this.audioConfig));
    this.audio.setMediaHandler(audioPacketizer);

    this.ctl = this.pc.createDataChannel('ctl');
    this.ctl.onMessage((msg) => this.onControl(String(msg)));

    this.pc.setLocalDescription();
    await waitFor(
      () => this.pc.gatheringState() === 'complete',
      (cb) => this.pc.onGatheringStateChange(cb),
      GATHER_TIMEOUT_MS,
    );
    const desc = this.pc.localDescription();
    if (!desc) throw new Error('could not make a WebRTC offer');
    this.answerTimer = setTimeout(() => {
      if (!this.pc?.remoteDescription()) this.close('no answer from the browser');
    }, ANSWER_TIMEOUT_MS);
    return { sdp: desc.sdp, type: desc.type, profile };
  }

  answer(sdp) {
    if (this.closed) throw Object.assign(new Error('this viewer is gone'), { status: 410 });
    const pt = acceptedVideoPayloadType(String(sdp));
    if (pt === null) {
      this.close('the browser turned the video down');
      throw Object.assign(new Error('This browser cannot play the console\'s H.264 video over WebRTC'), { status: 415 });
    }
    const ndc = this.ndc;
    this.videoConfig = new ndc.RtpPacketizationConfig(this.videoSsrc, this.cname, pt, VIDEO_CLOCK);
    const packetizer = new ndc.H264RtpPacketizer('StartSequence', this.videoConfig);
    packetizer.addToChain(new ndc.RtcpSrReporter(this.videoConfig));
    packetizer.addToChain(new ndc.RtcpNackResponder());
    this.video.setMediaHandler(packetizer);
    this.pc.setRemoteDescription(String(sdp), 'answer');
    clearTimeout(this.answerTimer);
    this.connectTimer = setTimeout(() => {
      if (!this.connected) this.close('the browser could not reach the backend');
    }, CONNECT_TIMEOUT_MS);
  }

  onConnected() {
    if (this.connected || this.closed) return;
    this.connected = true;
    clearTimeout(this.connectTimer);
    const { flags, timeUs, data } = this.firstKey;
    this.forward('V', flags, timeUs, data);
    for (const r of this.pending) this.forward(...r);
    this.pending = [];
    this.log?.('info', `WebRTC viewer ${this.id} watching session ${this.sid}`);
  }

  onControl(msg) {
    if (msg === 'idr') this.onKeyRequest?.();
  }

  forward(kind, flags, timeUs, data) {
    if (this.closed) return;
    try {
      if (kind === 'V') this.sendVideo(flags, timeUs, data);
      else if (kind === 'A') this.sendAudio(timeUs, data);
    } catch (_) { /* a track that just closed */ }
  }

  sendVideo(_flags, timeUs, data) {
    if (!this.video?.isOpen()) return;
    if (this.videoStartUs === null) {
      this.videoStartUs = timeUs;
      this.videoBaseTs = this.videoConfig.timestamp;
    }
    const elapsed = Math.max(0, timeUs - this.videoStartUs);
    this.videoConfig.timestamp = (this.videoBaseTs + Math.round(elapsed * VIDEO_CLOCK / 1e6)) >>> 0;
    this.video.sendMessageBinary(Buffer.from(data));
  }

  sendAudio(timeUs, data) {
    if (!this.audio?.isOpen()) return;
    const frame = this.audioFormat?.frameSize || 480;
    if (this.audioStartUs === null) {
      this.audioStartUs = timeUs;
      this.audioTs = this.audioConfig.timestamp;
      this.audioBaseTs = this.audioTs;
      this.audioSent = 0;
    } else {
      // Packets count the time; after a gap (packets lost on the way from
      // the console) the clock jumps ahead so sound and picture stay together.
      const expected = Math.round((timeUs - this.audioStartUs) * AUDIO_CLOCK / 1e6);
      this.audioSent += frame;
      if (expected - this.audioSent > AUDIO_CLOCK / 5) this.audioSent = expected;
    }
    this.audioConfig.timestamp = (this.audioBaseTs + this.audioSent) >>> 0;
    this.audio.sendMessageBinary(Buffer.from(data));
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.answerTimer);
    clearTimeout(this.connectTimer);
    try { this.abort.abort(); } catch (_) {}
    for (const c of [this.ctl, this.video, this.audio]) { try { c?.close(); } catch (_) {} }
    try { this.pc?.close(); } catch (_) {}
    viewers.delete(this.id);
    if (this.connected) this.log?.('info', `WebRTC viewer ${this.id} of session ${this.sid} left (${reason})`);
    this.onCloseCb?.(this);
  }
}

// A new viewer of session `sid`: opens the stream and returns the offer.
// `onKeyRequest` is called when the browser asks for a key frame.
export async function createViewer({ sid, upstreamUrl, onKeyRequest, log }) {
  await loadNdc();
  const id = String(nextId++);
  const viewer = new Viewer({ id, sid, upstreamUrl, log });
  viewer.onKeyRequest = () => {
    onKeyRequest?.();
  };
  viewers.set(id, viewer);
  try {
    await viewer.openUpstream();
    const offer = await viewer.offer();
    return {
      viewer_id: id,
      ...offer,
      audio: viewer.audioFormat ? { ...viewer.audioFormat } : null,
      resolution: viewer.resolution,
    };
  } catch (e) {
    viewer.close(e.message);
    throw e;
  }
}

export function answerViewer(id, sdp) {
  const viewer = viewers.get(String(id));
  if (!viewer) throw Object.assign(new Error('no such viewer - start again'), { status: 404 });
  viewer.answer(sdp);
}

export function closeViewer(id) {
  viewers.get(String(id))?.close('closed by the browser');
}

// Every viewer of a session, when the session goes.
export function closeViewersOf(sid) {
  for (const v of [...viewers.values()]) if (v.sid === sid) v.close('session stopped');
}
