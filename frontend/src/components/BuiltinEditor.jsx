import { useEffect, useMemo, useState, useCallback } from 'react';

const API = '/api';

// Hidden editor for /frontend/builtin/*.js. Reached via URL hash (#builtin)
// — intentionally absent from the main navigation. See App.jsx for the
// routing hookup and the small "Edit built-ins" link in Settings.
function BuiltinEditor({ onClose, onNotification }) {
  const [files, setFiles] = useState([]);
  const [dir, setDir] = useState('');
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState('');
  const [diskContent, setDiskContent] = useState('');
  const [mtime, setMtime] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const toast = useCallback((msg, type = 'info') => {
    if (onNotification) onNotification(msg, type);
    else setStatus(msg);
  }, [onNotification]);

  const dirty = useMemo(() => content !== diskContent, [content, diskContent]);

  const loadFile = useCallback(async (name) => {
    setSelected(name);
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/builtin/files/${encodeURIComponent(name)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setContent(data.content);
      setDiskContent(data.content);
      setMtime(data.mtime);
    } catch (err) {
      setError(err.message);
      toast(`Load failed: ${err.message}`, 'error');
    }
    setLoading(false);
  }, [toast]);

  const refreshIndex = useCallback(async (alsoLoadFirst = false) => {
    try {
      const res = await fetch(`${API}/builtin/files`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setFiles(data.files || []);
      setDir(data.dir || '');
      if (alsoLoadFirst && data.files?.length && !selected) {
        await loadFile(data.files[0].name);
      }
    } catch (err) {
      setError(err.message);
    }
  }, [selected, loadFile]);

  useEffect(() => { refreshIndex(true); }, [refreshIndex]);

  const save = async () => {
    if (!selected || saving) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`${API}/builtin/files/${encodeURIComponent(selected)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setDiskContent(content);
      setMtime(data.mtime);
      toast(`Saved ${selected}`, 'success');
      refreshIndex();
    } catch (err) {
      setError(err.message);
      toast(`Save failed: ${err.message}`, 'error');
    }
    setSaving(false);
  };

  const revert = () => {
    if (!dirty) return;
    if (!window.confirm('Discard your unsaved changes?')) return;
    setContent(diskContent);
    setError('');
  };

  const restoreBackup = async () => {
    if (!selected) return;
    if (!window.confirm(`Restore previous version of ${selected} from .bak?`)) return;
    try {
      const res = await fetch(`${API}/builtin/files/${encodeURIComponent(selected)}/restore-backup`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast(`Restored ${selected} from backup`, 'success');
      await loadFile(selected);
      refreshIndex();
    } catch (err) {
      toast(`Restore failed: ${err.message}`, 'error');
    }
  };

  // Ctrl/Cmd+S as the universal "save" gesture.
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (dirty) save();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, content, selected]);

  // Warn before navigating away with unsaved changes.
  useEffect(() => {
    const handler = (e) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const selectedMeta = files.find(f => f.name === selected);
  const fmtTime = (ms) => ms ? new Date(ms).toLocaleString() : '—';
  const fmtBytes = (n) => n == null ? '—' : `${n} B`;

  return (
    <div className="flex-col gap-md">
      <div className="comp-card">
        <div className="comp-card-header" style={{ flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
          <span className="comp-card-title">
            <span>🛠</span> Built-in Editor
            <span className="badge badge-warning" style={{ marginLeft: 8, fontSize: '0.65rem' }}>HIDDEN</span>
          </span>
          <div className="flex gap-sm items-center" style={{ marginLeft: 'auto' }}>
            <span className="font-mono text-xs text-muted truncate" title={dir} style={{ maxWidth: 320 }}>
              {dir || '…'}
            </span>
            {onClose && (
              <button className="btn btn-ghost btn-sm" onClick={onClose} title="Close editor">✕ Close</button>
            )}
          </div>
        </div>
        <div className="comp-card-body">
          <p className="text-sm text-muted" style={{ marginTop: 0 }}>
            Edit the files that drive the manager's built-in payloads, autoload templates
            and input scripts. Saves validate the file by importing it; a syntax error
            aborts without touching the live copy. The previous version is kept as
            <code style={{ margin: '0 4px' }}>&lt;file&gt;.bak</code>.
          </p>
          <div className="flex flex-wrap" style={{ gap: 6 }}>
            {files.map(f => {
              const isSel = f.name === selected;
              return (
                <button
                  key={f.name}
                  className={`btn btn-sm ${isSel ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => {
                    if (dirty && !window.confirm('Discard unsaved changes and switch file?')) return;
                    loadFile(f.name);
                  }}
                  title={f.description || f.name}
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  {f.title || f.name}
                  {!f.exists && <span className="badge badge-danger" style={{ marginLeft: 6, fontSize: '0.6rem' }}>MISSING</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="comp-card">
        <div className="comp-card-header" style={{ flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
          <span className="comp-card-title">
            <span>{dirty ? '●' : '📄'}</span>
            <span className="font-mono">{selected || 'No file selected'}</span>
            {dirty && (
              <span className="badge badge-warning" style={{ marginLeft: 8, fontSize: '0.65rem' }}>MODIFIED</span>
            )}
            {selectedMeta?.expectsExport && (
              <span className="badge badge-muted font-mono" style={{ marginLeft: 8, fontSize: '0.65rem' }}>
                export {selectedMeta.expectsExport}
              </span>
            )}
          </span>
          <div className="flex gap-sm">
            <button className="btn btn-ghost btn-sm" onClick={() => selected && loadFile(selected)} disabled={loading || !selected}>
              ↻ Reload
            </button>
            <button className="btn btn-secondary btn-sm" onClick={revert} disabled={!dirty || saving}>
              ⤺ Revert
            </button>
            <button className="btn btn-ghost btn-sm" onClick={restoreBackup} disabled={!selected || saving}>
              ⏮ Restore .bak
            </button>
            <button
              className="btn btn-success btn-sm"
              onClick={save}
              disabled={!selected || !dirty || saving}
              title="Ctrl/Cmd + S"
            >
              {saving ? '⏳ Saving…' : '💾 Save'}
            </button>
          </div>
        </div>
        <div className="comp-card-body flex-col gap-sm">
          {error && (
            <div className="text-sm" style={{ color: 'var(--red)', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)' }}>
              {error}
            </div>
          )}
          {status && !error && (
            <div className="text-sm text-muted">{status}</div>
          )}
          <textarea
            className="input font-mono"
            value={content}
            onChange={e => setContent(e.target.value)}
            spellCheck={false}
            disabled={!selected || loading || saving}
            placeholder={loading ? 'Loading…' : 'Pick a file above'}
            style={{
              minHeight: 480,
              padding: 14,
              lineHeight: 1.55,
              fontSize: '0.85rem',
              resize: 'vertical',
              tabSize: 2,
              MozTabSize: 2,
            }}
          />
          <div className="flex flex-wrap text-xs text-muted" style={{ gap: 16 }}>
            <span>Size on disk: <code>{fmtBytes(selectedMeta?.size)}</code></span>
            <span>Modified: <code>{fmtTime(mtime)}</code></span>
            <span>Buffer: <code>{content.length} chars</code></span>
            <span style={{ marginLeft: 'auto' }}>
              Tip: <kbd>Ctrl</kbd>+<kbd>S</kbd> to save
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default BuiltinEditor;
