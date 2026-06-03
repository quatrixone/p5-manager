import { useState, useEffect } from 'react';

const API = '/api';

const AVAILABLE_COMMANDS = [
  { cmd: 'left', desc: 'D-pad left' },
  { cmd: 'right', desc: 'D-pad right' },
  { cmd: 'up', desc: 'D-pad up' },
  { cmd: 'down', desc: 'D-pad down' },
  { cmd: 'x', desc: 'X button' },
  { cmd: 'cross', desc: 'Cross button' },
  { cmd: 'circle', desc: 'Circle button' },
  { cmd: 'square', desc: 'Square button' },
  { cmd: 'triangle', desc: 'Triangle button' },
  { cmd: 'ps', desc: 'PS button' },
  { cmd: 'options', desc: 'Options button' },
  { cmd: 'touchpad', desc: 'Touchpad click' },
  { cmd: 'L1', desc: 'L1 trigger' },
  { cmd: 'R1', desc: 'R1 trigger' },
  { cmd: 'L2', desc: 'L2 trigger' },
  { cmd: 'R2', desc: 'R2 trigger' },
  { cmd: 'L3', desc: 'L3 stick press' },
  { cmd: 'R3', desc: 'R3 stick press' },
  { cmd: 'wait', desc: 'Wait X ms (e.g. wait 1000)' },
];

