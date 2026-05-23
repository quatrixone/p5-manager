import { useState, useEffect } from 'react';

const API = '/api';

function LogViewer({ logs: systemLogs, onRefresh, profiles }) {
  const [activeSection, setActiveSection] = useState('system');
  const [luaLogs, setLuaLogs] = useState([]);
  const [luaServerStatus, setLuaServerStatus] = useState({ running: false, port: 8080 });
  const [port, setPort] = useState('8080');

  const fetchLuaStatus = async () => {
    try {
      const res = await fetch(`${API}/logserver/status`);
      const data = await res.json();
      setLuaServerStatus(data);
      setLuaLogs(data.logs || []);
    } catch (err) {
      console.error('Failed to fetch log server status:', err);
    }
  };

  useEffect(() => {
    fetchLuaStatus();
    const interval = setInterval(fetchLuaStatus, 1000);
    return () => clearInterval(interval);
  }, []);

  const getLevelColor = (level) => {
    switch (level) {
      case 'error': return '#e74c3c';
      case 'warning': return '#f39c12';
      case 'success': return '#27ae60';
      default: return '#3498db';
    }
  };

  const getProfileIp = () => {
    if (!profiles || profiles.length === 0) return null;
    const defaultProfile = profiles.find(p => p.is_default) || profiles[0];
    return defaultProfile.ip_address;
  };

  const handleStartLuaServer = async () => {
    try {
      const res = await fetch(`${API}/logserver/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: parseInt(port) })
      });
      const data = await res.json();
      if (data.success) {
        fetchLuaStatus();
        const profileIp = getProfileIp();
        if (profileIp) {
          const setlogserverRes = await fetch('https://raw.githubusercontent.com/Gezine/Luac0re/main/payloads/setlogserver.lua');
          const setlogserverContent = await setlogserverRes.text();
          const serverIp = window.location.hostname || '127.0.0.1';
          const modifiedContent = setlogserverContent.replace(/LOG_SERVER = ".*?"/g, `LOG_SERVER = "${serverIp}"`);
          await fetch(`${API}/payloads/send-raw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: profileIp, port: 9026, name: 'setlogserver.lua', data: btoa(modifiedContent) })
          });
        }
      }
    } catch (err) {
      console.error('Failed to start log server:', err);
    }
  };

  const handleStopLuaServer = async () => {
    try {
      await fetch(`${API}/logserver/stop`, { method: 'POST' });
      fetchLuaStatus();
    } catch (err) {
      console.error('Failed to stop log server:', err);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          onClick={() => setActiveSection('system')}
          style={{
            padding: '0.5rem 1rem',
            background: activeSection === 'system' ? '#e94560' : '#0f3460',
            color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem'
          }}
        >
          System
        </button>
        <button
          onClick={() => setActiveSection('lua')}
          style={{
            padding: '0.5rem 1rem',
            background: activeSection === 'lua' ? '#e94560' : '#0f3460',
            color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem'
          }}
        >
          LUA Log
        </button>
      </div>

      {/* SYSTEM LOGS SECTION */}
      {activeSection === 'system' && (
        <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 500 }}>System Logs ({systemLogs?.length || 0})</h2>
            <button onClick={onRefresh} style={{ padding: '0.4rem 0.75rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', minHeight: 32 }}>
              Refresh
            </button>
          </div>

          {(systemLogs?.length || 0) === 0 ? (
            <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>No logs yet</p>
          ) : (
            <div style={{ fontFamily: 'monospace', fontSize: '0.8rem', maxHeight: 400, overflow: 'auto' }}>
              {systemLogs.map(log => (
                <div key={log.id} style={{
                  padding: '0.5rem',
                  borderBottom: '1px solid #0f3460',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.5rem'
                }}>
                  <span style={{ color: '#666', whiteSpace: 'nowrap', fontSize: '0.75rem' }}>
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span style={{ color: getLevelColor(log.level), fontWeight: 500, textTransform: 'uppercase', minWidth: 50, fontSize: '0.75rem' }}>
                    {log.level}
                  </span>
                  <span style={{ color: '#eee', wordBreak: 'break-word' }}>{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* LUA LOG SECTION */}
      {activeSection === 'lua' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* LUA Log Server Controls */}
          <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <h2 style={{ fontSize: '1rem', fontWeight: 500 }}>LUA Log Server</h2>
              <div style={{
                padding: '0.4rem 0.75rem',
                borderRadius: 6,
                background: luaServerStatus.running ? '#27ae60' : '#c0392b',
                color: '#fff',
                fontWeight: 500,
                fontSize: '0.85rem'
              }}>
                {luaServerStatus.running ? `Running on ${luaServerStatus.port}` : 'Stopped'}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="number"
                  value={port}
                  onChange={e => setPort(e.target.value)}
                  disabled={luaServerStatus.running}
                  style={{ padding: '0.75rem', borderRadius: 6, border: '1px solid #0f3460', background: '#1a1a2e', color: '#fff', fontSize: '1rem', width: 100 }}
                />
                {getProfileIp() && (
                  <div style={{ padding: '0.75rem', color: '#eee', fontSize: '0.9rem' }}>
                    PS5: {getProfileIp()}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={handleStartLuaServer}
                  disabled={luaServerStatus.running}
                  style={{
                    padding: '0.75rem',
                    background: luaServerStatus.running ? '#555' : '#27ae60',
                    color: '#fff', border: 'none', borderRadius: 6,
                    cursor: luaServerStatus.running ? 'not-allowed' : 'pointer',
                    fontWeight: 500, fontSize: '1rem', flex: 1, minHeight: 44
                  }}
                >
                  Start
                </button>
                <button
                  onClick={handleStopLuaServer}
                  disabled={!luaServerStatus.running}
                  style={{
                    padding: '0.75rem',
                    background: !luaServerStatus.running ? '#555' : '#c0392b',
                    color: '#fff', border: 'none', borderRadius: 6,
                    cursor: !luaServerStatus.running ? 'not-allowed' : 'pointer',
                    fontWeight: 500, fontSize: '1rem', flex: 1, minHeight: 44
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

          {/* LUA Log Output */}
          <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 style={{ fontSize: '1rem', fontWeight: 500 }}>LUA Output ({luaLogs.length})</h2>
              <button onClick={fetchLuaStatus} style={{ padding: '0.4rem 0.75rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', minHeight: 32 }}>
                Refresh
              </button>
            </div>

            {luaLogs.length === 0 ? (
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
                {luaLogs.map((log, index) => (
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
      )}
    </div>
  );
}

export default LogViewer;