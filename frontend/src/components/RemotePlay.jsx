import { useEffect, useMemo, useRef, useState } from 'react';

const API = '/api/remoteplay';

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

function AnalogStick({ side, onChange }) {
  const wrapRef = useRef(null);
  const [active, setActive] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

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

  return (
    <div className="flex-col items-center gap-xs">
      <div className="text-xs text-muted">{side === 'left' ? 'Left stick' : 'Right stick'}</div>
      <div
        ref={wrapRef}
        onPointerDown={(e) => { setActive(true); e.target.setPointerCapture(e.pointerId); onPointer(e); }}
        onPointerMove={(e) => active && onPointer(e)}
        onPointerUp={() => { setActive(false); emit(0, 0); }}
        onPointerCancel={() => { setActive(false); emit(0, 0); }}
        style={{
          width: 130, height: 130, borderRadius: '50%',
          background: 'var(--panel2)', position: 'relative',
          border: '2px solid var(--border)', touchAction: 'none', userSelect: 'none',
        }}
      >
        <div style={{
          position: 'absolute',
          left: `calc(50% + ${pos.x * 45}px - 18px)`,
          top: `calc(50% + ${pos.y * 45}px - 18px)`,
          width: 36, height: 36, borderRadius: '50%',
          background: active ? 'var(--accent)' : 'var(--muted)',
          transition: active ? 'none' : 'all 0.15s',
        }} />
      </div>
    </div>
  );
}

