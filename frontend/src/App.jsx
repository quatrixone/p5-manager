import { useState, useEffect, useCallback } from 'react';
import PayloadList from './components/PayloadList';
import LogViewer from './components/LogViewer';
import AutoloadBuilder from './components/AutoloadBuilder';
import PS5Control from './components/PS5Control';
import Settings from './components/Settings';
import FileOps from './components/FileOps';
import { useMediaQuery } from './hooks/useSSE';
import './styles.css';

const API = '/api';

const tabs = [
  { id: 'payloads', label: 'Payloads', icon: '📦' },
  { id: 'autoload', label: 'Autoload', icon: '⚡' },
  { id: 'files', label: 'File Ops', icon: '📁' },
  { id: 'remote', label: 'PS5 Control', icon: '🎮' },
  { id: 'logs', label: 'Logs', icon: '📋' },
  { id: 'settings', label: 'Settings', icon: '⚙️' }
];

function App() {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [activeTab, setActiveTab] = useState(() => {
    const saved = localStorage.getItem('activeTab');
    // Dashboard and standalone remoteplay tabs were removed - migrate.
    if (!saved || saved === 'dashboard') return 'payloads';
    if (saved === 'remoteplay') return 'remote';
    return saved;
  });
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
    const profile = profiles[0];
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

  const createProfile = async (name, ip, mac, credential) => {
    try {
      await fetch(`${API}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ip_address: ip, mac_address: mac, credential })
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

  const updateProfile = async (id, name, ip, mac, credential) => {
    try {
      await fetch(`${API}/profiles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ip_address: ip, mac_address: mac, credential })
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

  const desktopTabs = (
    <nav className="top-tabs desktop-only">
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => setActiveTab(tab.id)}
        >
          {tab.icon} {tab.label}
        </button>
      ))}
    </nav>
  );

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
      <header style={{ background: 'var(--panel)', padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600, textAlign: 'center' }}>PS5WebPayload Manager</h1>
      </header>

      {notification && (
        <div style={{
          position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)', padding: '0.75rem 1.5rem', borderRadius: 8,
          background: notification.type === 'error' ? 'var(--red)' : notification.type === 'success' ? 'var(--green)' : 'var(--blue)',
          color: '#fff', zIndex: 1000, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', maxWidth: '90vw', textAlign: 'center'
        }}>
          {notification.message}
        </div>
      )}

      {isMobile ? mobileNav : desktopTabs}

      <main style={{ padding: '1rem', maxWidth: 1400, margin: '0 auto' }}>
        {activeTab === 'payloads' && (
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
        {activeTab === 'autoload' && (
          <AutoloadBuilder profiles={profiles} payloads={payloads} onNotification={showNotification} />
        )}
        {activeTab === 'remote' && <PS5Control profiles={profiles} onNotification={showNotification} />}
        {activeTab === 'files' && (
          <FileOps profiles={profiles} onNotification={showNotification} />
        )}
        {activeTab === 'settings' && (
          <Settings
            profiles={profiles}
            onProfileCreate={createProfile}
            onProfileUpdate={updateProfile}
            onProfileDelete={deleteProfile}
            onProfileSetDefault={setDefaultProfile}
            onLaunch={(titleId) => {
              const profile = profiles.find(p => p.is_default) || profiles[0];
              if (profile) {
                fetch(`${API}/ps5control/launch`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ip: profile.ip_address, titleId })
                }).then(() => showNotification(`Launched ${titleId}`, 'success'));
              }
            }}
            onWake={() => {
              const profile = profiles.find(p => p.is_default) || profiles[0];
              if (profile?.mac_address) {
                fetch(`${API}/ps5control/wol`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ mac: profile.mac_address, ip: profile.ip_address })
                }).then(() => showNotification('Wake on LAN sent', 'success'));
              }
            }}
          />
        )}
        {activeTab === 'logs' && (
          <LogViewer logs={logs} onRefresh={fetchLogs} profiles={profiles} />
        )}
      </main>
    </div>
  );
}

export default App;