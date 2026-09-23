import { useState, useEffect } from 'react';
import Modal from './UI/Modal';
import { api, apiSafe } from '../lib/api.js';
import { AVAILABLE_COMMANDS, buildOskInputs, parseLine } from '../lib/inputScriptDsl.js';

// Script list + editor, embedded inside RemotePlay's "Input Scripts" tab.
// Deliberately has NO session of its own - it used to run its own
// Start/Stop + a 4 s /quick-status poll, which just duplicated whatever
// RemotePlay's Live Session card already tracked for the exact same IP
// (same sidecar session underneath, ensureSessionForIp() is keyed by IP).
// The caller (RemotePlay) passes down the live session + a `sendCommand`
// that goes through the RP session's own input channel, so "▶ Run" here
// and the step-by-step "👣 Step" mode both ultimately press buttons the
// same way as the on-screen touch controller.
function ScriptRunner({ ip, liveSession, onStartSession, sendCommand, scripts, onScriptsChange, onRequestStep }) {
  const [output, setOutput] = useState([]);
  const [manualBusy, setManualBusy] = useState(null); // cmd currently in flight, or null
  const [isRunning, setIsRunning] = useState(null); // holds the id/key of the script currently running, or null
  const [stopRequested, setStopRequested] = useState(false);
  // Built-in scripts ship with the app (source: /frontend/builtin/inputScripts.json).
  // Fetched once on mount via /api/input-scripts/builtin; rendered above the
  // user-saved list in their own card. Editable in place via the edit modal
  // below (PUT /input-scripts/builtin/:id rewrites the source file).
  const [builtinScripts, setBuiltinScripts] = useState([]);

  // Single combined "Scripts" card has two tabs: built-in (curated) and
  // saved (user-created in this DB). We default to built-in because most
  // first-time users have nothing saved yet.
  const [scriptsTab, setScriptsTab] = useState('builtin');

  // Editing happens in a modal instead of a permanently-visible editor
  // card, so the list stays the focus and there's no dangling "New
  // Script" form taking up space when nobody's writing one.
  //   kind: 'saved' | 'builtin'
  //   id:   numeric input_scripts id (saved) or 'builtin:xxx' (builtin) — null when creating new
  //   isNew: true for the create-a-saved-script flow (Save always POSTs)
  const [editModal, setEditModal] = useState(null);
  const [savingModal, setSavingModal] = useState(false);
  const [modalError, setModalError] = useState('');

  const fetchBuiltinScripts = () => {
    apiSafe.get('/input-scripts/builtin').then(list => {
      if (Array.isArray(list)) setBuiltinScripts(list);
    });
  };

  useEffect(() => {
    fetchBuiltinScripts();
  }, []);

  const addOutput = (msg, type = 'info') => {
    setOutput(prev => [...prev, { msg, type, time: new Date().toLocaleTimeString() }]);
  };

  const runCommand = async (cmd, params = '') => {
    if (!liveSession) {
      addOutput('No live Remote Play session - hit Start session above first', 'error');
      return false;
    }
    try {
      await sendCommand(cmd, params);
      addOutput(`✓ ${cmd}${params ? ' ' + params : ''}`, 'success');
      return true;
    } catch (err) {
      addOutput(`✗ ${cmd} - ${err.message}`, 'error');
      return false;
    }
  };

  // Manual controls: a single tap, auto-starting a (video) session first
  // if nothing's live yet, unlike runCommand() (used by ▶ Run / 👣 Step,
  // which assume the caller already ensured a session).
  const manualPress = async (cmd) => {
    setManualBusy(cmd);
    try {
      if (!liveSession) {
        const ok = await onStartSession?.();
        if (!ok) { addOutput('Could not start a Remote Play session', 'error'); return; }
      }
      await sendCommand(cmd);
      addOutput(`✓ ${cmd}`, 'success');
    } catch (err) {
      addOutput(`✗ ${cmd} - ${err.message}`, 'error');
    }
    setManualBusy(null);
  };

  const commandDesc = Object.fromEntries(AVAILABLE_COMMANDS.map(({ cmd, desc }) => [cmd, desc]));

  // One gamepad-shaped button: same manualPress() plumbing as the old flat
  // grid, just laid out (and glyphed) to read as a physical controller.
  const GamepadButton = ({ cmd, label, className = '' }) => (
    <button
      onClick={() => manualPress(cmd)}
      disabled={manualBusy === cmd}
      title={commandDesc[cmd] || cmd}
      className={`gamepad-btn ${className}`}
    >
      {manualBusy === cmd ? '⏳' : (label ?? cmd)}
    </button>
  );

  const stopScript = () => {
    setStopRequested(true);
    addOutput('⏹ Stop requested...', 'warning');
  };

  // Executes one already-parsed line (parseLine's output, from the shared
  // inputScriptDsl module - also used by RemotePlay.jsx's step-by-step
  // "Input Scripts" tab, so the two execution paths can never drift apart
  // on what a given command actually does).
  const executeParsedLine = async (parsed, lineNum, checkStop = () => false) => {
    if (parsed.cmd === 'wait') {
      addOutput(`⏳ Wait ${parsed.params}ms...`, 'info');
      await new Promise(resolve => setTimeout(resolve, parsed.params));
      return;
    }

    if (parsed.cmd === 'text') {
      addOutput(`⌨ Type "${parsed.text}"`, 'info');
      const inputs = buildOskInputs(parsed.text || '');
      for (const ev of inputs) {
        if (checkStop()) break;
        await runCommand(ev.button);
        await new Promise(r => setTimeout(r, ev.commit ? 140 : 90));
      }
      return;
    }

    const reps = Math.max(1, parsed.count || 1);
    if (reps > 1) addOutput(`↻ ${parsed.cmd} ×${reps}`, 'info');
    for (let r = 0; r < reps; r++) {
      if (checkStop()) break;
      const success = await runCommand(parsed.cmd, parsed.params);
      if (!success) {
        addOutput(`Line ${lineNum}: Command failed, continuing...`, 'warning');
      }
      // Short pause so each press is registered separately by PS5 menus.
      if (reps > 1 && r < reps - 1) {
        await new Promise(resolve => setTimeout(resolve, 120));
      }
    }
  };

  const runScript = async (scriptToRun, key = 'script') => {
    if (!ip) {
      addOutput('No PS5 IP address configured', 'error');
      return;
    }
    if (!liveSession) {
      const ok = await onStartSession?.();
      if (!ok) { addOutput('Could not start a Remote Play session', 'error'); return; }
    }

    setIsRunning(key);
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

      await executeParsedLine(parsed, lineNum, () => stopRequested);
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    setIsRunning(null);
    setStopRequested(false);
    addOutput('✅ Script complete', 'success');
  };

  // ─── Edit modal ──────────────────────────────────────────────────────────
  // Opens the shared editor modal for one of three flows:
  //   • new saved script (blank)
  //   • editing an existing saved script
  //   • forking a built-in into a new saved script (prefilled, still a POST)
  const openNewScript = () => {
    setModalError('');
    setEditModal({ kind: 'saved', id: null, name: '', script: '', isNew: true });
  };

  const openEditSaved = (s) => {
    setModalError('');
    setEditModal({ kind: 'saved', id: s.id, name: s.name, script: s.script, isNew: false });
  };

  const openForkBuiltin = (b) => {
    setModalError('');
    setEditModal({ kind: 'saved', id: null, name: `${b.name} (copy)`, script: b.script, isNew: true });
  };

  // Built-in scripts have no editable name (it lives alongside the id in
  // the source file) - only the script body is sent to PUT /builtin/:id.
  const openEditBuiltin = (b) => {
    setModalError('');
    setEditModal({ kind: 'builtin', id: b.id, name: b.name, script: b.script, isNew: false });
  };

  const closeEditModal = () => {
    if (savingModal) return;
    setEditModal(null);
    setModalError('');
  };

  const updateModalField = (field, value) => {
    setEditModal(prev => (prev ? { ...prev, [field]: value } : prev));
  };

  const saveEditModal = async () => {
    if (!editModal) return;
    if (editModal.kind === 'saved' && !editModal.name.trim()) {
      setModalError('Name is required');
      return;
    }
    if (!editModal.script.trim()) {
      setModalError('Script is required');
      return;
    }

    setSavingModal(true);
    setModalError('');
    try {
      if (editModal.kind === 'builtin') {
        await api.put(`/input-scripts/builtin/${editModal.id}`, { script: editModal.script });
        addOutput(`Built-in script updated: ${editModal.name}`, 'success');
        fetchBuiltinScripts();
      } else if (editModal.isNew) {
        await api.post('/input-scripts', { name: editModal.name, script: editModal.script });
        addOutput('Script saved', 'success');
        onScriptsChange();
      } else {
        await api.put(`/input-scripts/${editModal.id}`, { name: editModal.name, script: editModal.script });
        addOutput('Script updated', 'success');
        onScriptsChange();
      }
      setEditModal(null);
    } catch (err) {
      setModalError(err.message);
    }
    setSavingModal(false);
  };

  const deleteScript = async (id) => {
    if (!confirm('Delete this script?')) return;
    try {
      await api.del(`/input-scripts/${id}`);
      addOutput('Script deleted', 'success');
      onScriptsChange();
    } catch (err) {
      addOutput(err.message, 'error');
    }
  };

  const clearOutput = () => setOutput([]);

  const outputColor = (type) => type === 'error' ? 'var(--red)'
    : type === 'success' ? 'var(--accent)'
    : type === 'warning' ? 'var(--amber)' : 'var(--text-soft)';

  return (
    <div className="flex-col gap-md">
      {/* Combined Scripts card with two tabs:
            • Built-in — curated (source: /frontend/builtin/inputScripts.json),
              editable in place via ✏️
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
          {scriptsTab === 'saved' && (
            <button className="btn btn-primary btn-sm" onClick={openNewScript}>＋ New</button>
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
                      onClick={() => openEditBuiltin(b)}
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
                        onClick={() => runScript(b.script, b.id)}
                        disabled={!!isRunning}
                        title="Run"
                      >▶</button>
                      <button
                        className="btn btn-info btn-sm btn-icon"
                        onClick={() => onRequestStep?.(b.script, b.name, { id: b.id, kind: 'builtin' })}
                        disabled={!!isRunning}
                        title="Step through with video preview"
                      >👣</button>
                      <button
                        className="btn btn-secondary btn-sm btn-icon"
                        onClick={() => openEditBuiltin(b)}
                        disabled={!!isRunning}
                        title="Edit"
                      >✏️</button>
                      <button
                        className="btn btn-secondary btn-sm btn-icon"
                        onClick={() => openForkBuiltin(b)}
                        disabled={!!isRunning}
                        title="Save as a new script"
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
                No saved scripts yet. Press <b>＋ New</b> above to create one.
              </div>
            ) : (
              <div className="flex-col" style={{ gap: 6, maxHeight: 260, overflowY: 'auto' }}>
                {scripts.map(s => (
                  <div
                    key={s.id}
                    className="list-item"
                    style={{ marginBottom: 0, padding: '10px 12px' }}
                  >
                    <span
                      className="flex-1 truncate"
                      style={{ cursor: 'pointer', fontSize: '0.9rem' }}
                      onClick={() => openEditSaved(s)}
                      title={s.name}
                    >
                      {s.name}
                    </span>
                    <div className="list-item-actions">
                      <button className="btn btn-success btn-sm btn-icon" onClick={() => runScript(s.script, s.id)} disabled={!!isRunning} title="Run">▶</button>
                      <button className="btn btn-info btn-sm btn-icon" onClick={() => onRequestStep?.(s.script, s.name, { id: s.id, kind: 'user' })} disabled={!!isRunning} title="Step through with video preview">👣</button>
                      <button className="btn btn-secondary btn-sm btn-icon" onClick={() => openEditSaved(s)} disabled={!!isRunning} title="Edit">✏️</button>
                      <button className="btn btn-danger btn-sm btn-icon" onClick={() => deleteScript(s.id)} title="Delete">🗑</button>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>

      {/* Manual controls — real button presses (not text insertion), for
          testing a button by hand while watching the video, or nudging the
          console mid-script without writing a whole line for it. Uses the
          same sendCommand the ▶ Run / 👣 Step paths use, so a manual press
          here behaves identically to a scripted one. Auto-starts a session
          (with video) on first press if nothing's live yet. */}
      <div className="comp-card">
        <div className="comp-card-header" style={{ alignItems: 'center' }}>
          <span className="comp-card-title" style={{ fontSize: '0.85rem' }}>🎮 Manual controls</span>
          {!liveSession && <span className="text-xs text-muted">Tap a button to start a session</span>}
        </div>
        <div className="comp-card-body">
          <div className="gamepad">
            <div className="gamepad-triggers">
              <GamepadButton cmd="L2" className="gamepad-trigger" />
              <GamepadButton cmd="L1" className="gamepad-trigger" />
              <span className="gamepad-spacer" />
              <GamepadButton cmd="R1" className="gamepad-trigger" />
              <GamepadButton cmd="R2" className="gamepad-trigger" />
            </div>
            <div className="gamepad-body">
              <div className="gamepad-dpad">
                <GamepadButton cmd="up" label="▲" className="dpad-up" />
                <GamepadButton cmd="left" label="◀" className="dpad-left" />
                <GamepadButton cmd="right" label="▶" className="dpad-right" />
                <GamepadButton cmd="down" label="▼" className="dpad-down" />
              </div>
              <div className="gamepad-center">
                <GamepadButton cmd="touchpad" label="▭" className="gamepad-center-btn" />
                <GamepadButton cmd="ps" label="PS" className="gamepad-center-btn gamepad-ps-btn" />
                <GamepadButton cmd="options" label="≡" className="gamepad-center-btn" />
                <GamepadButton cmd="L3" label="L3" className="gamepad-center-btn gamepad-stick-btn" />
                <GamepadButton cmd="R3" label="R3" className="gamepad-center-btn gamepad-stick-btn" />
              </div>
              <div className="gamepad-face">
                <GamepadButton cmd="triangle" label="△" className="face-up face-triangle" />
                <GamepadButton cmd="square" label="□" className="face-left face-square" />
                <GamepadButton cmd="circle" label="○" className="face-right face-circle" />
                <GamepadButton cmd="cross" label="✕" className="face-down face-cross" />
              </div>
            </div>
            {/* `x` is a DSL alias of `cross` (PS4-style naming for the same
                physical button) - kept as a small chip outside the diamond
                so it stays available without a second face slot. */}
            <div className="gamepad-extra">
              <GamepadButton cmd="x" label="X (alias of ✕)" className="gamepad-extra-btn" />
            </div>
          </div>
          <p className="text-xs text-muted mt-sm">
            Append <code>10x</code>, <code>x10</code>, or <code>*10</code> to repeat. Use <code>text &lt;string&gt;</code> to type on the PS5 on-screen keyboard.
          </p>
        </div>
      </div>

      {/* Output Console */}
      <div className="comp-card">
        <div className="comp-card-header">
          <span className="comp-card-title">
            <span>›_</span> Output Console
          </span>
          <div className="flex gap-sm">
            {isRunning && (
              <button className="btn btn-danger btn-sm" onClick={stopScript}>⏹ Stop</button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={clearOutput}>Clear</button>
          </div>
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

      {/* Edit modal — shared by "＋ New" (saved), "✏️ Edit" (saved or
          built-in) and "📋 Save as a new script" (fork a built-in). Built-in
          entries hide the name field since the backend only lets the
          script body be rewritten, not the id/name in the source file. */}
      <Modal
        isOpen={!!editModal}
        onClose={closeEditModal}
        title={
          editModal?.kind === 'builtin' ? `✏️ Edit built-in: ${editModal.name}`
            : editModal?.isNew ? '＋ New Script'
              : `✏️ Edit: ${editModal?.name || ''}`
        }
        footer={
          <>
            <button className="btn btn-ghost" onClick={closeEditModal} disabled={savingModal}>Cancel</button>
            <button className="btn btn-success" onClick={saveEditModal} disabled={savingModal}>
              💾 {savingModal ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        {editModal && (
          <div className="flex-col gap-sm">
            {editModal.kind === 'saved' && (
              <input
                type="text"
                className="input"
                placeholder="Script name"
                value={editModal.name}
                onChange={e => updateModalField('name', e.target.value)}
                autoFocus
              />
            )}
            <textarea
              className="input font-mono"
              value={editModal.script}
              onChange={e => updateModalField('script', e.target.value)}
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
              style={{ minHeight: 220, padding: 12, lineHeight: 1.55, resize: 'vertical' }}
            />
            <div className="text-xs text-muted">
              Use <code>//</code> for comments, <code>wait X</code> for a delay in milliseconds.
            </div>
            {modalError && (
              <div className="text-xs" style={{ color: 'var(--red)' }}>{modalError}</div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

export default ScriptRunner;
