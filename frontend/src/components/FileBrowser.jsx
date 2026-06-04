import { useState, useEffect, useCallback, useRef } from 'react';

const API = '/api';

const C = {
  bg: 'var(--bg)',
  panel: 'var(--bg-elev)',
  panel2: 'var(--bg-elev-2)',
  accent: 'var(--accent)',
  blue: 'var(--blue)',
  green: 'var(--accent)',
  red: 'var(--red)',
  text: '#fff',
  muted: '#aaa',
  border: 'var(--bg-elev-2)',
};

function fmtSize(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
}

const isArchive = (n) => /\.(rar|7z|zip|tar\.gz|tgz|tar|r\d{2}|part\d+\.rar)$/i.test(n);

export default function FileBrowser({
  profiles = [],
  onNotification,
  enableFtp = false,
  enableExtract = false,
  enableDelete = false,
  enableImportFile = false,
  enableImportFolder = false,
  enablePickDir = false,
  enablePickConvert = false,
  enableFtpUpload = false,
  enableSaveDefault = true,
  defaultKind = 'local',
  onExtractStarted,
  onImported,
  onPickDir,
  onPickConvert,
  jobKeyPrefix = 'mm.fb',
  title = 'File Browser',
  description,
}) {
  const [smbSources, setSmbSources] = useState([]);
  const [localRoots, setLocalRoots] = useState([]);
  const [browserPrefs, setBrowserPrefs] = useState({ local: '', smb: {} });

  const [kind, setKind] = useState(defaultKind);
  const [smbId, setSmbId] = useState('');
  const [ftpIp, setFtpIp] = useState('');

  const [pathInput, setPathInput] = useState('/mnt');
  const [path, setPath] = useState('/mnt');
  const [files, setFiles] = useState([]);
  const [parent, setParent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [extractPwd, setExtractPwd] = useState('');
  const [extractDeleteAfter, setExtractDeleteAfter] = useState(false);

  const [multiSelect, setMultiSelect] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [selectedFile, setSelectedFile] = useState(null);
  const [menuOpen, setMenuOpen] = useState(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (!e.target.closest('.file-menu')) setMenuOpen(null);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [menuOpen]);

  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState('asc');

  const listRef = useRef(null);

  useEffect(() => {
    fetch(`${API}/micromount/sources`).then(r => r.json()).then(rows => {
      setSmbSources((rows || []).filter(s => s.type === 'smb'));
    }).catch(() => {});
    fetch(`${API}/micromount/local/roots`).then(r => r.json()).then(d => {
      setLocalRoots(d.roots || []);
    }).catch(() => {});
    fetch(`${API}/micromount/browser-prefs`).then(r => r.json()).then(d => {
      setBrowserPrefs({ local: d.local || '', smb: d.smb || {} });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (enableFtp) {
      const def = profiles.find(p => p.is_default) || profiles[0];
      if (def && !ftpIp) setFtpIp(def.ip_address);
    }
  }, [profiles, enableFtp, ftpIp]);

  const browse = useCallback(async (p) => {
    setLoading(true); setError(null);
    setSelectedFile(null);
    setSelected(new Set());
    try {
      let r;
      if (kind === 'local') {
        r = await fetch(`${API}/micromount/local/browse`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p }),
        });
      } else if (kind === 'smb') {
        if (!smbId) { setLoading(false); setError('Select SMB source'); return; }
        r = await fetch(`${API}/micromount/sources/${smbId}/browse`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subPath: p }),
        });
      } else {
        if (!ftpIp) { setLoading(false); setError('Select PS5 IP'); return; }
        r = await fetch(`${API}/micromount/ftp/browse`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ip: ftpIp, path: p }),
        });
      }
      const d = await r.json();
      if (!r.ok) { setError(d.error); setFiles([]); return; }
      setPath(d.path); setPathInput(d.path);
      setFiles(d.files || []); setParent(d.parent);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [kind, smbId, ftpIp]);

  useEffect(() => {
    if (kind === 'local') {
      const p = browserPrefs.local || '/mnt';
      setPathInput(p); setPath(p); browse(p);
    } else if (kind === 'smb' && smbId) {
      const def = browserPrefs.smb?.[smbId] || '';
      setPathInput(def); setPath(def); browse(def);
    } else if (kind === 'ftp' && ftpIp) {
      setPathInput('/data'); setPath('/data'); browse('/data');
    } else { setFiles([]); setPath(''); setParent(null); }
  }, [kind, smbId, ftpIp, browserPrefs.local]);

  const open = (f) => {
    if (!f.isDir) return;
    const next = kind === 'local'
      ? (path === '/' ? `/${f.name}` : `${path.replace(/\/$/, '')}/${f.name}`)
      : (path ? `${path.replace(/\/+$/, '')}/${f.name}` : f.name);
    browse(next);
  };

  const goUp = () => { if (parent !== null && parent !== undefined) browse(parent); };
  const refresh = () => browse(path);

  const saveDefault = async () => {
    try {
      const next = { ...browserPrefs };
      if (kind === 'local') next.local = path;
      else if (kind === 'smb' && smbId) next.smb = { ...(next.smb || {}), [smbId]: path };
      else { onNotification?.('Default save not supported for FTP', 'info'); return; }
      const r = await fetch(`${API}/micromount/browser-prefs`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      setBrowserPrefs(next);
      onNotification?.(`Default saved: ${path}`, 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const navigateBreadcrumb = (segmentPath) => {
    browse(segmentPath);
  };

  const getBreadcrumbs = () => {
    if (!path) return [];
    const parts = path.split('/').filter(Boolean);
    const crumbs = [];
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  };

  const toggleSelect = (name) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };

  const clearSelection = () => {
    setMultiSelect(false);
    setSelected(new Set());
  };

  const toggleMultiSelect = () => {
    if (multiSelect) {
      clearSelection();
    } else {
      setMultiSelect(true);
    }
  };

  const deleteEntry = async (entry) => {
    if (!window.confirm(`Delete ${entry.isDir ? 'folder' : 'file'}\n${entry.name}?`)) return;
    try {
      let r, body;
      if (kind === 'local') {
        const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
        body = { path: fullPath, isDir: entry.isDir };
        r = await fetch(`${API}/micromount/local/delete`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      } else if (kind === 'smb') {
        const sub = path ? `${path.replace(/\/+$/, '')}/${entry.name}` : entry.name;
        body = { path: sub, isDir: entry.isDir };
        r = await fetch(`${API}/micromount/sources/${smbId}/delete`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      } else {
        const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
        body = { ip: ftpIp, path: fullPath, isDir: entry.isDir };
        r = await fetch(`${API}/micromount/ftp/delete`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onNotification?.(`Deleted ${entry.name}`, 'success');
      browse(path);
    } catch (e) { onNotification?.(`Delete failed: ${e.message}`, 'error'); }
  };

  const ftpUpload = async (entry) => {
    if (!ftpIp) return;
    const localPath = kind === 'local'
      ? (path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`)
      : null;
    if (!localPath && kind !== 'local') {
      onNotification?.('Upload only from local filesystem', 'error');
      return;
    }
    try {
      // Always go through the queue; user controls Start/Pause from the Queue tab.
      const r = await fetch(`${API}/micromount/ftp/upload/queue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: ftpIp, local_path: localPath }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onNotification?.(`Upload added to queue: ${entry.name}`, 'success');
    } catch (e) { onNotification?.(`Upload failed: ${e.message}`, 'error'); }
  };

  const startExtract = async (filename) => {
    if (kind === 'ftp') {
      onNotification?.('Extract from FTP not supported (download via Downloader first)', 'info');
      return;
    }
    try {
      let body;
      if (kind === 'local') {
        const fullPath = path === '/' ? `/${filename}` : `${path.replace(/\/$/, '')}/${filename}`;
        const dest = path || '/';
        body = {
          source: 'local-fs', local_path: fullPath,
          dest_kind: 'local-fs', dest_local_path: dest,
          password: extractPwd, delete_archive_after: extractDeleteAfter,
        };
      } else {
        body = {
          source: 'smb', source_id: smbId, smb_path: path, filename,
          dest_kind: 'smb-back', password: extractPwd, delete_archive_after: extractDeleteAfter,
        };
      }
      // Always go through the queue; user controls Start/Pause from the Queue tab.
      const r = await fetch(`${API}/micromount/extract/queue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onNotification?.(`Extract added to queue: ${filename}`, 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const importFile = async (filename) => {
    if (kind === 'ftp') return;
    try {
      let r;
      if (kind === 'local') {
        const fullPath = path === '/' ? `/${filename}` : `${path.replace(/\/$/, '')}/${filename}`;
        r = await fetch(`${API}/micromount/local/import-file`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ local_path: fullPath }),
        });
      } else {
        r = await fetch(`${API}/micromount/sources/${smbId}/import-file`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ smb_path: path, filename }),
        });
      }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onNotification?.(`Imported ${filename}`, 'success');
      onImported?.(d);
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const importFolder = async (folderName) => {
    if (kind === 'ftp') return;
    try {
      let r;
      if (kind === 'local') {
        const fullPath = path === '/' ? `/${folderName}` : `${path.replace(/\/$/, '')}/${folderName}`;
        r = await fetch(`${API}/micromount/local/import-folder`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ local_path: fullPath }),
        });
      } else {
        r = await fetch(`${API}/micromount/mkpfs/import-folder-from-smb`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_id: smbId, smb_path: path, folder_name: folderName }),
        });
      }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onNotification?.(`Folder import started: ${folderName}`, 'info');
      onImported?.(d);
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const pickDir = (entry) => {
    if (kind === 'ftp') {
      onNotification?.('FTP not supported as destination', 'info');
      return;
    }
    const fullPath = entry
      ? (kind === 'local'
        ? (path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`)
        : (path ? `${path.replace(/\/+$/, '')}/${entry.name}` : entry.name))
      : path;
    onPickDir?.({ kind, smbId, ftpIp, path: fullPath, entry });
    onNotification?.(`Picked ${fullPath || '/'}`, 'success');
  };

  const pickConvert = (entry) => {
    if (kind !== 'local') {
      onNotification?.('Convert in-place only for local filesystem', 'info');
      return;
    }
    const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
    onPickConvert?.({ kind, path: fullPath, isDir: !!entry.isDir, name: entry.name });
    onNotification?.(`Picked for convert: ${entry.name}`, 'success');
  };

  const deleteSelected = async () => {
    if (!window.confirm(`Delete ${selected.size} item(s)?`)) return;
    for (const name of selected) {
      const f = files.find(f => f.name === name);
      if (f) await deleteEntry(f);
    }
    clearSelection();
  };

  const sortFiles = (a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let cmp = 0;
    if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
    else if (sortBy === 'size') cmp = (a.size || 0) - (b.size || 0);
    else if (sortBy === 'type') {
      const extA = a.name.split('.').pop();
      const extB = b.name.split('.').pop();
      cmp = extA.localeCompare(extB);
    }
    return sortDir === 'asc' ? cmp : -cmp;
  };

  const sortedFiles = [...files].sort(sortFiles);
  const breadcrumbs = getBreadcrumbs();

  const renderFileCard = (f) => {
    const isSelected = selected.has(f.name);
    const isActive = selectedFile === f.name;
    const archiveFile = !f.isDir && isArchive(f.name);

    const primaryAction = f.isDir ? (
      <button className="btn btn-primary btn-sm" onClick={() => open(f)}>📂 Open</button>
    ) : archiveFile && enableExtract ? (
      <button className="btn btn-primary btn-sm" onClick={() => { setSelectedFile(f.name); setMenuOpen(null); }}>📦 Extract</button>
    ) : !f.isDir && enableFtpUpload && kind === 'local' && ftpIp ? (
      <button className="btn btn-primary btn-sm" onClick={() => ftpUpload(f)}>⬆ Upload</button>
    ) : null;

    const secondaryActions = [
      f.isDir && enablePickDir && kind !== 'ftp' && { label: '✓ Pick', action: () => pickDir(f) },
      enablePickConvert && kind === 'local' && { label: '🔄 Convert', action: () => pickConvert(f) },
      f.isDir && enableImportFolder && kind !== 'ftp' && { label: '📥 Import', action: () => importFolder(f.name) },
      !f.isDir && enableImportFile && kind !== 'ftp' && { label: '📥 Import', action: () => importFile(f.name) },
      enableDelete && { label: '🗑 Delete', action: () => deleteEntry(f), danger: true },
    ].filter(Boolean);

    return (
      <div
        key={f.name}
        data-file={f.name}
        className={`file-card ${isSelected ? 'file-card-selected' : ''} ${isActive ? 'file-card-active' : ''}`}
        onClick={() => {
          if (multiSelect) toggleSelect(f.name);
        }}
        style={{ position: 'relative' }}
      >
        <div className="file-card-content" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', padding: 'var(--space-sm) var(--space-md)' }}>
          {multiSelect && (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleSelect(f.name)}
              style={{ width: 20, height: 20, cursor: 'pointer', accentColor: 'var(--accent)' }}
            />
          )}

          <span style={{ fontSize: '1.5rem' }}>{f.isDir ? '📁' : archiveFile ? '📦' : '📄'}</span>

          <div className="flex-1" style={{ minWidth: 0 }}>
            <div className="text-sm truncate" style={{ color: f.isDir ? 'var(--blue)' : 'var(--text)' }}>{f.name}</div>
            <div className="text-xs text-muted">{f.isDir ? (f.size ? fmtSize(f.size) : '—') : fmtSize(f.size)}</div>
          </div>

          {primaryAction && (
            <div onClick={(e) => e.stopPropagation()}>
              {primaryAction}
            </div>
          )}

          {secondaryActions.length > 0 && (
            <div style={{ position: 'relative', overflow: 'visible' }} onClick={(e) => e.stopPropagation()}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setMenuOpen(menuOpen === f.name ? null : f.name)}
                style={{ minWidth: 36 }}
              >
                ⋮
              </button>
              {menuOpen === f.name && (
                <div className="file-menu">
                  {secondaryActions.map((action, i) => (
                    <button
                      key={i}
                      className={`file-menu-item ${action.danger ? 'text-danger' : ''}`}
                      onClick={() => { action.action(); setMenuOpen(null); }}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="comp-card">
      <div className="comp-card-header">
        <div className="flex justify-between items-center flex-1">
          <div>
            <span className="comp-card-title">{title}</span>
            {description && <div className="text-xs text-muted mt-xs">{description}</div>}
          </div>
          <button
            className={`btn btn-ghost btn-sm ${multiSelect ? 'btn-primary' : ''}`}
            onClick={toggleMultiSelect}
          >
            {multiSelect ? `✓ ${selected.size} selected` : '☰ Select'}
          </button>
        </div>
      </div>

      <div className="comp-card-body flex-col gap-md">
        <div className="tabs">
          <button className={`tab-item ${kind === 'local' ? 'active' : ''}`} onClick={() => setKind('local')}>💾 Local</button>
          <button className={`tab-item ${kind === 'smb' ? 'active' : ''}`} onClick={() => setKind('smb')}>📂 SMB</button>
          {enableFtp && <button className={`tab-item ${kind === 'ftp' ? 'active' : ''}`} onClick={() => setKind('ftp')}>🎮 PS5 FTP</button>}
        </div>

        {kind === 'smb' && (
          <select className="select" value={smbId} onChange={e => setSmbId(e.target.value)}>
            <option value="">— pick SMB source —</option>
            {smbSources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}

        {kind === 'ftp' && (
          <select className="select" value={ftpIp} onChange={e => setFtpIp(e.target.value)}>
            <option value="">— pick PS5 —</option>
            {profiles.map(p => <option key={p.id} value={p.ip_address}>{p.name} ({p.ip_address})</option>)}
          </select>
        )}

        {kind === 'local' && localRoots.length > 0 && (
          <div className="flex gap-xs flex-wrap">
            {localRoots.slice(0, 6).map(r => (
              <button key={r} className="btn btn-ghost btn-sm" onClick={() => browse(r)}>{r}</button>
            ))}
          </div>
        )}

        <div className="flex gap-sm items-center">
          <button className="btn btn-sm btn-ghost" onClick={goUp} disabled={parent === null || parent === undefined}>↑</button>
          <input
            className="input flex-1"
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') browse(pathInput); }}
            placeholder="/mnt"
          />
          <button className="btn btn-sm btn-primary" onClick={() => browse(pathInput)} disabled={loading}>▶</button>
          <button className="btn btn-sm btn-ghost" onClick={refresh} disabled={loading}>↻</button>
          {enableSaveDefault && kind !== 'ftp' && <button className="btn btn-sm btn-ghost" onClick={saveDefault}>★</button>}
          {enablePickDir && kind !== 'ftp' && <button className="btn btn-sm btn-success" onClick={() => pickDir(null)}>✓ Use</button>}
        </div>

        {breadcrumbs.length > 0 && (
          <div className="flex items-center gap-xs text-sm flex-wrap">
            <span style={{ fontSize: '1rem' }}>{kind === 'local' ? '💾' : kind === 'smb' ? '📂' : '🎮'}</span>
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-xs">
                {i > 0 && <span style={{ color: 'var(--muted)' }}>›</span>}
                <button
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    borderRadius: 4,
                    color: 'var(--text)',
                    fontSize: '0.85rem',
                  }}
                  onClick={() => navigateBreadcrumb(crumb.path)}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </div>
        )}

        {error && (
          <div className="p-sm" style={{ background: 'rgba(192, 57, 43, 0.1)', borderRadius: 6, color: 'var(--red)', fontSize: '0.85rem' }}>
            {error}
          </div>
        )}

        <div className="flex justify-between items-center text-sm text-muted">
          <span>{files.length} items{loading ? ' · loading…' : ''}</span>
          <div className="flex gap-xs">
            <button className={`btn btn-ghost btn-sm ${sortBy === 'name' ? 'btn-primary' : ''}`} onClick={() => { setSortBy('name'); setSortDir(d => sortBy === 'name' ? (d === 'asc' ? 'desc' : 'asc') : 'asc'); }}>Name</button>
            <button className={`btn btn-ghost btn-sm ${sortBy === 'size' ? 'btn-primary' : ''}`} onClick={() => { setSortBy('size'); setSortDir(d => sortBy === 'size' ? (d === 'asc' ? 'desc' : 'asc') : 'asc'); }}>Size</button>
            <button className={`btn btn-ghost btn-sm ${sortBy === 'type' ? 'btn-primary' : ''}`} onClick={() => { setSortBy('type'); setSortDir(d => sortBy === 'type' ? (d === 'asc' ? 'desc' : 'asc') : 'asc'); }}>Type</button>
          </div>
        </div>

        {selectedFile && enableExtract && (
          <div className="p-md" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
            <div className="text-sm mb-sm">📦 Extract: <strong>{selectedFile}</strong></div>
            <div className="flex gap-sm items-center flex-wrap">
              <input
                type="password"
                className="input"
                style={{ maxWidth: 160 }}
                placeholder="Archive password"
                value={extractPwd}
                onChange={e => setExtractPwd(e.target.value)}
              />
              <label className="flex items-center gap-xs text-sm" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={extractDeleteAfter} onChange={e => setExtractDeleteAfter(e.target.checked)} />
                <span style={{ color: extractDeleteAfter ? 'var(--red)' : 'var(--muted)' }}>🗑 Delete after</span>
              </label>
            </div>
            <div className="flex gap-sm mt-sm">
              <button className="btn btn-success btn-sm" onClick={() => { startExtract(selectedFile); setSelectedFile(null); }}>＋ Add to Queue</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedFile(null)}>✕</button>
            </div>
            <div className="text-xs text-muted mt-sm">
              Job runs once you press <strong>Start</strong> in the Queue tab.
            </div>
          </div>
        )}

        {sortedFiles.length === 0 && !loading ? (
          <div className="empty-state">
            <div className="empty-state-icon">📂</div>
            <div className="empty-state-title">No files</div>
            <div className="empty-state-text">This folder is empty</div>
          </div>
        ) : (
          <div
            ref={listRef}
            className="flex-col gap-xs"
            style={{ maxHeight: 450, overflowY: 'auto' }}
          >
            {sortedFiles.map(f => renderFileCard(f))}
          </div>
        )}

        {multiSelect && selected.size > 0 && (
          <div className="flex gap-sm items-center p-md" style={{ background: 'var(--accent)', borderRadius: 8, position: 'sticky', bottom: 0 }}>
            <span className="text-sm font-medium">{selected.size} selected</span>
            <button className="btn btn-sm btn-danger" onClick={deleteSelected}>🗑 Delete</button>
            <button className="btn btn-sm btn-ghost" onClick={clearSelection}>✕ Cancel</button>
          </div>
        )}

      </div>
    </div>
  );
}

export function ExtractLogPanel({ job }) {
  if (!job) return null;

  const statusColor = job.status === 'completed' ? 'var(--green)' : job.status === 'failed' ? 'var(--red)' : 'var(--blue)';

  return (
    <div className="comp-card mt-md">
      <div className="comp-card-header">
        <span className="comp-card-title">📦 Extract: {job.filename}</span>
        <span className="badge" style={{ background: statusColor }}>{job.status}</span>
      </div>
      <div className="comp-card-body">
        {job.error && <div className="text-sm text-danger mb-sm">Error: {job.error}</div>}
        {job.log && (
          <pre className="text-xs" style={{ background: 'var(--bg)', padding: 'var(--space-sm)', borderRadius: 4, maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
            {job.log}
          </pre>
        )}
      </div>
    </div>
  );
}