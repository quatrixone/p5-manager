import { useState, useEffect, useRef } from 'react';
import Badge from './UI/Badge';

const API = '/api';

function LogViewer({ logs: systemLogs, onRefresh, profiles }) {
  const [activeTab, setActiveTab] = useState('system');
  const [luaLogs, setLuaLogs] = useState([]);
  const [luaServerStatus, setLuaServerStatus] = useState({ running: false, port: 8080 });
  const [kernelLogs, setKernelLogs] = useState([]);
  const [kernelServerStatus, setKernelServerStatus] = useState({ running: false, port: 3232, connected: false, ps5Ip: null });
  const [ps5Logs, setPs5Logs] = useState([]);
  const [port, setPort] = useState('8080');
  const [payloadsSent, setPayloadsSent] = useState({ lua: false, kernel: false });
  const [logFilter, setLogFilter] = useState('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const logContainerRef = useRef(null);

  const fetchLuaStatus = async () => {
    try {
      const res = await fetch(`${API}/logserver/status`);
      const data = await res.json();
      setLuaServerStatus(data);
      setLuaLogs(data.logs || []);
      updatePs5Logs(data.logs || [], 'lua');
    } catch (err) {
      console.error('Failed to fetch log server status:', err);
    }
  };

  const fetchKernelStatus = async () => {
    try {
      const res = await fetch(`${API}/kernellog/status`);
      const data = await res.json();
      setKernelServerStatus(data);
      setKernelLogs(data.logs || []);
      updatePs5Logs(data.logs || [], 'kernel');
    } catch (err) {
      console.error('Failed to fetch kernel log server status:', err);
    }
  };

  const updatePs5Logs = (newLogs, source) => {
    setPs5Logs(prev => {
      const otherLogs = prev.filter(l => l.source !== source);
      const formattedLogs = newLogs.map(l => ({ ...l, source }));
      return [...formattedLogs, ...otherLogs].slice(0, 500);
    });
  };

  useEffect(() => {
    fetchLuaStatus();
    fetchKernelStatus();
    const interval = setInterval(() => {
      fetchLuaStatus();
      fetchKernelStatus();
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [ps5Logs, autoScroll]);

  const getLevelColor = (level) => {
    switch (level) {
      case 'error': return 'var(--red)';
      case 'warning': return 'var(--warning)';
      case 'success': return 'var(--green)';
      default: return 'var(--blue)';
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
          setPayloadsSent(prev => ({ ...prev, lua: true }));
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

  // Kernel log flow (correct topology for ps5-payload-dev/klogsrv):
  //   1. Send klogsrv-ps5.elf to PS5:9021 via the managed payload so its
  //      /dev/klog → TCP listener spins up on PS5:3232.
  //   2. Wait a moment for the ELF to start.
  //   3. Connect to PS5:3232 from the manager as a TCP client. Lines stream
  //      back and the /kernellog/status poll picks them up for the UI.
  //
  // Previously this called /kernellog/start (manager TCP server) which never
  // received anything because klogsrv is the server, not the client - that's
  // why no output showed up after pressing Start.
  const handleConnectKernel = async () => {
    try {
      const profileIp = getProfileIp();
      if (!profileIp) {
        console.error('No PS5 profile selected');
        return;
      }

      // Locate the managed klogsrv-ps5.elf payload (auto-downloaded by the
      // backend on boot) and push it via the standard send endpoint.
      const payloadsRes = await fetch(`${API}/payloads`);
      const payloads = await payloadsRes.json();
      const klogPayload = payloads.find(p =>
        (p.name || '').toLowerCase().includes('klogsrv') ||
        (p.filename || '').toLowerCase().includes('klogsrv'),
      );
      if (!klogPayload) {
        throw new Error('klogsrv payload not found - check Payloads tab');
      }

      const sendRes = await fetch(`${API}/payloads/send/${klogPayload.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: profileIp }),
      });
      const sendData = await sendRes.json();
      if (!sendData.success) throw new Error(sendData.error || 'send failed');
      setPayloadsSent(prev => ({ ...prev, kernel: true }));

      // Backend /connect now retries up to 6× with 1.5 s backoff, so we don't
      // need a long pre-wait. A small pause avoids burning the first retry on
      // a guaranteed "klogsrv still binding" miss.
      await new Promise(r => setTimeout(r, 800));

      const connRes = await fetch(`${API}/kernellog/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: profileIp, port: 3232 }),
      });
      const connData = await connRes.json();
      if (!connData.success) throw new Error(connData.error || 'connect failed');
      fetchKernelStatus();
    } catch (err) {
      console.error('Failed to start kernel log:', err);
      // Reset payloadsSent so the user can retry Start. We don't alert when
      // the connection rejection is just a "still booting" race - the retry
      // logic on the backend already handles those.
      setPayloadsSent(prev => ({ ...prev, kernel: false }));
      alert(`Kernel log start failed: ${err.message}`);
    }
  };

  const handleDisconnectKernel = async () => {
    try {
      // Disconnect the TCP client to PS5:3232. We also stop the legacy local
      // server in case it was left running by an older session. Either call
      // succeeding is enough - we don't fail the UX if one returns an error.
      await fetch(`${API}/kernellog/disconnect`, { method: 'POST' }).catch(() => {});
      await fetch(`${API}/kernellog/stop`, { method: 'POST' }).catch(() => {});
    } catch (err) {
      console.error('Failed to stop kernel server:', err);
    } finally {
      // Always reset local state so the user can press Start again even when
      // the backend connect failed and the server thinks nothing is running.
      setPayloadsSent(prev => ({ ...prev, kernel: false }));
      fetchKernelStatus();
    }
  };

  const filteredSystemLogs = logFilter === 'all'
    ? systemLogs
    : systemLogs?.filter(log => log.level === logFilter) || [];

  const renderSystemLogs = () => (
    <div>
      <div className="flex justify-between items-center mb-md">
        <h2 className="font-bold" style={{ fontSize: '1.25rem' }}>System Logs</h2>
        <div className="flex gap-sm items-center">
          <div className="flex gap-xs">
            {['all', 'info', 'warning', 'error'].map(f => (
              <button
                key={f}
                onClick={() => setLogFilter(f)}
                className={`btn btn-sm ${logFilter === f ? 'btn-primary' : 'btn-ghost'}`}
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
              >
                {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <button className="btn btn-sm btn-secondary" onClick={onRefresh}>🔄 Refresh</button>
        </div>
      </div>

      {filteredSystemLogs.length === 0 ? (
        <div className="comp-card">
          <div className="comp-card-body">
            <div className="empty-state">
              <div className="empty-state-icon">📋</div>
              <div className="empty-state-title">No logs yet</div>
              <div className="empty-state-text">Activity will appear here</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="comp-card">
          <div style={{ maxHeight: 500, overflow: 'auto', fontFamily: 'monospace', fontSize: '0.8rem' }}>
            {filteredSystemLogs.map(log => (
              <div key={log.id} style={{
                padding: 'var(--space-sm) var(--space-md)',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                gap: 'var(--space-sm)',
                flexWrap: 'wrap'
              }}>
                <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap', fontSize: '0.7rem' }}>
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span style={{ color: getLevelColor(log.level), fontWeight: 600, textTransform: 'uppercase', minWidth: 50, fontSize: '0.7rem' }}>
                  {log.level}
                </span>
                <span style={{ wordBreak: 'break-word', flex: 1 }}>{log.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const renderPs5Logs = () => (
    <div>
      <h2 className="font-bold mb-md" style={{ fontSize: '1.25rem' }}>PS5 Logs</h2>

      <div className="flex gap-sm mb-md flex-wrap">
        <div className="comp-card flex-1">
          <div className="comp-card-body p-sm">
            <div className="flex items-center gap-sm">
              <span style={{ fontSize: '1.5rem' }}>🔥</span>
              <div className="flex-1">
                <div className="text-sm text-muted">LUA Server</div>
                <div className="font-bold">{luaServerStatus.running ? 'Running' : 'Stopped'}</div>
              </div>
              <Badge variant={luaServerStatus.running ? 'success' : 'muted'}>
                {luaServerStatus.running ? 'On' : 'Off'}
              </Badge>
            </div>
            <div className="flex gap-sm mt-sm">
              <button
                className="btn btn-sm btn-success"
                onClick={handleStartLuaServer}
                disabled={luaServerStatus.running || payloadsSent.lua}
              >
                {payloadsSent.lua ? '✓ Sent' : '▶ Start'}
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={handleStopLuaServer}
                disabled={!luaServerStatus.running}
              >
                ⏹ Stop
              </button>
            </div>
          </div>
        </div>

        <div className="comp-card flex-1">
          <div className="comp-card-body p-sm">
            <div className="flex items-center gap-sm">
              <span style={{ fontSize: '1.5rem' }}>⚡</span>
              <div className="flex-1">
                <div className="text-sm text-muted">Kernel Log</div>
                <div className="font-bold">{kernelServerStatus.running ? 'Running' : 'Stopped'}</div>
              </div>
              <Badge variant={kernelServerStatus.running ? 'success' : 'muted'}>
                {kernelServerStatus.running ? 'On' : 'Off'}
              </Badge>
            </div>
            <div className="flex gap-sm mt-sm">
              <button
                className="btn btn-sm btn-primary"
                onClick={handleConnectKernel}
                disabled={kernelServerStatus.running || payloadsSent.kernel}
              >
                {payloadsSent.kernel ? '✓ Sent' : '▶ Start'}
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={handleDisconnectKernel}
                disabled={!kernelServerStatus.running && !payloadsSent.kernel}
              >
                ⏹ Stop
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mb-sm">
        <span className="text-muted text-sm">Output ({ps5Logs.length} entries)</span>
        <label className="flex items-center gap-sm text-sm" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={e => setAutoScroll(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          Auto-scroll
        </label>
      </div>

      <div className="comp-card">
        <div
          ref={logContainerRef}
          style={{
            maxHeight: 400,
            overflow: 'auto',
            background: 'var(--bg)',
            borderRadius: 8,
            padding: 'var(--space-md)',
            fontFamily: 'monospace',
            fontSize: '0.8rem'
          }}
        >
          {ps5Logs.length === 0 ? (
            <div className="empty-state" style={{ padding: 'var(--space-lg)' }}>
              <div className="empty-state-icon">📡</div>
              <div className="empty-state-title">No PS5 logs yet</div>
              <div className="empty-state-text">Start LUA or Kernel log to see output</div>
            </div>
          ) : (
            ps5Logs.map((log, index) => (
              <div key={index} style={{ marginBottom: 'var(--space-sm)', paddingBottom: 'var(--space-sm)', borderBottom: '1px solid var(--panel2)' }}>
                <div className="flex items-center gap-sm">
                  <span style={{ color: 'var(--green)', fontSize: '0.7rem' }}>
                    [{log.timestamp?.split('T')[1]?.split('.')[0] || '00:00:00'}]
                  </span>
                  <Badge variant={log.source === 'kernel' ? 'danger' : 'info'}>{log.source?.toUpperCase()}</Badge>
                  <span className="text-xs text-muted">{log.ip}</span>
                </div>
                <div style={{ marginTop: '0.25rem', wordBreak: 'break-word' }}>{log.message}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <div className="tabs mb-md">
        <button className={`tab-item ${activeTab === 'system' ? 'active' : ''}`} onClick={() => setActiveTab('system')}>
          📋 System
        </button>
        <button className={`tab-item ${activeTab === 'ps5' ? 'active' : ''}`} onClick={() => setActiveTab('ps5')}>
          🎮 PS5
        </button>
      </div>

      {activeTab === 'system' && renderSystemLogs()}
      {activeTab === 'ps5' && renderPs5Logs()}
    </div>
  );
}

export default LogViewer;