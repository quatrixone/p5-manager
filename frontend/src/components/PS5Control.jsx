import { useState, useEffect } from 'react';
import ScriptRunner from './ScriptRunner';
import RemotePlay from './RemotePlay';
// BT Virtual DualShock 4 emulator (host-side BlueZ HID device) moved to
// a sibling repo: /home/dietpi/Projects/vcontrol. PS5 firmware rejects
// every non-Sony-signed controller during the post-pair HID handshake
// (BD_ADDR + Sony controller-auth chip required), so the feature is
// shelved indefinitely. The DS4-via-DietPi BT bridge was also removed
// because its output still flows through pyremoteplay's RP feedback
// channel, which shares the PS2 Classics input filter, making the
// extra Bluetooth machinery useless for the original problem. The
// planned replacement is a Pi Zero 2 W + Brook auth chip mounted in
// the PS5 USB port (see project docs); that path bypasses every
// filter because PS5 sees a wired Sony-signed HID gamepad.
import Badge from './UI/Badge';

const API = '/api';

// P5 Control top-level sub-tabs. 'control' is the default and contains
// the live RP playback path (Start session, video preview, controller,
// fullscreen overlay) + Input Scripts. 'settings' is where the Remote
// Play *setup* (Sony OAuth, PIN pairing, offline activation) lives -
// it's a once-per-account flow that doesn't belong on the hot path.
//
// Persisted to localStorage so a refresh / navigate-back doesn't bounce
// the user out of Settings while they're in the middle of pairing.
const SUBTAB_KEY = 'ps5ControlSubTab';
const readInitialSubTab = () => {
  try {
    const v = localStorage.getItem(SUBTAB_KEY);
    return v === 'settings' ? 'settings' : 'control';
  } catch (_) {
    return 'control';
  }
};

