import { useState, useEffect, useCallback } from 'react';
import RemotePlay from './RemotePlay';
import useVisiblePolling from '../hooks/useVisiblePolling';
// BT Virtual DualShock 4 emulator (host-side BlueZ HID device) moved to
// a sibling repo (vcontrol). PS5 firmware rejects
// every non-Sony-signed controller during the post-pair HID handshake
// (BD_ADDR + Sony controller-auth chip required), so the feature is
// shelved indefinitely. The DS4-via-DietPi BT bridge was also removed
// because its output still flows through Remote Play's feedback
// channel, which shares the PS2 Classics input filter, making the
// extra Bluetooth machinery useless for the original problem. The
// planned replacement is a Pi Zero 2 W + Brook auth chip mounted in
// the PS5 USB port (see project docs); that path bypasses every
// filter because PS5 sees a wired Sony-signed HID gamepad.
import Badge from './UI/Badge';
import { api, apiSafe } from '../lib/api.js';
import { usePs5Status } from '../contexts/Ps5StatusContext';

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
  // Shared with the topbar and RemotePlay.jsx (see Ps5StatusContext.jsx) -
  // used to be its own 6 s /ps5/status poll here, a second one in the
  // topbar, and a third one inside RemotePlay.jsx, all disagreeing with
  // each other whenever the console was DDP-reachable but the payload
  // host wasn't loaded (e.g. right after Wake). One shared poll now.
  const ps5Status = usePs5Status();
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
  //   idle → nothing on the sidecar for this IP
  const [rpSession, setRpSession] = useState({ state: 'idle', sessionId: null, video: false });

  const defaultProfile = profiles.find(p => p.is_default) || profiles[0];
  const consoleLabel = defaultProfile?.console_type === 'ps4' ? 'PS4' : 'PS5';

  // An Autoload sequence that is steering this console right now. While it
  // runs the whole tab is locked: presses from here would land in the middle
  // of the sequence's own Remote Play inputs.
  const [autoloadRun, setAutoloadRun] = useState(null);
  useVisiblePolling(async () => {
    const runs = await apiSafe.get('/sequences/runs/recent');
    if (!Array.isArray(runs)) return;
    const active = runs.find(r => (r.status === 'running' || r.status === 'queued') && r.profile_id === defaultProfile?.id);
    setAutoloadRun(active || null);
  }, 3000, [defaultProfile?.id]);
  const cancelAutoloadRun = async () => {
    try {
      await api.post(`/sequences/runs/${autoloadRun.id}/cancel`);
      showToast('Sequence cancelled', 'info');
    } catch (e) { showToast(e.message, 'error'); }
  };

  const showToast = (message, type = 'info') => {
    if (onNotification) {
      onNotification(message, type);
      return;
    }
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  const fetchScripts = async () => {
    const data = await apiSafe.get('/input-scripts');
    if (Array.isArray(data)) setScripts(data);
  };

  useEffect(() => { fetchScripts(); }, []);

  // NOTE: `pollRpSession` is declared with `const`, so it MUST be defined
  // before any code that references it at render time (i.e. before the
  // useVisiblePolling call below). Putting useVisiblePolling above this
  // `const` declaration triggers a Temporal Dead Zone ReferenceError on
  // every render → blank PS5 Control tab.
  //
  // The old per-component `fetchStatus` (/ps5/status poll) lived here;
  // replaced by the shared ps5Status context (see its declaration above).

  // 4 s for the RP session state badge (was 3 s). Lower-priority signal
  // than the user actively pressing Start/Stop (those mutate the badge
  // optimistically), so an extra second of lag is invisible.
  const pollRpSession = useCallback(async () => {
    if (!defaultProfile) return;
    const r = await apiSafe.get(`/remoteplay/quick-status?ip=${encodeURIComponent(defaultProfile.ip_address)}`);
    if (!r?.success) return;
    if (r.active) {
      setRpSession({ state: 'live', sessionId: r.session_id || null, video: !!r.video });
    } else {
      setRpSession({ state: 'idle', sessionId: null, video: false });
    }
  }, [defaultProfile?.ip_address]);

  // 6 s for the legacy DDP / TCP port poll. Was 5 s; visibility-gated so a
  // backgrounded P5 Control tab stops sending the port probe entirely.
  useVisiblePolling(
    pollRpSession,
    defaultProfile ? 4000 : 0,
    [defaultProfile?.ip_address],
  );

  // Wake = the DDP WAKEUP and LAUNCH packets, nothing else. No Remote Play
  // session is opened, so none is left behind holding the console's RP slot.
  const handleWake = async () => {
    if (!defaultProfile) return;
    // Optimistic "waking" on the shared status - the topbar dot and this
    // tab's own badge both update immediately instead of the badge
    // sitting on "Offline" until the next poll catches up (or forever,
    // if the payload host never gets reloaded - that's expected after
    // standby, not a bug, but it shouldn't render as a hard error).
    ps5Status.markWaking();
    setWaking(true);
    try {
      const data = await api.post('/remoteplay/wake', { profile_id: defaultProfile.id });
      if (data.success) {
        showToast(`Wake sent to the ${consoleLabel}`, 'success');
        setTimeout(() => ps5Status.refresh(true), 1500);
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
      const data = await api.post('/remoteplay/standby', { profile_id: defaultProfile.id });
      if (data.success) {
        if (data.already_standby) showToast(`${consoleLabel} already in rest mode`, 'info');
        else showToast(`Rest mode sent (${data.via || 'ok'})`, 'success');
        setTimeout(() => ps5Status.refresh(true), 4000);
      } else {
        showToast('Rest mode failed: ' + (data.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      showToast('Rest mode error: ' + err.message, 'error');
    }
    setStandbyBusy(false);
  };

  const getStatusBadge = () => {
    switch (ps5Status.state) {
      case 'online': {
        if (!ps5Status.portStatus?.reachable && ps5Status.ddp?.success && /^ok$/i.test(ps5Status.ddp.status || '')) {
          return <Badge variant="success">Console online</Badge>;
        }
        // Payload-listener mapping (the old badge mislabelled 9020 as
        // "LUA" - 9020 is actually PS4 GoldHEN, 9026 is the real Lua
        // listener).
        //   9021 → PS5 ELF payload host
        //   9026 → PS5 Lua exploit chain
        //   9020 → PS4 GoldHEN payload host
        const port = ps5Status.portStatus?.openPort;
        if (port === 9021) return <Badge variant="success">ELF Active</Badge>;
        if (port === 9026) return <Badge variant="success">LUA Active</Badge>;
        if (port === 9020) return <Badge variant="warning">PS4 Payload</Badge>;
        return <Badge variant="info">Active</Badge>;
      }
      case 'waking':
        return <Badge variant="info">Waking…</Badge>;
      case 'standby':
        return <Badge variant="info">Rest mode</Badge>;
      case 'offline':
        return <Badge variant="danger">Offline</Badge>;
      default:
        return <Badge variant="muted">Unknown</Badge>;
    }
  };

  // RP-session-specific badge. Decoupled from the legacy port status above
  // so we can render both side-by-side - they answer different questions:
  //   getStatusBadge   → "is a payload server listening?"
  //   getRpBadge       → "can I send a controller input / open MJPEG?"
  const getRpBadge = () => {
    const { state, video } = rpSession;
    if (state === 'live') {
      return <Badge variant="success" title={video ? 'Video MJPEG endpoint available.' : 'Input-only RP session.'}>
        RP live{video ? ' · video' : ''}
      </Badge>;
    }
    return <Badge variant="muted">RP idle</Badge>;
  };

  // Stop ends the session for good (`all: true`), leaving nothing parked on
  // the sidecar. The console holds its ~60 s post-disconnect lock on our
  // regist key afterwards, so the next Start waits that out.
  const handleStopSession = async () => {
    if (!defaultProfile) return;
    if (rpSession.state === 'idle') return;
    setStoppingSession(true);
    try {
      const data = await api.post('/remoteplay/quick-stop', { ip: defaultProfile.ip_address, all: true });
      if (data.success) {
        showToast('Remote Play session stopped', 'success');
        // Snap the badge so the user sees feedback before the 4 s poll
        // catches up.
        setRpSession({ state: 'idle', sessionId: null, video: false });
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
            <div className="empty-state-title">No console selected</div>
            <div className="empty-state-text">Add a console in Settings → Your consoles to get started.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen screen-console-control">
      {notification && (
        <div className={`app-toast ${notification.type || 'info'}`} role="status" aria-live="polite">
          {notification.message}
        </div>
      )}

      {autoloadRun && (
        <div className="comp-card mb-md" role="status">
          <div className="comp-card-body flex gap-md items-center flex-wrap">
            <div className="flex-1" style={{ minWidth: 200 }}>
              <div className="font-medium">⏳ A sequence is running</div>
              <div className="text-sm text-muted" style={{ wordBreak: 'break-word' }}>
                {autoloadRun.sequence_name} · step {Math.min((autoloadRun.current_step || 0) + 1, autoloadRun.total)}/{autoloadRun.total}
                {autoloadRun.current_step_name ? `: ${autoloadRun.current_step_name}` : ''}
              </div>
              <div className="text-xs text-muted">Console controls will be available when it finishes.</div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={cancelAutoloadRun}>Stop sequence</button>
          </div>
        </div>
      )}

      <div className={autoloadRun ? 'ps5control-locked' : undefined} {...(autoloadRun ? { inert: '' } : {})}>

      {/* Status header. Wake + Standby live here on the right side so
          they're always visible without scrolling, matching the user's
          mental model of "PS5 power buttons are part of the PS5 status
          card". flex-wrap lets the action row drop below the identity
          block on narrow viewports. */}
      <div className="comp-card mb-md ps5control-status-card">
        <div className="flex items-center gap-md p-md flex-wrap ps5control-status-row">
          <span className="ps5control-console-icon" aria-hidden="true">🎮</span>
          <div className="flex-1 ps5control-identity">
            <div className="flex items-center gap-sm flex-wrap">
              <span className="font-bold" style={{ fontSize: '1.2rem' }}>{defaultProfile.name}</span>
              {getStatusBadge()}
              {getRpBadge()}
            </div>
            <div className="text-muted">{defaultProfile.ip_address}</div>
            {ps5Status.portStatus?.openPort && <div className="text-xs text-muted">Port: {ps5Status.portStatus.openPort}</div>}
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
          <div className="flex gap-sm flex-wrap ps5control-actions">
            <button
              className="btn btn-primary"
              onClick={handleWake}
              disabled={waking || standbyBusy || stoppingSession}
              title={
                rpSession.state === 'live' ? 'A Remote Play session is already active.'
                : 'Wake the console and prepare a Remote Play session for a faster start.'
              }
            >
              {waking ? '⏳ Waking…'
                : rpSession.state === 'live' ? '✓ Live'
                : '📡 Wake console'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleStandby}
              disabled={standbyBusy || waking || stoppingSession}
              title="Put the console into rest mode."
            >
              {standbyBusy ? '⏳' : '🌙'} Rest mode
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => { ps5Status.refresh(false); pollRpSession(); }}
              title="Refresh console status"
            >
              🔄
            </button>
          </div>
        </div>
      </div>

      {/* Only shown when there is a live session to stop, so it never
          competes for attention with the Wake/Standby pair above. */}
      {rpSession.state === 'live' && (
        <div className="mb-md">
          <button
            className="btn btn-secondary"
            onClick={() => handleStopSession()}
            disabled={stoppingSession || waking || standbyBusy}
            style={{ width: '100%' }}
            title="Stop the live Remote Play session."
          >
            {stoppingSession ? '⏳' : '⏹'} Stop session
          </button>
        </div>
      )}

      {/* Sub-tab selector. Two tabs only - more is overkill for this
          surface. Style mirrors RemotePlay.jsx's Pair sub-tabs so the
          two feel native to one another. */}
      <div
        className="flex gap-xs flex-wrap mb-md"
        data-ps5control-tabs
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
          Input Scripts (list/editor + step runner) + Payloads, all as tabs
          inside RemotePlay's Live Session card - see its sessionViewTab.
          RemotePlay.view="main" hides the OAuth / Pair sections so they
          don't reappear here. */}
      {subTab === 'control' && (
        <div className="comp-card mb-md ps5control-main-card">
          <div className="comp-card-header">
            <span className="comp-card-title">🕹️ PS Remote Play</span>
          </div>
          <div className="comp-card-body">
            <RemotePlay
              profiles={profiles}
              onNotification={showToast}
              onProfilesChanged={onProfilesChanged}
              onScriptsChange={fetchScripts}
              scripts={scripts}
              view="main"
            />
          </div>
        </div>
      )}

      {/* Settings sub-tab: setup-only slice of RemotePlay - Sony OAuth
          link + PIN pairing + offline activation. Input Scripts / Payloads
          are runtime concerns and stay on the Control sub-tab. */}
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
    </div>
  );
}

export default PS5Control;
