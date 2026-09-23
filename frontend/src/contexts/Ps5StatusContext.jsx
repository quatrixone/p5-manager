// Ps5StatusContext — single source of truth for "is the PS5 up, and in what
// sense?", shared by the topbar status pill and PS5 Control.
//
// Before this existed, App.jsx polled GET /api/ps5/status/:ip (TCP reachability
// of the payload-loader port, e.g. 9021) on its own 15 s timer for the topbar
// dot, while RemotePlay.jsx independently polled GET /api/remoteplay/discover
// (DDP - is Remote Play/the console itself reachable) for its own status text.
// Two pollers, two different questions, both drawing conclusions about "is
// this PS5 online" from unrelated signals:
//   - DDP can say "Ok" (console awake, Remote Play reachable) while the
//     payload port is closed - normal right after standby/wake, since the
//     injected kernel exploit / payload host doesn't survive a rest-mode
//     cycle and has to be re-run by hand.
//   - That mismatch is exactly what made the topbar dot flash red the
//     instant "Wake PS5" was clicked: DDP-side, the console really is
//     waking up; port-side, the payload host genuinely isn't listening yet
//     and won't be until the user re-injects it. Two truths, one confusing
//     red dot.
//
// This context polls BOTH signals once (still visibility-gated, still one
// interval), combines them into a single state, and gives every consumer
// (topbar, PS5 Control) the same answer instead of two that can disagree.
import { createContext, useContext, useMemo, useState, useCallback, useRef } from 'react';
import { apiSafe } from '../lib/api.js';
import useVisiblePolling from '../hooks/useVisiblePolling';

// Any open payload listener means the console is awake and running a
// payload host: ELF loader (9021), Lua loader (9026), PS4 GoldHEN (9020),
// PS4 web exploit (8080), etaHEN (6970).
const PAYLOAD_PORTS = new Set([9021, 9026, 9020, 8080, 6970]);

const Ps5StatusContext = createContext({
  state: 'offline', // 'online' | 'waking' | 'standby' | 'offline'
  ddp: null,
  portStatus: null,
  refresh: async () => {},
  busy: false,
  markWaking: () => {},
});

export function Ps5StatusProvider({ profile, children }) {
  const [ddp, setDdp] = useState(null);
  const [portStatus, setPortStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  // Optimistic flag set the instant the user clicks Wake, so the dot
  // shows "waking" immediately instead of whatever stale/conflicting
  // state the last poll happened to catch. Cleared once a poll confirms
  // the console is actually reachable (DDP Ok) or after a timeout so a
  // failed wake doesn't get stuck showing "waking" forever.
  const [manualWaking, setManualWaking] = useState(false);
  const wakingTimeoutRef = useRef(null);

  const markWaking = useCallback(() => {
    setManualWaking(true);
    clearTimeout(wakingTimeoutRef.current);
    wakingTimeoutRef.current = setTimeout(() => setManualWaking(false), 30000);
  }, []);

  const refresh = useCallback(async (silent = true) => {
    if (!profile?.ip_address) { setDdp(null); setPortStatus(null); return; }
    if (!silent) setBusy(true);
    try {
      const [d, p] = await Promise.all([
        apiSafe.get(`/remoteplay/discover?ip=${encodeURIComponent(profile.ip_address)}`),
        apiSafe.get(`/ps5/status/${profile.ip_address}?port=${profile.port || 9021}`),
      ]);
      setDdp(d);
      setPortStatus(p);
      if (d?.success && /^ok$/i.test(d.status || '')) {
        setManualWaking(false);
        clearTimeout(wakingTimeoutRef.current);
      }
    } finally {
      if (!silent) setBusy(false);
    }
  }, [profile?.ip_address, profile?.port]);

  useVisiblePolling(refresh, profile ? 15000 : 0, [profile?.ip_address, profile?.port]);

  const state = useMemo(() => {
    if (!profile) return 'offline';
    const portOpen = portStatus?.reachable && PAYLOAD_PORTS.has(portStatus.openPort);
    if (portOpen) return 'online';
    if (manualWaking) return 'waking';
    const ddpOk = ddp?.success && /^ok$/i.test(ddp.status || '');
    if (ddpOk) return 'waking'; // console/RP reachable, payload host not loaded yet
    const ddpStandby = ddp?.success && (ddp.status_code === 620 || /standby/i.test(ddp.status || ''));
    if (ddpStandby) return 'standby';
    return 'offline';
  }, [profile, ddp, portStatus, manualWaking]);

  const value = useMemo(() => ({
    state, ddp, portStatus, refresh, busy, markWaking,
    // Exposed so a consumer tracking a DIFFERENT profile (e.g. PS5
    // Control's own profile picker, when it's not set to the default
    // profile this provider is scoped to) can tell its state doesn't
    // apply and fall back to a local check instead of showing the
    // wrong console's status.
    profileId: profile?.id ?? null,
  }), [state, ddp, portStatus, refresh, busy, markWaking, profile?.id]);

  return (
    <Ps5StatusContext.Provider value={value}>
      {children}
    </Ps5StatusContext.Provider>
  );
}

export function usePs5Status() {
  return useContext(Ps5StatusContext);
}
