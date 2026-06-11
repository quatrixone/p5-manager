import { useEffect, useState, useCallback } from 'react';
import Modal from './Modal';

const API = '/api';

// Lightweight folder-only browser used as a modal picker by the
// Downloader and Convert tabs. Talks to the same /convert/local/browse
// endpoint as the full FileBrowser but renders folders only (files are
// shown disabled, so the user still sees what's in a directory while
// navigating). Provides:
//   - quick-tab buttons sourced from /convert/local/roots
//   - manual path entry with Go / ↻ refresh
//   - breadcrumb navigation
//   - "+ New folder" inline create (creates beneath current path)
//   - "Pick this folder" CTA returning the current path
//
// Props:
//   open          : boolean
//   onClose       : () => void
//   onPick(path)  : called with the picked absolute path, then modal closes
//   initialPath   : optional string, defaults to first quick-tab root
//   title         : modal title
//   selectFiles   : when true, files are also pickable - clicking a file
//                   immediately returns its path (typical "Open file"
//                   dialog UX). Folders still navigate on click.
//   fileFilter    : optional (name) => boolean used to grey out files
//                   that don't match (e.g. only .pkg / .ffpfsc). Ignored
//                   when selectFiles=false.
export default function FolderPickerModal({
  open, onClose, onPick, initialPath,
  title = 'Pick folder',
  selectFiles = false,
  fileFilter,
}) {
  const [path, setPath] = useState(initialPath || '');
  const [pathInput, setPathInput] = useState(initialPath || '');
  const [entries, setEntries] = useState([]);
  const [parent, setParent] = useState(null);
  const [roots, setRoots] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState('');

  // Sync state with initialPath when the modal opens — handles the
  // case where the parent component changes the default between
  // openings (e.g. Convert tab switching between pack/unpack modes).
  useEffect(() => {
    if (open) {
      setPath(initialPath || '');
      setPathInput(initialPath || '');
      setError(null);
      setNewName('');
    }
  }, [open, initialPath]);

  useEffect(() => {
    if (!open) return;
    fetch(`${API}/convert/local/roots`).then(r => r.json()).then(d => {
      setRoots(d.roots || []);
      // Fallback when no initialPath was provided.
      if (!path && d.roots?.length) {
        setPath(d.roots[0]);
        setPathInput(d.roots[0]);
      }
    }).catch(() => {});
  }, [open]);

  const browse = useCallback(async (p) => {
    if (!p) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API}/convert/local/browse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || 'Browse failed');
        setEntries([]);
        return;
      }
      setPath(d.path);
      setPathInput(d.path);
      setEntries(d.files || []);
      setParent(d.parent);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && path) browse(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, path && open ? path : null]);

  const goUp = () => { if (parent != null) browse(parent); };

  const enter = (entry) => {
    if (!entry.isDir) return;
    const next = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
    browse(next);
  };

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    // Reuse /local/move's create-directory side effect would be ugly;
    // there's no dedicated mkdir endpoint, so we piggy-back on
    // /downloader/start's behaviour (creates dest dir recursively) by
    // ... no, that downloads. Cleaner: synthesise an empty file move?
    // No - simplest is to add a dedicated mkdir, but to avoid backend
    // churn we just create the dir via /local/copy with a self-target
    // — also ugly. Best move: use a *new* lightweight endpoint. Since
    // adding it is one line, we call /convert/local/mkdir and rely on
    // the matching backend route added alongside this component.
    try {
      const r = await fetch(`${API}/convert/local/mkdir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: path === '/' ? `/${name}` : `${path.replace(/\/$/, '')}/${name}`,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'mkdir failed');
      setNewName('');
      browse(path);
    } catch (e) {
      setError(e.message);
    }
  };

  const breadcrumbs = (() => {
    if (!path) return [];
    const parts = path.split('/').filter(Boolean);
    let acc = '';
    return parts.map(p => { acc += `/${p}`; return { label: p, path: acc }; });
  })();

  // Sort: dirs first, then files greyed out
  const sorted = [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-success"
            onClick={() => { if (path) { onPick?.(path); onClose?.(); } }}
            disabled={!path || loading}
          >
            ✓ Use {path || '…'}
          </button>
        </>
      }
    >
      <div className="flex-col gap-sm">
        {roots.length > 0 && (
          <div className="flex gap-xs flex-wrap">
            {roots.slice(0, 8).map(r => (
              <button
                key={r}
                className={`btn btn-sm ${r === path ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => browse(r)}
                title={r}
              >
                {/* Strip the user-data root prefix for prettier labels
                    ("payloads" instead of "/data/payloads"). Falls back
                    to the full path for non-prefixed roots. */}
                {(/^\/data\/(.+)$/.exec(r) || [, r])[1]}
              </button>
            ))}
          </div>
        )}

        <div className="flex gap-xs items-center">
          <button className="btn btn-sm btn-ghost" onClick={goUp} disabled={parent == null}>↑</button>
          <input
            className="input flex-1"
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') browse(pathInput); }}
            placeholder="/data/downloads"
          />
          <button className="btn btn-sm btn-primary" onClick={() => browse(pathInput)} disabled={loading}>▶</button>
          <button className="btn btn-sm btn-ghost" onClick={() => browse(path)} disabled={loading}>↻</button>
        </div>

        {breadcrumbs.length > 0 && (
          <div className="flex items-center gap-xs flex-wrap text-sm" style={{ padding: '4px 0' }}>
            <span style={{ color: 'var(--muted)' }}>📁</span>
            {breadcrumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-xs">
                {i > 0 && <span style={{ color: 'var(--muted)' }}>›</span>}
                <button
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    padding: '2px 4px', borderRadius: 4,
                    color: 'var(--text)', fontSize: '0.85rem',
                  }}
                  onClick={() => browse(c.path)}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </div>
        )}

        {error && (
          <div className="p-sm" style={{ background: 'rgba(192,57,43,0.1)', borderRadius: 6, color: 'var(--red)', fontSize: '0.85rem' }}>
            {error}
          </div>
        )}

        <div
          style={{
            maxHeight: 360,
            overflowY: 'auto',
            border: '1px solid var(--bg-elev-2)',
            borderRadius: 6,
            background: 'var(--bg-elev)',
          }}
        >
          {loading && <div className="p-sm text-muted text-sm">Loading…</div>}
          {!loading && sorted.length === 0 && (
            <div className="p-sm text-muted text-sm">Folder is empty</div>
          )}
          {!loading && sorted.map(e => {
            // A file is "pickable" when the parent opted into selectFiles
            // AND it passes fileFilter (when provided). Directories are
            // always navigable.
            const fileEligible = !e.isDir && selectFiles && (!fileFilter || fileFilter(e.name));
            const clickable = e.isDir || fileEligible;
            const onClick = () => {
              if (e.isDir) { enter(e); return; }
              if (fileEligible) {
                const full = path === '/' ? `/${e.name}` : `${path.replace(/\/$/, '')}/${e.name}`;
                onPick?.(full);
                onClose?.();
              }
            };
            return (
              <div
                key={e.name}
                onClick={onClick}
                style={{
                  display: 'flex', alignItems: 'center', gap: 'var(--space-sm)',
                  padding: '6px 10px',
                  cursor: clickable ? 'pointer' : 'default',
                  opacity: clickable ? 1 : 0.4,
                  borderBottom: '1px solid var(--bg-elev-2)',
                }}
              >
                <span>{e.isDir ? '📁' : '📄'}</span>
                <span style={{ flex: 1, fontSize: '0.88rem', color: e.isDir ? 'var(--blue)' : (fileEligible ? 'var(--text)' : 'var(--muted)') }}>{e.name}</span>
                {!e.isDir && typeof e.size === 'number' && (
                  <span className="text-xs text-muted">
                    {e.size < 1024
                      ? `${e.size} B`
                      : e.size < 1024 * 1024
                        ? `${(e.size / 1024).toFixed(1)} KB`
                        : `${(e.size / 1024 / 1024).toFixed(1)} MB`}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex gap-xs items-center">
          <input
            className="input"
            style={{ flex: 1 }}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') createFolder(); }}
            placeholder="New folder name…"
          />
          <button className="btn btn-sm btn-secondary" onClick={createFolder} disabled={!newName.trim() || !path}>
            ＋ New folder
          </button>
        </div>
      </div>
    </Modal>
  );
}
