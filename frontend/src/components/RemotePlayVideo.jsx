import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

const API = '/api/remoteplay';

// Can this browser take the console's video over WebRTC? It needs WebRTC
// and an H.264 decoder there; without either the MJPEG stream is used.
export function webrtcPlayable() {
  try {
    if (typeof RTCPeerConnection === 'undefined') return false;
    const caps = RTCRtpReceiver.getCapabilities?.('video');
    return !!caps?.codecs?.some(c => /h264/i.test(c.mimeType));
  } catch (_) {
    return false;
  }
}

// Sessions whose WebRTC did not work in this tab: they stay on MJPEG until
// the page is reloaded, so a broken path is not retried on every render.
const fellBack = new Set();

const FIRST_FRAME_MS = 10000;
const STALL_MS = 3000;

// The live picture of a Remote Play session.
//
// WebRTC when it can: the console's own H.264 and Opus, decoded here, about
// a tenth of a second behind. Otherwise - an old browser, a service without
// the chiaki engine, a connection that does not come up - the MJPEG stream
// the backend has always had, about a second behind.
//
// `mediaRef` gets the <video> or the <img>, whichever is shown. Sound comes
// with WebRTC only and follows `muted`.
export default function RemotePlayVideo({
  sessionId, nonce = 0, mjpegFps = 15, muted = true,
  mediaRef, style, alt = 'PS5 Remote Play', onError, onModeChange,
}) {
  const fallbackKey = `${sessionId}:${nonce}`;
  const [mode, setMode] = useState(() => (
    webrtcPlayable() && !fellBack.has(sessionId) ? 'webrtc' : 'mjpeg'
  ));
  const videoRef = useRef(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // A new session (or a restart) tries WebRTC again.
  useEffect(() => {
    setMode(webrtcPlayable() && !fellBack.has(sessionId) ? 'webrtc' : 'mjpeg');
  }, [fallbackKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { onModeChange?.(mode); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode !== 'webrtc' || !sessionId) return undefined;
    let closed = false;
    let pc = null;
    let viewerId = null;
    let ctl = null;
    const timers = [];

    const fallBack = (why) => {
      if (closed) return;
      fellBack.add(sessionId);
      if (why) onErrorRef.current?.(`WebRTC: ${why} - showing the MJPEG stream instead`, 'info');
      setMode('mjpeg');
    };

    (async () => {
      let offer;
      try {
        offer = await api.post(`${API}/sessions/${encodeURIComponent(sessionId)}/webrtc`, {});
      } catch (e) {
        // 501: the Remote Play service has no encoded stream (another
        // engine) - not worth a message.
        fallBack(e.status === 501 ? null : e.message);
        return;
      }
      if (closed) {
        api.post(`${API}/sessions/${encodeURIComponent(sessionId)}/webrtc/${offer.viewer_id}/close`, {}).catch(() => {});
        return;
      }
      viewerId = offer.viewer_id;
      pc = new RTCPeerConnection();
      const stream = new MediaStream();
      pc.ontrack = (e) => {
        stream.addTrack(e.track);
        const v = videoRef.current;
        if (v && v.srcObject !== stream) v.srcObject = stream;
      };
      pc.ondatachannel = (e) => { ctl = e.channel; };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') fallBack('the connection to the backend failed');
      };
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await new Promise((resolve) => {
          if (pc.iceGatheringState === 'complete') return resolve();
          pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); };
          timers.push(setTimeout(resolve, 1500));
        });
        if (closed) return;
        await api.post(`${API}/sessions/${encodeURIComponent(sessionId)}/webrtc/${viewerId}/answer`, {
          sdp: pc.localDescription.sdp,
        });
      } catch (e) {
        fallBack(e.message);
        return;
      }

      // No picture in time: fall back. A picture that stops: ask the
      // console for a key frame (the decoder lost its footing on a
      // damaged frame), at most every few seconds.
      let lastFrames = 0;
      let lastChange = Date.now();
      let lastAsk = 0;
      const started = Date.now();
      timers.push(setInterval(async () => {
        if (closed || !pc) return;
        let frames = 0;
        try {
          const stats = await pc.getStats();
          stats.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') frames = s.framesDecoded || 0; });
        } catch (_) { return; }
        const now = Date.now();
        if (frames !== lastFrames) { lastFrames = frames; lastChange = now; return; }
        if (frames === 0 && now - started > FIRST_FRAME_MS) { fallBack('no picture arrived'); return; }
        if (frames > 0 && now - lastChange > STALL_MS && now - lastAsk > STALL_MS && ctl?.readyState === 'open') {
          lastAsk = now;
          ctl.send('idr');
        }
      }, 1000));
    })();

    return () => {
      closed = true;
      timers.forEach(t => { clearTimeout(t); clearInterval(t); });
      try { pc?.close(); } catch (_) {}
      if (viewerId) {
        api.post(`${API}/sessions/${encodeURIComponent(sessionId)}/webrtc/${viewerId}/close`, {}).catch(() => {});
      }
      const v = videoRef.current;
      if (v) v.srcObject = null;
    };
  }, [mode, fallbackKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unmuting needs play() again in some browsers; the click that unmuted is
  // the user gesture that allows it.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
    if (!muted) v.play?.().catch(() => {});
  }, [muted, mode]);

  const setVideo = (el) => {
    videoRef.current = el;
    if (mediaRef) mediaRef.current = el;
  };
  const setImg = (el) => {
    if (mediaRef) mediaRef.current = el;
  };

  if (mode === 'webrtc') {
    return (
      <video
        ref={setVideo}
        autoPlay
        playsInline
        muted={muted}
        aria-label={alt}
        style={style}
      />
    );
  }
  return (
    <img
      ref={setImg}
      key={nonce}
      src={`${API}/sessions/${encodeURIComponent(sessionId)}/video.mjpeg?fps=${mjpegFps}&nonce=${nonce}`}
      alt={alt}
      style={style}
      onError={() => onErrorRef.current?.('Video stream dropped - try restarting the session', 'warning')}
    />
  );
}
