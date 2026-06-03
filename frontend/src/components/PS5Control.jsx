import { useState, useEffect } from 'react';
import PairPS5 from './PairPS5';
import ScriptRunner from './ScriptRunner';
import RemotePlay from './RemotePlay';
import Badge from './UI/Badge';

const API = '/api';

function PS5Control({ profiles, onNotification }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [credential, setCredential] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [captureStatus, setCaptureStatus] = useState(null);
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

  useEffect(() => {
    if (defaultProfile) {
      fetchStatus();
      fetchCaptureStatus();
    }
  }, [defaultProfile]);

  useEffect(() => {
    if (!defaultProfile) return;
    const interval = setInterval(() => {
      fetchStatus();
    }, 5000);
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

  const fetchCaptureStatus = async () => {
    try {
      const res = await fetch(`${API}/ps5control/capture-status`);
      const data = await res.json();
      setCaptureStatus(data);
      if (data.credential && !capturing) setCredential(data.credential);
    } catch (err) {
      console.error('Failed to fetch capture status:', err);
    }
  };

  const handleWake = async () => {
    if (!defaultProfile) return;
    setLoading(true);
    try {
      const credToUse = defaultProfile.credential || credential;
      const res = await fetch(`${API}/ps5control/wake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: defaultProfile.ip_address, credential: credToUse })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Wake on LAN sent!', 'success');
        setTimeout(fetchStatus, 3000);
      } else {
        showToast('Wake failed: ' + (data.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      showToast('Wake error: ' + err.message, 'error');
    }
    setLoading(false);
  };

  const handleCaptureCredential = async () => {
    if (!defaultProfile) return;
    setCapturing(true);
    try {
      const res = await fetch(`${API}/ps5control/capture-credential`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: defaultProfile.ip_address })
      });
      const data = await res.json();
      setCapturing(false);
      if (data.success && data.credential) {
        setCredential(data.credential);
        showToast('Credential captured!', 'success');
      } else {
        showToast('Failed to capture: ' + (data.error || 'Unknown error'), 'error');
      }
    } catch (err) {
      setCapturing(false);
      showToast('Capture error: ' + err.message, 'error');
    }
  };

  const handleStopCapture = async () => {
    try {
      const res = await fetch(`${API}/ps5control/capture-stop`, { method: 'POST' });
      const data = await res.json();
      if (data.credential) {
        setCredential(data.credential);
        showToast('Credential saved!', 'success');
      } else {
        showToast('No credential captured', 'info');
      }
    } catch (err) {
      showToast('Stop error: ' + err.message, 'error');
    }
  };

  const handleSaveCredential = async () => {
    if (!defaultProfile || !captureStatus?.credential) return;
    try {
      await fetch(`${API}/profiles/${defaultProfile.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: defaultProfile.name,
          ip_address: defaultProfile.ip_address,
          mac_address: defaultProfile.mac_address,
          credential: captureStatus.credential
        })
      });
      showToast('Credential saved!', 'success');
    } catch (err) {
      showToast('Failed to save: ' + err.message, 'error');
    }
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
        <button className="btn btn-primary" onClick={handleWake} disabled={loading}>
          {loading ? '⏳' : '⏰'} Wake
        </button>
        <button className="btn btn-secondary" onClick={fetchStatus}>
          🔍 Check Status
        </button>
      </div>

      <div className="mb-md">
        <RemotePlay profiles={profiles} onNotification={showToast} />
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

      <button
        className="btn btn-ghost btn-block mb-md"
        onClick={() => setShowAdvanced(!showAdvanced)}
      >
        {showAdvanced ? '▲' : '▼'} Advanced (credential capture, legacy pair)
      </button>

      {showAdvanced && (
        <div className="flex-col gap-md">
          <div className="comp-card">
            <div className="comp-card-header">
              <span className="comp-card-title">🔑 Credential Capture</span>
            </div>
            <div className="comp-card-body">
              <p className="text-sm text-muted mb-md">
                Capture PS5 credential for Wake on LAN. Put PS5 in deep sleep first.
              </p>
              <div className="flex gap-sm flex-wrap">
                <button
                  className="btn btn-secondary"
                  onClick={handleCaptureCredential}
                  disabled={capturing || captureStatus?.active}
                >
                  {capturing || captureStatus?.active ? '⏳ Listening...' : '🎯 Capture'}
                </button>
                {(capturing || captureStatus?.active) && (
                  <button className="btn btn-danger" onClick={handleStopCapture}>⏹ Stop</button>
                )}
                {captureStatus?.credential && (
                  <button className="btn btn-success" onClick={handleSaveCredential}>💾 Save</button>
                )}
              </div>
              {captureStatus?.credential && (
                <div className="mt-sm text-xs text-muted">Saved: {captureStatus.credential}</div>
              )}
            </div>
          </div>

          <div className="comp-card">
            <div className="comp-card-header">
              <span className="comp-card-title">🔗 Legacy PIN pair</span>
            </div>
            <div className="comp-card-body">
              <p className="text-sm text-muted mb-sm">
                Native UDP PIN pairing (kept for compatibility). Prefer the Remote Play card above.
              </p>
              <PairPS5 ip={defaultProfile.ip_address} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PS5Control;