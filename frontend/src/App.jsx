import { useState, useEffect, useCallback } from 'react';
import PayloadList from './components/PayloadList';
import LogViewer from './components/LogViewer';
import AutoloadBuilder from './components/AutoloadBuilder';
import PS5Control from './components/PS5Control';
import Settings from './components/Settings';
import FileOps from './components/FileOps';
import BuiltinEditor from './components/BuiltinEditor';
import './styles.css';

const API = '/api';

const tabs = [
  { id: 'payloads', label: 'Payloads', icon: '📦' },
  { id: 'autoload', label: 'Autoload', icon: '⚡' },
  { id: 'files', label: 'File Ops', icon: '📁' },
  { id: 'remote', label: 'P5 Control', icon: '🎮' },
  { id: 'logs', label: 'Logs', icon: '📋' },
  { id: 'settings', label: 'Settings', icon: '⚙️' }
];

// Hidden route: the built-in editor lives at #builtin. It is intentionally
// absent from `tabs` so it doesn't show up in the sidebar / bottom nav.
// Settings → Config has a discreet "Edit built-ins" link to discover it.
const BUILTIN_HASH = '#builtin';
const readHashRoute = () => (typeof window !== 'undefined' && window.location.hash === BUILTIN_HASH);

function App() {
  const [activeTab, setActiveTab] = useState(() => {
    const saved = localStorage.getItem('activeTab');
    // Dashboard and standalone remoteplay tabs were removed - migrate.
    if (!saved || saved === 'dashboard') return 'payloads';
    if (saved === 'remoteplay') return 'remote';
    return saved;
  });
  const [showBuiltinEditor, setShowBuiltinEditor] = useState(readHashRoute);

  // Sync state with hash changes (browser back/forward, manual edits).
  useEffect(() => {
    const onHash = () => setShowBuiltinEditor(readHashRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const closeBuiltinEditor = () => {
    if (window.location.hash === BUILTIN_HASH) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    setShowBuiltinEditor(false);
  };
  const [payloads, setPayloads] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [logs, setLogs] = useState([]);
  const [notification, setNotification] = useState(null);

  const showNotification = (message, type = 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  const fetchPayloads = useCallback(async () => {
    try {
      const res = await fetch(`${API}/payloads`);
      const data = await res.json();
      setPayloads(data);
    } catch (err) {
      console.error('Failed to fetch payloads:', err);
    }
  }, []);

  const fetchProfiles = useCallback(async () => {
    try {
      const res = await fetch(`${API}/profiles`);
      const data = await res.json();
      setProfiles(data);
    } catch (err) {
      console.error('Failed to fetch profiles:', err);
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`${API}/logs?limit=50`);
      const data = await res.json();
      setLogs(data);
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    }
  }, []);

  useEffect(() => {
    fetchPayloads();
    fetchProfiles();
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [fetchPayloads, fetchProfiles, fetchLogs]);

  useEffect(() => {
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);

  const fetchFromGitHub = async (repo, filePath) => {
    try {
      const res = await fetch(`${API}/payloads/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, path: filePath })
      });
      const data = await res.json();
      if (data.success) {
        showNotification(`Downloaded ${data.downloaded.length} payload(s)`, 'success');
        fetchPayloads();
        fetchLogs();
      } else {
        showNotification(data.error, 'error');
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const fetchFromGitHubUrl = async (url) => {
    try {
      const res = await fetch(`${API}/payloads/fetch-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (data.success) {
        showNotification(`Downloaded ${data.downloaded.length} payload(s)`, 'success');
        fetchPayloads();
        fetchLogs();
      } else {
        showNotification(data.error, 'error');
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const sendPayload = async (payloadId) => {
    // Always honour the user-chosen default profile; profiles[0] would send
    // to whichever PS5 happens to be first in the list (often a PS4 in mixed
    // households).
    const profile = profiles.find(p => p.is_default) || profiles[0];
    if (!profile) {
      showNotification('Please create a profile first', 'error');
      return;
    }
    try {
      const res = await fetch(`${API}/payloads/send/${payloadId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: profile.ip_address, port: profile.port })
      });
      const data = await res.json();
      if (data.success) {
        showNotification(`Payload sent to ${profile.name}`, 'success');
      } else {
        showNotification(data.error, 'error');
      }
      fetchLogs();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const deletePayload = async (id) => {
    try {
      await fetch(`${API}/payloads/${id}`, { method: 'DELETE' });
      showNotification('Payload deleted', 'success');
      fetchPayloads();
      fetchLogs();
          } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const updatePayload = async (id) => {
    try {
      const res = await fetch(`${API}/payloads/${id}/update`, { method: 'PUT' });
      const data = await res.json();
      if (data.success) {
        showNotification('Payload updated', 'success');
        fetchPayloads();
        fetchLogs();
              } else {
        showNotification(data.error || 'Update failed', 'warning');
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const restoreDefaultPayloads = async (force = false) => {
    try {
      const res = await fetch(`${API}/payloads/defaults/restore${force ? '?force=1' : ''}`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const a = data.added?.length || 0;
        const s = data.skipped?.length || 0;
        const f = data.failed?.length || 0;
        showNotification(`Defaults: +${a} added, ${s} kept${f ? `, ${f} failed` : ''}`, f ? 'warning' : 'success');
        fetchPayloads();
        fetchLogs();
      } else {
        showNotification(data.error || 'Restore failed', 'error');
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const uploadPayload = async (file) => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));

      const res = await fetch(`${API}/payloads/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, data: base64 })
      });
      const data = await res.json();
      if (data.success) {
        showNotification('Payload uploaded', 'success');
        fetchPayloads();
        fetchLogs();
              } else {
        showNotification(data.error, 'error');
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const createProfile = async (name, ip, mac) => {
    try {
      await fetch(`${API}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ip_address: ip, mac_address: mac })
      });
      showNotification('Profile created', 'success');
      fetchProfiles();
      fetchLogs();
      // If this is the first profile, set it as default
      if (profiles.length === 0) {
        const res = await fetch(`${API}/profiles`);
        const allProfiles = await res.json();
        if (allProfiles.length === 1) {
          await fetch(`${API}/profiles/${allProfiles[0].id}/set-default`, { method: 'POST' });
          fetchProfiles();
        }
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const updateProfile = async (id, name, ip, mac) => {
    try {
      await fetch(`${API}/profiles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ip_address: ip, mac_address: mac })
      });
      showNotification('Profile updated', 'success');
      fetchProfiles();
      fetchLogs();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const setDefaultProfile = async (id) => {
    try {
      await fetch(`${API}/profiles/${id}/set-default`, { method: 'POST' });
      showNotification('Default profile set', 'success');
      fetchProfiles();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const deleteProfile = async (id) => {
    try {
      await fetch(`${API}/profiles/${id}`, { method: 'DELETE' });
      showNotification('Profile deleted', 'success');
      fetchProfiles();
      fetchLogs();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const checkPs5Status = async (ip, port) => {
    try {
      const res = await fetch(`${API}/ps5/status/${ip}?port=${port || 9021}`);
      const data = await res.json();
      showNotification(data.reachable ? 'PS5 is reachable' : 'PS5 not reachable', data.reachable ? 'success' : 'warning');
      fetchLogs();
      return data.reachable;
    } catch (err) {
      showNotification(err.message, 'error');
      return false;
    }
  };

  const exportBackup = async () => {
    try {
      const res = await fetch(`${API}/backup`);
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ps5-backup-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showNotification('Backup exported', 'success');
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const importBackup = async (file) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await fetch(`${API}/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data })
      });
      showNotification('Backup imported', 'success');
      fetchProfiles();
      fetchPayloads();
      fetchLogs();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const defaultProfile = profiles.find(p => p.is_default) || profiles[0];
  const [defaultStatus, setDefaultStatus] = useState(null); // { reachable, openPort }

  // Lightweight status poll for the topbar status pill. Mirrors PS5Control's
  // own poll so the indicator always reflects the default console, no matter
  // which tab the user is on.
  useEffect(() => {
    if (!defaultProfile) {
      setDefaultStatus(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`${API}/ps5/status/${defaultProfile.ip_address}?port=${defaultProfile.port || 9021}`);
        const data = await res.json();
        if (!cancelled) setDefaultStatus(data);
      } catch (_) {
        if (!cancelled) setDefaultStatus({ reachable: false });
      }
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, [defaultProfile?.ip_address, defaultProfile?.port]);

  const statusDot = (() => {
    if (!defaultProfile) return 'offline';
    if (!defaultStatus) return 'offline';
    if (!defaultStatus.reachable) return 'offline';
    if (defaultStatus.openPort === 9021 || defaultStatus.openPort === 9020) return 'online';
    return 'standby';
  })();

  const sidebar = (
    <aside className="app-sidebar">
      <h6>Workspace</h6>
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={`nav-item ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => setActiveTab(tab.id)}
        >
          <span className="nav-item-icon">{tab.icon}</span>
          <span>{tab.label}</span>
        </button>
      ))}
    </aside>
  );

  const mobileNav = (
    <nav className="bottom-nav">
      <div className="bottom-nav-inner">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`bottom-nav-item ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="bottom-nav-icon">{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );

  return (
    <>
      <header className="app-topbar">
        <div className="app-brand">
          <span className="app-brand-mark">P5</span>
          <span>Manager</span>
        </div>

        {defaultProfile && (
          <div className="app-status" title={defaultProfile.name}>
            <span className={`dot ${statusDot}`} />
            <span className="truncate">{defaultProfile.name}</span>
            <span className="ip">{defaultProfile.ip_address}</span>
          </div>
        )}
      </header>

      {notification && (
        <div className={`app-toast ${notification.type || 'info'}`}>
          {notification.message}
        </div>
      )}

      <div className="app-shell">
        {sidebar}

        <main className="app-main">
          {showBuiltinEditor && (
            <BuiltinEditor onClose={closeBuiltinEditor} onNotification={showNotification} />
          )}
          {!showBuiltinEditor && activeTab === 'payloads' && (
            <PayloadList
              payloads={payloads}
              profiles={profiles}
              onFetchUrl={fetchFromGitHubUrl}
              onSend={sendPayload}
              onDelete={deletePayload}
              onUpdate={updatePayload}
              onUpload={uploadPayload}
              onRestoreDefaults={restoreDefaultPayloads}
            />
          )}
          {!showBuiltinEditor && activeTab === 'autoload' && (
            <AutoloadBuilder profiles={profiles} payloads={payloads} onNotification={showNotification} />
          )}
          {!showBuiltinEditor && activeTab === 'remote' && (
            <PS5Control profiles={profiles} onNotification={showNotification} onProfilesChanged={fetchProfiles} />
          )}
          {!showBuiltinEditor && activeTab === 'files' && (
            <FileOps profiles={profiles} onNotification={showNotification} />
          )}
          {!showBuiltinEditor && activeTab === 'settings' && (
            <Settings
              profiles={profiles}
              onProfileCreate={createProfile}
              onProfileUpdate={updateProfile}
              onProfileDelete={deleteProfile}
              onProfileSetDefault={setDefaultProfile}
            />
          )}
          {!showBuiltinEditor && activeTab === 'logs' && (
            <LogViewer logs={logs} onRefresh={fetchLogs} profiles={profiles} />
          )}
        </main>
      </div>

      {mobileNav}
    </>
  );
}

export default App;