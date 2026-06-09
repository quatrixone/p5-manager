import { useState, useEffect, useRef } from 'react';

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
  { cmd: 'text', desc: 'Type text on PS5 on-screen keyboard (e.g. text Revenge)' },
];

// Note: append "Nx" / "xN" / "*N" to any button line to repeat it N times.
//   e.g. `left 10x`  -> presses left 10 times
//   e.g. `cross 5x 120` -> 5 taps, each 120 ms long
//
// `text <string>` simulates typing on the PS5 software keyboard by walking
// the d-pad and tapping cross for each letter (a-z, space).

const OSK_KEY_COORDS = (() => {
  const map = {};
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) map[row[c]] = [c, r];
  });
  map[' '] = [3, 3];
  return map;
})();

function buildOskInputs(text) {
  const events = [];
  let curCol = 0, curRow = 0;
  for (let i = 0; i < 4; i++) events.push({ button: 'up' });
  for (let i = 0; i < 10; i++) events.push({ button: 'left' });
  events.push({ button: 'down' });
  for (const ch0 of String(text)) {
    const ch = ch0.toLowerCase();
    const coords = OSK_KEY_COORDS[ch];
    if (!coords) continue;
    const [tc, tr] = coords;
    const dr = tr - curRow;
    const dc = tc - curCol;
    if (dr > 0) for (let i = 0; i < dr; i++) events.push({ button: 'down' });
    else if (dr < 0) for (let i = 0; i < -dr; i++) events.push({ button: 'up' });
    if (dc > 0) for (let i = 0; i < dc; i++) events.push({ button: 'right' });
    else if (dc < 0) for (let i = 0; i < -dc; i++) events.push({ button: 'left' });
    events.push({ button: 'cross', commit: true });
    curCol = tc; curRow = tr;
  }
  return events;
}

