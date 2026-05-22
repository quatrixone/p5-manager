import { useState, useEffect, useCallback } from 'react';
import PayloadList from './components/PayloadList';
import ProfileManager from './components/ProfileManager';
import NetworkSender from './components/NetworkSender';
import LogViewer from './components/LogViewer';
import AutoloadBuilder from './components/AutoloadBuilder';
import LogServer from './components/LogServer';

const API = '/api';

function App() {
  const [activeTab, setActiveTab] = useState('payloads');
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
        showNotification(data.error, 'error');
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

  const createProfile = async (name, ip) => {
    try {
      await fetch(`${API}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ip_address: ip })
      });
      showNotification('Profile created', 'success');
      fetchProfiles();
      fetchLogs();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const updateProfile = async (id, name, ip) => {
    try {
      await fetch(`${API}/profiles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ip_address: ip })
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

  const tabs = [
    { id: 'payloads', label: 'Payloads' },
    { id: 'profiles', label: 'Profiles' },
    { id: 'autoload', label: 'Autoload' },
    { id: 'sender', label: 'Network Send' },
    { id: 'logserver', label: 'LUA log server' },
    { id: 'logs', label: 'Logs' }
  ];

  return (
    <div style={{ minHeight: '100vh', background: '#1a1a2e', color: '#eee' }}>
      <header style={{ background: '#16213e', padding: '1rem 2rem', borderBottom: '1px solid #0f3460' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>PS5WebPayload Manager</h1>
      </header>

      {notification && (
        <div style={{
          position: 'fixed', top: 20, right: 20, padding: '1rem 1.5rem', borderRadius: 8,
          background: notification.type === 'error' ? '#e74c3c' : notification.type === 'success' ? '#27ae60' : '#3498db',
          color: '#fff', zIndex: 1000, boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
        }}>
          {notification.message}
        </div>
      )}

      <nav style={{ display: 'flex', gap: '0.5rem', padding: '1rem 2rem', background: '#16213e', borderBottom: '1px solid #0f3460' }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '0.75rem 1.5rem', border: 'none', borderRadius: 6, cursor: 'pointer',
              background: activeTab === tab.id ? '#e94560' : '#0f3460', color: '#fff',
              fontWeight: 500, transition: 'background 0.2s'
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <main style={{ padding: '2rem', maxWidth: 1400, margin: '0 auto' }}>
        {activeTab === 'payloads' && (
          <PayloadList
            payloads={payloads}
            profiles={profiles}
            onFetchUrl={fetchFromGitHubUrl}
            onSend={sendPayload}
            onDelete={deletePayload}
            onUpdate={updatePayload}
            onUpload={uploadPayload}
          />
        )}
        {activeTab === 'profiles' && (
          <ProfileManager
            profiles={profiles}
            onCreate={createProfile}
            onUpdate={updateProfile}
            onDelete={deleteProfile}
            onSetDefault={setDefaultProfile}
          />
        )}
        {activeTab === 'autoload' && (
          <AutoloadBuilder
            profiles={profiles}
            payloads={payloads}
          />
        )}
        {activeTab === 'sender' && (
          <NetworkSender
            profiles={profiles}
            payloads={payloads}
            onSend={sendPayload}
            onCheckStatus={checkPs5Status}
          />
        )}
        {activeTab === 'logserver' && <LogServer profiles={profiles} />}
        {activeTab === 'logs' && (
          <LogViewer logs={logs} onRefresh={fetchLogs} />
        )}
      </main>
    </div>
  );
}

export default App;