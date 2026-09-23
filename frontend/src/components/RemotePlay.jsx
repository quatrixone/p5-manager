import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiSafe } from '../lib/api.js';
import { usePs5Status } from '../contexts/Ps5StatusContext';
import { parseLine, buildOskInputs, AVAILABLE_COMMANDS } from '../lib/inputScriptDsl.js';
import ScriptRunner from './ScriptRunner';

const API = '/api/remoteplay';
// Paths used with `api.*` are relative to /api, so the Remote Play sidecar's
// routes are prefixed once here instead of building them inline.
const RP = '/remoteplay';

const PS5_BUTTONS = [
  { id: 'cross', label: 'X', color: 'var(--accent)' },
  { id: 'circle', label: '○', color: 'var(--red)' },
  { id: 'square', label: '□', color: 'var(--blue)' },
  { id: 'triangle', label: '△', color: 'var(--green)' },
  { id: 'up', label: '↑' },
  { id: 'down', label: '↓' },
  { id: 'left', label: '←' },
  { id: 'right', label: '→' },
  { id: 'l1', label: 'L1' },
  { id: 'r1', label: 'R1' },
  { id: 'l2', label: 'L2' },
  { id: 'r2', label: 'R2' },
  { id: 'l3', label: 'L3' },
  { id: 'r3', label: 'R3' },
  { id: 'options', label: 'Opts' },
  { id: 'share', label: 'Share' },
  { id: 'ps', label: 'PS' },
  { id: 'touchpad', label: 'Touchpad' },
];

function Section({ title, hint, children, status }) {
  return (
    <div className="comp-card">
      <div className="comp-card-header">
        <span className="comp-card-title">{title}</span>
        {status && <span className="text-xs text-muted">{status}</span>}
      </div>
      <div className="comp-card-body flex-col gap-md">
        {hint && <p className="text-sm text-muted">{hint}</p>}
        {children}
      </div>
    </div>
  );
}

// Press-and-hold button used by the fullscreen overlay. Behaves like a
// physical gamepad button: press = down, release = up. Re-uses the same
// pointer-event lifecycle as the in-page controller buttons so the sidecar
// receives identical {action:'press'} / {action:'release'} pairs.
//
// Visuals are tuned for the fullscreen-on-video case: very translucent at
// rest so the game stays visible, plus a clear "lit-up" press state so
// users get unmistakable tactile feedback on glass-tap UIs.
function HoldButton({
  id, label, onPress, onRelease,
  size = 64, fontSize, background, color, style = {}, ariaLabel,
}) {
  const downRef = useRef(false);
  const [pressed, setPressed] = useState(false);
  const press = (e) => {
    e?.preventDefault?.();
    if (downRef.current) return;
    downRef.current = true;
    setPressed(true);
    onPress?.(id);
  };
  const release = () => {
    if (!downRef.current) return;
    downRef.current = false;
    setPressed(false);
    onRelease?.(id);
  };
  // For colour-coded face buttons we get a tinted background prop. Default
  // is a neutral glass panel. The pressed state simply boosts opacity +
  // adds a soft glow so the same visual works on any tint.
  const baseBg = background || 'rgba(18, 22, 32, 0.28)';
  const pressedBg = background
    ? background.replace(/rgba?\(([^)]+)\)/, (_, parts) => {
        // bump the alpha of the supplied colour to ~0.95 on press
        const [r, g, b] = parts.split(',').map((s) => s.trim());
        return `rgba(${r}, ${g}, ${b}, 0.95)`;
      })
    : 'rgba(120, 145, 200, 0.55)';
  return (
    <button
      type="button"
      aria-label={ariaLabel || id}
      onPointerDown={(e) => { e.target.setPointerCapture?.(e.pointerId); press(e); }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={(e) => { if (e.buttons) release(); }}
      style={{
        width: size, height: size, borderRadius: '50%',
        background: pressed ? pressedBg : baseBg,
        WebkitBackdropFilter: 'blur(10px) saturate(140%)',
        backdropFilter: 'blur(10px) saturate(140%)',
        color: color || '#fff',
        border: `1px solid rgba(255,255,255,${pressed ? 0.55 : 0.22})`,
        fontWeight: 700,
        fontSize: fontSize || Math.round(size * 0.36),
        textShadow: '0 1px 3px rgba(0,0,0,0.6)',
        userSelect: 'none', touchAction: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: pressed
          ? '0 0 0 2px rgba(120,160,255,0.45), 0 6px 20px rgba(0,0,0,0.35)'
          : '0 2px 10px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.10)',
        transform: pressed ? 'scale(0.92)' : 'scale(1)',
        transition: 'transform 80ms ease-out, background 120ms ease-out, box-shadow 120ms ease-out',
        cursor: 'pointer',
        ...style,
      }}
    >
      {label}
    </button>
  );
}