function ScriptRunner({ ip, onSendInput, scripts, onScriptsChange }) {
  const [scriptName, setScriptName] = useState('');
  const [script, setScript] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [output, setOutput] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  // sessionState transitions:
  //   idle      → no RP session anywhere on the sidecar for this IP
  //   warm      → sidecar holds a paused session that can be resumed in O(ms)
  //   connecting → user clicked Start, handshake in progress
  //   connected  → live session ready, button events will flow immediately
  //   stopping   → user clicked Stop, waiting for sidecar to park the session
  //
  // `warm` is what the sidecar reports when /quick-stop was a soft-stop (the
  // default for the Stop button) or when /prewarm was used. From the user's
  // perspective the next Start click is basically free, so we surface this
  // explicitly instead of lumping it under idle.
  const [sessionState, setSessionState] = useState('idle');
  const [sessionId, setSessionId] = useState('');
  // Last warm-cache snapshot from /quick-status. Lets the badge show
  // "warm · 12s ago, 168s TTL" so it's obvious whether Start will be
  // instant (warm) or whether the user is about to pay the cold-start
  // cost (idle).
  const [warmInfo, setWarmInfo] = useState(null); // { ageS, ttlS } | null
  // PS5 power state (DDP). Lets us swap "Start session" for "PS5 offline"
  // when there's nothing on the other end - the input button still works
  // but at least the user knows why nothing's happening.
  const [ps5Online, setPs5Online] = useState(null); // true | false | null=unknown
  // Built-in scripts ship with the app (source: /frontend/builtin/inputScripts.js).
  // Fetched once on mount via /api/input-scripts/builtin; rendered above the
  // user-saved list in their own card so they can't be deleted/edited in place.
  const [builtinScripts, setBuiltinScripts] = useState([]);

  // Single combined "Scripts" card has two tabs: built-in (curated, read-only)
  // and saved (user-created in this DB). We default to built-in because most
  // first-time users have nothing saved yet — once a script is saved we don't
  // auto-switch (would steal focus while typing in the editor).
  const [scriptsTab, setScriptsTab] = useState('builtin');

  // Command reference is collapsed by default — most users insert commands by
  // typing or by forking a built-in. Toggle reveals the chip palette.
  const [showCommands, setShowCommands] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/input-scripts/builtin`)
      .then(r => r.ok ? r.json() : [])
      .then(list => { if (!cancelled && Array.isArray(list)) setBuiltinScripts(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  // Mirror the latest state into a ref so the polling closure always reads
  // the truth without re-creating the interval on every render.
  const sessionStateRef = useRef('idle');
  useEffect(() => { sessionStateRef.current = sessionState; }, [sessionState]);

  // Poll the cached RP session status for this IP every 4 s. Single source
  // of truth: the sidecar. If the sidecar says a session exists for this IP
  // (regardless of who opened it - this component, RemotePlay tab, Autoload,
  // etc.) we adopt it and show "connected". When the sidecar reports no
  // active session and we're not mid-transition we drop back to "idle"
  // (or "warm" if the sidecar still has the session in its PAUSED cache).
  useEffect(() => {
    if (!ip) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [r, statusRes] = await Promise.all([
          fetch(`${API}/remoteplay/quick-status?ip=${encodeURIComponent(ip)}`).then(r => r.json()),
          // Use the same unified endpoint the top-right header badge uses
          // (TCP port scan + pyremoteplay discover fallback). Earlier we
          // called /remoteplay/discover directly and matched on
          // `status === 'Standby'`, but the sidecar actually returns
          // "Server Standby" / status_code=null, so the input-script
          // badge wrongly displayed "PS5 offline" for any Standby console.
          // /api/ps5/status normalises all of that into a single
          // `reachable` boolean — one source of truth across the app.
          fetch(`${API}/ps5/status/${encodeURIComponent(ip)}`)
            .then(r => r.json()).catch(() => null),
        ]);
        if (cancelled) return;
        if (statusRes && typeof statusRes.reachable === 'boolean') {
          setPs5Online(statusRes.reachable);
        } else {
          setPs5Online(null);
        }
        const cur = sessionStateRef.current;
        if (r.success && r.active) {
          if (cur !== 'connected') setSessionState('connected');
          if (r.session_id) setSessionId(r.session_id);
          setWarmInfo(null);
          return;
        }
        if (r.success && r.warm) {
          setWarmInfo({
            ageS: Math.round(r.warm_age_s || 0),
            ttlS: Math.round(r.warm_ttl_remaining_s || 0),
          });
          if (cur === 'connecting' || cur === 'stopping') return;
          if (cur !== 'warm') setSessionState('warm');
          if (sessionId) setSessionId('');
          return;
        }
        setWarmInfo(null);
        // Inactive - only flip to idle when we're not actively starting or
        // stopping the session ourselves.
        if (cur === 'connecting' || cur === 'stopping') return;
        if (cur !== 'idle') setSessionState('idle');
        if (sessionId) setSessionId('');
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

  const parseRepeatToken = (tok) => {
    if (!tok) return null;
    const m = /^(?:x(\d+)|(\d+)x|\*(\d+))$/i.exec(tok);
    if (!m) return null;
    const n = parseInt(m[1] || m[2] || m[3], 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : null;
  };

  const parseLine = (line) => {
    line = line.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) return null;

    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'wait' || cmd === 'sleep') {
      const ms = parseInt(parts[1]) || 1000;
      return { cmd: 'wait', params: ms };
    }

    if (cmd === 'text' || cmd === 'type') {
      return { cmd: 'text', text: line.replace(/^\S+\s+/, '') };
    }

    if (AVAILABLE_COMMANDS.find(c => c.cmd === cmd)) {
      // Extract optional repeat token (10x / x10 / *10) and remaining
      // params (typically a duration in ms).
      let count = 1;
      const rest = [];
      for (let i = 1; i < parts.length; i++) {
        const rep = parseRepeatToken(parts[i]);
        if (rep != null) { count = rep; continue; }
        rest.push(parts[i]);
      }
      return { cmd, params: rest.join(' '), count };
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

      if (parsed.cmd === 'text') {
        addOutput(`⌨ Type "${parsed.text}"`, 'info');
        const inputs = buildOskInputs(parsed.text || '');
        for (const ev of inputs) {
          if (stopRequested) break;
          await sendCommand(ev.button);
          await new Promise(r => setTimeout(r, ev.commit ? 140 : 90));
        }
        continue;
      }

      const reps = Math.max(1, parsed.count || 1);
      if (reps > 1) addOutput(`↻ ${parsed.cmd} ×${reps}`, 'info');
      for (let r = 0; r < reps; r++) {
        if (stopRequested) break;
        const success = await sendCommand(parsed.cmd, parsed.params);
        if (!success) {
          addOutput(`Line ${lineNum}: Command failed, continuing...`, 'warning');
        }
        // Short pause so each press is registered separately by PS5 menus.
        if (reps > 1 && r < reps - 1) {
          await new Promise(resolve => setTimeout(resolve, 120));
        }
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

  // Fork a built-in into the editor as a new (unsaved) user copy. We strip
  // the editing id so saveScript() does a POST (new row), not a PUT (which
  // would 404 since builtin:* ids don't exist in the DB).
  const forkBuiltin = (b) => {
    setScriptName(`${b.name} (copy)`);
    setScript(b.script);
    setEditingId(null);
    addOutput(`Forked built-in: ${b.name} — edit & save to keep your changes`, 'info');
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

  // Variant drives the badge colour. `warm` is intentionally surfaced as
  // success-tinted (almost-ready) so users learn it's basically the same
  // as connected from a "will Start be instant?" perspective.
  const sessionVariant = sessionState === 'connected' ? 'success'
    : sessionState === 'warm' ? 'info'
    : sessionState === 'connecting' ? 'warning'
    : sessionState === 'stopping' ? 'warning' : 'muted';

  // One-line, human-friendly description of the session+console state.
  // Goes right after the dot so the user gets the full picture at a glance.
  const sessionLabel = (() => {
    if (sessionState === 'connected') return 'connected';
    if (sessionState === 'connecting') return 'connecting…';
    if (sessionState === 'stopping') return 'stopping…';
    if (sessionState === 'warm' && warmInfo) {
      return `warm cache · resume ready (age ${warmInfo.ageS}s, TTL ${warmInfo.ttlS}s)`;
    }
    if (sessionState === 'warm') return 'warm cache · resume ready';
    if (ps5Online === false) return 'idle · PS5 offline';
    if (ps5Online === null) return 'idle';
    return 'idle';
  })();

  const outputColor = (type) => type === 'error' ? 'var(--red)'
    : type === 'success' ? 'var(--accent)'
    : type === 'warning' ? 'var(--amber)' : 'var(--text-soft)';

  return (
    <div className="flex-col gap-md">
      {/* Remote Play session control */}
      <div className="comp-card">
        <div className="comp-card-body flex items-center gap-sm flex-wrap">
          <span className={`badge badge-${sessionVariant}`}>
            <span style={{
              width: 6, height: 6, borderRadius: 999,
              background: 'currentColor',
              boxShadow: sessionState === 'connected' ? '0 0 0 4px var(--accent-dim)' : 'none',
            }} />
            RP session · {sessionLabel}
          </span>
          {ps5Online === false && (
            <span className="badge badge-danger" title="DDP discover failed. The PS5 is off or out of network reach.">
              ● PS5 offline
            </span>
          )}
          {sessionId && (
            <span className="font-mono text-xs text-muted">{sessionId.slice(0, 12)}</span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-sm)' }}>
            {sessionState !== 'connected' ? (
              <button
                className="btn btn-success btn-sm"
                onClick={startSession}
                disabled={!ip || sessionState === 'connecting'}
                title={
                  sessionState === 'warm'
                    ? 'Resume from warm cache — should be ~instant.'
                    : ps5Online === false
                    ? 'PS5 appears offline — Start will try to wake it but may take a while.'
                    : 'Open a Remote Play session for input scripts.'
                }
              >
                {sessionState === 'connecting'
                  ? '⏳ Starting…'
                  : sessionState === 'warm'
                  ? '⚡ Resume session'
                  : '▶ Start session'}
              </button>
            ) : (
              <button
                className="btn btn-danger btn-sm"
                onClick={stopSession}
                disabled={sessionState === 'stopping'}
                title="Soft stop — session is parked in the sidecar warm cache so the next Start is instant."
              >
                ⏹ Stop session
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Combined Scripts card with two tabs:
            • Built-in — curated, read-only (source: /frontend/builtin/inputScripts.js)
            • Saved   — user-created entries from the local DB
          Tabs save vertical space on mobile (single header instead of two
          stacked cards) and group the related "pick something to run" actions.
          Compact mobile styling (badge/desc/hint hiding) inherited from
          .builtin-scripts-compact. */}
      <div className="comp-card builtin-scripts-compact">
        <div className="comp-card-header">
          <div className="tabs" style={{ flex: 1, marginRight: 8 }}>
            <button
              type="button"
              className={`tab-item ${scriptsTab === 'builtin' ? 'active' : ''}`}
              onClick={() => setScriptsTab('builtin')}
            >
              <span>🧩</span> Built-in
              <span className="badge badge-muted" style={{ marginLeft: 6 }}>{builtinScripts.length}</span>
            </button>
            <button
              type="button"
              className={`tab-item ${scriptsTab === 'saved' ? 'active' : ''}`}
              onClick={() => setScriptsTab('saved')}
            >
              <span>💾</span> Saved
              <span className="badge badge-muted" style={{ marginLeft: 6 }}>{scripts?.length || 0}</span>
            </button>
          </div>
          {scriptsTab === 'builtin' && (
            <span className="text-xs text-muted builtin-edit-hint">
              Edit in <code>frontend/builtin/inputScripts.js</code>
            </span>
          )}
        </div>
        <div className="comp-card-body">
          {scriptsTab === 'builtin' && (
            builtinScripts.length === 0 ? (
              <div className="text-sm text-muted">No built-in scripts available.</div>
            ) : (
              <div className="flex-col builtin-list" style={{ gap: 6, maxHeight: 260, overflowY: 'auto' }}>
                {builtinScripts.map(b => (
                  <div
                    key={b.id}
                    className="list-item"
                    style={{ marginBottom: 0 }}
                  >
                    <div
                      className="flex-1"
                      style={{ cursor: 'pointer', minWidth: 0 }}
                      onClick={() => forkBuiltin(b)}
                      title={b.description || b.name}
                    >
                      <div className="truncate builtin-name">
                        <span
                          className="badge badge-info builtin-badge"
                          style={{ marginRight: 8, fontSize: '0.65rem' }}
                        >BUILT-IN</span>
                        {b.name}
                      </div>
                      {b.description && (
                        <div className="text-muted truncate builtin-desc" style={{ marginTop: 2 }}>
                          {b.description}
                        </div>
                      )}
                    </div>
                    <div className="list-item-actions">
                      <button
                        className="btn btn-success btn-sm btn-icon"
                        onClick={() => runScript(b.script)}
                        disabled={isRunning}
                        title="Run"
                      >▶</button>
                      <button
                        className="btn btn-secondary btn-sm btn-icon"
                        onClick={() => forkBuiltin(b)}
                        disabled={isRunning}
                        title="Use as template (fork into editor)"
                      >📋</button>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {scriptsTab === 'saved' && (
            !scripts || scripts.length === 0 ? (
              <div className="text-sm text-muted">
                No saved scripts yet. Use the editor below to create one and press <b>💾 Save</b>.
              </div>
            ) : (
              <div className="flex-col" style={{ gap: 6, maxHeight: 260, overflowY: 'auto' }}>
                {scripts.map(s => (
                  <div
                    key={s.id}
                    className={`list-item ${editingId === s.id ? 'file-card-selected' : ''}`}
                    style={{ marginBottom: 0, padding: '10px 12px' }}
                  >
                    <span
                      className="flex-1 truncate"
                      style={{ cursor: 'pointer', fontSize: '0.9rem' }}
                      onClick={() => loadScript(s)}
                      title={s.name}
                    >
                      {s.name}
                    </span>
                    <div className="list-item-actions">
                      <button className="btn btn-success btn-sm btn-icon" onClick={() => runScript(s.script)} disabled={isRunning} title="Run">▶</button>
                      <button className="btn btn-secondary btn-sm btn-icon" onClick={() => loadScript(s)} disabled={isRunning} title="Edit">✏️</button>
                      <button className="btn btn-danger btn-sm btn-icon" onClick={() => deleteScript(s.id)} title="Delete">🗑</button>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>

      {/* Command Reference — collapsed by default; just a toggle link until
          the user clicks. Cuts a full card+chip-grid worth of vertical noise
          from the typical mobile viewport. */}
      <div className="comp-card">
        <div className="comp-card-header" style={{ alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowCommands(v => !v)}
            style={{ padding: '4px 8px', minHeight: 0 }}
            title={showCommands ? 'Hide commands reference' : 'Show commands reference'}
          >
            <span style={{ marginRight: 6 }}>{showCommands ? '▾' : '▸'}</span>
            🎛️ Available Commands
            <span className="badge badge-muted" style={{ marginLeft: 8 }}>{AVAILABLE_COMMANDS.length}</span>
          </button>
        </div>
        {showCommands && (
          <div className="comp-card-body">
            <div className="flex flex-wrap" style={{ gap: 6 }}>
              {AVAILABLE_COMMANDS.map(({ cmd, desc }) => (
                <button
                  key={cmd}
                  onClick={() => insertCommand(cmd)}
                  disabled={isRunning}
                  title={desc}
                  className="btn btn-secondary btn-sm font-mono"
                  style={{ minHeight: 32, padding: '4px 10px' }}
                >
                  {cmd}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted mt-sm">
              Append <code>10x</code>, <code>x10</code>, or <code>*10</code> to repeat. Use <code>text &lt;string&gt;</code> to type on the PS5 on-screen keyboard.
            </p>
          </div>
        )}
      </div>

      {/* Script Editor */}
      <div className="comp-card">
        <div className="comp-card-header">
          <span className="comp-card-title">
            <span>{editingId ? '✏️' : '＋'}</span>
            {editingId ? `Editing: ${scriptName}` : 'New Script'}
          </span>
          <div className="flex gap-sm">
            <button className="btn btn-ghost btn-sm" onClick={clearForm} disabled={isRunning}>Clear</button>
            <button
              className="btn btn-success btn-sm"
              onClick={saveScript}
              disabled={isRunning || !scriptName.trim() || !script.trim()}
            >
              💾 Save
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => runScript(script)}
              disabled={isRunning || !script.trim()}
            >
              {isRunning ? 'Running…' : '▶ Run'}
            </button>
            {isRunning && (
              <button className="btn btn-danger btn-sm" onClick={stopScript}>⏹ Stop</button>
            )}
          </div>
        </div>
        <div className="comp-card-body flex-col gap-sm">
          <input
            type="text"
            className="input"
            placeholder="Script name"
            value={scriptName}
            onChange={e => setScriptName(e.target.value)}
            disabled={isRunning}
          />
          <textarea
            className="input font-mono"
            value={script}
            onChange={e => setScript(e.target.value)}
            disabled={isRunning}
            spellCheck={false}
            placeholder={`// Enter commands, one per line:
//   left              tap once
//   left 120          hold for 120 ms
//   left 10x          tap 10 times (also: x10 or *10)
//   left 10x 120      10 taps, each 120 ms
//   wait 500          sleep 500 ms
//   text Revenge      type on PS5 on-screen keyboard (a-z + space)
left
wait 500
text revenge
cross 120
circle`}
            style={{ minHeight: 180, padding: 12, lineHeight: 1.55, resize: 'vertical' }}
          />
          <div className="text-xs text-muted">
            Use <code>//</code> for comments, <code>wait X</code> for a delay in milliseconds.
          </div>
        </div>
      </div>

      {/* Output Console */}
      <div className="comp-card">
        <div className="comp-card-header">
          <span className="comp-card-title">
            <span>›_</span> Output Console
          </span>
          <button className="btn btn-ghost btn-sm" onClick={clearOutput}>Clear</button>
        </div>
        <div
          className="font-mono"
          style={{
            minHeight: 120,
            maxHeight: 240,
            overflowY: 'auto',
            padding: 14,
            background: 'rgba(0,0,0,0.35)',
            borderTop: '1px solid var(--border)',
            fontSize: '0.78rem',
            lineHeight: 1.65,
          }}
        >
          {output.length === 0 ? (
            <span className="text-muted">Output will appear here…</span>
          ) : (
            output.map((o, i) => (
              <div key={i} style={{ color: outputColor(o.type) }}>
                <span style={{ color: 'var(--muted-2)', marginRight: 8 }}>[{o.time}]</span>
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