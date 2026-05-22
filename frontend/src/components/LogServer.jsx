import { useState, useEffect } from 'react';

const API = '/api';

function LogServer({ profiles }) {
  const [status, setStatus] = useState({ running: false, port: 8080 });
  const [logs, setLogs] = useState([]);
  const [port, setPort] = useState('8080');

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API}/logserver/status`);
      const data = await res.json();
      setStatus(data);
      setLogs(data.logs || []);
    } catch (err) {
      console.error('Failed to fetch log server status:', err);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleStart = async () => {
    try {
      // Start log server first
      const res = await fetch(`${API}/logserver/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: parseInt(port) })
      });
      const data = await res.json();
      if (data.success) {
        fetchStatus();

        // Get PS5 IP from profile and send setlogserver.lua
        const profileIp = getProfileIp();
        if (profileIp) {
          // Fetch setlogserver.lua content from GitHub and send it
          const setlogserverRes = await fetch('https://raw.githubusercontent.com/Gezine/Luac0re/main/payloads/setlogserver.lua');
          const setlogserverContent = await setlogserverRes.text();

          // Replace LOG_SERVER IP with actual PS5 IP (server IP for receiving logs)
          const serverIp = window.location.hostname || '127.0.0.1';
          const modifiedContent = setlogserverContent.replace(/LOG_SERVER = ".*?"/g, `LOG_SERVER = "${serverIp}"`);

          // Send to PS5
          await fetch(`${API}/payloads/send-raw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ip: profileIp,
              port: 9026,
              name: 'setlogserver.lua',
              data: btoa(modifiedContent)
            })
          });
        }
      }
    } catch (err) {
      console.error('Failed to start log server:', err);
    }
  };

  const handleStop = async () => {
    try {
      await fetch(`${API}/logserver/stop`, { method: 'POST' });
      fetchStatus();
    } catch (err) {
      console.error('Failed to stop log server:', err);
    }
  };

  const getProfileIp = () => {
    if (!profiles || profiles.length === 0) return null;
    const defaultProfile = profiles.find(p => p.is_default) || profiles[0];
    return defaultProfile.ip_address;
  };

  const getProfileName = () => {
    if (!profiles || profiles.length === 0) return null;
    const defaultProfile = profiles.find(p => p.is_default) || profiles[0];
    return defaultProfile.name;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 500 }}>PS5 Log Server</h2>
          <div style={{
            padding: '0.4rem 0.75rem',
            borderRadius: 6,
            background: status.running ? '#27ae60' : '#c0392b',
            color: '#fff',
            fontWeight: 500,
            fontSize: '0.85rem'
          }}>
            {status.running ? `Running on ${status.port}` : 'Stopped'}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="number"
              value={port}
              onChange={e => setPort(e.target.value)}
              style={{ padding: '0.75rem', borderRadius: 6, border: '1px solid #0f3460', background: '#1a1a2e', color: '#fff', fontSize: '1rem', width: 100 }}
            />
            {profiles && profiles.length > 0 && (
              <div style={{ padding: '0.75rem', color: '#eee', fontSize: '0.9rem' }}>
                PS5: {getProfileIp()}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={handleStart}
              disabled={status.running}
              style={{
                padding: '0.75rem',
                background: status.running ? '#555' : '#27ae60',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                cursor: status.running ? 'not-allowed' : 'pointer',
                fontWeight: 500,
                fontSize: '1rem',
                flex: 1,
                minHeight: 44
              }}
            >
              Start
            </button>
            <button
              onClick={handleStop}
              disabled={!status.running}
              style={{
                padding: '0.75rem',
                background: !status.running ? '#555' : '#c0392b',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                cursor: !status.running ? 'not-allowed' : 'pointer',
                fontWeight: 500,
                fontSize: '1rem',
                flex: 1,
                minHeight: 44
              }}
            >
              Stop
            </button>
          </div>
        </div>

        <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: '#888' }}>
          Set your PS5 log server to: <code style={{ color: '#27ae60' }}>{getProfileIp() || 'PS5_IP'}:{port}</code>
        </p>
      </section>

      <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 500 }}>Output</h2>
          <button
            onClick={fetchStatus}
            style={{ padding: '0.4rem 0.75rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', minHeight: 32 }}
          >
            Refresh
          </button>
        </div>

        {logs.length === 0 ? (
          <p style={{ color: '#888', textAlign: 'center', padding: '1.5rem', fontSize: '0.9rem' }}>No logs yet</p>
        ) : (
          <div style={{
            maxHeight: 300,
            overflow: 'auto',
            background: '#0f3460',
            borderRadius: 8,
            padding: '0.75rem',
            fontFamily: 'monospace',
            fontSize: '0.8rem',
            color: '#eee'
          }}>
            {logs.map((log, index) => (
              <div key={index} style={{ marginBottom: '0.5rem', paddingBottom: '0.5rem', borderBottom: '1px solid #16213e' }}>
                <span style={{ color: '#27ae60' }}>[{log.timestamp?.split('T')[1]?.split('.')[0] || '00:00:00'}]</span>
                <span style={{ color: '#888', marginLeft: '0.5rem' }}>from {log.ip}</span>
                <div style={{ marginTop: '0.25rem', color: '#fff', wordBreak: 'break-word' }}>{log.message}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default LogServer;