function PS5Control({ profiles, onNotification, onProfilesChanged }) {
  const [status, setStatus] = useState(null);
  const [waking, setWaking] = useState(false);
  const [standbyBusy, setStandbyBusy] = useState(false);
  const [stoppingSession, setStoppingSession] = useState(false);
  const [scripts, setScripts] = useState([]);
  const [notification, setNotification] = useState(null);
  const [subTab, setSubTab] = useState(readInitialSubTab);
  useEffect(() => {
    try { localStorage.setItem(SUBTAB_KEY, subTab); } catch (_) { /* ignore */ }
  }, [subTab]);
  // Remote Play session state for the default profile. Mirrors what
  // RemotePlay.jsx and ScriptRunner.jsx track independently, but PS5 Control
  // shows it in the top-level header so the user gets the full picture
  // (legacy port status + RP session) without having to scroll to either
  // sub-card.
  //   live → sidecar has an active SESSIONS pool entry (Start session done)
  //   warm → sidecar has a PAUSED entry (Wake or recent soft-stop)
  //   idle → nothing on the sidecar for this IP
  const [rpSession, setRpSession] = useState({ state: 'idle', sessionId: null, warmTtl: null, video: false });

  const defaultProfile = profiles.find(p => p.is_default) || profiles[0];

  const showToast = (message, type = 'info') => {
    if (onNotification) {
      onNotification(message, type);
      return;
    }
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  const fetchScripts = async () => {
    try {
      const res = await fetch(`${API}/input-scripts`);
      const data = await res.json();
      setScripts(data);
    } catch (err) {
      console.error('Failed to fetch scripts:', err);
    }
  };

  useEffect(() => { if (defaultProfile) fetchStatus(); }, [defaultProfile]);
  useEffect(() => { fetchScripts(); }, []);

  useEffect(() => {
    if (!defaultProfile) return;
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [defaultProfile]);

  // Independent (faster) poll for RP session state. We use 3 s here -
  // separate from the 5 s legacy port poll - so the badge tracks Start /
  // Stop clicks (in any sub-tab) with minimal lag.
  useEffect(() => {
    if (!defaultProfile) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${API}/remoteplay/quick-status?ip=${encodeURIComponent(defaultProfile.ip_address)}`).then(r => r.json());
        if (cancelled || !r?.success) return;
        if (r.active) {
          setRpSession({ state: 'live', sessionId: r.session_id || null, warmTtl: null, video: !!r.video });
        } else if (r.warm) {
          setRpSession({
            state: 'warm',
            sessionId: r.warm_session_id || null,
            warmTtl: Math.round(r.warm_ttl_remaining_s || 0),
            video: !!r.video,
          });
        } else {
          setRpSession({ state: 'idle', sessionId: null, warmTtl: null, video: false });
        }
      } catch (_) { /* transient sidecar - keep prior badge */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [defaultProfile?.ip_address]);

  const fetchStatus = async () => {
    if (!defaultProfile) return;
    try {
      const res = await fetch(`${API}/ps5/status/${defaultProfile.ip_address}`);
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setStatus({ status: 'unreachable', error: err.message });
    }
  };

  // Wake = full pre-warm flow:
  //   1) start a real Remote Play session (wake from rest + DDP LAUNCH +
  //      RP auth handshake + slot claim);
  //   2) immediately park the session in the sidecar warm cache.
  // Effect: the PS5 is genuinely ready (account is logged in, RP service
  // primed), and the next "Start session" in the Remote Play tab resumes
  // from warm cache in milliseconds. This replaces the old bare DDP WAKEUP
  // (which only got the console out of standby but left RP unreachable)
  // AND the previous quick-start variant (which left a live session
  // dangling that the user had to remember to stop).
  const handleWake = async () => {
    if (!defaultProfile) return;
    setWaking(true);
    try {
      const res = await fetch(`${API}/remoteplay/prewarm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: defaultProfile.id }),
      });
      const data = await res.json();
      if (data.success) {
        let msg;
        if (data.already_live) msg = 'Remote Play session is already live';
        else if (data.resumed) msg = `Pre-warmed (resumed from cache, ${data.warm_cache_ttl_s}s ready)`;
        else msg = `Pre-warmed (${data.warm_cache_ttl_s}s ready) — Start session will resume instantly`;
        showToast(msg, 'success');
        setTimeout(fetchStatus, 1500);
      } else {
        showToast('Wake failed: ' + (data.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      showToast('Wake error: ' + err.message, 'error');
    }
    setWaking(false);
  };

  // Put the PS5 into rest mode via the Remote Play sidecar. Uses an existing
  // live RP session when one exists, otherwise spins up a temporary session
  // just to send the standby control packet (see /api/remoteplay/standby).
  const handleStandby = async () => {
    if (!defaultProfile) return;
    if (!window.confirm(`Put ${defaultProfile.name} into rest mode?`)) return;
    setStandbyBusy(true);
    try {
      const res = await fetch(`${API}/remoteplay/standby`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: defaultProfile.id }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.already_standby) showToast('PS5 already in rest mode', 'info');
        else showToast(`Rest mode sent (${data.via || 'ok'})`, 'success');
        setTimeout(fetchStatus, 4000);
      } else {
        showToast('Rest mode failed: ' + (data.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      showToast('Rest mode error: ' + err.message, 'error');
    }
    setStandbyBusy(false);
  };

  const getStatusBadge = () => {
    if (!status) return <Badge variant="muted">Unknown</Badge>;
    if (!status.reachable) return <Badge variant="danger">Offline</Badge>;
    // Payload-listener mapping (the old badge mislabelled 9020 as "LUA"
    // - 9020 is actually PS4 GoldHEN, 9026 is the real Lua listener).
    //   9021 → PS5 ELF payload host
    //   9026 → PS5 Lua exploit chain
    //   9020 → PS4 GoldHEN payload host
    if (status.openPort === 9021) return <Badge variant="success">ELF Active</Badge>;
    if (status.openPort === 9026) return <Badge variant="success">LUA Active</Badge>;
    if (status.openPort === 9020) return <Badge variant="warning">PS4 Payload</Badge>;
    if (status.openPort === 8080 || status.openPort === 6970)
      return <Badge variant="info">Active</Badge>;
    return <Badge variant="info">Rest mode</Badge>;
  };

  // RP-session-specific badge. Decoupled from the legacy port status above
  // so we can render both side-by-side - they answer different questions:
  //   getStatusBadge   → "is a payload server listening?"
  //   getRpBadge       → "can I send a controller input / open MJPEG?"
  const getRpBadge = () => {
    const { state, warmTtl, video } = rpSession;
    if (state === 'live') {
      return <Badge variant="success" title={video ? 'Video MJPEG endpoint available.' : 'Input-only RP session.'}>
        RP live{video ? ' · video' : ''}
      </Badge>;
    }
    if (state === 'warm') {
      return <Badge variant="info" title="Sidecar warm cache - next Start session is instant (~20 ms).">
        RP warm · {warmTtl}s{video ? ' · video' : ''}
      </Badge>;
    }
    return <Badge variant="muted">RP idle</Badge>;
  };

  // Stop the current Remote Play session for the default profile. The exact
  // behaviour depends on which state we're in:
  //
  //   live → soft stop (no `all:true`). Sidecar parks the session in the
  //          warm cache so the next Start (anywhere in the app) is ~20 ms.
  //
  //   warm → hard stop (`all:true`). The user explicitly wants the warm
  //          cache gone, which means disconnecting from the PS5 entirely.
  //          That triggers the PS5's ~60 s post-disconnect session lock on
  //          our regist-key, so the next Start will have to wait it out -
  //          but the user opted into this by clicking Stop on a warm-only
  //          state. The toast message warns about it.
  //
  // Soft-stop on a warm-only state would be a no-op (sidecar's quick-stop
  // only touches Node's local SID cache when `all:false`), which is why we
  // route the warm path through stop-all here.
  const handleStopSession = async () => {
    if (!defaultProfile) return;
    if (rpSession.state === 'idle') return;
    setStoppingSession(true);
    const wasWarm = rpSession.state === 'warm';
    try {
      const res = await fetch(`${API}/remoteplay/quick-stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: defaultProfile.ip_address, all: wasWarm }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(wasWarm
          ? 'Warm cache cleared — next Start will wait ~60 s for the PS5 session lock'
          : 'Session soft-stopped — parked in warm cache for instant re-start', 'success');
        // Snap the badge so the user sees feedback before the 3 s poll
        // catches up.
        setRpSession((s) => wasWarm
          ? { state: 'idle', sessionId: null, warmTtl: null, video: false }
          : { ...s, state: 'warm' });
      } else {
        showToast('Stop failed: ' + (data.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      showToast('Stop error: ' + err.message, 'error');
    }
    setStoppingSession(false);
  };

  if (!defaultProfile) {
    return (
      <div className="comp-card">
        <div className="comp-card-body">
          <div className="empty-state">
            <div className="empty-state-icon">🎮</div>
            <div className="empty-state-title">No PS5 Profile</div>
            <div className="empty-state-text">Create a profile in Settings first</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {notification && (
        <div style={{
          position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)',
          padding: 'var(--space-sm) var(--space-lg)', borderRadius: 8,
          background: notification.type === 'error' ? 'var(--red)' : notification.type === 'success' ? 'var(--green)' : 'var(--blue)',
          color: 'var(--text)', zIndex: 3000, fontSize: '0.9rem', fontWeight: 500,
        }}>
          {notification.message}
        </div>
      )}

      {/* Status header. Wake + Standby live here on the right side so
          they're always visible without scrolling, matching the user's
          mental model of "PS5 power buttons are part of the PS5 status
          card". flex-wrap lets the action row drop below the identity
          block on narrow viewports. */}
      <div className="comp-card mb-md">
        <div className="flex items-center gap-md p-md flex-wrap">
          <span style={{ fontSize: '3rem' }}>🎮</span>
          <div className="flex-1" style={{ minWidth: 180 }}>
            <div className="flex items-center gap-sm flex-wrap">
              <span className="font-bold" style={{ fontSize: '1.2rem' }}>{defaultProfile.name}</span>
              {getStatusBadge()}
              {getRpBadge()}
            </div>
            <div className="text-muted">{defaultProfile.ip_address}</div>
            {status?.openPort && <div className="text-xs text-muted">Port: {status.openPort}</div>}
            {rpSession.sessionId && (
              <div className="text-xs text-muted font-mono">
                session {rpSession.sessionId.slice(0, 12)}
              </div>
            )}
          </div>
          {/* Action buttons. All use the default .btn size (34px tall)
              to match the sub-tab selector below - the user asked for
              every clickable element on this surface to share one
              consistent height. */}
          <div className="flex gap-sm flex-wrap" style={{ justifyContent: 'flex-end' }}>
            <button
              className="btn btn-primary"
              onClick={handleWake}
              disabled={waking || standbyBusy || stoppingSession}
              title={
                rpSession.state === 'live' ? 'A live RP session already exists - this is a no-op.'
                : rpSession.state === 'warm' ? 'Re-warm: refreshes the warm cache TTL back to 180 s.'
                : 'Pre-warm: wakes from rest, logs in, parks an RP session in the sidecar warm cache so the next Start is ~20 ms.'
              }
            >
              {waking ? '⏳ Waking…'
                : rpSession.state === 'live' ? '✓ Live'
                : rpSession.state === 'warm' ? `✓ Warm ${rpSession.warmTtl}s`
                : '📡 Wake PS5'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleStandby}
              disabled={standbyBusy || waking || stoppingSession}
              title="Put the PS5 into rest mode."
            >
              {standbyBusy ? '⏳' : '🌙'} Rest mode
            </button>
            <button
              className="btn btn-ghost"
              onClick={fetchStatus}
              title="Refresh PS5 status (DDP discover + RP session probe)"
            >
              🔄
            </button>
          </div>
        </div>
      </div>

      {/* Stop / Clear-warm only appears when there's something to stop -
          a full-width single button so it doesn't compete for attention
          with the always-visible Wake/Standby pair above. */}
      {rpSession.state !== 'idle' && (
        <div className="mb-md">
          <button
            className="btn btn-secondary"
            onClick={handleStopSession}
            disabled={stoppingSession || waking || standbyBusy}
            style={{ width: '100%' }}
            title={
              rpSession.state === 'live'
                ? 'Soft stop the live RP session - parks it in the warm cache for instant restart.'
                : 'Clear the warm cache for this PS5.'
            }
          >
            {stoppingSession ? '⏳' : '⏹'}{' '}
            {rpSession.state === 'live' ? 'Stop session' : 'Clear warm'}
          </button>
        </div>
      )}

      {/* Sub-tab selector. Two tabs only - more is overkill for this
          surface. Style mirrors RemotePlay.jsx's Pair sub-tabs so the
          two feel native to one another. */}
      <div
        className="flex gap-xs flex-wrap mb-md"
        role="tablist"
        aria-label="P5 Control sub-tabs"
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
          aria-selected={subTab === 'control'}
          className={`btn ${subTab === 'control' ? 'btn-primary' : 'btn-ghost'}`}
          style={{ flex: '1 1 200px' }}
          onClick={() => setSubTab('control')}
        >
          {subTab === 'control' ? '● ' : ''}🎮 Control
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'settings'}
          className={`btn ${subTab === 'settings' ? 'btn-primary' : 'btn-ghost'}`}
          style={{ flex: '1 1 200px' }}
          onClick={() => setSubTab('settings')}
        >
          {subTab === 'settings' ? '● ' : ''}⚙️ PS Remote Play Settings
        </button>
      </div>

      {/* Control sub-tab: Start session + live preview + controllers +
          fullscreen + Input Scripts. RemotePlay.view="main" hides the
          OAuth / Pair sections so they don't reappear here. */}
      {subTab === 'control' && (
        <>
          <div className="comp-card mb-md">
            <div className="comp-card-header">
              <span className="comp-card-title">🕹️ PS Remote Play</span>
            </div>
            <div className="comp-card-body">
              <RemotePlay
                profiles={profiles}
                onNotification={showToast}
                onProfilesChanged={onProfilesChanged}
                onScriptsChange={fetchScripts}
                view="main"
              />
            </div>
          </div>

          {/* Input Scripts wrapper. ScriptRunner already renders its own nested
              comp-cards (RP session bar, Built-in scripts, Saved scripts, etc.),
              so on mobile we collapse the outer body padding and hide the
              contextual hint to avoid double-padding the nested cards. The
              built-in scripts card itself uses .builtin-scripts-compact for
              additional mobile shrinking. */}
          <div className="comp-card mb-md ps5control-scripts-wrap">
            <div className="comp-card-header">
              <span className="comp-card-title">⌨️ Input Scripts</span>
            </div>
            <div className="comp-card-body">
              <p className="text-sm text-muted mb-sm desktop-only">
                Scripts play back via the Remote Play sidecar above. Pair the PS5 first.
              </p>
              <ScriptRunner
                ip={defaultProfile.ip_address}
                scripts={scripts}
                onScriptsChange={fetchScripts}
              />
            </div>
          </div>
        </>
      )}

      {/* Settings sub-tab: setup-only slice of RemotePlay - Sony OAuth
          link + PIN pairing + offline activation. ScriptRunner is
          intentionally NOT here; Input Scripts are a runtime concern
          and stay on the Control sub-tab. */}
      {subTab === 'settings' && (
        <div className="comp-card mb-md">
          <div className="comp-card-header">
            <span className="comp-card-title">⚙️ PS Remote Play Settings</span>
          </div>
          <div className="comp-card-body">
            <RemotePlay
              profiles={profiles}
              onNotification={showToast}
              onProfilesChanged={onProfilesChanged}
              onScriptsChange={fetchScripts}
              view="settings"
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default PS5Control;
