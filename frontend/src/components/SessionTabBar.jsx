import { useEffect, useRef, useState } from 'react';
import SearchSelect from './UI/SearchSelect';

// Tab row of RemotePlay's Live Session card. "Control" is a plain tab;
// "Input Scripts" and "Payloads" open a dropdown so a script can be run or
// a payload sent while the video + controller stay on screen. The full
// script list/editor is still a tab, reached through the dropdown's
// "Editor" entry.
export default function SessionTabBar({
  viewTab, onSelectTab,
  scripts, onOpenScripts, onRunScript, scriptRunning,
  payloads, payloadsLoaded, onOpenPayloads, onSendPayload, sendingPayloadId,
  targetName, payloadPlatform,
}) {
  const [menu, setMenu] = useState(null); // null | 'scripts' | 'payloads'
  const [scriptId, setScriptId] = useState(null);
  const [payloadId, setPayloadId] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setMenu(null); };
    const onKey = (e) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const toggle = (which) => {
    if (menu === which) { setMenu(null); return; }
    if (which === 'scripts') onOpenScripts?.();
    if (which === 'payloads') onOpenPayloads?.();
    setMenu(which);
  };

  const script = scripts.find(s => s.id === scriptId) || null;
  const payload = payloads.find(p => p.id === payloadId) || null;

  useEffect(() => {
    if (payloadId != null && !payloads.some(p => p.id === payloadId)) setPayloadId(null);
  }, [payloads, payloadId]);

  return (
    <div className="session-tabbar mb-sm" ref={wrapRef}>
      <div className="tabs">
        <button
          type="button"
          className={`tab-item ${viewTab === 'control' ? 'active' : ''}`}
          onClick={() => { setMenu(null); onSelectTab('control'); }}
        >
          🎮 Control
        </button>
        <button
          type="button"
          className={`tab-item ${viewTab === 'scripts' ? 'active' : ''}`}
          aria-haspopup="true"
          aria-expanded={menu === 'scripts'}
          onClick={() => toggle('scripts')}
        >
          ⌨️ Input Scripts ▾
        </button>
        <button
          type="button"
          className="tab-item"
          aria-haspopup="true"
          aria-expanded={menu === 'payloads'}
          onClick={() => toggle('payloads')}
        >
          📦 Payloads ▾
        </button>
      </div>

      {menu === 'scripts' && (
        <div className="session-tabbar-menu">
          <div className="session-tabbar-menu-head">
            <span className="text-sm font-medium">Run a script</span>
            <button
              type="button"
              className="btn btn-success btn-sm"
              disabled={!script || scriptRunning}
              onClick={() => { onRunScript(script); setMenu(null); }}
            >
              {scriptRunning ? '⏳ Running…' : '▶ Run'}
            </button>
          </div>
          <SearchSelect
            items={scripts.map(s => ({ key: s.id, label: s.name, badge: s.kind === 'builtin' ? 'BUILT-IN' : null }))}
            value={scriptId}
            onChange={setScriptId}
            placeholder="Search scripts…"
            emptyText="No scripts found"
            autoFocus
          />
          <button
            type="button"
            className="session-tabbar-menu-item"
            onClick={() => { setMenu(null); onSelectTab('scripts'); }}
          >
            ✏️ Editor
          </button>
        </div>
      )}

      {menu === 'payloads' && (
        <div className="session-tabbar-menu">
          <div className="session-tabbar-menu-head">
            <span className="text-sm font-medium truncate">Send a payload{targetName ? ` to ${targetName}` : ''}</span>
            <button
              type="button"
              className="btn btn-success btn-sm"
              disabled={!payload || sendingPayloadId != null}
              onClick={() => onSendPayload(payload)}
            >
              {sendingPayloadId != null ? '⏳ Sending…' : '📤 Send'}
            </button>
          </div>
          {!payloadsLoaded ? (
            <div className="text-sm text-muted">Loading…</div>
          ) : (
            <SearchSelect
              items={payloads.map(p => ({ key: p.id, label: p.name, badge: p.console_type ? p.console_type.toUpperCase() : null }))}
              value={payloadId}
              onChange={setPayloadId}
              placeholder="Search payloads…"
              emptyText={payloads.length
                ? 'No matching payloads found'
                : `No ${payloadPlatform?.toUpperCase() || 'console'} payloads available - add some in the Payloads tab`}
              autoFocus
            />
          )}
        </div>
      )}
    </div>
  );
}
