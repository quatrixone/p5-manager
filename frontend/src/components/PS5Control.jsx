import { useState, useEffect } from 'react';
import ScriptRunner from './ScriptRunner';
import RemotePlay from './RemotePlay';
import Badge from './UI/Badge';

const API = '/api';

function PS5Control({ profiles, onNotification, onProfilesChanged }) {
  const [status, setStatus] = useState(null);
  const [waking, setWaking] = useState(false);
  const [standbyBusy, setStandbyBusy] = useState(false);
  const [scripts, setScripts] = useState([]);
  const [notification, setNotification] = useState(null);

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

  // "Wake" now does the *full* start-session flow (quick-start), not just
  // the bare DDP WAKEUP packet. Sending a packet without opening an RP
  // session leaves the PS5 sitting on the "Press PS button" account picker
  // and the next Start session inevitably fights a half-cocked RP service
  // (60-90 s of "Connection refused"). quick-start handles the whole
  // wake → DDP LAUNCH → connect → ready sequence, transparently uses the
  // sidecar warm cache when available, and leaves us with a usable
  // session - which is what the user actually wants when they hit Wake.
  const handleWake = async () => {
    if (!defaultProfile) return;
    setWaking(true);
    try {
      const res = await fetch(`${API}/remoteplay/quick-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: defaultProfile.id }),
      });
      const data = await res.json();
      if (data.success) {
        const tag = data.resumed ? ' (resumed from cache)' : '';
        showToast(`Remote Play session started${tag}`, 'success');
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
    if (!window.confirm(`Put ${defaultProfile.name} into standby?`)) return;
    setStandbyBusy(true);
    try {
      const res = await fetch(`${API}/remoteplay/standby`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_id: defaultProfile.id }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.already_standby) showToast('PS5 already in standby', 'info');
        else showToast(`Standby sent (${data.via || 'ok'})`, 'success');
        setTimeout(fetchStatus, 4000);
      } else {
        showToast('Standby failed: ' + (data.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      showToast('Standby error: ' + err.message, 'error');
    }
    setStandbyBusy(false);
  };

  const getStatusBadge = () => {
    if (!status) return <Badge variant="muted">Unknown</Badge>;
    if (!status.reachable) return <Badge variant="danger">Offline</Badge>;
    if (status.openPort === 9021) return <Badge variant="success">ELF Active</Badge>;
    if (status.openPort === 9020) return <Badge variant="warning">LUA Active</Badge>;
    return <Badge variant="info">Standby</Badge>;
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

      <div className="comp-card mb-md">
        <div className="flex items-center gap-md p-md">
          <span style={{ fontSize: '3rem' }}>🎮</span>
          <div className="flex-1">
            <div className="flex items-center gap-sm">
              <span className="font-bold" style={{ fontSize: '1.2rem' }}>{defaultProfile.name}</span>
              {getStatusBadge()}
            </div>
            <div className="text-muted">{defaultProfile.ip_address}</div>
            {status?.openPort && <div className="text-xs text-muted">Port: {status.openPort}</div>}
          </div>
          <button className="btn btn-sm btn-ghost" onClick={fetchStatus}>🔄</button>
        </div>
      </div>

      <div className="grid-2 mb-md">
        <button className="btn btn-primary" onClick={handleWake} disabled={waking || standbyBusy}>
          {waking ? '⏳' : '📡'} Wake PS5
        </button>
        <button className="btn btn-secondary" onClick={handleStandby} disabled={standbyBusy || waking}>
          {standbyBusy ? '⏳' : '🌙'} Standby
        </button>
      </div>

      <div className="comp-card mb-md">
        <div className="comp-card-header">
          <span className="comp-card-title">🕹️ PS Remote Play</span>
        </div>
        <div className="comp-card-body">
          <RemotePlay profiles={profiles} onNotification={showToast} onProfilesChanged={onProfilesChanged} />
        </div>
      </div>

      <div className="comp-card mb-md">
        <div className="comp-card-header">
          <span className="comp-card-title">⌨️ Input Scripts</span>
        </div>
        <div className="comp-card-body">
          <p className="text-sm text-muted mb-sm">
            Scripts play back via the Remote Play sidecar above. Pair the PS5 first.
          </p>
          <ScriptRunner
            ip={defaultProfile.ip_address}
            scripts={scripts}
            onScriptsChange={fetchScripts}
          />
        </div>
      </div>
    </div>
  );
}

export default PS5Control;