function AnalogStick({ side, onChange, size = 130, showLabel = true, compact = false, transparent = false }) {
  const wrapRef = useRef(null);
  const [active, setActive] = useState(false);
  // activeRef mirrors `active` but updates synchronously so the very first
  // pointermove after a pointerdown can decide whether to emit. React's
  // batched setState would otherwise drop those early frames.
  const activeRef = useRef(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  // When `size` is a CSS string (e.g. clamp(96px,22vh,140px)) we need to
  // know the *rendered* pixel size to scale the knob and clamp the max
  // offset. Numeric sizes skip the observer and use the prop directly.
  const [measuredPx, setMeasuredPx] = useState(typeof size === 'number' ? size : 130);
  const sizeIsCss = typeof size === 'string';
  useEffect(() => {
    if (!sizeIsCss) { setMeasuredPx(size); return undefined; }
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect?.width;
      if (w && Math.abs(w - measuredPx) > 1) setMeasuredPx(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [size, sizeIsCss, measuredPx]);

  // Knob is 28% of the rendered diameter; maxOffset leaves a small visual
  // margin so the knob never clips the well border.
  const knobSize = Math.round(measuredPx * 0.28);
  const maxOffset = (measuredPx - knobSize) / 2 - 2;

  const emit = (x, y) => {
    setPos({ x, y });
    onChange?.({ x, y });
  };

  const onPointer = (e) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = (e.clientX - cx) / (r.width / 2);
    const dy = (e.clientY - cy) / (r.height / 2);
    const mag = Math.min(1, Math.hypot(dx, dy));
    const ang = Math.atan2(dy, dx);
    emit(Math.cos(ang) * mag, Math.sin(ang) * mag);
  };

  const well = (
    <div
      ref={wrapRef}
      // Capture must land on the WELL element, not whatever the user happened
      // to tap (often the centred knob). Using e.currentTarget guarantees
      // future pointermove events fire on the well handler regardless of the
      // hit-test target. The knob itself also opts out of pointer events
      // below so it can never intercept the gesture.
      onPointerDown={(e) => {
        activeRef.current = true;
        setActive(true);
        e.currentTarget.setPointerCapture?.(e.pointerId);
        onPointer(e);
      }}
      // Gate on the synchronous ref instead of the React state - that lets
      // the very first move frame after pointerdown emit, while still
      // ignoring mouse-hover moves when no gesture is in progress.
      onPointerMove={(e) => { if (activeRef.current) onPointer(e); }}
      onPointerUp={() => { activeRef.current = false; setActive(false); emit(0, 0); }}
      onPointerCancel={() => { activeRef.current = false; setActive(false); emit(0, 0); }}
      style={{
        width: size, height: size,
        borderRadius: '50%',
        background: transparent ? 'rgba(18, 22, 32, 0.25)' : 'var(--panel2)',
        position: 'relative',
        border: transparent
          ? `1px solid rgba(255,255,255,${active ? 0.45 : 0.20})`
          : '2px solid var(--border)',
        WebkitBackdropFilter: transparent ? 'blur(10px) saturate(140%)' : undefined,
        backdropFilter: transparent ? 'blur(10px) saturate(140%)' : undefined,
        boxShadow: transparent
          ? '0 4px 16px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.10)'
          : undefined,
        touchAction: 'none', userSelect: 'none',
      }}
    >
      <div style={{
        position: 'absolute',
        left: `calc(50% + ${pos.x * maxOffset}px - ${knobSize / 2}px)`,
        top: `calc(50% + ${pos.y * maxOffset}px - ${knobSize / 2}px)`,
        width: knobSize, height: knobSize, borderRadius: '50%',
        background: transparent
          ? (active ? 'rgba(140, 170, 230, 0.85)' : 'rgba(220, 225, 240, 0.55)')
          : (active ? 'var(--accent)' : 'var(--muted)'),
        border: transparent ? '1px solid rgba(255,255,255,0.35)' : 'none',
        transition: active ? 'none' : 'all 0.15s',
        boxShadow: active
          ? (transparent
              ? '0 0 0 4px rgba(120,160,255,0.30), 0 2px 8px rgba(0,0,0,0.4)'
              : '0 0 0 4px rgba(0,0,0,0.25)')
          : '0 2px 6px rgba(0,0,0,0.3)',
        // Knob is purely decorative for the touch gesture - the well owns
        // all pointer handling. Without this, a tap landing on the knob
        // would steal the pointer capture and the drag would never reach
        // the well's pointermove handler.
        pointerEvents: 'none',
      }} />
    </div>
  );

  if (compact) return well;

  return (
    <div className="flex-col items-center gap-xs">
      {showLabel && (
        <div className="text-xs text-muted">{side === 'left' ? 'Left stick' : 'Right stick'}</div>
      )}
      {well}
    </div>
  );
}

/**
 * Remote Play surface.
 *
 * @param {object}   props
 * @param {Array}    props.profiles
 * @param {Function} props.onNotification
 * @param {Function} props.onProfilesChanged
 * @param {Function} props.onScriptsChange
 * @param {'all'|'settings'|'main'} [props.view='all']
 *   - `all`      → full UI (header + setup + Start session + controls). Default.
 *   - `settings` → header + Setup only (Sony OAuth + PIN/offline-activation pair).
 *                  Hides Start session, video stream, controllers, fullscreen.
 *                  Used by the "PS Remote Play Settings" sub-tab in P5 Control.
 *   - `main`     → header + Start session + everything below. Setup sections
 *                  are hidden (managed via the Settings sub-tab instead).
 *                  Used by the default "Control" sub-tab in P5 Control.
 *
 * The header Section (sidecar status + profile picker + "PSN/RP" badge row)
 * stays visible in every view because it's identity context — without it
 * the rest of the UI doesn't know which PS5 it's talking to.
 */
export default function RemotePlay({ profiles, onNotification, onProfilesChanged, onScriptsChange, scripts, view = 'all' }) {
  // Derived flags for which slices of the UI tree to actually render.
  // Doing it once up here keeps the JSX below readable.
  const showMainBlock  = view === 'all' || view === 'main';
  // Setup block visibility:
  //  - 'main'     → never (Setup lives in the Settings sub-tab)
  //  - 'settings' → ALWAYS (the user explicitly opened the Settings
  //                 sub-tab; collapsing the only thing in it would be
  //                 a dead surface). The user-controlled showSetup
  //                 toggle is bypassed here on purpose.
  //  - 'all'      → respect the user's collapse choice via the
  //                 effectiveShowSetup state machine in header.
  // Computed lazily inside the JSX because effectiveShowSetup isn't
  // declared yet at this point of the function body.
  const [profileId, setProfileId] = useState('');
  const profile = useMemo(() => profiles.find(p => String(p.id) === String(profileId)) || null, [profiles, profileId]);
  // Optimistic overlay on top of the parent's profile object. Pair/OAuth/
  // forget flows used to mutate `profile` in place, which is a React
  // anti-pattern (it bypasses setState and corrupts the parent's
  // `profiles` array). Instead we hold an overlay here that is reset
  // whenever the profile id changes, and patch it from the action handlers.
  // `profileView` (renamed from `view` to avoid clashing with the
  // component's `view` prop) is what the rest of the component reads.
  const [localProfile, setLocalProfile] = useState(null);
  useEffect(() => { setLocalProfile(null); }, [profile?.id]);
  const profileView = localProfile ? { ...profile, ...localProfile } : profile;

  const [health, setHealth] = useState(null);
  const [loginUrl, setLoginUrl] = useState('');
  const [redirectUrl, setRedirectUrl] = useState('');
  const [oauthBusy, setOauthBusy] = useState(false);

  const [pin, setPin] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  // Auto-PIN fetcher state. Calls /api/remoteplay/get-pin which under the
  // hood pushes the idlesauce rp-get-pin.elf payload to the PS5 and parses
  // the PIN + base64 Account ID out of the ELF's stdout. Lets users skip
  // the "open PS5 Settings → Remote Play → enter PIN" dance when their
  // account is offline-activated (the menu won't show on those accounts).
  const [autoPinBusy, setAutoPinBusy] = useState(false);
  const [autoPinResult, setAutoPinResult] = useState(null);

  // Pair-section sub-tabs: 'activated' (default - PIN pairing flow,
  // exactly as before) vs 'unactivated' (push offact.elf to the PS5 to
  // mark the foreground user as PSN-activated, then proceed with PIN).
  // Persisted only in component state - resets to 'activated' on remount
  // since the unactivated tab is a once-per-account operation.
  const [pairTab, setPairTab] = useState('activated');
  // Offact (offline-activation) state: separate busy/result so we can
  // show progress + result without colliding with the PIN auto-fetch UI.
  const [offactBusy, setOffactBusy] = useState(false);
  const [offactResult, setOffactResult] = useState(null);

  const [sessionId, setSessionId] = useState('');
  const [sessionState, setSessionState] = useState('idle'); // idle | connecting | connected
  const [stickThrottle, setStickThrottle] = useState({ left: 0, right: 0 });
  // Video preview state. `enableVideo` is the user's intent (checkbox) - it
  // controls the next Start session call. `sessionHasVideo` reflects what
  // the *actual* live session was started with: a mid-session toggle of
  // enableVideo won't retroactively add a receiver, so we use this flag to
  // decide whether to render the <img> at all.
  const [enableVideo, setEnableVideo] = useState(false);
  const [sessionHasVideo, setSessionHasVideo] = useState(false);
  // PS5 Remote Play stream resolution. pyremoteplay supports up to 1080p
  // but we only expose 360p / 540p / 720p — anything higher saturates a
  // Pi-class CPU on the MJPEG re-encode pass and the gain is marginal
  // for a preview tile. 720p is the default sweet spot.
  const [rpResolution, setRpResolution] = useState('720p');
  // Once a session is live, report what the sidecar actually negotiated.
  // Warm-cached resume may differ from the picker if the warm session was
  // started with different params; we keep the picker value as the user
  // *intent* for the next fresh start, and `liveStream` as the *truth*.
  const [liveStream, setLiveStream] = useState(null); // { resolution, fps } | null
  // MJPEG output FPS (sidecar → browser). Separate from the RP stream FPS
  // above: this throttles how fast we re-encode JPEGs so a Pi-class CPU
  // doesn't melt. 30 fps default matches the RP stream so we never miss
  // frames at the encode stage. The picker lets users drop lower for slow
  // links or push to the sidecar's cap (also 30).
  const [videoFps, setVideoFps] = useState(30);
  // Cache-buster for the <img> src: when the session restarts we want the
  // browser to actually re-open the stream instead of using the cached
  // connection. Bumped on every successful start.
  const [videoNonce, setVideoNonce] = useState(0);

  // ─── Input Scripts tab (script list/editor + step-by-step runner) ──────
  // Lives inside the Live Session card, sharing the SAME video img/session
  // as the Control tab - see the sessionViewTab switch below. ScriptRunner
  // is rendered as a direct child here (not a sibling anymore), so its
  // "👣 Step" buttons call openStepMode() directly via the onRequestStep
  // prop - no more lifting state up through PS5Control.
  const [sessionViewTab, setSessionViewTab] = useState('control'); // 'control' | 'scripts' | 'payloads'
  const [stepPanel, setStepPanel] = useState(null); // { name, steps, index } | null
  const [stepBusy, setStepBusy] = useState(false);
  // DOM node per step row (keyed by index), so the current step can be
  // scrolled into view + focused automatically whenever the cursor moves
  // (Next / Prev / Restart / Replay all just change stepPanel.index).
  const stepLineRefs = useRef([]);
  useEffect(() => {
    if (!stepPanel) return;
    const el = stepLineRefs.current[stepPanel.index];
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el.focus?.({ preventScroll: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepPanel?.index]);
  const [stepMobileTab, setStepMobileTab] = useState('video');
  const [editingStepIdx, setEditingStepIdx] = useState(null);
  const [stepDraftText, setStepDraftText] = useState('');
  const [stepDraftError, setStepDraftError] = useState('');
  const [addAfterIdx, setAddAfterIdx] = useState(null); // -1 = top, else step index, null = closed
  const [addDraftText, setAddDraftText] = useState('');
  const [addDraftError, setAddDraftError] = useState('');

  // ─── Payloads tab ───────────────────────────────────────────────────────
  // Send a payload to the console without leaving PS Remote Play. Mirrors
  // PayloadList.jsx's send action (POST /payloads/send/:id) but scoped to
  // whatever profile this Remote Play view is already talking to.
  const [payloadsList, setPayloadsList] = useState([]);
  const [payloadsLoaded, setPayloadsLoaded] = useState(false);
  const [sendingPayloadId, setSendingPayloadId] = useState(null);

  // Fullscreen video + touch-controls overlay. `fsActive` is the *user
  // intent* (toggled by the button). We also listen to fullscreenchange so
  // Esc / browser back / OS gestures collapse the overlay cleanly.
  const videoContainerRef = useRef(null);
  const [fsActive, setFsActive] = useState(false);

  // ─── Input recording ──────────────────────────────────────────────────────
  //
  // While `recording` is true, every payload that flows through `sendInput`
  // is timestamped and buffered. On Stop we walk the timeline and emit a
  // script-DSL transcript (the same format ScriptRunner consumes). Buffer
  // lives in a ref so individual events don't cause re-renders mid-game.
  const [recording, setRecording] = useState(false);
  const recBufferRef = useRef([]);
  const recStartRef = useRef(0);
  const [recElapsed, setRecElapsed] = useState(0);   // re-render clock for HUD
  const [recEventCount, setRecEventCount] = useState(0);
  const [recReviewOpen, setRecReviewOpen] = useState(false);
  // `recRecordedBody` is the immutable transcript of the just-finished
  // session. `recScriptText` is what's actually in the textarea, which the
  // user may freely edit (and which may include the existing destination's
  // content when appending). Keeping them separate means picking a different
  // destination re-renders the textarea from scratch without losing the
  // recording itself.
  const [recRecordedBody, setRecRecordedBody] = useState('');
  const [recScriptText, setRecScriptText] = useState('');
  const [recExistingScripts, setRecExistingScripts] = useState([]);
  // Persistent "append target" — the user can pick a script to keep growing
  // across multiple recording sessions. Restored from localStorage on mount.
  const [recAppendId, setRecAppendId] = useState(() => {
    try { return localStorage.getItem('rp:recAppendId') || ''; } catch { return ''; }
  });
  const [recNewName, setRecNewName] = useState('');
  const [recSaving, setRecSaving] = useState(false);

  useEffect(() => {
    try {
      if (recAppendId) localStorage.setItem('rp:recAppendId', recAppendId);
      else localStorage.removeItem('rp:recAppendId');
    } catch { /* ignore */ }
  }, [recAppendId]);

  // Cheap once-per-second clock so the REC pill updates while active.
  useEffect(() => {
    if (!recording) return undefined;
    const id = setInterval(() => setRecElapsed(Date.now() - recStartRef.current), 250);
    return () => clearInterval(id);
  }, [recording]);

  // On unmount, drop any in-flight recording state. Without this, a quick
  // tab switch while holding a button would leave `recording` true (the
  // pill still rendered) and the buffer would keep growing for any late
  // sendInput invocations before React finally tears the component down.
  useEffect(() => {
    return () => {
      recBufferRef.current = [];
      setRecording(false);
    };
  }, []);

  // Fetch BOTH user-saved scripts and built-in macros. Built-in entries are
  // tagged so the save flow can route them to /api/input-scripts/builtin/:id
  // instead of the SQL-backed PUT endpoint. The dropdown shows them with a
  // 🔧 prefix so the user can clearly tell them apart.
  const fetchExistingScripts = useCallback(async () => {
    const [userArr, builtinArr] = await Promise.all([
      apiSafe.get('/input-scripts'),
      apiSafe.get('/input-scripts/builtin'),
    ]);
    const merged = [
      ...(Array.isArray(userArr) ? userArr.map(s => ({
        id: String(s.id), name: s.name, script: s.script || '', kind: 'user',
      })) : []),
      ...(Array.isArray(builtinArr) ? builtinArr.map(s => ({
        id: s.id, name: s.name, script: s.script || '', kind: 'builtin',
      })) : []),
    ];
    setRecExistingScripts(merged);
    return merged;
  }, []);

  // Map internal button id → script DSL identifier.
  const dslName = (id) => ({ l1:'L1', r1:'R1', l2:'L2', r2:'R2', l3:'L3', r3:'R3' }[id] || id);

  const compileRecording = (events) => {
    const lines = [];
    const pressedAt = {};
    let lastEmitT = null;
    for (const e of events) {
      if (e.kind !== 'button') continue;        // sticks not representable
      if (e.action === 'press') {
        // If a second press arrives without release (e.g. stuck event),
        // keep the *earliest* press time so the eventual release still
        // produces a tap line instead of being silently dropped.
        if (pressedAt[e.id] == null) pressedAt[e.id] = e.t;
      } else if (e.action === 'release') {
        const t0 = pressedAt[e.id];
        if (t0 == null) continue;
        delete pressedAt[e.id];
        if (lastEmitT != null) {
          const gap = t0 - lastEmitT;
          if (gap >= 80) lines.push(`wait ${Math.round(gap)}`);
        }
        const hold = e.t - t0;
        const name = dslName(e.id);
        // Only emit an explicit hold duration when it's noticeably longer
        // than the default tap; otherwise a bare button line keeps the
        // script readable.
        if (hold > 200) lines.push(`${name} ${Math.round(hold)}`);
        else lines.push(name);
        lastEmitT = e.t;
      }
    }
    return lines.join('\n');
  };

  // Build the textarea body for a given destination + recorded transcript.
  // When destination is set, the destination's current script is included
  // ABOVE the freshly recorded lines so the user can read / edit / reorder
  // everything in one place before saving.
  const buildReviewBody = (destinationId, scripts, recorded) => {
    if (!destinationId) return recorded;
    const dest = scripts.find(s => s.id === destinationId);
    if (!dest) return recorded;
    const head = (dest.script || '').replace(/\s+$/, '');
    if (!recorded.trim()) return head;
    const stamp = new Date().toLocaleString();
    const sep = head ? `${head}\n\n# --- recorded ${stamp} ---\n` : '';
    return `${sep}${recorded}`;
  };

  const startRecording = async () => {
    recBufferRef.current = [];
    recStartRef.current = Date.now();
    setRecElapsed(0);
    setRecEventCount(0);
    setRecReviewOpen(false);
    setRecording(true);
    // Pre-fetch existing scripts so the post-record panel renders instantly.
    fetchExistingScripts();
  };

  // ─── Run-script picker (▶ button) ───────────────────────────────────────
  // Lists every saved + built-in script; picking one hands off to the
  // existing step-through runner (openStepMode, defined below) so playback
  // against the live session/video is the one already-tested code path -
  // no separate "auto-run a whole script" engine duplicated here.
  const [runPickerOpen, setRunPickerOpen] = useState(false);
  const openRunPicker = async () => {
    await fetchExistingScripts();
    setRunPickerOpen(true);
  };
  const closeRunPicker = () => setRunPickerOpen(false);
  const runPickedScript = (s) => {
    setRunPickerOpen(false);
    openStepMode(s.script, s.name, false, { id: s.id, kind: s.kind });
  };

  // ─── Auto-hiding video overlay controls ─────────────────────────────────
  // The REC/▶ cluster sitting on top of the video shrinks to a small dot
  // after a few seconds of no interaction so it doesn't permanently
  // obscure the preview; hovering (desktop) or tapping the dot (mobile)
  // brings the full row back for another few seconds. Never hides while
  // actively recording - the elapsed-time HUD needs to stay legible.
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsHideTimerRef = useRef(null);
  const showControls = () => {
    setControlsVisible(true);
    if (controlsHideTimerRef.current) clearTimeout(controlsHideTimerRef.current);
    if (!recording) {
      controlsHideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
    }
  };
  useEffect(() => {
    showControls();
    return () => { if (controlsHideTimerRef.current) clearTimeout(controlsHideTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Force the row back open the moment recording starts, and resume the
  // auto-hide countdown the moment it stops.
  useEffect(() => {
    if (recording) {
      setControlsVisible(true);
      if (controlsHideTimerRef.current) clearTimeout(controlsHideTimerRef.current);
    } else {
      showControls();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const stopRecording = async () => {
    setRecording(false);
    const buf = recBufferRef.current.slice();
    const compiled = compileRecording(buf);
    if (!compiled.trim()) {
      onNotification?.('Recording stopped — no button events captured', 'info');
      return;
    }
    setRecRecordedBody(compiled);
    // Ensure dropdown is populated before the modal renders so the
    // pre-loaded existing content is accurate from the very first paint.
    const scripts = await fetchExistingScripts();
    setRecScriptText(buildReviewBody(recAppendId, scripts, compiled));
    setRecReviewOpen(true);
  };

  // When the user picks a different destination, re-derive the textarea
  // body from the immutable recorded transcript + the new destination's
  // existing content. Any in-place edits the user made get reset — which is
  // the only sensible behaviour: keeping them would mix lines from two
  // different scripts together silently.
  const handleDestinationChange = (newId) => {
    setRecAppendId(newId);
    setRecScriptText(buildReviewBody(newId, recExistingScripts, recRecordedBody));
  };

  const discardRecording = () => {
    setRecReviewOpen(false);
    setRecScriptText('');
    setRecRecordedBody('');
    recBufferRef.current = [];
  };

  const saveRecording = async () => {
    if (recSaving) return;
    const body = (recScriptText || '').trim();
    if (!body) {
      onNotification?.('Nothing to save — script is empty', 'warning');
      return;
    }
    setRecSaving(true);
    try {
      // Three save paths: built-in entry, existing user entry, or brand-new.
      if (recAppendId.startsWith('builtin:')) {
        await api.put(`/input-scripts/builtin/${encodeURIComponent(recAppendId)}`, { script: body });
        const dest = recExistingScripts.find(s => s.id === recAppendId);
        onNotification?.(`Updated built-in "${dest?.name || recAppendId}"`, 'success');
      } else if (recAppendId) {
        // User script: PUT replaces both name (unchanged) and script body.
        const dest = recExistingScripts.find(s => s.id === recAppendId);
        const existing = await api.get(`/input-scripts/${encodeURIComponent(recAppendId)}`);
        await api.put(`/input-scripts/${encodeURIComponent(recAppendId)}`, { name: existing.name, script: body });
        onNotification?.(`Updated "${dest?.name || existing.name}"`, 'success');
      } else {
        const name = (recNewName || '').trim() || `Recording ${new Date().toLocaleString()}`;
        const created = await api.post('/input-scripts', { name, script: body });
        onNotification?.(`Saved as "${name}"`, 'success');
        // Stick on the new script so the next recording can append to it.
        if (created && created.id) setRecAppendId(String(created.id));
        setRecNewName('');
      }
      fetchExistingScripts();
      setRecReviewOpen(false);
      setRecScriptText('');
      setRecRecordedBody('');
      recBufferRef.current = [];
      onScriptsChange?.();
    } catch (e) {
      onNotification?.(`Save failed: ${e.message}`, 'error');
    } finally {
      setRecSaving(false);
    }
  };

  // Sidecar-reported warm cache state for the current profile's IP. Updated
  // by the watchdog tick. When set, the "Start session" button can promise
  // a near-instant resume instead of a 60-150 s cold start, and the Wake
  // button can be greyed out (pre-warm is a no-op when already warm).
  const [warmCache, setWarmCache] = useState(null); // { ttl_s, video } | null
  const [wakeBusy, setWakeBusy] = useState(false);

  // Shared status (see Ps5StatusContext.jsx): the topbar and PS5 Control
  // used to run two independent pollers asking two different questions
  // about the same console, which is what made the topbar dot flash red
  // the instant "Wake PS5" was clicked even though the console really was
  // waking up. The provider is scoped to the app's DEFAULT profile (same
  // one the topbar shows); when this component's own profile picker (see
  // `profileId` state, below) is pointed at that same profile - the
  // common case - we read the shared state instead of polling again
  // ourselves. If the user picked a *different* profile here, the shared
  // state doesn't apply to it, so we fall back to a local one-off check
  // (ps5StatusCtx.profileId won't match `profile.id` in that case).
  const ps5StatusCtx = usePs5Status();
  const usingSharedStatus = ps5StatusCtx.profileId != null && profile?.id === ps5StatusCtx.profileId;

  // Last DDP discover snapshot for the current profile. Lets us show the
  // user *why* a Start failed (PS5 in standby? offline?) and pick the right
  // recovery suggestion without them having to read the sidecar logs.
  //   { status: 'Ok' | 'Standby', code, runningApp, hostName } | { error }
  const [localPs5State, setLocalPs5State] = useState(null);
  const [ps5Busy, setPs5Busy] = useState(false);

  const ps5State = usingSharedStatus
    ? (ps5StatusCtx.ddp?.success
        ? {
            status: ps5StatusCtx.ddp.status || 'Unknown',
            code: ps5StatusCtx.ddp.status_code,
            runningApp: ps5StatusCtx.ddp.running_app || null,
            hostName: ps5StatusCtx.ddp.host_name || null,
          }
        : (ps5StatusCtx.ddp ? { error: ps5StatusCtx.ddp.error || 'unreachable' } : null))
    : localPs5State;
  // Ref mirrors so the polling effect always sees the latest values without
  // having to re-subscribe (which would reset the interval timer).
  const sessionStateRef = useRef('idle');
  const userStoppedRef = useRef(false);
  // Countdown shown on the Start button while /sessions/start is stuck in
  // the sidecar's 45 s post-disconnect-lock retry (see retryStatus poll
  // effect below). null when not currently retrying.
  const [retryStatus, setRetryStatus] = useState(null);
  // Timestamp until which the quick-status poll (tick(), below) should
  // ignore an "active" response instead of re-adopting it. Without this,
  // clicking Stop races the next poll tick: the soft-stop call on the
  // sidecar hasn't fully propagated yet, quick-status still reports the
  // old session as active, tick() re-adopts it and flips sessionState
  // back to 'connected' - which then permanently disables the Wake
  // button (disabled whenever liveSession is true) until something else
  // clears it. Reproduced via repeated automated Rest/Wake/Start/Stop
  // cycling: ~50% of cycles hit this race with the bare 6 s poll interval.
  const stoppedUntilRef = useRef(0);
  useEffect(() => { sessionStateRef.current = sessionState; }, [sessionState]);

  useEffect(() => {
    if (!profileId && profiles.length) {
      const def = profiles.find(p => p.is_default) || profiles[0];
      if (def) setProfileId(String(def.id));
    }
  }, [profiles, profileId]);

  useEffect(() => {
    apiSafe.get(`${RP}/health`).then(d => setHealth(d || { success: false, error: 'sidecar offline' }));
  }, []);

  // DDP discover - returns whether the PS5 is on/standby/unreachable plus
  // the currently running app. Cheap (single UDP round-trip), but can
  // timeout up to 8 s when the console is unreachable, so we never poll it
  // tightly: only on profile change and after session lifecycle events.
  const refreshPs5State = async (silent = true) => {
    if (usingSharedStatus) return ps5StatusCtx.refresh(silent);
    if (!profile?.ip_address) { setLocalPs5State(null); return null; }
    if (!silent) setPs5Busy(true);
    try {
      const r = await api.get(`${RP}/discover?ip=${encodeURIComponent(profile.ip_address)}`);
      if (r.success) {
        const next = {
          status: r.status || 'Unknown',
          code: r.status_code,
          runningApp: r.running_app || null,
          hostName: r.host_name || null,
        };
        setLocalPs5State(next);
        return next;
      }
      const err = { error: r.error || 'unreachable' };
      setLocalPs5State(err);
      return err;
    } catch (e) {
      const err = { error: e.message };
      setLocalPs5State(err);
      return err;
    } finally {
      if (!silent) setPs5Busy(false);
    }
  };

  // Pull a fresh DDP snapshot whenever the active profile changes, but only
  // for the local fallback path - the shared context already polls itself.
  useEffect(() => {
    if (usingSharedStatus) return;
    if (profile?.ip_address) refreshPs5State(true);
    else setLocalPs5State(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.ip_address, usingSharedStatus]);

  const accountLinked = !!profileView?.psn_account_id;
  const paired = !!profileView?.rp_user_profile;
  const liveSession = sessionState === 'connected';

  // Setup steps (1 PSN link, 2 PIN pair) collapse once both are done so the
  // common case (start session, control PS5) is one click away. The toggle
  // is exposed on the header section so users can still re-link / re-pair.
  //
  // We track three modes:
  //   - showSetup === null     → auto: collapse when setupComplete, expand otherwise
  //   - showSetup === true     → user explicitly expanded (stays expanded)
  //   - showSetup === false    → user explicitly collapsed (stays collapsed)
  // This avoids the "first render flash" bug where profile data isn't loaded
  // yet, setupComplete computes to false, and the panel stays open on
  // mobile even after pairing data arrives.
  const setupComplete = accountLinked && paired;
  const [showSetup, setShowSetup] = useState(null);
  const effectiveShowSetup = showSetup === null ? !setupComplete : showSetup;

  // --- OAuth ----------------------------------------------------------------

  const startOAuth = async () => {
    setOauthBusy(true);
    try {
      const r = await api.get(`${RP}/oauth/login-url`);
      if (!r.success) throw new Error(r.error);
      setLoginUrl(r.url);
      window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      onNotification?.(`OAuth start failed: ${e.message}`, 'error');
    } finally {
      setOauthBusy(false);
    }
  };

  const finishOAuth = async () => {
    if (!redirectUrl.trim()) return;
    if (!profile) { onNotification?.('Pick a profile first', 'warning'); return; }
    setOauthBusy(true);
    try {
      const r = await api.post(`${RP}/oauth/exchange`, {
        redirect_url: redirectUrl.trim(),
        profile_id: profile.id,
      });
      if (!r.success) throw new Error(r.error);
      onNotification?.(`Linked PSN account: ${r.online_id || r.account_id}`, 'success');
      setRedirectUrl('');
      // Optimistic overlay — let `view` reflect the linked state immediately,
      // then ask the parent to refetch profiles so the new field reaches the
      // rest of the tree and our overlay resets cleanly on the next render.
      setLocalProfile((prev) => ({ ...(prev || profile), psn_account_id: r.account_id, psn_online_id: r.online_id }));
      onProfilesChanged?.();
    } catch (e) {
      onNotification?.(`OAuth exchange failed: ${e.message}`, 'error');
    } finally {
      setOauthBusy(false);
    }
  };

  // --- Pair -----------------------------------------------------------------

  // Profile-aware pairing instructions. PS4 takes a slightly different menu
  // path to the Link Device screen ("Settings → Remote Play Connection
  // Settings → Add Device") and the PIN is also 8 digits but lives in a
  // different sub-menu — we surface both so the user can't get lost.
  const isPs4Profile = profileView?.console_type === 'ps4';
  // rp-get-pin.elf is a PS5-only payload (ptrace path uses PS5 SDK + 12.70
  // kernel offsets), so the Auto-fetch PIN button only appears on PS5
  // profiles. PS4 profiles still get the manual 8-digit PIN entry below.
  const isPs5Profile = !isPs4Profile;
  const pairConsoleLabel = isPs4Profile ? 'PS4' : 'PS5';
  const pairMenuPath = isPs4Profile
    ? 'PS4: Settings → Remote Play Connection Settings → Add Device'
    : 'PS5: Settings → System → Remote Play → Link Device';

  const pair = async () => {
    if (!profile) return;
    if (liveSession) {
      onNotification?.('Stop the live Remote Play session before pairing - registering a new PIN while the console is already connected can knock out the active session.', 'warning');
      return;
    }
    if (pin.replace(/\D/g, '').length < 8) {
      onNotification?.(`PIN must be 8 digits (shown on ${pairMenuPath})`, 'warning');
      return;
    }
    setPairBusy(true);
    try {
      const r = await api.post(`${RP}/register`, {
        ip: profile.ip_address,
        pin: pin.replace(/\D/g, ''),
        profile_id: profile.id,
      });
      if (!r.success) throw new Error(r.error);
      onNotification?.(`${pairConsoleLabel} paired for Remote Play`, 'success');
      setPin('');
      setLocalProfile((prev) => ({ ...(prev || profile), rp_user_profile: JSON.stringify(r.profile) }));
      onProfilesChanged?.();
    } catch (e) {
      onNotification?.(`Pair failed: ${e.message}`, 'error');
    } finally {
      setPairBusy(false);
    }
  };

  // Auto-fetch the PIN by sending the rp-get-pin.elf payload to elfldr.
  // The backend parses the ELF's stdout for "Pin code: NNNN NNNN" and
  // "Account ID: <base64>" and returns both. On success we drop the PIN
  // straight into the input field so the user can hit Pair without typing
  // 8 digits from a tiny PS5-screen notification. The Account ID is shown
  // for verification but NOT auto-pushed into the profile - if it differs
  // from what OAuth captured the user probably wants to know.
  const autoFetchPin = async () => {
    if (!profile) return;
    if (liveSession) {
      onNotification?.('Stop the live Remote Play session before fetching a PIN - rp-get-pin.elf attaches to SceShellUI and can interrupt an active session.', 'warning');
      return;
    }
    setAutoPinBusy(true);
    setAutoPinResult(null);
    try {
      const r = await api.post(`${RP}/get-pin`, {
        ip: profile.ip_address,
        profile_id: profile.id,
      });

      if (r.pin) {
        setPin(r.pin.replace(/\s+/g, ''));
        setAutoPinResult({ pin: r.pin, account_id: r.account_id, online_id: r.online_id, log: r.log });
        // Backend now persists account_id + online_id onto the profile when
        // the PS5 is PSN-signed-in (rp-get-pin reads them straight from
        // regmgr). Mirror them in the optimistic overlay so the "PSN
        // Activated" step ticks immediately without waiting for the next
        // profiles refresh, then trigger a refresh so other tabs see it.
        if (r.account_id || r.online_id) {
          setLocalProfile((prev) => ({
            ...(prev || profile),
            ...(r.account_id ? { psn_account_id: r.account_id } : {}),
            ...(r.online_id ? { psn_online_id: r.online_id } : {}),
          }));
        }
        if (r.account_id) onProfilesChanged?.();
        const who = r.online_id || (r.account_id ? `${r.account_id.slice(0, 12)}…` : null);
        onNotification?.(
          `PIN captured: ${r.pin}${who ? ` for ${who}` : ''}`,
          'success',
        );
      } else if (r.message) {
        // Soft failure - payload ran but didn't produce a usable PIN line.
        // We surface the captured stdout log so the user can see what
        // actually happened (ptrace contention, old-instance kill, etc.)
        // instead of just a vague error.
        setAutoPinResult({ message: r.message, log: r.log });
        onNotification?.(r.message, 'warning');
      } else if (r.error) {
        throw new Error(r.error);
      } else {
        throw new Error('No PIN line in payload output (check Logs tab)');
      }
    } catch (e) {
      onNotification?.(`Auto-fetch PIN failed: ${e.message}`, 'error');
      setAutoPinResult({ error: e.message });
    } finally {
      setAutoPinBusy(false);
    }
  };

  // Push the PSN account we linked via OAuth (step 1) onto the PS5
  // by sending offact.elf. Used for the "Not Activated" sub-tab when
  // the console itself has nobody signed into PSN.
  //
  // Backend writes profile.psn_account_id into a trigger file on the
  // PS5 via FTP, then ships the ELF. offact reads the trigger and
  // syncs the on-console registry to it (adopt when empty, overwrite
  // when different, no-op when already in sync). The result is that
  // the foreground PS5 user becomes linked to the same PSN account
  // the manager is using, without anyone having to sign into PSN
  // on the console itself.
  //
  // On success we auto-switch back to the "PSN Activated" sub-tab so
  // the user can continue with PIN pairing.
  const activateOffline = async () => {
    if (!profile) { onNotification?.('Pick a profile first', 'warning'); return; }
    setOffactBusy(true);
    setOffactResult(null);
    try {
      const r = await api.post(`${RP}/activate-account`, {
        ip: profile.ip_address,
        profile_id: profile.id,
      });

      setOffactResult(r);

      if (r.success) {
        // Optimistic overlay so the rest of the UI updates without waiting
        // for the parent's profile refetch.
        if (r.account_id || r.user) {
          setLocalProfile((prev) => ({
            ...(prev || profile),
            ...(r.account_id ? { psn_account_id: r.account_id } : {}),
            ...(r.user ? { psn_online_id: r.user } : {}),
          }));
        }
        onProfilesChanged?.();

        const verb = r.activated === 'already' ? 'already activated' : 'activated';
        onNotification?.(
          `${r.user || 'Account'} ${verb} (slot ${r.slot}) — you can now grab a PIN and pair.`,
          'success',
        );

        // Hop the user to the PIN sub-tab so the next step is right
        // under their cursor instead of behind another click.
        setPairTab('activated');
      } else {
        const msg = r.message || r.error || 'offact.elf failed';
        onNotification?.(`Push to console failed: ${msg}`, 'error');
      }
    } catch (e) {
      onNotification?.(`Push to console failed: ${e.message}`, 'error');
      setOffactResult({ error: e.message });
    } finally {
      setOffactBusy(false);
    }
  };

  const forgetPair = async () => {
    if (!profile) return;
    if (!confirm('Forget Remote Play credentials on this profile?')) return;
    try {
      await api.post(`${RP}/forget`, { profile_id: profile.id });
      setLocalProfile((prev) => ({ ...(prev || profile), rp_user_profile: null }));
      onProfilesChanged?.();
      onNotification?.('Forgotten', 'success');
    } catch (e) {
      onNotification?.(e.message, 'error');
    }
  };

  // Wipes the OAuth-derived (or offact-derived) PSN account from this
  // profile. Pairing credentials are kept intact so the user can re-link
  // a different PSN account onto the same paired console without
  // re-doing the PIN dance. Mirrors forgetPair but talks to the new
  // /forget-account endpoint.
  const forgetAccount = async () => {
    if (!profile) return;
    if (!confirm(
      'Forget the linked PSN account on this profile?\n\n' +
      'Pairing credentials will be kept - you can link a different ' +
      'PSN account without re-pairing.'
    )) return;
    try {
      const r = await api.post(`${RP}/forget-account`, { profile_id: profile.id });
      if (!r.success) throw new Error(r.error || 'forget-account failed');
      setLocalProfile((prev) => ({ ...(prev || profile), psn_account_id: null, psn_online_id: null }));
      onProfilesChanged?.();
      onNotification?.('PSN account forgotten', 'success');
    } catch (e) {
      onNotification?.(`Forget account failed: ${e.message}`, 'error');
    }
  };

  // --- Session --------------------------------------------------------------

  // Translate the most common /sessions/start failure modes into an
  // actionable user-facing tip. Returns an appended hint string (empty
  // when we don't recognise the error). Keeps the toast self-explanatory
  // so the user doesn't have to read the sidecar logs to know what to do.
  const explainStartError = (msg) => {
    const m = (msg || '').toLowerCase();
    if (/another remote play session/.test(m))
      return ' Tip: click 📡 Wake PS5 to claim the slot, or close any other Remote Play / Chiaki-ng client connected to this PS5.';
    if (/connection refused|errno 111/.test(m))
      return ' Tip: PS5 Remote Play service is restarting. Wait ~30 s and try 📡 Wake PS5. If it persists, hard-reset the console (hold power 7 s).';
    if (/didn.?t wake up|standby/.test(m))
      return ' Tip: PS5 stayed in rest mode - check it has network access (Settings → System → Power Saving → Features in Rest Mode → Stay Connected to the Internet).';
    if (/credentials|profile|re-pair|no remote play/.test(m))
      return ' Tip: re-pair the PS5 in step 2 above.';
    if (/timeout/.test(m))
      return ' Tip: sidecar took too long. Try 🧹 Force reset, then 📡 Wake PS5.';
    if (/not reachable|no status/.test(m))
      return ' Tip: PS5 is offline. Check it is powered on and on the same network as this server.';
    return '';
  };

  // `forceVideo` lets a caller (the step-by-step Input Scripts tab) demand
  // video without going through the checkbox - setEnableVideo(true) then
  // immediately calling startSession() would still read the OLD value of
  // `enableVideo` via closure (React state updates aren't synchronous), so
  // this is a real parameter, not a stale-read workaround-by-convention.
  const startSession = async (forceVideo = false) => {
    if (!profile) return false;
    userStoppedRef.current = false;
    setSessionState('connecting');
    try {
      const r = await api.post(`${RP}/sessions/start`, {
        ip: profile.ip_address,
        profile_id: profile.id,
        enable_video: forceVideo || enableVideo,
        // Pass the user-chosen resolution. The sidecar normalises it,
        // so out-of-range values are coerced rather than rejected.
        resolution: rpResolution,
      });
      if (!r.success) throw new Error(r.error);
      setSessionId(r.session_id);
      setSessionState('connected');
      setSessionHasVideo(!!r.video);
      setLiveStream({
        resolution: r.resolution || rpResolution,
      });
      setVideoNonce(n => n + 1);
      const resumeTag = r.resumed ? ' (resumed from warm cache)' : r.reused ? ' (reused existing)' : '';
      const mediaBits = r.video ? 'video' : '';
      const streamTag = r.resolution ? ` @ ${r.resolution}` : '';
      onNotification?.(
        (mediaBits ? `Remote Play session started with ${mediaBits}` : 'Remote Play session started')
          + resumeTag + streamTag,
        'success',
      );
      // Refresh DDP state so the "Running: <app>" row + hint text reflect
      // the woken console instead of the stale "Standby" from before.
      refreshPs5State(true);
      return true;
    } catch (e) {
      setSessionState('idle');
      setSessionHasVideo(false);
      setLiveStream(null);
      const hint = explainStartError(e.message);
      onNotification?.(`Start failed: ${e.message}.${hint}`, 'error');
      // A failed start often means the PS5 went into a weird state - poll
      // discover so the next render reflects ground truth.
      refreshPs5State(true);
      return false;
    }
  };

  const stopSession = async () => {
    // Soft-stop preference: we want the sidecar to park the session in its
    // warm cache so the next Start resumes in O(ms) instead of fighting the
    // 60s PS5 post-disconnect lock.
    //
    // We use EXACTLY ONE endpoint:
    //   - /sessions/:sid/stop  when we know the local session id (normal case);
    //     this soft-stops on the sidecar and KEEPS the warm cache populated.
    //   - /quick-stop          only as a fallback when sessionId is empty
    //     (failed Start, page reload). Calling both used to wipe the warm
    //     cache because /quick-stop's "no local cache → stop-all" fallback
    //     fires right after /sessions/:sid/stop emptied the Node cache.
    userStoppedRef.current = true;
    // Set BEFORE the await so even a tick() already in flight when Stop
    // was clicked (racing the soft-stop call itself) discards its stale
    // "active" response instead of re-adopting the session we're in the
    // middle of stopping.
    stoppedUntilRef.current = Date.now() + 5000;
    try {
      if (sessionId) {
        await apiSafe.post(`${RP}/sessions/${encodeURIComponent(sessionId)}/stop`);
      } else if (profile?.ip_address) {
        await apiSafe.post(`${RP}/quick-stop`, { ip: profile.ip_address });
      }
      onNotification?.('Session stopped', 'info');
    } catch (_) {}
    setSessionId('');
    setSessionState('idle');
    setSessionHasVideo(false);
    // After Stop the PS5 may have transitioned (e.g. into rest mode via
    // Standby flow) - refresh so the header isn't stale.
    refreshPs5State(true);
  };

  // Wake = full pre-warm cycle: open a real RP session, then immediately
  // park it in the sidecar's warm cache. The PS5 ends up genuinely ready
  // (out of standby, account logged in, RP slot claimed) and the *next*
  // "Start session" click resumes from warm cache in milliseconds.
  //
  // Replaces the previous bare DDP WAKEUP packet which only got the
  // console out of standby and left RP unreachable - users then hit Start
  // and burned 60-90 s on the post-disconnect lock anyway.
  const wakePs5 = async () => {
    if (!profile?.ip_address) return;
    // Optimistic "waking" state on the shared status (topbar dot included)
    // the instant the click happens - only when this profile is the one
    // the shared context tracks, so waking a non-default profile here
    // never mislabels the topbar's own console.
    if (usingSharedStatus) ps5StatusCtx.markWaking();
    setWakeBusy(true);
    try {
      const r = await api.post(`${RP}/prewarm`, {
        ip: profile.ip_address,
        profile_id: profile.id,
        // Pre-warm with the same defaults the Start button will use, so
        // the warm cache and a fresh start match — otherwise resuming
        // from a 360p warm cache while the picker says 1080p surprises
        // the user. Wake is always input-only — no video decoder
        // attached so the receiver doesn't burn CPU while parked.
        resolution: rpResolution,
      });
      if (!r.success) throw new Error(r.error);
      if (r.already_live) {
        onNotification?.('Session is already live — open it from Start session', 'info');
      } else if (r.warm_cached) {
        const ttl = Math.round(r.warm_cache_ttl_s || 0);
        onNotification?.(
          r.resumed
            ? `Pre-warmed (resumed from cache, ${ttl}s ready)`
            : `Pre-warmed (${ttl}s ready) — Start session resumes instantly`,
          'success',
        );
        setWarmCache({ ttl_s: ttl, video: !!r.video });
      } else {
        onNotification?.('Wake completed', 'success');
      }
    } catch (e) {
      const hint = explainStartError(e.message);
      onNotification?.(`Wake failed: ${e.message}.${hint}`, 'error');
    } finally {
      setWakeBusy(false);
      refreshPs5State(true);
    }
  };

  // Put PS5 into rest mode via Remote Play. Reuses an active session when
  // available, otherwise opens a temporary one just to send the standby
  // packet. Restart isn't supported - PS5 firmware doesn't expose a reboot
  // command in the RP protocol.
  const [standbyBusy, setStandbyBusy] = useState(false);
  const standbyPs5 = async () => {
    if (!profile?.ip_address) return;
    if (!confirm(`Put ${profile.name} (${profile.ip_address}) into rest mode?`)) return;
    setStandbyBusy(true);
    try {
      const r = await api.post(`${RP}/standby`, {
        ip: profile.ip_address,
        profile_id: profile.id,
      });
      if (!r.success) throw new Error(r.error);
      // Standby disconnects our session as a side-effect; reflect it locally.
      setSessionId('');
      setSessionState('idle');
      onNotification?.(
        r.already_standby ? 'PS5 was already in rest mode' : 'Rest mode sent - PS5 is going to rest',
        'success',
      );
    } catch (e) {
      onNotification?.(`Rest mode failed: ${e.message}`, 'error');
    } finally {
      setStandbyBusy(false);
      // Give the console a moment to actually transition before we poll
      // its DDP status, otherwise we still see "Ok" for a few seconds.
      setTimeout(() => refreshPs5State(true), 3000);
    }
  };

  const forceReset = async () => {
    if (!profile?.ip_address) return;
    if (!confirm('Force-reset will clear ALL Remote Play sessions for this PS5 on the sidecar. If the PS5 still refuses to connect afterwards, put it into Rest Mode and back on. Continue?')) return;
    userStoppedRef.current = true;
    try {
      const r = await api.post(`${RP}/quick-stop`, { ip: profile.ip_address, all: true });
      onNotification?.(
        `Reset: ${r.cleared_sidecar_sessions?.length || 0} session(s) cleared`,
        'success',
      );
    } catch (e) {
      onNotification?.(`Reset failed: ${e.message}`, 'error');
    }
    setSessionId('');
    setSessionState('idle');
  };

  // ─── Session watchdog ─────────────────────────────────────────────────────
  //
  // We poll quick-status to keep the local UI in sync with the sidecar:
  //  - if the sidecar reports an active session and we don't have one
  //    locally, "adopt" it (Script Runner / Autoload / previous page load
  //    started it), so the live-session UI shows up no matter who opened it.
  //  - if the sidecar says no session and we thought we had one, drop
  //    locally back to idle. We do NOT auto-reconnect on session loss -
  //    the user is in charge of pressing Start again if they want to come
  //    back.
  useEffect(() => {
    if (!profile?.ip_address) return undefined;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const state = sessionStateRef.current;
      // Don't tick during an in-flight Start; the request itself will set
      // the final state.
      if (state === 'connecting') return;
      try {
        const r = await api.get(`${RP}/quick-status?ip=${encodeURIComponent(profile.ip_address)}`);
        if (cancelled) return;
        if (!r.success) return;
        // Discard a stale "active" reading that raced our own Stop click -
        // see stoppedUntilRef's declaration for why. A "not active" reading
        // is still honoured below (that's the outcome Stop wants), only the
        // adopt-as-connected branch is suppressed.
        if (r.active && Date.now() < stoppedUntilRef.current) return;

        const sidecarSid = r.session_id || '';
        if (r.active) {
          if (sessionStateRef.current !== 'connected') {
            setSessionState('connected');
            setSessionHasVideo(!!r.video);
            userStoppedRef.current = false;
            if (state === 'idle') {
              onNotification?.('Adopted active Remote Play session', 'info');
            }
          }
          if (sidecarSid && sidecarSid !== sessionId) setSessionId(sidecarSid);
          // Adopt the sidecar-reported stream params so the live status
          // chip always reflects ground truth (e.g. after a Node restart
          // that lost local liveStream state).
          if (r.resolution) {
            setLiveStream(prev => {
              const next = { resolution: r.resolution || prev?.resolution };
              if (prev && prev.resolution === next.resolution) return prev;
              return next;
            });
          }
          setWarmCache(null);
          return;
        }

        // r.active === false. Surface warm cache state so the UI can promise
        // an instant Start.
        if (r.warm) {
          setWarmCache({
            ttl_s: r.warm_ttl_remaining_s,
            video: !!r.video,
            resolution: r.resolution || null,
          });
        } else if (warmCache) {
          setWarmCache(null);
        }

        if (state === 'connected' && !userStoppedRef.current) {
          // Session went away on its own (network blip, PS5 dropped us, sidecar
          // restart). Surface it once so the user knows why the UI flipped to
          // idle, then leave it to them to hit Start.
          onNotification?.('Remote Play session ended', 'info');
        }
        if (sessionId) setSessionId('');
        if (state !== 'idle') setSessionState('idle');
        if (sessionHasVideo) setSessionHasVideo(false);
        if (liveStream) setLiveStream(null);
      } catch (_) { /* network hiccup - try again next tick */ }
    };

    tick();
    const id = setInterval(tick, 6000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.ip_address]);

  // While a Start is in flight, poll whether the sidecar fell into its 45 s
  // post-disconnect-lock retry so the button can show a countdown instead
  // of a "Starting..." spinner that looks identical whether it's 2 s or
  // 40 s from finishing. Only polls during 'connecting' - cheap the rest
  // of the time since the effect just re-mounts its interval on that
  // transition.
  useEffect(() => {
    if (sessionState !== 'connecting' || !profile?.ip_address) {
      setRetryStatus(null);
      return undefined;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await api.get(`${RP}/retry-status?ip=${encodeURIComponent(profile.ip_address)}`);
        if (cancelled) return;
        setRetryStatus(r.waiting ? { remainingS: r.remaining_s, totalS: r.total_s, reason: r.reason } : null);
      } catch (_) { /* transient - keep whatever we last showed */ }
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => { cancelled = true; clearInterval(id); };
  }, [sessionState, profile?.ip_address]);

  const sendInput = async (payload) => {
    if (!sessionId) return;
    // Recording capture is intentional BEFORE the network send so the
    // transcript reflects user intent even if the sidecar drops the input.
    if (recording && payload && typeof payload === 'object') {
      const t = Date.now() - recStartRef.current;
      if (payload.button) {
        recBufferRef.current.push({ kind: 'button', id: payload.button, action: payload.action, t });
      } else if (payload.stick) {
        recBufferRef.current.push({ kind: 'stick', side: payload.stick, x: payload.x, y: payload.y, t });
      }
      // Cheap counter update — keeps the HUD live without re-rendering on
      // every tick. We tolerate slight visual lag (250 ms via the clock).
      setRecEventCount(recBufferRef.current.length);
    }
    try {
      await api.post(`${RP}/sessions/${encodeURIComponent(sessionId)}/input`, payload);
    } catch (e) {
      onNotification?.(`Input dropped: ${e.message}`, 'warning');
    }
  };

  // Dedicated touchpad-click helper. PS5 ignores a touchpad button that's
  // pressed and released within the same network round-trip — the touchpad
  // subsystem polls slower than the regular d-pad/face buttons and needs a
  // longer hold to register a click. 500 ms matches a deliberate human
  // press of the physical DualSense touchpad and registers reliably on
  // all tested firmwares; shorter values (≤250 ms) were missed in games
  // that use the touchpad for menu / map toggles. Using the sidecar-side
  // `tap` action lets the press/sleep/release sequence happen ON the
  // sidecar with tight timing, sidestepping browser→sidecar latency jitter.
  // For the input recorder we still log a clean press+release pair (with
  // the requested hold) so the transcript is replayable.
  // Touchpad tap with optional X,Y coordinate (pixel space inside the DS4
  // 1920×942 surface). Defaults to centre (960×471) for backwards-compat,
  // which is the safe value for normal touchpad-button games. PS2 Classics
  // (and SNK PS4 BC fighters) need an off-centre touch to register Select
  // (left half, X≈400) or Start (right half, X≈1500) — the touchpad CLICK
  // alone is dropped by those titles. See server.py InputReq / patches
  // touchpad_click for the protocol detail.
  // Motion-burst trigger for the fullscreen "Shake" button. Backend proxies
  // to the sidecar's `Controller.shake()` patch which animates the
  // accelerometer + gyro sub-state inside FeedbackState packets for the
  // duration, so motion-listening titles (Death Stranding, Resogun, a
  // bunch of PS2 BC games) see a real shake spike — exactly as if the
  // user had physically shaken a real DualSense / DualShock 4.
  //
  // We also log the gesture into the input recorder so user-recorded
  // scripts can replay it. The transcript stores it as a single button
  // entry with id `shake@<intensity>` and a tap action — playback only
  // needs to fire the same POST again at the same offset.
  const sendShake = async (durationMs = 700, intensity = 0.85) => {
    if (!sessionId) return;
    if (recording) {
      const t = Date.now() - recStartRef.current;
      const recId = `shake@${Math.round(intensity * 100)}`;
      recBufferRef.current.push({ kind: 'button', id: recId, action: 'press', t });
      recBufferRef.current.push({ kind: 'button', id: recId, action: 'release', t: t + durationMs });
      setRecEventCount(recBufferRef.current.length);
    }
    try {
      await api.post(`${RP}/sessions/${encodeURIComponent(sessionId)}/shake`, {
        duration_ms: durationMs,
        intensity,
      });
    } catch (e) {
      onNotification?.(`Shake dropped: ${e.message}`, 'warning');
    }
  };

  const sendTouchpadTap = async (durationMs = 500, x = null, y = null) => {
    if (!sessionId) return;
    if (recording) {
      const t = Date.now() - recStartRef.current;
      const recId = x === null ? 'touchpad' : `touchpad@${x},${y ?? 471}`;
      recBufferRef.current.push({ kind: 'button', id: recId, action: 'press', t });
      recBufferRef.current.push({ kind: 'button', id: recId, action: 'release', t: t + durationMs });
      setRecEventCount(recBufferRef.current.length);
    }
    try {
      const body = { button: 'touchpad', action: 'tap', duration_ms: durationMs };
      if (x !== null) body.touch_x = x;
      if (y !== null) body.touch_y = y;
      await api.post(`${RP}/sessions/${encodeURIComponent(sessionId)}/input`, body);
    } catch (e) {
      onNotification?.(`Touchpad dropped: ${e.message}`, 'warning');
    }
  };

  // ─── Input Scripts tab: step-by-step execution ─────────────────────────
  // Sends via sendInput() - the SAME RP-session input channel the touch
  // controller overlay uses - rather than the older /ps5control/input
  // payload-injection path ScriptRunner used before this moved here. One
  // real session, one real input channel, for both the touch overlay and
  // scripted playback.
  const stepSendCommand = async (cmd, params = '') => {
    const duration = parseInt(params, 10) || 80;
    await sendInput({ button: cmd, action: 'tap', duration_ms: duration });
  };

  // Quick action for the step editor's manual pad: PS -> Down -> Cross,
  // which backs out of whatever's running to the Home screen. Reuses the
  // same tap semantics as scripted playback (stepSendCommand) so it
  // behaves identically to typing "ps\ndown\ncross" into a script.
  const resetToMainScreen = async () => {
    await stepSendCommand('ps');
    await new Promise(r => setTimeout(r, 400));
    await stepSendCommand('down');
    await new Promise(r => setTimeout(r, 400));
    await stepSendCommand('cross');
  };

  const executeStepLine = async (parsed) => {
    if (parsed.cmd === 'wait') {
      await new Promise(resolve => setTimeout(resolve, parsed.params));
      return;
    }
    if (parsed.cmd === 'text') {
      const inputs = buildOskInputs(parsed.text || '');
      for (const ev of inputs) {
        await stepSendCommand(ev.button);
        await new Promise(r => setTimeout(r, ev.commit ? 140 : 90));
      }
      return;
    }
    const reps = Math.max(1, parsed.count || 1);
    for (let r = 0; r < reps; r++) {
      await stepSendCommand(parsed.cmd, parsed.params);
      if (reps > 1 && r < reps - 1) await new Promise(resolve => setTimeout(resolve, 120));
    }
  };

  const parseScriptToSteps = (scriptText) => {
    const steps = [];
    (scriptText || '').split('\n').forEach((raw, i) => {
      const parsed = parseLine(raw);
      if (parsed) steps.push({ raw: raw.trim(), lineNum: i + 1, parsed });
    });
    return steps;
  };

  // `source` tracks where the script came from - { id, kind: 'builtin'|'user' }
  // or null for a blank "New script" session - so saveStepScript() below
  // knows whether to overwrite the original (built-in source file or the
  // saved-script row) instead of always creating a brand-new saved copy.
  const openStepMode = async (scriptText, name, allowEmpty = false, source = null) => {
    const steps = parseScriptToSteps(scriptText);
    setSessionViewTab('scripts');
    if (steps.length === 0 && !allowEmpty) {
      onNotification?.('Nothing to step through - script has no executable lines', 'warning');
      return;
    }
    if (!liveSession || !sessionHasVideo) {
      const ok = await startSession(true); // forceVideo
      if (!ok) return;
    }
    setStepMobileTab('video');
    setStepPanel({ name, steps, index: 0, source });
  };

  // Shared video block for the Input Scripts and Payloads tabs, so the
  // video genuinely stays put (same img, not re-mounted) whether you're
  // browsing scripts, stepping through one, or sending a payload - only
  // the Control tab has its own separate video (deeply woven into its
  // touch-controller grid layout, left alone here).
  // DualSense-style inline pad. No analog sticks here on purpose - precise
  // stick input is available in the fullscreen overlay (tap ⛶ on the
  // video). Layout mirrors a real PS5 controller:
  //
  //   ┌─────────────────────────────────────┐
  //   │  L2  L1                    R1  R2   │ shoulder strip
  //   │                                     │
  //   │      ↑                       △      │
  //   │    ← + →                   □   ○    │  D-pad   |  face
  //   │      ↓                       X      │
  //   │                                     │
  //   │      Share  Touchpad  Options       │
  //   │           PS    L3    R3            │  center row
  //   └─────────────────────────────────────┘
  //
  // IDs come from the existing PS5_BUTTONS array so the press/release
  // semantics stay identical everywhere it's used. Extracted to its own
  // function (rather than inlined once) so it can render both in the
  // Control tab (inside .rp-live-layout, where CSS reflows it into the
  // desktop 3-column layout - see the .rp-live-layout rules in
  // styles.css) AND in the Scripts tab above the step panel, where it
  // renders with its own standalone base styling (flex/grid, no
  // .rp-live-layout ancestor) so the user can press real buttons while
  // building/running a script live.
  const renderManualPad = () => {
    const byId = Object.fromEntries(PS5_BUTTONS.map(b => [b.id, b]));
    const Btn = ({ id, className = '', style = {} }) => {
      const b = byId[id];
      if (!b) return null;
      // Touchpad gets a dedicated tap path (see sendTouchpadTap):
      // the PS5 touchpad subsystem needs a noticeably longer hold
      // than the regular d-pad/face buttons. Other buttons keep
      // press/release semantics so the user can "hold" them.
      if (id === 'touchpad') {
        return (
          <button
            type="button"
            className={`btn btn-sm ${className}`.trim()}
            style={{
              background: b.color || 'var(--panel2)',
              color: b.color ? '#fff' : undefined,
              ...style,
            }}
            onPointerDown={(e) => { e.preventDefault(); sendTouchpadTap(500); }}
          >
            {b.label}
          </button>
        );
      }
      return (
        <button
          type="button"
          className={`btn btn-sm ${className}`.trim()}
          style={{
            background: b.color || 'var(--panel2)',
            color: b.color ? '#fff' : undefined,
            ...style,
          }}
          onPointerDown={(e) => { e.preventDefault(); sendInput({ button: b.id, action: 'press' }); }}
          onPointerUp={() => sendInput({ button: b.id, action: 'release' })}
          onPointerCancel={() => sendInput({ button: b.id, action: 'release' })}
          onPointerLeave={(e) => { if (e.buttons) sendInput({ button: b.id, action: 'release' }); }}
        >
          {b.label}
        </button>
      );
    };
    return (
      <div className="rp-pad">
        <div className="rp-pad-shoulders">
          <div className="rp-pad-shoulders-side">
            <Btn id="l2" /><Btn id="l1" />
          </div>
          <div className="rp-pad-shoulders-side rp-pad-shoulders-side-right">
            <Btn id="r1" /><Btn id="r2" />
          </div>
        </div>

        <div className="rp-pad-main">
          <div className="rp-dpad">
            <div className="rp-dpad-up"><Btn id="up" /></div>
            <div className="rp-dpad-left"><Btn id="left" /></div>
            <div className="rp-dpad-right"><Btn id="right" /></div>
            <div className="rp-dpad-down"><Btn id="down" /></div>
          </div>
          <div className="rp-face">
            <div className="rp-face-triangle"><Btn id="triangle" /></div>
            <div className="rp-face-square"><Btn id="square" /></div>
            <div className="rp-face-circle"><Btn id="circle" /></div>
            <div className="rp-face-cross"><Btn id="cross" /></div>
          </div>
        </div>

        <div className="rp-pad-center rp-pad-center-main">
          <Btn id="share" />
          <Btn id="touchpad" />
          <Btn id="options" />
          <Btn id="ps" />
          <Btn id="l3" />
          <Btn id="r3" />
          {/* Motion-burst gesture. Same one-shot semantics as the
              touchpad tap — see sendShake() for the wiring. */}
          <button
            type="button"
            className="btn btn-sm"
            style={{ background: 'rgba(245, 166, 35, 0.45)', color: '#fff', minWidth: 64 }}
            onPointerDown={(e) => { e.preventDefault(); sendShake(700, 0.85); }}
            title="Shake the controller (~700 ms motion burst)"
          >
            🤝 Shake
          </button>
        </div>

        {/* PS2 Classics / SNK BC fighter compatibility row. Those
            games ignore the Options button *and* the touchpad click
            — they look for a finger landing on the LEFT or RIGHT
            half of the touchpad SURFACE (X≈400 = Select; X≈1500 =
            Start, per Brook UFB documentation). The patched
            touchpad_click in pyremoteplay_patches.py emits the
            correct chiaki surface-down → click → surface-up
            sequence at the requested pixel; the standard "Tch"
            button above stays at centre (960×471) so existing
            touchpad-menu games are unaffected. */}
        <div
          className="rp-pad-center rp-pad-center-ps2"
          style={{
            marginTop: 6,
            opacity: 0.85,
            borderTop: '1px dashed var(--border)',
            paddingTop: 6,
          }}
          title="PS2 Classics & SNK BC fighters: use these instead of Options."
        >
          <button
            type="button"
            className="btn btn-sm"
            style={{ background: 'var(--panel2)', minWidth: 64 }}
            onPointerDown={(e) => { e.preventDefault(); sendTouchpadTap(500, 400, 471); }}
            title="Touchpad LEFT zone — Select in PS2 Classics"
          >
            ◀ Sel
          </button>
          <button
            type="button"
            className="btn btn-sm"
            style={{ background: 'var(--panel2)', minWidth: 64 }}
            onPointerDown={(e) => { e.preventDefault(); sendTouchpadTap(500, 1500, 471); }}
            title="Touchpad RIGHT zone — Start in PS2 Classics"
          >
            Str ▶
          </button>
        </div>

        <p className="text-xs text-muted rp-controller-hint">
          Hold for repeat; release to lift. Tap ⛶ on the video for analog sticks.
          <br />
          <span className="text-xs">
            PS2/SNK: use <b>◀ Sel</b> / <b>Str ▶</b> instead of Options.
          </span>
        </p>
      </div>
    );
  };

  const renderTabVideo = () => (
    sessionHasVideo && sessionId ? (
      <img
        key={videoNonce}
        src={`${API}/sessions/${encodeURIComponent(sessionId)}/video.mjpeg?fps=15&nonce=${videoNonce}`}
        alt="PS5 preview"
        style={{ width: '100%', borderRadius: 8, display: 'block', background: '#000' }}
        onError={() => onNotification?.('Video stream dropped - try 🔄 restarting the session', 'warning')}
      />
    ) : (
      <div className="text-muted text-sm">No video session yet - hit Start session above.</div>
    )
  );

  const stepNext = async () => {
    if (!stepPanel || stepBusy) return;
    const step = stepPanel.steps[stepPanel.index];
    if (!step) return;
    setStepBusy(true);
    try {
      await executeStepLine(step.parsed);
    } catch (e) {
      onNotification?.(`Step failed: ${e.message}`, 'error');
    }
    setStepPanel(p => (p ? { ...p, index: p.index + 1 } : p));
    setStepBusy(false);
  };

  // Navigation-only - moves the cursor back a step without re-sending
  // anything. There's no "undo" for a physical button press, so Previous
  // just lets the user re-mark a step as not-yet-done (e.g. after
  // clicking Next by mistake), it never un-presses a button.
  const stepPrev = () => {
    if (!stepPanel || stepBusy || stepPanel.index === 0) return;
    setStepPanel(p => (p ? { ...p, index: Math.max(0, p.index - 1) } : p));
  };

  const stepRestart = () => {
    if (!stepPanel) return;
    setStepPanel(p => (p ? { ...p, index: 0 } : p));
  };

  // "Replay to step N": runs forward from the CURRENT position through
  // step N (1-based, matching the line numbers shown in the list) and
  // stops. Deliberately continues from wherever the cursor already is
  // rather than rewinding to step 1 first - re-sending already-executed
  // presses could double-toggle a menu that's already open on the
  // console. If the target is behind the current position there's
  // nothing to do (no way to "un-press" a button), so it's a no-op.
  const [replayTarget, setReplayTarget] = useState('');
  const stepReplayTo = async () => {
    if (!stepPanel || stepBusy) return;
    const targetLine = parseInt(replayTarget, 10);
    if (!Number.isFinite(targetLine) || targetLine < 1) return;
    const targetIdx = Math.min(targetLine, stepPanel.steps.length) - 1;
    if (targetIdx < stepPanel.index) return;

    setStepBusy(true);
    try {
      let idx = stepPanel.index;
      while (idx <= targetIdx) {
        const step = stepPanel.steps[idx];
        if (!step) break;
        await executeStepLine(step.parsed);
        idx++;
        setStepPanel(p => (p ? { ...p, index: idx } : p));
        if (idx <= targetIdx) await new Promise(r => setTimeout(r, 100));
      }
    } catch (e) {
      onNotification?.(`Step failed: ${e.message}`, 'error');
    }
    setStepBusy(false);
  };

  const closeStepPanel = () => {
    // Leaves the session running - Stop session above still works normally.
    setStepPanel(null);
    setEditingStepIdx(null);
    setAddAfterIdx(null);
  };

  // Persists whatever's currently in the step panel (including any live
  // edits/additions made via ＋). When the panel was opened FROM a
  // built-in or an existing saved script (stepPanel.source), this
  // overwrites that same entry - previously it always POSTed a brand-new
  // saved script regardless of origin, so editing a built-in through the
  // step editor silently forked it instead of updating the built-in
  // source file. A blank "New script" session (source === null) still
  // prompts for a name and creates one, then promotes the panel to point
  // at it so a second Save updates rather than prompting again.
  const saveStepScript = async () => {
    if (!stepPanel || stepPanel.steps.length === 0) return;
    const scriptText = stepPanel.steps.map(s => s.raw).join('\n');
    const source = stepPanel.source;
    try {
      if (source?.kind === 'builtin') {
        await api.put(`/input-scripts/builtin/${encodeURIComponent(source.id)}`, { script: scriptText });
        onNotification?.(`Updated built-in "${stepPanel.name}"`, 'success');
      } else if (source?.kind === 'user') {
        await api.put(`/input-scripts/${encodeURIComponent(source.id)}`, { name: stepPanel.name, script: scriptText });
        onNotification?.(`Updated "${stepPanel.name}"`, 'success');
      } else {
        const defaultName = stepPanel.name === 'New script' ? '' : stepPanel.name;
        const name = window.prompt('Save as script name:', defaultName);
        if (!name || !name.trim()) return;
        const data = await api.post('/input-scripts', { name: name.trim(), script: scriptText });
        if (!data.success) {
          onNotification?.(`Save failed: ${data.error}`, 'error');
          return;
        }
        onNotification?.('Script saved', 'success');
        setStepPanel(p => (p ? { ...p, name: name.trim(), source: { id: data.id, kind: 'user' } } : p));
      }
      onScriptsChange?.();
    } catch (e) {
      onNotification?.(`Save failed: ${e.message}`, 'error');
    }
  };

  // Loads lazily (only when the Payloads tab is first opened) rather than
  // on mount - most sessions never touch this tab.
  const fetchPayloadsList = async () => {
    const list = await apiSafe.get('/payloads');
    if (Array.isArray(list)) setPayloadsList(list);
    setPayloadsLoaded(true);
  };

  const sendPayload = async (payload) => {
    if (!profile) return;
    setSendingPayloadId(payload.id);
    try {
      const data = await api.post(`/payloads/send/${payload.id}`, {
        ip: profile.ip_address,
        port: profile.port,
      });
      if (data.success) {
        onNotification?.(`Sent ${payload.name}`, 'success');
      } else {
        onNotification?.(`Send failed: ${data.error}`, 'error');
      }
    } catch (e) {
      onNotification?.(`Send failed: ${e.message}`, 'error');
    }
    setSendingPayloadId(null);
  };

  const renumberSteps = (steps) => steps.map((s, i) => ({ ...s, lineNum: i + 1 }));

  const startEditStep = (i) => {
    setEditingStepIdx(i);
    setStepDraftText(stepPanel.steps[i].raw);
    setStepDraftError('');
  };
  const cancelEditStep = () => { setEditingStepIdx(null); setStepDraftError(''); };
  const saveEditStep = () => {
    const text = stepDraftText.trim();
    const parsed = parseLine(text);
    if (!parsed) { setStepDraftError('Not a recognised command.'); return; }
    setStepPanel(p => {
      const steps = [...p.steps];
      steps[editingStepIdx] = { ...steps[editingStepIdx], raw: text, parsed };
      return { ...p, steps };
    });
    setEditingStepIdx(null);
    setStepDraftError('');
  };
  const deleteStepRow = (i) => {
    setStepPanel(p => {
      const steps = renumberSteps(p.steps.filter((_, idx) => idx !== i));
      const index = i < p.index ? p.index - 1 : p.index;
      return { ...p, steps, index };
    });
    if (editingStepIdx === i) cancelEditStep();
  };
  const openAddForm = (afterIdx) => { setAddAfterIdx(afterIdx); setAddDraftText(''); setAddDraftError(''); };
  const cancelAddForm = () => { setAddAfterIdx(null); setAddDraftError(''); };
  const confirmAddStep = () => {
    const text = addDraftText.trim();
    const parsed = parseLine(text);
    if (!parsed) { setAddDraftError('Not a recognised command.'); return; }
    setStepPanel(p => {
      const steps = [...p.steps];
      steps.splice(addAfterIdx + 1, 0, { raw: text, lineNum: 0, parsed });
      const index = addAfterIdx + 1 <= p.index ? p.index + 1 : p.index;
      return { ...p, steps: renumberSteps(steps), index };
    });
    setAddAfterIdx(null);
    setAddDraftText('');
    setAddDraftError('');
  };

  // ─── Fullscreen video + touch controls ───────────────────────────────────
  //
  // The Fullscreen API is the preferred path - it gives us actual viewport-
  // sized rendering plus a chance to lock landscape orientation on phones.
  // iOS Safari doesn't support requestFullscreen() on a <div>, so we always
  // *also* apply position:fixed inset:0 styling as a CSS fallback that
  // mimics fullscreen visually. The exit path covers both.

  const toggleFullscreen = async () => {
    if (fsActive) {
      setFsActive(false);
      try { if (document.fullscreenElement) await document.exitFullscreen(); } catch (_) {}
      try { screen.orientation?.unlock?.(); } catch (_) {}
      return;
    }
    setFsActive(true);
    const el = videoContainerRef.current;
    if (el && el.requestFullscreen) {
      try { await el.requestFullscreen(); } catch (_) { /* fallback to CSS overlay */ }
    } else if (el && el.webkitRequestFullscreen) {
      try { el.webkitRequestFullscreen(); } catch (_) {}
    }
    // Best-effort orientation lock for phones. Will fail silently on
    // desktop / iOS where the API is unavailable.
    try { await screen.orientation?.lock?.('landscape'); } catch (_) {}
  };

  useEffect(() => {
    const onFsChange = () => {
      // Browser may exit fullscreen without our knowledge (Esc, swipe down on
      // mobile, etc.). Re-sync local state so the overlay disappears.
      if (!document.fullscreenElement && fsActive) {
        setFsActive(false);
        try { screen.orientation?.unlock?.(); } catch (_) {}
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }, [fsActive]);

  // Suppress body scroll while the CSS overlay is up so phone users can't
  // accidentally swipe the page underneath the controls.
  useEffect(() => {
    if (!fsActive) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [fsActive]);

  // Auto-collapse when the session ends or video is dropped - the overlay
  // becomes useless without the underlying stream.
  useEffect(() => {
    if (fsActive && (!liveSession || !sessionHasVideo || !sessionId)) {
      setFsActive(false);
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch (_) {}
    }
  }, [fsActive, liveSession, sessionHasVideo, sessionId]);

  // Stick handler with rate-limit (~25 Hz) to avoid flooding.
  const onStick = (side) => ({ x, y }) => {
    const now = Date.now();
    if (now - (stickThrottle[side] || 0) < 40 && (x !== 0 || y !== 0)) return;
    setStickThrottle(prev => ({ ...prev, [side]: now }));
    sendInput({ stick: side, x, y: y, action: 'set' });
  };

  // ─── Fullscreen overlay layout ────────────────────────────────────────────
  //
  // Rendered ONLY when fsActive is true and the video preview is visible.
  // Tuned for landscape mobile (the common case) - controls sit in corners
  // with the centre of the screen kept clear so the gameplay remains
  // readable. Sizes use CSS `clamp()` so the layout scales smoothly from
  // small phones (≤360 px tall landscape) up to tablets/desktops without
  // overlapping or vanishing into the safe-area cut-out.
  //
  //   ┌──────────────────────────────────────────────────────────────┐
  //   │ [✕] [L2][L1]      [PS][Tch][Opt][Shr]      [R1][R2]          │
  //   │                                                              │
  //   │  ↑                                                    △      │
  //   │ ← →                                                  □ ○     │
  //   │  ↓                                                    ✕      │
  //   │                                                              │
  //   │  ◉ L3                                              R3 ◉      │
  //   └──────────────────────────────────────────────────────────────┘
  //
  // All button backgrounds are heavily translucent (≈25 % alpha) with a
  // backdrop-blur so the game remains visible; pressing lights them up
  // into a clearly opaque/glowing state for unambiguous tactile feedback.

  const overlayPress = (id) => sendInput({ button: id, action: 'press' });
  const overlayRelease = (id) => sendInput({ button: id, action: 'release' });

  function renderFullscreenOverlay() {
    const handleStick = (side) => ({ x, y }) => onStick(side)({ x, y });

    // PS5-themed translucent tints. Press state brings each to ~0.95 alpha
    // automatically (see HoldButton).
    const btnBg = {
      cross: 'rgba(94, 156, 255, 0.30)',
      circle: 'rgba(231, 76, 76, 0.30)',
      square: 'rgba(255, 128, 230, 0.30)',
      triangle: 'rgba(100, 220, 140, 0.30)',
    };

    // Responsive sizing - clamp(min, vh-based, max). Landscape phones tend
    // to be ~320-420 px tall, tablets ~600-900 px; the vh slot keeps
    // controls in proportion without ever shrinking past the usable touch
    // target or growing absurdly large on a desktop.
    const SZ = {
      face: 'clamp(48px, 9vh, 64px)',
      dpad: 'clamp(42px, 8vh, 56px)',
      shoulder: 'clamp(40px, 7vh, 52px)',
      sys: 'clamp(36px, 5.5vh, 44px)',
      stick: 'clamp(96px, 22vh, 140px)',
      l3: 'clamp(34px, 5vh, 42px)',
    };
    // HoldButton's size prop is a number (used for fontSize math); but for
    // responsive sizing we pass the clamp() string via the `style` override
    // and let HoldButton's font sizing still work via fontSize prop. Note:
    // we have to pick a *representative* numeric size for fontSize so the
    // label scales sensibly - use the clamp midpoint as a heuristic.
    const numHint = (slot) => ({ face: 56, dpad: 48, shoulder: 46, sys: 40, l3: 38 }[slot]);

    return (
      <div
        style={{
          position: 'absolute', inset: 0,
          pointerEvents: 'none',  // each cluster opts back in
          color: '#fff',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {/* ─── Top-left: L2/L1 shoulders ────────────────────────────────
            Offset to the right of the 44 px close (✕) button which sits
            at the very corner (see <button> above renderFullscreenOverlay). */}
        <div style={{
          position: 'absolute',
          top: 'max(12px, env(safe-area-inset-top))',
          left: 'calc(max(12px, env(safe-area-inset-left)) + 56px)',
          display: 'flex', gap: 8,
          pointerEvents: 'auto',
        }}>
          <HoldButton id="l2" label="L2" onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('shoulder')} style={{ width: SZ.shoulder, height: SZ.shoulder }} />
          <HoldButton id="l1" label="L1" onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('shoulder')} style={{ width: SZ.shoulder, height: SZ.shoulder }} />
        </div>

        {/* ─── Top-center: system buttons (PS / Touch / Opt / Share) ────
            Moved up from the bottom so the bottom half is free for the
            primary face / d-pad / stick clusters - matches most mobile
            game overlays (Steam Link, Moonlight). */}
        <div style={{
          position: 'absolute',
          top: 'max(12px, env(safe-area-inset-top))',
          left: '50%', transform: 'translateX(-50%)',
          display: 'flex', gap: 6,
          pointerEvents: 'auto',
          background: 'rgba(10, 12, 18, 0.30)',
          WebkitBackdropFilter: 'blur(10px) saturate(140%)',
          backdropFilter: 'blur(10px) saturate(140%)',
          padding: '4px 8px', borderRadius: 999,
          border: '1px solid rgba(255,255,255,0.15)',
        }}>
          <HoldButton id="ps" label="PS" onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('sys')} fontSize={14} style={{ width: SZ.sys, height: SZ.sys }} />
          {/* Touchpad uses a sidecar-side `tap` instead of press/release —
              PS5 needs ~200 ms of held-down state for the touchpad click
              to register. See sendTouchpadTap() for the rationale. The
              HoldButton's visual press feedback still works because its
              internal state machine toggles on the pointer events; we just
              ignore the release here so the button "snaps back" naturally. */}
          <HoldButton id="touchpad" label="Tch"
            onPress={() => sendTouchpadTap(500)}
            onRelease={() => { /* tap is one-shot, no release needed */ }}
            size={numHint('sys')} fontSize={12} style={{ width: SZ.sys, height: SZ.sys }} />
          {/* PS2-zone touchpad clicks (Select / Start zones). Same tap
              semantics as the Tch button but with explicit X/Y so PS2
              Classics & SNK BC fighters that ignore Options receive the
              correct surface-down + click + surface-up sequence. */}
          <HoldButton id="tch_l" label="◀Sel"
            onPress={() => sendTouchpadTap(500, 400, 471)}
            onRelease={() => { /* tap is one-shot */ }}
            size={numHint('sys')} fontSize={11} style={{ width: SZ.sys, height: SZ.sys }} />
          <HoldButton id="tch_r" label="Str▶"
            onPress={() => sendTouchpadTap(500, 1500, 471)}
            onRelease={() => { /* tap is one-shot */ }}
            size={numHint('sys')} fontSize={11} style={{ width: SZ.sys, height: SZ.sys }} />
          <HoldButton id="options" label="Opt" onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('sys')} fontSize={13} style={{ width: SZ.sys, height: SZ.sys }} />
          <HoldButton id="share" label="Shr" onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('sys')} fontSize={13} style={{ width: SZ.sys, height: SZ.sys }} />
          {/* Motion-burst (Shake) — one-shot like the touchpad tap. Sends
              ~700 ms of accel/gyro waveform via the sidecar's
              Controller.shake() patch. We mark it visually with an amber
              tint so it stands out from the held buttons; the press
              feedback comes from HoldButton's internal state machine
              even though we ignore the release (same pattern as Tch). */}
          <HoldButton id="shake" label="Shk"
            onPress={() => sendShake(700, 0.85)}
            onRelease={() => { /* one-shot, daemon thread on sidecar */ }}
            background="rgba(245, 166, 35, 0.30)"
            size={numHint('sys')} fontSize={13}
            style={{ width: SZ.sys, height: SZ.sys }} />
        </div>

        {/* ─── Record toggle (just below the system-button strip) ────────
            A dedicated REC button is needed here because the inline button
            (top-right on the video) is hidden in fullscreen — that corner
            is now occupied by the R1/R2 cluster. Centred below the system
            row sits in an empty band on every supported viewport and never
            crosses into the d-pad / face / shoulder territory. */}
        <button
          type="button"
          onClick={recording ? stopRecording : startRecording}
          aria-label={recording ? 'Stop recording inputs' : 'Record inputs'}
          className={recording ? 'rp-rec-btn rp-rec-active' : 'rp-rec-btn'}
          style={{
            position: 'absolute',
            top: 'calc(max(12px, env(safe-area-inset-top)) + clamp(48px, 7vh, 60px))',
            left: '50%', transform: 'translateX(-50%)',
            height: 36, minWidth: 36, padding: recording ? '0 10px' : 0,
            borderRadius: 999,
            background: recording ? 'rgba(220, 50, 50, 0.85)' : 'rgba(10, 12, 18, 0.55)',
            color: '#fff', border: '1px solid rgba(255,255,255,0.25)',
            fontSize: recording ? 12 : 14, fontWeight: 700, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            pointerEvents: 'auto', touchAction: 'none', userSelect: 'none',
          }}
        >
          <span className={recording ? 'rp-rec-dot rp-rec-dot-active' : 'rp-rec-dot'} />
          {recording && (
            <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              REC {Math.floor(recElapsed / 1000)}s · {recEventCount}
            </span>
          )}
        </button>

        {/* ─── Top-right: R1/R2 shoulders ─────────────────────────────── */}
        <div style={{
          position: 'absolute',
          top: 'max(12px, env(safe-area-inset-top))',
          right: 'max(12px, env(safe-area-inset-right))',
          display: 'flex', gap: 8,
          pointerEvents: 'auto',
        }}>
          <HoldButton id="r1" label="R1" onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('shoulder')} style={{ width: SZ.shoulder, height: SZ.shoulder }} />
          <HoldButton id="r2" label="R2" onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('shoulder')} style={{ width: SZ.shoulder, height: SZ.shoulder }} />
        </div>

        {/* ─── Middle-left: D-pad cluster ────────────────────────────────
            Pulled away from the corner so it doesn't fight with the left
            stick below it on short screens. Vertically centred via the
            bottom-offset that matches the stick's reserved space. */}
        <div style={{
          position: 'absolute',
          bottom: 'calc(max(20px, env(safe-area-inset-bottom)) + clamp(110px, 25vh, 160px))',
          left: 'max(14px, env(safe-area-inset-left))',
          display: 'grid',
          gridTemplateColumns: `repeat(3, ${SZ.dpad})`,
          gridTemplateRows: `repeat(3, ${SZ.dpad})`,
          gap: 4,
          pointerEvents: 'auto',
        }}>
          <div /><HoldButton id="up" label="↑" onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('dpad')} fontSize={26} style={{ width: SZ.dpad, height: SZ.dpad }} /><div />
          <HoldButton id="left" label="←" onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('dpad')} fontSize={26} style={{ width: SZ.dpad, height: SZ.dpad }} />
          <div />
          <HoldButton id="right" label="→" onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('dpad')} fontSize={26} style={{ width: SZ.dpad, height: SZ.dpad }} />
          <div /><HoldButton id="down" label="↓" onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('dpad')} fontSize={26} style={{ width: SZ.dpad, height: SZ.dpad }} /><div />
        </div>

        {/* ─── Middle-right: face buttons diamond ──────────────────────── */}
        <div style={{
          position: 'absolute',
          bottom: 'calc(max(20px, env(safe-area-inset-bottom)) + clamp(110px, 25vh, 160px))',
          right: 'max(14px, env(safe-area-inset-right))',
          display: 'grid',
          gridTemplateColumns: `repeat(3, ${SZ.face})`,
          gridTemplateRows: `repeat(3, ${SZ.face})`,
          gap: 4,
          pointerEvents: 'auto',
        }}>
          <div /><HoldButton id="triangle" label="△" background={btnBg.triangle}
            onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('face')} fontSize={28} style={{ width: SZ.face, height: SZ.face }} /><div />
          <HoldButton id="square" label="□" background={btnBg.square}
            onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('face')} fontSize={28} style={{ width: SZ.face, height: SZ.face }} />
          <div />
          <HoldButton id="circle" label="○" background={btnBg.circle}
            onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('face')} fontSize={28} style={{ width: SZ.face, height: SZ.face }} />
          <div /><HoldButton id="cross" label="✕" background={btnBg.cross}
            onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('face')} fontSize={28} style={{ width: SZ.face, height: SZ.face }} /><div />
        </div>

        {/* ─── Bottom-left: Left stick + L3 inline ────────────────────────
            Stick anchors the bottom-left corner where the user's left
            thumb naturally rests in landscape grip. L3 sits to the right
            so it doesn't push the stick out of reach. */}
        <div style={{
          position: 'absolute',
          bottom: 'max(16px, env(safe-area-inset-bottom))',
          left: 'max(12px, env(safe-area-inset-left))',
          display: 'flex', alignItems: 'flex-end', gap: 8,
          pointerEvents: 'auto',
        }}>
          <AnalogStick side="left" onChange={handleStick('left')}
            size={SZ.stick} showLabel={false} compact transparent />
          <HoldButton id="l3" label="L3" onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('l3')} fontSize={13} style={{ width: SZ.l3, height: SZ.l3 }} />
        </div>

        {/* ─── Bottom-right: R3 inline + Right stick ──────────────────── */}
        <div style={{
          position: 'absolute',
          bottom: 'max(16px, env(safe-area-inset-bottom))',
          right: 'max(12px, env(safe-area-inset-right))',
          display: 'flex', alignItems: 'flex-end', gap: 8,
          pointerEvents: 'auto',
        }}>
          <HoldButton id="r3" label="R3" onPress={overlayPress} onRelease={overlayRelease}
            size={numHint('l3')} fontSize={13} style={{ width: SZ.l3, height: SZ.l3 }} />
          <AnalogStick side="right" onChange={handleStick('right')}
            size={SZ.stick} showLabel={false} compact transparent />
        </div>
      </div>
    );
  }

  // --- UI -------------------------------------------------------------------

  if (!profiles.length) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🎮</div>
        <div className="empty-state-title">No profile yet</div>
        <div className="empty-state-text">Create a PS5 profile in Settings first.</div>
      </div>
    );
  }

  return (
    <div className="flex-col gap-md">
      {/* Identity header. Hidden in 'main' view because the parent
          (PS5Control's Control sub-tab) already wraps this card with a
          "🕹️ PS Remote Play" title and the profile picker is redundant
          there - the default profile is auto-selected via the useEffect
          below. The header IS shown in 'all' and 'settings' so the user
          can still switch profiles when managing pairing. */}
      {view !== 'main' && (
      <Section
        title="🎮 Remote Play"
        status={
          <span className="flex items-center gap-xs">
            {/* Sidecar health badge */}
            <span style={{ color: health?.ok ? 'var(--green)' : 'var(--red)' }}>
              ● sidecar {health?.ok ? 'OK' : 'offline'}
            </span>
            {health?.pyremoteplay === false && <span style={{ color: 'var(--red)' }}>(pyremoteplay missing!)</span>}
          </span>
        }
      >
        <label className="text-sm text-muted" style={{ display: 'block' }}>Profile</label>
        <div className="flex gap-sm" style={{ alignItems: 'center' }}>
          <select
            className="select"
            value={profileId}
            onChange={e => setProfileId(e.target.value)}
            style={{ flex: 1 }}
          >
            {profiles.map(p => (
              <option key={p.id} value={p.id}>{p.name} ({p.ip_address})</option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => refreshPs5State(false)}
            disabled={!profile || (usingSharedStatus ? ps5StatusCtx.busy : ps5Busy)}
            title="Re-query PS5 power state (DDP discover)"
          >
            {(usingSharedStatus ? ps5StatusCtx.busy : ps5Busy) ? '⏳' : '🔄'}
          </button>
        </div>
        {profile && ps5State?.runningApp && !ps5State.error && (
          <div className="text-xs text-muted">
            Running: <span style={{ color: 'var(--accent)' }}>{ps5State.runningApp}</span>
          </div>
        )}
        {profile && (
          <div className="flex items-center justify-between flex-wrap gap-sm">
            <div className="text-xs text-muted">
              PSN: {profileView?.psn_online_id || profileView?.psn_account_id || <em>not linked</em>}
              {' · '}
              RP: {paired ? <span style={{ color: 'var(--green)' }}>paired</span> : <em>not paired</em>}
            </div>
            {/* The Show/Hide setup toggle only makes sense in the
                combined "all" view. In dedicated 'settings' or 'main'
                sub-tabs the parent already chose which slice to show,
                so the toggle is dead weight (or worse, confusing). */}
            {view === 'all' && setupComplete && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowSetup(effectiveShowSetup ? false : true)}
              >
                {effectiveShowSetup ? '▲ Hide setup' : '🔧 Manage PSN / pairing'}
              </button>
            )}
          </div>
        )}
      </Section>
      )}

      {(view === 'settings' || (view === 'all' && effectiveShowSetup)) && (<>

      {/* ───────────────────────────────────────────────────────────────────
          Sub-tab selector + jailbreak status badge. PS5-only because the
          two divergent paths (PIN auto-fetch via rp-get-pin.elf and PSN
          activation via offact.elf) are PS5-targeted (prospero-clang ABI +
          12.x regmgr offsets). On PS4 we collapse to the original linear
          OAuth → PIN flow without a tab switcher.

          The order inside each tab implements the user-requested flow:
            • PSN Activated:  0=Auto-fetch  1=PSN account  2=Pair
            • Not Activated:  1=offact (+inline OAuth prereq)  2=Auto-fetch+Pair
          ─────────────────────────────────────────────────────────────── */}
      {isPs5Profile && (
        <div
          className="flex gap-xs flex-wrap items-center"
          role="tablist"
          aria-label="Pairing path"
          style={{
            padding: 4,
            background: 'rgba(255, 255, 255, 0.03)',
            borderRadius: 8,
            border: '1px solid var(--border)',
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={pairTab === 'activated'}
            className={`btn btn-sm ${pairTab === 'activated' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ flex: '1 1 220px' }}
            onClick={() => setPairTab('activated')}
            title="PS5 is signed into PSN already. Use rp-get-pin.elf to grab the PIN (and PSN account) in one click, then pair."
          >
            {pairTab === 'activated' ? '● ' : ''}🔐 PSN Activated
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pairTab === 'unactivated'}
            className={`btn btn-sm ${pairTab === 'unactivated' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ flex: '1 1 220px' }}
            onClick={() => setPairTab('unactivated')}
            title="PS5 is NOT signed into PSN. Link a PSN account here via OAuth, then push it onto the console with offact.elf, then pair."
          >
            {pairTab === 'unactivated' ? '● ' : ''}🪄 Not Activated
          </button>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          PSN Activated path (PS5)  ──  also the PS4 fallback (no sub-tabs).
          Order: 0 · Auto-fetch PIN → 1 · PSN account (OAuth) → 2 · Pair.
          ═══════════════════════════════════════════════════════════════ */}
      {(!isPs5Profile || pairTab === 'activated') && (<>

        {/* ─── Step 0: Auto-fetch PIN (PS5 only) ───────────────────────────
            Sends rp-get-pin.elf to elfldr:9021. The payload reads the
            foreground user's PSN account_id + online_id from regmgr and
            calls sceRemoteplayGeneratePinCode, then prints both on its
            stdout. We parse it, drop the captured account_id into the
            profile (backend persistence), and pre-fill the PIN below. */}
        {isPs5Profile && (
          <Section
            title={autoPinResult?.pin ? '0 · Auto-fetch PIN ✓' : '0 · Auto-fetch PIN'}
            hint={liveSession
              ? '⛔ A Remote Play session is live - stop it first (Control tab above) before fetching a PIN, otherwise rp-get-pin.elf attaching to SceShellUI can knock the session out.'
              : '⚡ Sends rp-get-pin.elf to elfldr (port 9021) and captures the PIN + PSN account from its stdout. If the PS5 is PSN-signed-in this also auto-fills step 1 — no manual Sony OAuth needed.'}
          >
            <div className="flex gap-sm flex-wrap items-center">
              <button
                type="button"
                className="btn btn-primary"
                disabled={autoPinBusy || !profile?.ip_address || liveSession}
                onClick={autoFetchPin}
                title="Send rp-get-pin.elf to the PS5 and read PIN + Account ID from its stdout"
              >
                {autoPinBusy ? '⏳ Sending payload…' : '🪄 Auto-fetch PIN'}
              </button>
              {autoPinResult?.pin && (
                <span className="text-sm" style={{ color: 'var(--green)' }}>
                  ✓ PIN: <b style={{ letterSpacing: 2 }}>{autoPinResult.pin}</b>
                </span>
              )}
              {autoPinResult?.online_id && (
                <span className="text-sm" style={{ color: 'var(--text)' }}>
                  👤 <b>{autoPinResult.online_id}</b>
                </span>
              )}
              {autoPinResult?.account_id && (
                <span className="text-xs" style={{ color: 'var(--muted)', fontFamily: 'monospace' }} title={autoPinResult.account_id}>
                  acct: {autoPinResult.account_id.slice(0, 16)}…
                </span>
              )}
              {autoPinResult?.message && !autoPinResult.pin && (
                <span className="text-sm" style={{ color: 'var(--yellow)' }}>{autoPinResult.message}</span>
              )}
              {autoPinResult?.error && !autoPinResult.pin && (
                <span className="text-sm" style={{ color: 'var(--red)' }}>{autoPinResult.error}</span>
              )}
            </div>
            {Array.isArray(autoPinResult?.log) && autoPinResult.log.length > 0 && !autoPinResult.pin && (
              <details style={{ fontSize: '0.85em' }}>
                <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>
                  Show payload output ({autoPinResult.log.length} lines)
                </summary>
                <pre
                  style={{
                    margin: '6px 0 0 0',
                    padding: 8,
                    background: 'rgba(0, 0, 0, 0.25)',
                    borderRadius: 4,
                    maxHeight: 200,
                    overflow: 'auto',
                    fontFamily: 'monospace',
                    fontSize: '0.75rem',
                    lineHeight: 1.4,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {autoPinResult.log.join('\n')}
                </pre>
              </details>
            )}
          </Section>
        )}

        {/* ─── Step 1: Link PSN account (Sony OAuth) ───────────────────────
            On PSN-activated consoles step 0 already populates this when it
            succeeds, so OAuth here becomes a manual fallback / re-link.
            Still required if rp-get-pin.elf can't run (no HEN yet) or the
            PS5 isn't PSN-signed-in (caller should switch to Not Activated
            tab in that case). */}
        <Section
          title={accountLinked ? '1 · PSN account ✓' : '1 · Link PSN account'}
          hint={accountLinked
            ? `Linked as ${profileView?.psn_online_id || profileView?.psn_account_id}. Re-link below if you switch PSN accounts. (Step 0 fills this automatically when it succeeds.)`
            : "Sony OAuth → opens in a new tab. Sign in, then when the page goes blank or to a 'redirect' URL, copy the FULL URL from the browser address bar and paste below. (You can skip this if step 0 already captured a PSN-signed-in console.)"}
        >
          <div className="flex gap-sm flex-wrap">
            <button className="btn btn-primary" disabled={oauthBusy || !profile} onClick={startOAuth}>
              {oauthBusy ? '⏳ Opening…' : accountLinked ? '🔄 Re-link Sony account' : '🔗 Open Sony login'}
            </button>
            {accountLinked && (
              <button
                className="btn btn-ghost"
                onClick={forgetAccount}
                disabled={oauthBusy}
                title="Drop the linked PSN account from this profile. Pairing credentials are kept."
              >
                🗑 Forget
              </button>
            )}
          </div>
          {loginUrl && (
            <a href={loginUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-muted truncate">
              {loginUrl}
            </a>
          )}
          <label className="text-sm text-muted" style={{ display: 'block' }}>Redirect URL after sign-in</label>
          <textarea
            className="input"
            rows={2}
            placeholder="https://my.account.sony.com/...?code=..."
            value={redirectUrl}
            onChange={e => setRedirectUrl(e.target.value)}
          />
          <button className="btn btn-success" disabled={oauthBusy || !redirectUrl.trim() || !profile} onClick={finishOAuth}>
            {oauthBusy ? '⏳' : '✓ Extract account ID'}
          </button>
        </Section>

        {/* ─── Step 2: Pair (PIN entry + Pair button) ──────────────────── */}
        <Section
          title={paired ? `2 · Pair ${pairConsoleLabel} ✓` : `2 · Pair ${pairConsoleLabel}`}
          hint={
            paired
              ? 'Already paired. Re-pair below with a fresh PIN if you swap PSN accounts, or click Forget pairing to start over.'
              : !accountLinked
                ? 'Link a PSN account first (step 0 if your PS5 is PSN-signed-in, otherwise step 1).'
                : isPs5Profile
                  ? `Use the PIN from step 0 above, or open ${pairMenuPath.split(': ')[1]} on the ${pairConsoleLabel} and type that PIN.`
                  : `On the ${pairConsoleLabel}: ${pairMenuPath.split(': ')[1]}. Type the 8-digit PIN shown there below.`
          }
        >
          <input
            className="input"
            inputMode="numeric"
            maxLength={9}
            placeholder="12345678"
            value={pin}
            onChange={e => setPin(e.target.value)}
            disabled={!accountLinked}
            style={{ fontSize: '1.5rem', letterSpacing: 4, textAlign: 'center' }}
          />
          <div className="flex gap-sm flex-wrap">
            <button
              className="btn btn-success"
              disabled={!accountLinked || pairBusy || pin.replace(/\D/g, '').length < 8 || liveSession}
              onClick={pair}
            >
              {pairBusy ? '⏳ Pairing…' : paired ? '🔄 Re-pair' : '🤝 Pair'}
            </button>
            {paired && (
              <button className="btn btn-ghost" onClick={forgetPair}>🗑 Forget pairing</button>
            )}
          </div>
        </Section>
      </>)}

      {/* ═══════════════════════════════════════════════════════════════════
          Not Activated path (PS5 only). The PS5 isn't PSN-signed-in, so
          we must first push our OAuth-linked PSN id onto its registry via
          offact.elf, THEN rp-get-pin.elf can ask Remote Play for a PIN.
          Order: 1 · offact (with inline OAuth prereq) → 2 · Auto-fetch+Pair.
          ═══════════════════════════════════════════════════════════════ */}
      {isPs5Profile && pairTab === 'unactivated' && (<>

        {/* ─── Step 1: Push linked PSN account to console (offact.elf) ─── */}
        <Section
          title={offactResult?.success ? '1 · Push linked PSN account ✓' : '1 · Push linked PSN account'}
          hint={
            offactResult?.success
              ? `Linked PSN id is now on the PS5${offactResult.user ? ` as ${offactResult.user}` : ''}. Continue to step 2 to grab a PIN and pair.`
              : accountLinked
                ? `Sends offact.elf to elfldr:9021. It reads the foreground user's registry slot, drops a trigger file with your linked PSN id (${profile?.psn_online_id || `${profile?.psn_account_id?.slice(0, 12)}…`}), then reconciles them — adopting if empty, overwriting if mismatched.`
                : 'Requires a linked PSN account first — complete the inline OAuth below, then send the payload.'
          }
        >
          {/* Inline OAuth — required prereq for offact. Compact when already
              linked, full UX when not. We don't render a separate "Step 1
              OAuth" section in this tab because the user explicitly asked
              for offact to be Step 1. */}
          {!accountLinked && (
            <div
              className="flex flex-col gap-sm"
              style={{
                padding: 12,
                border: '1px solid var(--yellow)',
                borderRadius: 8,
                background: 'rgba(255, 193, 7, 0.08)',
              }}
            >
              <div className="text-sm" style={{ color: 'var(--yellow)', lineHeight: 1.5 }}>
                ⚠ <b>Link a PSN account first.</b> offact.elf mirrors the account_id from this profile
                onto the console — without a linked PSN id it has nothing to push and will refuse.
              </div>
              <div className="flex gap-sm flex-wrap">
                <button className="btn btn-primary btn-sm" disabled={oauthBusy || !profile} onClick={startOAuth}>
                  {oauthBusy ? '⏳ Opening…' : '🔗 Open Sony login'}
                </button>
              </div>
              {loginUrl && (
                <a href={loginUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-muted truncate">
                  {loginUrl}
                </a>
              )}
              <label className="text-sm text-muted" style={{ display: 'block' }}>Redirect URL after sign-in</label>
              <textarea
                className="input"
                rows={2}
                placeholder="https://my.account.sony.com/...?code=..."
                value={redirectUrl}
                onChange={e => setRedirectUrl(e.target.value)}
              />
              <button className="btn btn-success btn-sm" disabled={oauthBusy || !redirectUrl.trim() || !profile} onClick={finishOAuth}>
                {oauthBusy ? '⏳' : '✓ Extract account ID'}
              </button>
            </div>
          )}

          {accountLinked && (
            <div className="text-sm" style={{ color: 'var(--muted)' }}>
              ✓ Linked PSN: <b>{profileView?.psn_online_id || profileView?.psn_account_id}</b>
              {' · '}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={forgetAccount}
                style={{ padding: '2px 8px', fontSize: '0.8rem' }}
              >
                🗑 Forget &amp; re-link
              </button>
            </div>
          )}

          <details style={{ fontSize: '0.85em' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>
              How offact.elf reconciles the account
            </summary>
            <div
              className="text-sm"
              style={{
                marginTop: 8,
                padding: 12,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'rgba(126, 87, 194, 0.08)',
                lineHeight: 1.5,
              }}
            >
              The manager writes the <code>account_id</code> from your linked PSN account into a small
              trigger file on the PS5 (<code>/data/.p5manager-offact</code>) over FTP, then sends
              <code> offact.elf </code> to <code>elfldr:9021</code>. The payload reads the foreground
              user's registry slot and reconciles it with the trigger:
              <ul style={{ margin: '6px 0 6px 18px' }}>
                <li><b>empty slot</b> → adopts the linked PSN id</li>
                <li><b>different id</b> → overwrites to match the linked PSN id</li>
                <li><b>already in sync</b> → no-op, just confirms <code>type="np"</code> + <code>flags=0x1002</code></li>
              </ul>
              We never invent a synthetic id — if you haven't linked a PSN account and the console has
              no PSN signed in either, the payload refuses to activate.
              <br /><br />
              <span style={{ color: 'var(--muted)' }}>
                Source: vendored <code>ps5-payload-dev/offact</code> at <code>p5managerclient/offact/</code>,
                reworked to read the manager-supplied account_id instead of synthesising one from the
                local display name.
              </span>
            </div>
          </details>

          <div className="flex gap-sm flex-wrap items-center">
            <button
              type="button"
              className="btn btn-primary"
              disabled={offactBusy || !profile?.ip_address || !accountLinked}
              onClick={activateOffline}
              title={
                !accountLinked
                  ? 'Link a PSN account above first.'
                  : 'Send offact.elf to the PS5 and sync its registry to the linked PSN account'
              }
            >
              {offactBusy ? '⏳ Sending payload…' : '🪄 Push linked PSN account to console'}
            </button>
            {offactResult?.success && offactResult?.user && (
              <span className="text-sm" style={{ color: 'var(--green)' }}>
                ✓ {offactResult.activated === 'already' ? 'Already activated' : 'Activated'}: <b>{offactResult.user}</b>
                {' '}<span style={{ color: 'var(--muted)' }}>(slot {offactResult.slot})</span>
              </span>
            )}
            {offactResult?.account_id && (
              <span className="text-xs" style={{ color: 'var(--muted)', fontFamily: 'monospace' }} title={offactResult.account_id_hex || offactResult.account_id}>
                acct: {offactResult.account_id.slice(0, 16)}…
              </span>
            )}
            {offactResult?.message && !offactResult.success && (
              <span className="text-sm" style={{ color: 'var(--yellow)' }}>{offactResult.message}</span>
            )}
            {offactResult?.error && (
              <span className="text-sm" style={{ color: 'var(--red)' }}>{offactResult.error}</span>
            )}
          </div>

          {Array.isArray(offactResult?.log) && offactResult.log.length > 0 && (
            <details style={{ fontSize: '0.85em' }}>
              <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>
                Show payload output ({offactResult.log.length} lines)
              </summary>
              <pre
                style={{
                  margin: '6px 0 0 0',
                  padding: 8,
                  background: 'rgba(0, 0, 0, 0.25)',
                  borderRadius: 4,
                  maxHeight: 200,
                  overflow: 'auto',
                  fontFamily: 'monospace',
                  fontSize: '0.75rem',
                  lineHeight: 1.4,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {offactResult.log.join('\n')}
              </pre>
            </details>
          )}
        </Section>

        {/* ─── Step 2: Auto-fetch PIN & Pair (combined) ────────────────────
            Now that offact.elf has flipped the registry to look PSN-active,
            rp-get-pin.elf can ask Remote Play for a PIN, and the regular
            pairing handshake will accept it. We collapse both into one
            section since the user runs them back-to-back. */}
        <Section
          title={paired ? `2 · Auto-fetch PIN & Pair ${pairConsoleLabel} ✓` : `2 · Auto-fetch PIN & Pair ${pairConsoleLabel}`}
          hint={
            liveSession
              ? '⛔ A Remote Play session is live - stop it first (Control tab above) before fetching a PIN or pairing, otherwise rp-get-pin.elf attaching to SceShellUI can knock the session out.'
              : paired
                ? 'Already paired. Re-pair below with a fresh PIN if you swap PSN accounts, or click Forget pairing to start over.'
                : offactResult?.success
                  ? 'PSN id is on the console — click Auto-fetch PIN to grab one via rp-get-pin.elf, then Pair.'
                  : 'Run step 1 first so the console has a PSN-linked user; rp-get-pin.elf needs that to generate a PIN.'
          }
        >
          <div className="flex gap-sm flex-wrap items-center">
            <button
              type="button"
              className="btn btn-primary"
              disabled={autoPinBusy || !profile?.ip_address || liveSession}
              onClick={autoFetchPin}
              title="Send rp-get-pin.elf to the PS5 and read PIN + Account ID from its stdout"
            >
              {autoPinBusy ? '⏳ Sending payload…' : '🪄 Auto-fetch PIN'}
            </button>
            {autoPinResult?.pin && (
              <span className="text-sm" style={{ color: 'var(--green)' }}>
                ✓ PIN: <b style={{ letterSpacing: 2 }}>{autoPinResult.pin}</b>
              </span>
            )}
            {autoPinResult?.online_id && (
              <span className="text-sm" style={{ color: 'var(--text)' }}>
                👤 <b>{autoPinResult.online_id}</b>
              </span>
            )}
            {autoPinResult?.message && !autoPinResult.pin && (
              <span className="text-sm" style={{ color: 'var(--yellow)' }}>{autoPinResult.message}</span>
            )}
            {autoPinResult?.error && !autoPinResult.pin && (
              <span className="text-sm" style={{ color: 'var(--red)' }}>{autoPinResult.error}</span>
            )}
          </div>
          {Array.isArray(autoPinResult?.log) && autoPinResult.log.length > 0 && !autoPinResult.pin && (
            <details style={{ fontSize: '0.85em' }}>
              <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>
                Show payload output ({autoPinResult.log.length} lines)
              </summary>
              <pre
                style={{
                  margin: '6px 0 0 0',
                  padding: 8,
                  background: 'rgba(0, 0, 0, 0.25)',
                  borderRadius: 4,
                  maxHeight: 200,
                  overflow: 'auto',
                  fontFamily: 'monospace',
                  fontSize: '0.75rem',
                  lineHeight: 1.4,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {autoPinResult.log.join('\n')}
              </pre>
            </details>
          )}
          <input
            className="input"
            inputMode="numeric"
            maxLength={9}
            placeholder="12345678"
            value={pin}
            onChange={e => setPin(e.target.value)}
            disabled={!accountLinked}
            style={{ fontSize: '1.5rem', letterSpacing: 4, textAlign: 'center' }}
          />
          <div className="flex gap-sm flex-wrap">
            <button
              className="btn btn-success"
              disabled={!accountLinked || pairBusy || pin.replace(/\D/g, '').length < 8 || liveSession}
              onClick={pair}
            >
              {pairBusy ? '⏳ Pairing…' : paired ? '🔄 Re-pair' : '🤝 Pair'}
            </button>
            {paired && (
              <button className="btn btn-ghost" onClick={forgetPair}>🗑 Forget pairing</button>
            )}
          </div>
        </Section>
      </>)}
      </>)}

      {showMainBlock && (<>
      <Section
        title={liveSession ? '🟢 Live session' : '3 · Start session'}
        status={paired
          ? liveSession
            ? (liveStream ? liveStream.resolution : sessionState)
            : warmCache
              ? `warm · ${Math.round(warmCache.ttl_s)}s${warmCache.resolution ? ` · ${warmCache.resolution}` : ''}`
              : sessionState
          : 'pair first'}
        hint={
          !paired
            ? 'Pair the PS5 in step 2 first.'
            : liveSession
              ? null
                : warmCache
                  ? `⚡ Warm cache ready (${Math.round(warmCache.ttl_s)}s left${warmCache.resolution ? `, ${warmCache.resolution}` : ''}) — Start session will resume in milliseconds.`
                : ps5State?.error
                  ? '⚠ PS5 is offline / unreachable — check network and power on the console.'
                  : (ps5State?.code === 620 || /standby/i.test(ps5State?.status || ''))
                    ? '🌙 PS5 is in rest mode. Start session will wake it (15-90 s). Tip: 📡 Wake PS5 first if you want it ready in the background.'
                    : 'Start a control-only Remote Play session. By default the video stream is ignored - tick "Stream video" below if you want a live preview (uses more CPU).'
        }
      >
        {!liveSession && (
          <>
            {/* Resolution picker. pyremoteplay supports up to 1080p but
                we cap at 720p — the MJPEG re-encode pass at 1080p on a
                Pi-class CPU drops to single-digit fps and looks worse
                than 720p anyway. 720p is the default sweet spot. */}
            <div className="flex items-center gap-sm text-sm flex-wrap" style={{ marginBottom: 6 }}>
              <span style={{ minWidth: 90 }}>📐 Resolution:</span>
              {['360p', '540p', '720p'].map(r => (
                <button
                  key={r}
                  type="button"
                  className={`btn btn-sm ${rpResolution === r ? 'btn-primary' : 'btn-ghost'}`}
                  disabled={!paired || sessionState === 'connecting'}
                  onClick={() => setRpResolution(r)}
                  title={r === '720p' ? 'Best quality on this build (1080p removed because the MJPEG re-encode is too slow on a Pi).' : r === '360p' ? 'Lowest bandwidth / CPU.' : ''}
                >
                  {r}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-sm text-sm" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={enableVideo}
                onChange={(e) => setEnableVideo(e.target.checked)}
                disabled={!paired || sessionState === 'connecting'}
              />
              <span>
                📺 Stream video preview ({rpResolution} MJPEG, ~{videoFps} fps)
              </span>
            </label>
          </>
        )}
        <div className="flex gap-sm flex-wrap">
          <button
            className="btn btn-primary"
            disabled={!paired || sessionState === 'connecting' || liveSession}
            onClick={() => startSession()}
          >
            {sessionState === 'connecting'
              ? (retryStatus
                  ? `🔒 PS5 locked, retrying in ${Math.ceil(retryStatus.remainingS)}s…`
                  : '⏳ Starting…')
              : enableVideo ? '▶ Start session + video'
              : '▶ Start session'}
          </button>
          <button
            className="btn btn-danger"
            disabled={!paired || (sessionState === 'idle' && !sessionId)}
            onClick={stopSession}
          >
            ⏹ Stop session
          </button>
          <button
            className="btn btn-ghost"
            disabled={!paired || wakeBusy || liveSession}
            onClick={wakePs5}
            title="Pre-warm: opens a full Remote Play session (waking the PS5 from rest mode if needed) and immediately parks it in the warm cache so the next Start session resumes in milliseconds."
          >
            {wakeBusy ? '⏳ Waking…' : warmCache ? '✓ Warm — re-warm?' : '📡 Wake PS5'}
          </button>
          <button
            className="btn btn-ghost"
            disabled={!paired || standbyBusy}
            onClick={standbyPs5}
            title="Puts the PS5 into rest mode via Remote Play. Restart isn't supported by the RP protocol."
          >
            {standbyBusy ? '⏳ Rest mode…' : '🌙 Rest mode'}
          </button>
          <button
            className="btn btn-ghost"
            disabled={!paired}
            onClick={forceReset}
            title="Clears every cached Remote Play session on the sidecar. Use when the PS5 keeps reporting 'Another Remote Play session is connected'."
          >
            🧹 Force reset
          </button>
        </div>
      </Section>

      {/* Merged "Live session" panel: MJPEG cap row → video preview → on-screen
          controller. Single Section keeps the preview directly above the sticks
          on mobile (no card boundary in between) and avoids redundant headers.
          The Fullscreen text button is gone — the ⛶ icon overlaid on the video
          covers that path. */}
      {liveSession && (
        <Section
          title={sessionHasVideo && sessionId ? '📺 Live session' : '🎮 Controller'}
          status={sessionHasVideo && sessionId && liveStream ? liveStream.resolution : null}
          hint={
            sessionHasVideo && sessionId
              ? `Live MJPEG stream from the PS5 (~1-2 s latency)${liveStream ? `, RP stream is ${liveStream.resolution}` : ''}. Tap ⛶ on the video for fullscreen with touch controls.`
              : undefined
          }
        >
        {/* Control (touch overlay) / Input Scripts (list + editor + step
            runner) / Payloads (send without leaving this view) - Control
            and Input Scripts share the same video/session, never two
            MJPEG streams at once since only one tab's markup is mounted
            at a time. */}
        <div className="tabs mb-sm" style={{ maxWidth: 460 }}>
          <button
            type="button"
            className={`tab-item ${sessionViewTab === 'control' ? 'active' : ''}`}
            onClick={() => setSessionViewTab('control')}
          >
            🎮 Control
          </button>
          <button
            type="button"
            className={`tab-item ${sessionViewTab === 'scripts' ? 'active' : ''}`}
            onClick={() => setSessionViewTab('scripts')}
          >
            ⌨️ Input Scripts
          </button>
          <button
            type="button"
            className={`tab-item ${sessionViewTab === 'payloads' ? 'active' : ''}`}
            onClick={() => { setSessionViewTab('payloads'); if (!payloadsLoaded) fetchPayloadsList(); }}
          >
            📦 Payloads
          </button>
        </div>

        {sessionViewTab === 'control' && (
        <>
        {/* rp-live-layout: on mobile this is just a vertical flex stack
            (chips → video → pad). On desktop (≥1024px) CSS reflows it
            into a 3-column grid where the D-pad sits to the LEFT of the
            video and the face buttons to the RIGHT, while everything
            else (chips, video, system buttons, PS2 row, hint) stays in
            the center column. The pad's inner wrappers use
            display: contents at that breakpoint so the grandchildren
            become direct grid children and individual grid-area
            assignments work. */}
        <div className="rp-live-layout">
          {sessionHasVideo && sessionId && (
            <>
              {/* MJPEG cap chooser sits ABOVE the video — the chip strip is
                  much shorter than the 16:9 preview, so putting it on top keeps
                  the FPS toggles in thumb reach and the video itself fills the
                  vertical space immediately. */}
              <div className="rp-live-chips flex items-center gap-sm text-xs text-muted flex-wrap">
                <span>MJPEG cap:</span>
                {[6, 12, 18, 24, 30].map(f => (
                  <button
                    key={f}
                    type="button"
                    className={`btn btn-sm ${videoFps === f ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => { setVideoFps(f); setVideoNonce(n => n + 1); }}
                    title={f > 30 ? 'Higher than the RP stream FPS (30) — no extra frames.' : ''}
                  >
                    {f}
                  </button>
                ))}
              </div>

              <div
                ref={videoContainerRef}
                className="rp-live-video"
                style={{
                  position: fsActive ? 'fixed' : 'relative',
                  inset: fsActive ? 0 : undefined,
                  zIndex: fsActive ? 9999 : undefined,
                  background: '#000',
                  borderRadius: fsActive ? 0 : 'var(--radius-md, 8px)',
                  overflow: 'hidden',
                  aspectRatio: fsActive ? undefined : '16 / 9',
                  // Max width is driven by --rp-video-max (set per
                  // breakpoint in styles.css) so desktop can claim
                  // ~1100px without bloating mobile past 640px.
                  maxWidth: fsActive ? undefined : 'var(--rp-video-max, 640px)',
                  margin: fsActive ? 0 : '0 auto',
                  width: fsActive ? '100vw' : '100%',
                  height: fsActive ? '100vh' : undefined,
                  touchAction: fsActive ? 'none' : undefined,
                }}
              >
                <img
                  key={videoNonce}
                  src={`${API}/sessions/${encodeURIComponent(sessionId)}/video.mjpeg?fps=${videoFps}&nonce=${videoNonce}`}
                  alt="PS5 Remote Play preview"
                  style={{
                    width: '100%', height: '100%', display: 'block',
                    objectFit: 'contain',
                    pointerEvents: 'none',
                  }}
                  onError={() => {
                    onNotification?.('Video stream dropped - try restarting the session', 'warning');
                  }}
                />

                {/* ─── Fullscreen toggle (always visible on the video) ───── */}
                <button
                  type="button"
                  onClick={toggleFullscreen}
                  aria-label={fsActive ? 'Exit fullscreen' : 'Enter fullscreen'}
                  style={{
                    position: 'absolute',
                    top: fsActive ? 'max(12px, env(safe-area-inset-top))' : 8,
                    left: fsActive ? 'max(12px, env(safe-area-inset-left))' : 'auto',
                    right: fsActive ? 'auto' : 8,
                    width: 44, height: 44, borderRadius: 8,
                    background: 'rgba(0,0,0,0.55)',
                    color: '#fff', border: '1px solid rgba(255,255,255,0.3)',
                    fontSize: 22, fontWeight: 700, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    touchAction: 'none', userSelect: 'none',
                  }}
                >
                  {fsActive ? '✕' : '⛶'}
                </button>

                {/* ─── Record + Run toggles (inline preview only) ──────────
                    Sit next to the ⛶ fullscreen toggle. REC pulses red
                    while active and expands into a tiny HUD with elapsed
                    seconds + captured event count. ▶ opens a picker so the
                    user can run any saved or built-in script against the
                    live session without leaving Remote Play. Auto-hides to
                    a single small dot after a few seconds of no
                    interaction (never while actively recording) so the
                    cluster doesn't permanently cover the video - hover or
                    tap it to bring the full row back. */}
                {!fsActive && (
                  controlsVisible || recording ? (
                    <div onMouseEnter={showControls} onMouseLeave={showControls}>
                      <button
                        type="button"
                        onClick={recording ? stopRecording : startRecording}
                        aria-label={recording ? 'Stop recording inputs' : 'Record inputs'}
                        title={recording ? 'Stop recording' : 'Record inputs to a script'}
                        className={recording ? 'rp-rec-btn rp-rec-active' : 'rp-rec-btn'}
                        style={{
                          position: 'absolute',
                          top: 8,
                          right: recording ? 60 : 112,
                          height: 44, minWidth: 44,
                          padding: recording ? '0 10px' : 0,
                          borderRadius: 8,
                          background: recording ? 'rgba(220, 50, 50, 0.85)' : 'rgba(0,0,0,0.55)',
                          color: '#fff', border: '1px solid rgba(255,255,255,0.3)',
                          fontSize: recording ? 13 : 18, fontWeight: 700, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          touchAction: 'none', userSelect: 'none',
                        }}
                      >
                        <span className={recording ? 'rp-rec-dot rp-rec-dot-active' : 'rp-rec-dot'} />
                        {recording && (
                          <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            REC {Math.floor(recElapsed / 1000)}s · {recEventCount}
                          </span>
                        )}
                      </button>
                      {!recording && (
                        <button
                          type="button"
                          onClick={openRunPicker}
                          aria-label="Run a script"
                          title="Run a saved or built-in script"
                          style={{
                            position: 'absolute',
                            top: 8,
                            right: 60,
                            width: 44, height: 44, borderRadius: 8,
                            background: 'rgba(0,0,0,0.55)',
                            color: '#fff', border: '1px solid rgba(255,255,255,0.3)',
                            fontSize: 18, fontWeight: 700, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            touchAction: 'none', userSelect: 'none',
                          }}
                        >
                          ▶
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={showControls}
                      onMouseEnter={showControls}
                      aria-label="Show recording and script controls"
                      title="Show controls"
                      style={{
                        position: 'absolute',
                        top: 8,
                        right: 60,
                        width: 20, height: 20, borderRadius: '50%',
                        background: 'rgba(0,0,0,0.5)',
                        border: '1px solid rgba(255,255,255,0.35)',
                        padding: 0, cursor: 'pointer',
                        touchAction: 'none',
                      }}
                    />
                  )
                )}

                {fsActive && renderFullscreenOverlay()}
              </div>
            </>
          )}

          {renderManualPad()}
        </div>{/* /rp-live-layout */}
        </>
        )}

        {sessionViewTab === 'scripts' && (
          <div>
            {/* Backs the add/edit step inputs' `list` attribute: a native
                searchable dropdown (type to filter) that still lets the
                user type anything free-form (params like "wait 500" or
                "left 10x" aren't in this list and wouldn't match, but the
                input accepts them anyway - <datalist> only suggests). */}
            <datalist id="script-cmd-datalist">
              {AVAILABLE_COMMANDS.map(({ cmd, desc }) => (
                <option key={cmd} value={cmd}>{desc}</option>
              ))}
            </datalist>
            {stepPanel ? (
              <>
                <div className="flex items-center justify-between mb-sm" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <span className="font-bold" style={{ fontSize: '0.9rem' }}>👣 {stepPanel.name}</span>
                  <div className="flex gap-sm">
                    <button className="btn btn-ghost btn-sm" onClick={closeStepPanel}>✕ Close</button>
                  </div>
                </div>

                {/* Manual controls above the video/step grid - lets the user
                    press real buttons while building or running a script
                    live, same pad + press/release wiring as the Control
                    tab (see renderManualPad above). */}
                <div className="mb-sm rp-pad-compact">
                  {renderManualPad()}
                </div>

                <div className="tabs mobile-only" style={{ marginBottom: 10 }}>
                  <button
                    type="button"
                    className={`tab-item ${stepMobileTab === 'video' ? 'active' : ''}`}
                    onClick={() => setStepMobileTab('video')}
                  >
                    📺 Video
                  </button>
                  <button
                    type="button"
                    className={`tab-item ${stepMobileTab === 'steps' ? 'active' : ''}`}
                    onClick={() => setStepMobileTab('steps')}
                  >
                    📋 Steps
                  </button>
                </div>

                <div className="step-panel-grid">
                  <div className={`step-video ${stepMobileTab === 'video' ? '' : 'mobile-hidden'}`}>
                    {renderTabVideo()}
                  </div>

                  <div className={`step-list ${stepMobileTab === 'steps' ? '' : 'mobile-hidden'}`}>
                    {/* Reset + Save, above the Prev/Next/Restart/Replay row -
                        moved out of the manual pad and the panel header
                        respectively so every step-editor action lives in
                        one place. */}
                    <div className="flex items-center gap-sm mb-sm" style={{ flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={resetToMainScreen}
                        title="PS, then Down, then Cross - back out to the Home screen"
                      >
                        🏠 Reset to main screen
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={saveStepScript}
                        disabled={stepPanel.steps.length === 0}
                        title={
                          stepPanel.source?.kind === 'builtin' ? 'Save the current steps back into this built-in script'
                            : stepPanel.source?.kind === 'user' ? 'Save the current steps back into this saved script'
                              : 'Save the current steps (including any live edits/additions) as a new saved script'
                        }
                      >
                        💾 {
                          stepPanel.source?.kind === 'builtin' ? 'Save to built-in'
                            : stepPanel.source?.kind === 'user' ? 'Update script'
                              : 'Save as script'
                        }
                      </button>
                    </div>

                    {/* Step navigation - pinned above the scrolling list
                        (not below the whole video+list grid like before)
                        so it stays reachable without scrolling past a long
                        script. Next/Prev/Restart just move the cursor;
                        "Replay to" runs forward from wherever the cursor
                        already is through the chosen step number. */}
                    <div className="flex items-center gap-sm mb-sm" style={{ flexWrap: 'wrap' }}>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={stepPrev}
                        disabled={stepBusy || stepPanel.steps.length === 0 || stepPanel.index === 0}
                      >
                        ◀ Prev
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={stepNext}
                        disabled={stepBusy || stepPanel.steps.length === 0 || stepPanel.index >= stepPanel.steps.length}
                      >
                        {stepBusy
                          ? '⏳ Executing…'
                          : stepPanel.steps.length === 0
                            ? '▶ Next'
                            : stepPanel.index >= stepPanel.steps.length
                              ? '✅ Done'
                              : `▶ Next (${stepPanel.index + 1}/${stepPanel.steps.length})`}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={stepRestart} disabled={stepBusy || stepPanel.steps.length === 0}>
                        ↺ Restart
                      </button>
                      <div className="flex items-center gap-xs" style={{ marginLeft: 'auto' }}>
                        <span className="text-xs text-muted">Replay to</span>
                        <input
                          type="number"
                          className="input"
                          style={{ width: 60, minHeight: 28, padding: '2px 6px', fontSize: '0.78rem' }}
                          min={1}
                          max={stepPanel.steps.length}
                          placeholder="#"
                          value={replayTarget}
                          onChange={e => setReplayTarget(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') stepReplayTo(); }}
                        />
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={stepReplayTo}
                          disabled={stepBusy || !replayTarget || stepPanel.steps.length === 0}
                          title="Run forward from the current step through the chosen step number"
                        >
                          ▶▶ Go
                        </button>
                      </div>
                    </div>
                    {stepPanel.index < stepPanel.steps.length && (
                      <div className="text-xs text-muted mb-sm">
                        Next line: <code>{stepPanel.steps[stepPanel.index].raw}</code>
                      </div>
                    )}

                    <div className="step-list-scroll">
                      {addAfterIdx === -1 ? (
                        <div className="step-add-row">
                          <input
                            autoFocus
                            className="input font-mono"
                            style={{ fontSize: '0.78rem', padding: '4px 8px' }}
                            value={addDraftText}
                            onChange={e => setAddDraftText(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') confirmAddStep(); if (e.key === 'Escape') cancelAddForm(); }}
                            list="script-cmd-datalist"
                            placeholder="e.g. cross, wait 500, left 10x"
                          />
                          <button className="btn btn-success btn-sm btn-icon" onClick={confirmAddStep} title="Add">✓</button>
                          <button className="btn btn-ghost btn-sm btn-icon" onClick={cancelAddForm} title="Cancel">✕</button>
                        </div>
                      ) : (
                        <button className="step-add-toggle" onClick={() => openAddForm(-1)} title="Insert a command here">＋</button>
                      )}
                      {addAfterIdx === -1 && addDraftError && (
                        <div className="text-xs" style={{ color: 'var(--red)' }}>{addDraftError}</div>
                      )}

                      {stepPanel.steps.length === 0 && (
                        <div className="text-sm text-muted" style={{ padding: '8px 0' }}>
                          No commands yet - use the ＋ above to add the first one.
                        </div>
                      )}

                      {stepPanel.steps.map((s, i) => (
                        <div key={i}>
                          <div
                            ref={el => { stepLineRefs.current[i] = el; }}
                            tabIndex={-1}
                            className={`step-line ${i === stepPanel.index ? 'current' : i < stepPanel.index ? 'done' : ''}`}
                          >
                            <span className="step-line-num">{s.lineNum}</span>
                            {editingStepIdx === i ? (
                              <>
                                <input
                                  autoFocus
                                  className="input font-mono"
                                  style={{ fontSize: '0.78rem', padding: '4px 8px', flex: 1 }}
                                  value={stepDraftText}
                                  onChange={e => setStepDraftText(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') saveEditStep(); if (e.key === 'Escape') cancelEditStep(); }}
                                  list="script-cmd-datalist"
                                />
                                <button className="btn btn-success btn-sm btn-icon" onClick={saveEditStep} title="Save">✓</button>
                                <button className="btn btn-ghost btn-sm btn-icon" onClick={cancelEditStep} title="Cancel">✕</button>
                              </>
                            ) : (
                              <>
                                <span className="step-line-text font-mono">{s.raw}</span>
                                {i < stepPanel.index && <span className="step-line-check">✓</span>}
                                <button className="btn btn-ghost btn-sm btn-icon step-line-action" onClick={() => startEditStep(i)} title="Edit this step">✏️</button>
                                <button className="btn btn-ghost btn-sm btn-icon step-line-action" onClick={() => deleteStepRow(i)} title="Delete this step">🗑</button>
                              </>
                            )}
                          </div>
                          {editingStepIdx === i && stepDraftError && (
                            <div className="text-xs" style={{ color: 'var(--red)', margin: '2px 0 4px' }}>{stepDraftError}</div>
                          )}

                          {addAfterIdx === i ? (
                            <div className="step-add-row">
                              <input
                                autoFocus
                                className="input font-mono"
                                style={{ fontSize: '0.78rem', padding: '4px 8px' }}
                                value={addDraftText}
                                onChange={e => setAddDraftText(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') confirmAddStep(); if (e.key === 'Escape') cancelAddForm(); }}
                                list="script-cmd-datalist"
                            placeholder="e.g. cross, wait 500, left 10x"
                              />
                              <button className="btn btn-success btn-sm btn-icon" onClick={confirmAddStep} title="Add">✓</button>
                              <button className="btn btn-ghost btn-sm btn-icon" onClick={cancelAddForm} title="Cancel">✕</button>
                            </div>
                          ) : (
                            <button className="step-add-toggle" onClick={() => openAddForm(i)} title="Insert a command here">＋</button>
                          )}
                          {addAfterIdx === i && addDraftError && (
                            <div className="text-xs" style={{ color: 'var(--red)' }}>{addDraftError}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="step-panel-grid">
                <div className="step-video">{renderTabVideo()}</div>
                <div className="step-list" style={{ overflowY: 'visible' }}>
                  <div className="flex-col gap-md">
                    <button
                      className="btn btn-info btn-sm"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() => openStepMode('', 'New script', true)}
                      title="Build a script live, one command at a time, while watching video"
                    >
                      🆕 New script (live)
                    </button>
                    <ScriptRunner
                      ip={profile?.ip_address}
                      liveSession={liveSession}
                      onStartSession={() => startSession(true)}
                      sendCommand={stepSendCommand}
                      scripts={scripts}
                      onScriptsChange={onScriptsChange}
                      onRequestStep={(scriptText, name, source) => openStepMode(scriptText, name, false, source)}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {sessionViewTab === 'payloads' && (
          <div className="step-panel-grid">
            <div className="step-video">{renderTabVideo()}</div>
            <div className="step-list" style={{ overflowY: 'visible' }}>
              <p className="text-sm text-muted mb-sm">
                Send a payload to <b>{profile?.name}</b> ({profile?.ip_address}) without leaving Remote Play.
                Manage the full library (add / update / delete) in the Payloads tab.
              </p>
              {!payloadsLoaded ? (
                <div className="text-sm text-muted">Loading…</div>
              ) : payloadsList.length === 0 ? (
                <div className="text-sm text-muted">No payloads yet - add some in the Payloads tab.</div>
              ) : (
                <div className="flex-col" style={{ gap: 6, maxHeight: 420, overflowY: 'auto' }}>
                  {payloadsList.map(p => (
                    <div key={p.id} className="list-item" style={{ marginBottom: 0 }}>
                      <div className="flex-1 truncate" title={p.name}>
                        <span className="truncate" style={{ fontWeight: 600 }}>{p.name}</span>
                        {p.console_type && (
                          <span className="console-type-badge" style={{ marginLeft: 6 }}>{p.console_type.toUpperCase()}</span>
                        )}
                      </div>
                      <div className="list-item-actions">
                        <button
                          className="btn btn-success btn-sm btn-icon"
                          onClick={() => sendPayload(p)}
                          disabled={sendingPayloadId === p.id}
                          title="Send"
                        >
                          {sendingPayloadId === p.id ? '⏳' : '📤'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        </Section>
      )}

      {health?.success === false && (
        <div className="text-xs text-muted">
          Sidecar error: {health.error}. Check the <code>pyremoteplay</code> container logs.
        </div>
      )}

      {/* ─── Run-script picker ─────────────────────────────────────────────
          Opened by the ▶ button next to REC. Lists saved + built-in
          scripts; picking one hands off to the step-through runner so it
          plays against the live session/video. */}
      {runPickerOpen && (
        <div
          className="rp-rec-modal-backdrop"
          onClick={(e) => { if (e.target === e.currentTarget) closeRunPicker(); }}
        >
          <div className="rp-rec-modal">
            <div className="rp-rec-modal-header">
              <span>▶ Run a script</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={closeRunPicker} aria-label="Close">✕</button>
            </div>
            <div className="rp-rec-modal-body">
              {recExistingScripts.length === 0 ? (
                <div className="text-sm text-muted">
                  No scripts yet - record one (● above) or create one in the Scripts tab.
                </div>
              ) : (
                <div className="flex-col" style={{ gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                  {recExistingScripts.map(s => (
                    <button
                      key={s.id}
                      type="button"
                      className="btn btn-secondary btn-block"
                      style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                      onClick={() => runPickedScript(s)}
                    >
                      {s.kind === 'builtin' ? '🔧 ' : ''}{s.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── Post-recording review modal ─────────────────────────────────────
          Position-fixed so it overlays both the inline preview and the
          fullscreen overlay (z-index 10000 sits above the fs container at
          9999). The user reviews / edits the captured DSL, picks "new" or
          "append to an existing script", and saves with one click. */}
      {recReviewOpen && (
        <div
          className="rp-rec-modal-backdrop"
          onClick={(e) => { if (e.target === e.currentTarget) discardRecording(); }}
        >
          <div className="rp-rec-modal">
            <div className="rp-rec-modal-header">
              <span>📼 Recorded input script</span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={discardRecording}
                aria-label="Close"
              >✕</button>
            </div>

            <div className="rp-rec-modal-body">
              {/* Destination picker first so the textarea below always
                  reflects the chosen script's current content + the new
                  recording. Changing destinations re-derives the body from
                  the immutable transcript — no silent merging. */}
              <div className="rp-rec-modal-row">
                <label className="text-sm">Destination</label>
                <select
                  className="select"
                  value={recAppendId}
                  onChange={(e) => handleDestinationChange(e.target.value)}
                >
                  <option value="">— New script —</option>
                  {recExistingScripts.filter(s => s.kind === 'user').length > 0 && (
                    <optgroup label="Saved scripts">
                      {recExistingScripts.filter(s => s.kind === 'user').map(s => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {recExistingScripts.filter(s => s.kind === 'builtin').length > 0 && (
                    <optgroup label="Built-in macros">
                      {recExistingScripts.filter(s => s.kind === 'builtin').map(s => (
                        <option key={s.id} value={s.id}>🔧 {s.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>

              {!recAppendId && (
                <div className="rp-rec-modal-row">
                  <label className="text-sm">Name</label>
                  <input
                    className="input"
                    type="text"
                    placeholder={`Recording ${new Date().toLocaleString()}`}
                    value={recNewName}
                    onChange={(e) => setRecNewName(e.target.value)}
                  />
                </div>
              )}

              <div className="text-xs text-muted">
                {recRecordedBody.split('\n').filter(Boolean).length} command(s) recorded.
                {recAppendId
                  ? ' The full edited script will replace the destination on save.'
                  : ' Edit freely before saving.'}
                {recAppendId.startsWith('builtin:') && (
                  <span style={{ color: 'var(--warning, #f5a623)', marginLeft: 6 }}>
                    Saves overwrite the built-in source file (a .bak is kept).
                  </span>
                )}
              </div>

              <textarea
                className="textarea"
                rows={12}
                spellCheck={false}
                value={recScriptText}
                onChange={(e) => setRecScriptText(e.target.value)}
                style={{ fontFamily: 'monospace', fontSize: 13, width: '100%' }}
              />
            </div>

            <div className="rp-rec-modal-footer">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={discardRecording}
                disabled={recSaving}
              >Discard</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={saveRecording}
                disabled={recSaving || !recScriptText.trim()}
              >
                {recSaving ? 'Saving…' : recAppendId.startsWith('builtin:') ? 'Save built-in' : recAppendId ? 'Update' : 'Save as new'}
              </button>
            </div>
          </div>
        </div>
      )}
      </>)}
    </div>
  );
}