export default function RemotePlay({ profiles, onNotification, onProfilesChanged }) {
  const [profileId, setProfileId] = useState('');
  const profile = useMemo(() => profiles.find(p => String(p.id) === String(profileId)) || null, [profiles, profileId]);

  const [health, setHealth] = useState(null);
  const [loginUrl, setLoginUrl] = useState('');
  const [redirectUrl, setRedirectUrl] = useState('');
  const [oauthBusy, setOauthBusy] = useState(false);

  const [pin, setPin] = useState('');
  const [pairBusy, setPairBusy] = useState(false);

  const [sessionId, setSessionId] = useState('');
  const [sessionState, setSessionState] = useState('idle'); // idle | connecting | connected | reconnecting
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [stickThrottle, setStickThrottle] = useState({ left: 0, right: 0 });
  // Ref mirrors so the polling effect always sees the latest values without
  // having to re-subscribe (which would reset the interval timer).
  const sessionStateRef = useRef('idle');
  const autoReconnectRef = useRef(true);
  const reconnectAttemptRef = useRef(0);
  const userStoppedRef = useRef(false);
  useEffect(() => { sessionStateRef.current = sessionState; }, [sessionState]);
  useEffect(() => { autoReconnectRef.current = autoReconnect; }, [autoReconnect]);
  useEffect(() => { reconnectAttemptRef.current = reconnectAttempt; }, [reconnectAttempt]);

  useEffect(() => {
    if (!profileId && profiles.length) {
      const def = profiles.find(p => p.is_default) || profiles[0];
      if (def) setProfileId(String(def.id));
    }
  }, [profiles, profileId]);

  useEffect(() => {
    fetch(`${API}/health`).then(r => r.json()).then(setHealth).catch(() => setHealth({ success: false, error: 'sidecar offline' }));
  }, []);

  const accountLinked = !!profile?.psn_account_id;
  const paired = !!profile?.rp_user_profile;
  const liveSession = sessionState === 'connected';

  // --- OAuth ----------------------------------------------------------------

  const startOAuth = async () => {
    setOauthBusy(true);
    try {
      const r = await fetch(`${API}/oauth/login-url`).then(r => r.json());
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
      const r = await fetch(`${API}/oauth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_url: redirectUrl.trim(), profile_id: profile.id }),
      }).then(r => r.json());
      if (!r.success) throw new Error(r.error);
      onNotification?.(`Linked PSN account: ${r.online_id || r.account_id}`, 'success');
      setRedirectUrl('');
      // Mutate local snapshot for immediate UI feedback, then ask the parent
      // to refetch profiles so the new field reaches the rest of the tree.
      profile.psn_account_id = r.account_id;
      profile.psn_online_id = r.online_id;
      onProfilesChanged?.();
    } catch (e) {
      onNotification?.(`OAuth exchange failed: ${e.message}`, 'error');
    } finally {
      setOauthBusy(false);
    }
  };

  // --- Pair -----------------------------------------------------------------

  const pair = async () => {
    if (!profile) return;
    if (pin.replace(/\D/g, '').length < 8) {
      onNotification?.('PIN must be 8 digits (shown on PS5 Settings → Remote Play → Link Device)', 'warning');
      return;
    }
    setPairBusy(true);
    try {
      const r = await fetch(`${API}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: profile.ip_address, pin: pin.replace(/\D/g, ''), profile_id: profile.id }),
      }).then(r => r.json());
      if (!r.success) throw new Error(r.error);
      onNotification?.('PS5 paired for Remote Play', 'success');
      setPin('');
      profile.rp_user_profile = JSON.stringify(r.profile);
      onProfilesChanged?.();
    } catch (e) {
      onNotification?.(`Pair failed: ${e.message}`, 'error');
    } finally {
      setPairBusy(false);
    }
  };

  const forgetPair = async () => {
    if (!profile) return;
    if (!confirm('Forget Remote Play credentials on this profile?')) return;
    try {
      await fetch(`${API}/forget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: profile.id }),
      });
      profile.rp_user_profile = null;
      onProfilesChanged?.();
      onNotification?.('Forgotten', 'success');
    } catch (e) {
      onNotification?.(e.message, 'error');
    }
  };

  // --- Session --------------------------------------------------------------

  const startSession = async ({ silent = false, reconnect = false } = {}) => {
    if (!profile) return false;
    userStoppedRef.current = false;
    setSessionState(reconnect ? 'reconnecting' : 'connecting');
    try {
      const r = await fetch(`${API}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: profile.ip_address, profile_id: profile.id }),
      }).then(r => r.json());
      if (!r.success) throw new Error(r.error);
      setSessionId(r.session_id);
      setSessionState('connected');
      setReconnectAttempt(0);
      if (!silent) onNotification?.(reconnect ? 'Remote Play session reconnected' : 'Remote Play session started', 'success');
      return true;
    } catch (e) {
      setSessionState('idle');
      if (!silent) onNotification?.(`${reconnect ? 'Reconnect' : 'Start'} failed: ${e.message}`, 'error');
      return false;
    }
  };

  const stopSession = async () => {
    // Always run a quick-stop on the IP - works even when sessionId is empty
    // (e.g. after a failed Start). Falls back to sessions/:id/stop if we do
    // have a fresh session_id.
    userStoppedRef.current = true;     // Signal the watchdog to NOT auto-reconnect
    setReconnectAttempt(0);
    try {
      if (sessionId) {
        await fetch(`${API}/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' });
      }
      if (profile?.ip_address) {
        await fetch(`${API}/quick-stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ip: profile.ip_address }),
        });
      }
      onNotification?.('Session stopped', 'info');
    } catch (_) {}
    setSessionId('');
    setSessionState('idle');
  };

  // Nuke every cached sidecar session for this IP. Used to recover from the
  // "Another Remote Play session is connected to host" loop that happens when
  // the PS5 keeps a half-open RP slot alive after an ungraceful disconnect.
  const wakePs5 = async () => {
    if (!profile?.ip_address) return;
    try {
      const r = await fetch(`${API}/wake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: profile.ip_address, profile_id: profile.id }),
      }).then(r => r.json());
      if (!r.success) throw new Error(r.error);
      onNotification?.(`Wakeup sent (${r.packets_sent || 0} packets)`, 'success');
    } catch (e) {
      onNotification?.(`Wake failed: ${e.message}`, 'error');
    }
  };

  const forceReset = async () => {
    if (!profile?.ip_address) return;
    if (!confirm('Force-reset will clear ALL Remote Play sessions for this PS5 on the sidecar. If the PS5 still refuses to connect afterwards, put it into Rest Mode and back on. Continue?')) return;
    userStoppedRef.current = true;
    setReconnectAttempt(0);
    try {
      const r = await fetch(`${API}/quick-stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: profile.ip_address, all: true }),
      }).then(r => r.json());
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

  // ─── Watchdog / auto-reconnect ────────────────────────────────────────────
  //
  // Once a session is connected we poll quick-status; if the sidecar reports
  // the cached session is gone (PS5 dropped it, network blip, sidecar
  // restart) and the user did NOT click Stop, we transition to "reconnecting"
  // and retry startSession() with exponential backoff up to 5 attempts.
  useEffect(() => {
    if (!profile?.ip_address) return undefined;
    let cancelled = false;
    let reconnectTimer = null;

    const tryReconnect = async () => {
      if (cancelled) return;
      const attempt = (reconnectAttemptRef.current || 0) + 1;
      setReconnectAttempt(attempt);
      if (attempt > 5) {
        setSessionState('idle');
        setReconnectAttempt(0);
        onNotification?.('Auto-reconnect gave up after 5 attempts - press Start to try again', 'warning');
        return;
      }
      // From attempt 2 onward, send wakeup packets before each connect try.
      // The most common reason for the reconnect to fail is that the PS5 is
      // still holding the previous (kicked) RP slot - extra wakeups encourage
      // it to release.
      if (attempt > 1) {
        try {
          await fetch(`${API}/wake`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: profile.ip_address, profile_id: profile.id }),
          });
        } catch (_) {}
      }
      const ok = await startSession({ silent: true, reconnect: true });
      if (ok || cancelled) return;
      // Exponential backoff: 3s, 6s, 12s, 24s, 48s (max ~93s total)
      const delayMs = Math.min(48_000, 3_000 * 2 ** (attempt - 1));
      reconnectTimer = setTimeout(tryReconnect, delayMs);
    };

    const tick = async () => {
      if (cancelled) return;
      const state = sessionStateRef.current;
      // Poll on every state except a reconnect in progress. That way we
      // detect sessions opened from Script Runner / Autoload / a previous
      // page load and "adopt" them - the live-session UI shows up no matter
      // who started it.
      if (state === 'reconnecting' || state === 'connecting') return;
      try {
        const r = await fetch(`${API}/quick-status?ip=${encodeURIComponent(profile.ip_address)}`).then(r => r.json());
        if (cancelled) return;
        if (!r.success) return;

        const sidecarSid = r.session_id || '';
        if (r.active) {
          // Session exists somewhere (we started it, or Script Runner /
          // Autoload did). Sync local state so the live-session UI shows up.
          if (sessionStateRef.current !== 'connected') {
            setSessionState('connected');
            setReconnectAttempt(0);
            userStoppedRef.current = false;
            if (state === 'idle') {
              onNotification?.('Adopted active Remote Play session', 'info');
            }
          }
          if (sidecarSid && sidecarSid !== sessionId) setSessionId(sidecarSid);
          return;
        }

        // r.active === false
        if (state !== 'connected') {
          // We weren't tracking a session and there's none - idle is correct.
          if (sessionId) setSessionId('');
          if (state !== 'idle') setSessionState('idle');
          return;
        }
        // We thought we were connected but the sidecar says nope.
        if (userStoppedRef.current || !autoReconnectRef.current) {
          setSessionId('');
          setSessionState('idle');
          return;
        }
        onNotification?.('Session lost - auto-reconnecting…', 'info');
        setSessionState('reconnecting');
        setReconnectAttempt(0);
        tryReconnect();
      } catch (_) { /* network hiccup - try again next tick */ }
    };

    // Fire once immediately so the UI reflects any in-progress session as
    // soon as the user opens the tab, then keep polling every 6 s.
    tick();
    const id = setInterval(tick, 6000);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.ip_address]);

  const sendInput = async (payload) => {
    if (!sessionId) return;
    try {
      await fetch(`${API}/sessions/${encodeURIComponent(sessionId)}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      onNotification?.(`Input dropped: ${e.message}`, 'warning');
    }
  };

  // Stick handler with rate-limit (~25 Hz) to avoid flooding.
  const onStick = (side) => ({ x, y }) => {
    const now = Date.now();
    if (now - (stickThrottle[side] || 0) < 40 && (x !== 0 || y !== 0)) return;
    setStickThrottle(prev => ({ ...prev, [side]: now }));
    sendInput({ stick: side, x, y: y, action: 'set' });
  };

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
      <Section
        title="🎮 Remote Play"
        status={health?.ok ? `sidecar OK${health.pyremoteplay === false ? ' (pyremoteplay missing!)' : ''}` : 'sidecar offline'}
      >
        <label className="text-sm text-muted" style={{ display: 'block' }}>Profile</label>
        <select className="select" value={profileId} onChange={e => setProfileId(e.target.value)}>
          {profiles.map(p => (
            <option key={p.id} value={p.id}>{p.name} ({p.ip_address})</option>
          ))}
        </select>
        {profile && (
          <div className="text-xs text-muted">
            PSN: {profile.psn_online_id || profile.psn_account_id || <em>not linked</em>}
            {' · '}
            RP: {paired ? <span style={{ color: 'var(--green)' }}>paired</span> : <em>not paired</em>}
          </div>
        )}
      </Section>

      <Section
        title={accountLinked ? '1 · PSN account ✓' : '1 · Link PSN account'}
        hint={accountLinked
          ? `Linked as ${profile?.psn_online_id || profile?.psn_account_id}. Re-link below if you switch PSN accounts.`
          : "Sony OAuth → opens in a new tab. Sign in, then when the page goes blank or to a 'redirect' URL, copy the FULL URL from the browser address bar and paste below."}
      >
        <button className="btn btn-primary" disabled={oauthBusy || !profile} onClick={startOAuth}>
          {oauthBusy ? '⏳ Opening…' : accountLinked ? '🔄 Re-link Sony account' : '🔗 Open Sony login'}
        </button>
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

      <Section
        title={paired ? '2 · Pair PS5 (PIN) ✓' : '2 · Pair PS5 (PIN)'}
        hint={
          !accountLinked
            ? 'Link your PSN account in step 1 first.'
            : paired
              ? 'Already paired. Enter a fresh 8-digit PIN here to re-pair, or click Forget to drop the saved credentials.'
              : 'On the PS5: Settings → System → Remote Play → Link Device. Type the 8-digit PIN shown there below.'
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
            disabled={!accountLinked || pairBusy || pin.replace(/\D/g, '').length < 8}
            onClick={pair}
          >
            {pairBusy ? '⏳ Pairing…' : paired ? '🔄 Re-pair' : '🤝 Pair'}
          </button>
          {paired && (
            <button className="btn btn-ghost" onClick={forgetPair}>🗑 Forget pairing</button>
          )}
        </div>
      </Section>

      <Section
        title={
          sessionState === 'reconnecting'
            ? `🔄 Reconnecting (attempt ${reconnectAttempt}/5)`
            : liveSession ? '🟢 Live session' : '3 · Start session'
        }
        status={paired ? sessionState : 'pair first'}
        hint={
          !paired
            ? 'Pair the PS5 in step 2 first.'
            : sessionState === 'reconnecting'
              ? 'Session was lost - retrying with exponential backoff. Press Stop to cancel.'
              : liveSession
                ? null
                : 'Start a control-only Remote Play session. PS5 will boot Remote Play but we ignore the video stream.'
        }
      >
        <div className="flex gap-sm flex-wrap">
          <button
            className="btn btn-primary"
            disabled={!paired || sessionState === 'connecting' || sessionState === 'reconnecting' || liveSession}
            onClick={() => startSession()}
          >
            {sessionState === 'connecting' ? '⏳ Starting…'
              : sessionState === 'reconnecting' ? '🔄 Reconnecting…'
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
            disabled={!paired}
            onClick={wakePs5}
            title="Sends wakeup packets to the PS5 (no session opened). Use to nudge the console when it holds a stale Remote Play slot after the session was kicked by a physical controller."
          >
            📡 Wake PS5
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
        <label className="flex items-center gap-xs text-sm text-muted" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoReconnect}
            onChange={(e) => setAutoReconnect(e.target.checked)}
          />
          Auto-reconnect on session loss (up to 5 attempts with backoff)
        </label>
      </Section>

      {liveSession && (
        <Section title="🎮 Controller">
          <div className="grid-2 gap-md" style={{ alignItems: 'center', justifyItems: 'center' }}>
            <AnalogStick side="left" onChange={onStick('left')} />
            <AnalogStick side="right" onChange={onStick('right')} />
          </div>
          <div className="flex gap-xs flex-wrap" style={{ marginTop: 'var(--space-md)' }}>
            {PS5_BUTTONS.map(b => (
              <button
                key={b.id}
                className="btn btn-sm"
                style={{
                  minWidth: 56, height: 48,
                  background: b.color || 'var(--panel2)',
                  color: b.color ? '#fff' : undefined,
                  fontWeight: 700,
                }}
                onPointerDown={(e) => { e.preventDefault(); sendInput({ button: b.id, action: 'press' }); }}
                onPointerUp={() => sendInput({ button: b.id, action: 'release' })}
                onPointerCancel={() => sendInput({ button: b.id, action: 'release' })}
                onPointerLeave={(e) => { if (e.buttons) sendInput({ button: b.id, action: 'release' }); }}
              >
                {b.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">Hold for repeat; release to lift. Sticks emit at ~25 Hz.</p>
        </Section>
      )}

      {health?.success === false && (
        <div className="text-xs text-muted">
          Sidecar error: {health.error}. Check the <code>chiaki</code> container logs.
        </div>
      )}
    </div>
  );
}
