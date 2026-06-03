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

export default function RemotePlay({ profiles, onNotification }) {
  const [profileId, setProfileId] = useState('');
  const profile = useMemo(() => profiles.find(p => String(p.id) === String(profileId)) || null, [profiles, profileId]);

  const [health, setHealth] = useState(null);
  const [loginUrl, setLoginUrl] = useState('');
  const [redirectUrl, setRedirectUrl] = useState('');
  const [oauthBusy, setOauthBusy] = useState(false);

  const [pin, setPin] = useState('');
  const [pairBusy, setPairBusy] = useState(false);

  const [sessionId, setSessionId] = useState('');
  const [sessionState, setSessionState] = useState('idle');
  const [stickThrottle, setStickThrottle] = useState({ left: 0, right: 0 });

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
      // Mutate local profile snapshot optimistically.
      profile.psn_account_id = r.account_id;
      profile.psn_online_id = r.online_id;
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
      onNotification?.('Forgotten', 'success');
    } catch (e) {
      onNotification?.(e.message, 'error');
    }
  };

  // --- Session --------------------------------------------------------------

  const startSession = async () => {
    if (!profile) return;
    setSessionState('connecting');
    try {
      const r = await fetch(`${API}/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: profile.ip_address, profile_id: profile.id }),
      }).then(r => r.json());
      if (!r.success) throw new Error(r.error);
      setSessionId(r.session_id);
      setSessionState('connected');
      onNotification?.('Remote Play session started', 'success');
    } catch (e) {
      setSessionState('idle');
      onNotification?.(`Start failed: ${e.message}`, 'error');
    }
  };

  const stopSession = async () => {
    if (!sessionId) return;
    try {
      await fetch(`${API}/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' });
    } catch (_) {}
    setSessionId('');
    setSessionState('idle');
  };

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

      {!accountLinked && (
        <Section
          title="1 · Link PSN account"
          hint="Sony OAuth → opens in a new tab. Sign in, then when the page goes blank or to a 'redirect' URL, copy the FULL URL from the browser address bar and paste below."
        >
          <button className="btn btn-primary" disabled={oauthBusy || !profile} onClick={startOAuth}>
            {oauthBusy ? '⏳ Opening…' : '🔗 Open Sony login'}
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
      )}

      {accountLinked && !paired && (
        <Section
          title="2 · Pair PS5 (PIN)"
          hint="On the PS5: Settings → System → Remote Play → Link Device. Type the 8-digit PIN below."
        >
          <input
            className="input"
            inputMode="numeric"
            maxLength={9}
            placeholder="12345678"
            value={pin}
            onChange={e => setPin(e.target.value)}
            style={{ fontSize: '1.5rem', letterSpacing: 4, textAlign: 'center' }}
          />
          <button className="btn btn-success" disabled={pairBusy || pin.replace(/\D/g, '').length < 8} onClick={pair}>
            {pairBusy ? '⏳ Pairing…' : '🤝 Pair'}
          </button>
        </Section>
      )}

      {paired && (
        <Section
          title={liveSession ? '🟢 Live session' : '3 · Start session'}
          status={sessionState}
          hint={liveSession ? null : 'Start a control-only Remote Play session. PS5 will boot Remote Play but we ignore the video stream.'}
        >
          <div className="flex gap-sm">
            {!liveSession ? (
              <button className="btn btn-primary" disabled={sessionState === 'connecting'} onClick={startSession}>
                ▶ Start
              </button>
            ) : (
              <button className="btn btn-danger" onClick={stopSession}>⏹ Stop</button>
            )}
            <button className="btn btn-ghost" onClick={forgetPair}>🗑 Forget pairing</button>
          </div>
        </Section>
      )}

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