function ScriptRunner({ ip, onSendInput, scripts, onScriptsChange }) {
  const [scriptName, setScriptName] = useState('');
  const [script, setScript] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [output, setOutput] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [sessionState, setSessionState] = useState('idle'); // idle | connecting | connected | stopping
  const [sessionId, setSessionId] = useState('');

  // Poll the cached RP session status for this IP every 4s so users see when
  // a session is open (vs. starting on first input).
  useEffect(() => {
    if (!ip) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`${API}/remoteplay/quick-status?ip=${encodeURIComponent(ip)}`).then(r => r.json());
        if (cancelled) return;
        if (r.success && r.active) {
          setSessionState('connected');
          setSessionId(r.session_id || '');
        } else if (sessionState === 'connected' || sessionState === 'connecting') {
          // Don't clobber a "connecting" state we just initiated.
          if (sessionState !== 'connecting') setSessionState('idle');
        }
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ip]);

  const startSession = async () => {
    if (!ip) return;
    setSessionState('connecting');
    try {
      const r = await fetch(`${API}/remoteplay/quick-start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip }),
      }).then(r => r.json());
      if (!r.success) throw new Error(r.error);
      setSessionId(r.session_id || '');
      setSessionState('connected');
      addOutput(`▶ Session started (${r.session_id})`, 'success');
    } catch (e) {
      setSessionState('idle');
      addOutput(`Session start failed: ${e.message}`, 'error');
    }
  };

  const stopSession = async () => {
    if (!ip) return;
    setSessionState('stopping');
    try {
      await fetch(`${API}/remoteplay/quick-stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip }),
      });
      addOutput('⏹ Session stopped', 'info');
    } catch (e) {
      addOutput(`Session stop error: ${e.message}`, 'warning');
    }
    setSessionState('idle');
    setSessionId('');
  };

  const addOutput = (msg, type = 'info') => {
    setOutput(prev => [...prev, { msg, type, time: new Date().toLocaleTimeString() }]);
  };

  const sendCommand = async (cmd, params = '') => {
    if (!ip) {
      addOutput('No IP address', 'error');
      return false;
    }

    try {
      const res = await fetch(`${API}/ps5control/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, button: cmd, param: params })
      });
      const data = await res.json();
      if (data.success) {
        addOutput(`✓ ${cmd}${params ? ' ' + params : ''}`, 'success');
        return true;
      } else {
        addOutput(`✗ ${cmd} - ${data.error}`, 'error');
        return false;
      }
    } catch (err) {
      addOutput(`✗ ${cmd} - ${err.message}`, 'error');
      return false;
    }
  };

  const parseLine = (line) => {
    line = line.trim();
    if (!line || line.startsWith('//')) return null;

    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const params = parts.slice(1).join(' ');

    if (AVAILABLE_COMMANDS.find(c => c.cmd === cmd)) {
      return { cmd, params };
    }

    if (cmd === 'wait') {
      const ms = parseInt(params) || 1000;
      return { cmd: 'wait', params: ms };
    }

    return null;
  };

  const stopScript = () => {
    setStopRequested(true);
    addOutput('⏹ Stop requested...', 'warning');
  };

  const runScript = async (scriptToRun) => {
    if (!ip) {
      addOutput('No PS5 IP address configured', 'error');
      return;
    }

    setIsRunning(true);
    setStopRequested(false);
    setOutput([]);
    addOutput('▶ Starting script...', 'info');

    const lines = scriptToRun.split('\n');
    let lineNum = 0;

    for (const line of lines) {
      if (stopRequested) {
        addOutput('⏹ Script stopped by user', 'warning');
        break;
      }

      lineNum++;
      const parsed = parseLine(line);

      if (!parsed) {
        if (line.trim() && !line.trim().startsWith('//')) {
          addOutput(`Line ${lineNum}: Unknown command "${line.trim()}"`, 'error');
        }
        continue;
      }

      if (parsed.cmd === 'wait') {
        addOutput(`⏳ Wait ${parsed.params}ms...`, 'info');
        await new Promise(resolve => setTimeout(resolve, parsed.params));
        continue;
      }

      const success = await sendCommand(parsed.cmd, parsed.params);
      if (!success && parsed.cmd !== 'wait') {
        addOutput(`Line ${lineNum}: Command failed, continuing...`, 'warning');
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    setIsRunning(false);
    setStopRequested(false);
    addOutput('✅ Script complete', 'success');
  };

  const insertCommand = (cmd) => {
    setScript(prev => prev + (prev ? '\n' : '') + cmd);
  };

  const saveScript = async () => {
    if (!scriptName.trim() || !script.trim()) {
      addOutput('Name and script required', 'error');
      return;
    }

    try {
      const method = editingId ? 'PUT' : 'POST';
      const url = editingId ? `${API}/input-scripts/${editingId}` : `${API}/input-scripts`;
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: scriptName, script })
      });
      const data = await res.json();
      if (data.success) {
        addOutput(editingId ? 'Script updated' : 'Script saved', 'success');
        setScriptName('');
        setScript('');
        setEditingId(null);
        onScriptsChange();
      }
    } catch (err) {
      addOutput(err.message, 'error');
    }
  };

  const loadScript = (scriptToLoad) => {
    setScriptName(scriptToLoad.name);
    setScript(scriptToLoad.script);
    setEditingId(scriptToLoad.id);
    addOutput(`Loaded: ${scriptToLoad.name}`, 'info');
  };

  const deleteScript = async (id) => {
    if (!confirm('Delete this script?')) return;
    try {
      await fetch(`${API}/input-scripts/${id}`, { method: 'DELETE' });
      addOutput('Script deleted', 'success');
      onScriptsChange();
      if (editingId === id) {
        setScriptName('');
        setScript('');
        setEditingId(null);
      }
    } catch (err) {
      addOutput(err.message, 'error');
    }
  };

  const clearForm = () => {
    setScriptName('');
    setScript('');
    setEditingId(null);
  };

  const clearOutput = () => setOutput([]);

  const sessionColor = sessionState === 'connected' ? '#27ae60'
    : sessionState === 'connecting' ? '#f39c12'
    : sessionState === 'stopping' ? '#e67e22' : '#7f8c8d';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Remote Play session control */}
      <div style={{ background: '#16213e', padding: '0.75rem 1rem', borderRadius: 12, display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
          background: '#0f3460', borderRadius: 999, padding: '0.25rem 0.75rem', fontSize: '0.8rem',
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: sessionColor }} />
          RP session: <b style={{ color: sessionColor }}>{sessionState}</b>
          {sessionId && <span style={{ color: '#888', fontFamily: 'monospace', fontSize: '0.7rem' }}>{sessionId.slice(0, 8)}</span>}
        </span>
        {sessionState !== 'connected' ? (
          <button
            onClick={startSession}
            disabled={!ip || sessionState === 'connecting'}
            style={{ padding: '0.4rem 0.8rem', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.8rem' }}
          >
            {sessionState === 'connecting' ? '⏳ Starting…' : '▶ Start session'}
          </button>
        ) : (
          <button
            onClick={stopSession}
            disabled={sessionState === 'stopping'}
            style={{ padding: '0.4rem 0.8rem', background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.8rem' }}
          >
            ⏹ Stop session
          </button>
        )}
        <span style={{ color: '#888', fontSize: '0.75rem', flex: 1 }}>
          Optional — the first input will auto-open a session too, but starting it explicitly avoids the first-command delay.
        </span>
      </div>

      {/* Saved Scripts */}
      {scripts && scripts.length > 0 && (
        <div style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
          <h3 style={{ fontSize: '0.9rem', fontWeight: 500, marginBottom: '0.75rem', color: '#27ae60' }}>
            Saved Scripts ({scripts.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: 200, overflowY: 'auto' }}>
            {scripts.map(s => (
              <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', background: '#0f3460', borderRadius: 6 }}>
                <span style={{ flex: 1, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => loadScript(s)}>{s.name}</span>
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                  <button onClick={() => runScript(s.script)} disabled={isRunning} style={{ padding: '0.3rem 0.5rem', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.75rem' }}>▶</button>
                  <button onClick={() => loadScript(s)} disabled={isRunning} style={{ padding: '0.3rem 0.5rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.75rem' }}>✏️</button>
                  <button onClick={() => deleteScript(s.id)} style={{ padding: '0.3rem 0.5rem', background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.75rem' }}>🗑</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Command Reference */}
      <div style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 500, marginBottom: '0.75rem', color: '#27ae60' }}>
          Available Commands
        </h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {AVAILABLE_COMMANDS.map(({ cmd, desc }) => (
            <button
              key={cmd}
              onClick={() => insertCommand(cmd)}
              disabled={isRunning}
              title={desc}
              style={{
                padding: '0.4rem 0.6rem',
                background: isRunning ? '#333' : '#0f3460',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: isRunning ? 'not-allowed' : 'pointer',
                fontSize: '0.75rem',
                minHeight: 32
              }}
            >
              {cmd}
            </button>
          ))}
          <button
            onClick={() => insertCommand('wait ')}
            disabled={isRunning}
            title="Wait X ms"
            style={{
              padding: '0.4rem 0.6rem',
              background: isRunning ? '#333' : '#8e44ad',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: isRunning ? 'not-allowed' : 'pointer',
              fontSize: '0.75rem',
              minHeight: 32
            }}
          >
            wait X
          </button>
        </div>
      </div>

      {/* Script Editor */}
      <div style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={{ fontSize: '0.9rem', fontWeight: 500 }}>
            {editingId ? `Editing: ${scriptName}` : 'New Script'}
          </h3>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={clearForm}
              disabled={isRunning}
              style={{ padding: '0.4rem 0.75rem', background: '#666', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem' }}
            >
              Clear
            </button>
            <button
              onClick={saveScript}
              disabled={isRunning || !scriptName.trim() || !script.trim()}
              style={{ padding: '0.4rem 0.75rem', background: isRunning ? '#555' : '#27ae60', color: '#fff', border: 'none', borderRadius: 4, cursor: isRunning ? 'not-allowed' : 'pointer', fontSize: '0.8rem' }}
            >
              💾 Save
            </button>
            <button
              onClick={() => runScript(script)}
              disabled={isRunning || !script.trim()}
              style={{ padding: '0.4rem 0.75rem', background: isRunning ? '#555' : '#e94560', color: '#fff', border: 'none', borderRadius: 4, cursor: isRunning ? 'not-allowed' : 'pointer', fontSize: '0.8rem' }}
            >
              {isRunning ? 'Running...' : '▶ Run'}
            </button>
            {isRunning && (
              <button
                onClick={stopScript}
                style={{ padding: '0.4rem 0.75rem', background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem' }}
              >
                ⏹ Stop
              </button>
            )}
          </div>
        </div>
        <div style={{ marginBottom: '0.75rem' }}>
          <input
            type="text"
            placeholder="Script name"
            value={scriptName}
            onChange={e => setScriptName(e.target.value)}
            disabled={isRunning}
            style={{ width: '100%', padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '1rem', marginBottom: '0.5rem' }}
          />
        </div>
        <textarea
          value={script}
          onChange={e => setScript(e.target.value)}
          disabled={isRunning}
          placeholder={`// Enter commands, one per line:
// Example:
left
right
wait 500
x
cross
circle`}
          style={{
            width: '100%',
            minHeight: 150,
            padding: '0.75rem',
            borderRadius: 8,
            background: isRunning ? '#1a1a2e' : '#0a0a15',
            color: '#fff',
            border: '1px solid #0f3460',
            fontSize: '0.85rem',
            fontFamily: 'monospace',
            resize: 'vertical',
            lineHeight: 1.5
          }}
        />
        <div style={{ fontSize: '0.75rem', color: '#888', marginTop: '0.5rem' }}>
          Use <code style={{ background: '#0f3460', padding: '0.1rem 0.3rem', borderRadius: 3 }}>//</code> for comments, <code style={{ background: '#0f3460', padding: '0.1rem 0.3rem', borderRadius: 3 }}>wait X</code> for delay in milliseconds
        </div>
      </div>

      {/* Output Console */}
      <div style={{ background: '#0a0a15', padding: '1rem', borderRadius: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={{ fontSize: '0.9rem', fontWeight: 500 }}>Output Console</h3>
          <button
            onClick={clearOutput}
            style={{ padding: '0.3rem 0.6rem', background: '#333', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.75rem' }}
          >
            Clear
          </button>
        </div>
        <div style={{
          minHeight: 100,
          maxHeight: 200,
          overflowY: 'auto',
          fontFamily: 'monospace',
          fontSize: '0.8rem',
          lineHeight: 1.6,
          padding: '0.5rem',
          background: '#000',
          borderRadius: 6,
          border: '1px solid #333'
        }}>
          {output.length === 0 ? (
            <span style={{ color: '#555' }}>Output will appear here...</span>
          ) : (
            output.map((o, i) => (
              <div key={i} style={{ color: o.type === 'error' ? '#e74c3c' : o.type === 'success' ? '#27ae60' : o.type === 'warning' ? '#f39c12' : '#aaa' }}>
                <span style={{ color: '#555', marginRight: '0.5rem' }}>[{o.time}]</span>
                {o.msg}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default ScriptRunner;