import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';

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
const isPfsImage = (n) => /\.(ffpfs|ffpfsc|pfs|dat|bin)$/i.test(n);

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
  // Invoked when the user picks "Upload/Download/Convert queue" from the
  // kebab menu. Parent decides how to navigate to the Queue view
  // (e.g. by switching its sub-tab). Signature: (type: 'upload' | 'download' | 'convert')
  onOpenQueue,
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

  // Upload-to-PS5 target. Used by the unified Upload action that handles
  // files and folders coming from either the local FS or any configured
  // remote source (SMB / external FTP). Seeded from the default profile.
  const [uploadIp, setUploadIp] = useState('');
  const [uploadDest, setUploadDest] = useState('/data/homebrew');
  useEffect(() => {
    if (!uploadIp && profiles.length) {
      const def = profiles.find(p => p.is_default) || profiles[0];
      if (def) setUploadIp(def.ip_address);
    }
  }, [profiles, uploadIp]);

  const [multiSelect, setMultiSelect] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [selectedFile, setSelectedFile] = useState(null);
  // menuOpen carries both the file name and the viewport-anchored style for
  // the floating ⋮ menu. We use position:fixed so the popover escapes the
  // scrollable list container (which used to clip menus on the last rows).
  const [menuOpen, setMenuOpen] = useState(null);
  const [menuStyle, setMenuStyle] = useState(null);

  const openMenu = (e, fileName) => {
    e.stopPropagation();
    if (menuOpen === fileName) { setMenuOpen(null); setMenuStyle(null); return; }
    // Adaptive placement. Prior behaviour anchored the menu's BOTTOM to the
    // button's BOTTOM, which made the menu pop upward — fine for rows at the
    // bottom of the viewport, but invisible (clipped above viewport top) for
    // rows in the middle/top. Now we prefer dropping DOWN from the button and
    // only flip up when there's clearly more room above (e.g. last row in a
    // long list). `position: fixed` is still used so the menu escapes the
    // file list's `overflow: auto` scroll container.
    const rect = e.currentTarget.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const right = Math.max(8, vw - rect.right);
    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;
    const style = spaceBelow >= spaceAbove
      ? { position: 'fixed', right, top: rect.bottom + 4, bottom: 'auto' }
      : { position: 'fixed', right, bottom: vh - rect.top + 4, top: 'auto' };
    setMenuStyle(style);
    setMenuOpen(fileName);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => { setMenuOpen(null); setMenuStyle(null); };
    const handler = (e) => {
      if (!e.target.closest('.file-menu')) close();
    };
    document.addEventListener('click', handler);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', handler);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuOpen]);

  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState('asc');

  const listRef = useRef(null);

  useEffect(() => {
    fetch(`${API}/convert/sources`).then(r => r.json()).then(rows => {
      // The "SMB" tab now lists every remote source (SMB + FTP). The backend
      // /sources/:id/browse endpoint handles both transports transparently.
      setSmbSources((rows || []).filter(s => s.type === 'smb' || s.type === 'ftp'));
    }).catch(() => {});
    fetch(`${API}/convert/local/roots`).then(r => r.json()).then(d => {
      setLocalRoots(d.roots || []);
    }).catch(() => {});
    fetch(`${API}/convert/browser-prefs`).then(r => r.json()).then(d => {
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
        r = await fetch(`${API}/convert/local/browse`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p }),
        });
      } else if (kind === 'smb') {
        if (!smbId) { setLoading(false); setError('Select SMB source'); return; }
        r = await fetch(`${API}/convert/sources/${smbId}/browse`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subPath: p }),
        });
      } else {
        if (!ftpIp) { setLoading(false); setError('Select PS5 IP'); return; }
        r = await fetch(`${API}/convert/ftp/browse`, {
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
      const r = await fetch(`${API}/convert/browser-prefs`, {
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
        r = await fetch(`${API}/convert/local/delete`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      } else if (kind === 'smb') {
        const sub = path ? `${path.replace(/\/+$/, '')}/${entry.name}` : entry.name;
        body = { path: sub, isDir: entry.isDir };
        r = await fetch(`${API}/convert/sources/${smbId}/delete`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      } else {
        const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
        body = { ip: ftpIp, path: fullPath, isDir: entry.isDir };
        r = await fetch(`${API}/convert/ftp/delete`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      }
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onNotification?.(`Deleted ${entry.name}`, 'success');
      browse(path);
    } catch (e) { onNotification?.(`Delete failed: ${e.message}`, 'error'); }
  };

  // Unified upload: handles files and folders from either local FS or a
  // configured remote (SMB / external FTP) source. Always enqueues into the
  // FTP upload queue - user starts/pauses jobs from the Queue tab.
  const uploadEntry = async (entry) => {
    if (kind === 'ftp') {
      onNotification?.('Items already on PS5 FTP - no upload needed', 'info');
      return;
    }
    if (!uploadIp) {
      onNotification?.('Pick a target PS5 first', 'error');
      return;
    }
    let body;
    if (kind === 'local') {
      const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
      body = { ip: uploadIp, local_path: fullPath, dest_path: uploadDest };
    } else if (kind === 'smb') {
      if (!smbId) { onNotification?.('Pick a remote source first', 'error'); return; }
      const sub = path ? `${path.replace(/\/+$/, '')}/${entry.name}` : entry.name;
      body = {
        ip: uploadIp,
        dest_path: uploadDest,
        source_id: Number(smbId),
        source_path: sub,
        is_dir: !!entry.isDir,
      };
    } else {
      return;
    }
    try {
      const r = await fetch(`${API}/convert/ftp/upload/queue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'upload queue failed');
      const n = d.count || (d.items?.length ?? 1);
      onNotification?.(
        n > 1
          ? `Queued ${n} files from ${entry.name} → ${uploadIp}${uploadDest}`
          : `Queued upload: ${entry.name} → ${uploadIp}${uploadDest}`,
        'success',
      );
    } catch (e) { onNotification?.(`Upload failed: ${e.message}`, 'error'); }
  };

  const uploadSelected = async () => {
    if (!uploadIp) { onNotification?.('Pick a target PS5 first', 'error'); return; }
    const list = Array.from(selected);
    if (list.length === 0) return;
    let ok = 0, fail = 0;
    for (const name of list) {
      const f = files.find(x => x.name === name);
      if (!f) { fail++; continue; }
      try { await uploadEntry(f); ok++; }
      catch (_) { fail++; }
    }
    onNotification?.(
      fail > 0 ? `Queued ${ok}, ${fail} failed` : `Queued ${ok} item(s) → ${uploadIp}${uploadDest}`,
      fail > 0 ? 'error' : 'success',
    );
    clearSelection();
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
      const r = await fetch(`${API}/convert/extract/queue`, {
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
        r = await fetch(`${API}/convert/local/import-file`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ local_path: fullPath }),
        });
      } else {
        r = await fetch(`${API}/convert/sources/${smbId}/import-file`, {
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
        r = await fetch(`${API}/convert/local/import-folder`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ local_path: fullPath }),
        });
      } else {
        r = await fetch(`${API}/convert/mkpfs/import-folder-from-smb`, {
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

  const pickConvert = (entry, intent = null) => {
    // Convert can run on local files/folders or PS5-FTP files/folders (the
    // backend stages an FTP source to a local temp dir before mkpfs and
    // pushes the result back automatically). SMB sources still need to be
    // imported first.
    //
    // `intent` may be 'now', 'queue', or null:
    //   - 'now'   → pre-select the Convert tab's "🚀 Convert now"   button
    //   - 'queue' → pre-select the Convert tab's "🕒 Add to queue"   button
    //   - null    → just pre-fill the form, let the user decide
    // The actual enqueue + queue pause/resume happens inside Convert.jsx so
    // the user can still tweak options (mode, compress, push target…) before
    // committing.
    if (kind === 'smb') {
      onNotification?.('For SMB sources, import the file first; convert reads from local fs or PS5 FTP.', 'info');
      return;
    }
    const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
    onPickConvert?.({ kind, ftpIp, path: fullPath, isDir: !!entry.isDir, name: entry.name, intent });
    onNotification?.(
      kind === 'ftp' && entry.isDir
        ? `Picked folder for convert: ${entry.name} (will stage from PS5 first)`
        : `Picked for convert: ${entry.name}`,
      'success',
    );
  };

  const deleteSelected = async () => {
    if (!window.confirm(`Delete ${selected.size} item(s)?`)) return;
    for (const name of selected) {
      const f = files.find(f => f.name === name);
      if (f) await deleteEntry(f);
    }
    clearSelection();
  };

  // Trigger a browser download via a hidden anchor. The backend streams the
  // file (or a zip for folders) with proper Content-Disposition, so the
  // browser shows the native "Save as" dialog.
  const downloadEntry = (entry) => {
    let url;
    if (kind === 'local') {
      const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
      url = `${API}/convert/local/download?path=${encodeURIComponent(fullPath)}`;
    } else if (kind === 'smb') {
      if (!smbId) { onNotification?.('Pick a remote source first', 'error'); return; }
      const sub = path ? `${path.replace(/\/+$/, '')}/${entry.name}` : entry.name;
      url = `${API}/convert/sources/${smbId}/download?path=${encodeURIComponent(sub)}&isDir=${entry.isDir ? 1 : 0}`;
    } else if (kind === 'ftp') {
      if (!ftpIp) { onNotification?.('Pick a PS5 first', 'error'); return; }
      const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
      url = `${API}/convert/ftp/download?ip=${encodeURIComponent(ftpIp)}&path=${encodeURIComponent(fullPath)}&isDir=${entry.isDir ? 1 : 0}`;
    } else {
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    // Hint to the browser that this is a download, not a navigation. Some
    // browsers ignore Content-Disposition on same-origin links without this
    // attribute (especially when the URL has no path-based filename).
    a.download = entry.isDir ? `${entry.name}.zip` : entry.name;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    onNotification?.(`Download started: ${entry.name}${entry.isDir ? ' (zip)' : ''}`, 'info');
  };

  // ------------------------------------------------------------------
  // Queue control + one-click enqueue helpers used by the kebab menu.
  // Semantics shared across Upload / Convert / Extract / Download:
  //   "X now"   → enqueue + resume the queue (auto-start)
  //   "X queue" → enqueue + pause  the queue (user starts manually later)
  // ------------------------------------------------------------------

  const QUEUE_PATHS = {
    upload:  '/api/convert/ftp/upload/queue',
    convert: '/api/convert/convert/queue',
    extract: '/api/convert/extract/queue',
    download:'/api/downloader/queue',
  };

  const setQueueRunning = async (type, running) => {
    const base = QUEUE_PATHS[type];
    if (!base) return;
    try {
      await fetch(`${base}/${running ? 'resume' : 'pause'}`, { method: 'POST' });
    } catch (_) { /* best-effort; the user sees the queue tab anyway */ }
  };

  // (Convert defaults are now applied inside Convert.jsx after the user picks
  // a target file/folder via the kebab menu, so we no longer need a
  // one-click enqueue helper here — `pickConvert` hands the entry over with
  // an intent ('now' / 'queue' / null) and the Convert tab arms the matching
  // action button.)

  // One-click unpack — reverse of pack. mkpfs unpack pulls the .ffpfsc image
  // apart into a folder next to it. Output folder name defaults to
  // <basename>-extracted. SMB sources need to be imported first (mkpfs needs
  // a local seekable input); PS5 FTP is supported via the staging dance.
  const enqueueUnpackDefault = async (entry) => {
    if (entry.isDir || !isPfsImage(entry.name)) {
      onNotification?.('Unpack expects a .ffpfsc/.ffpfs/.pfs file', 'error');
      return false;
    }
    const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
    // Output folder mirrors the pack convention (Game.exfat → Game.ffpfsc),
    // so .ffpfsc → folder named exactly Game/. No `-extracted` / `-final`
    // suffix — keep round-trips clean.
    const base = entry.name.replace(/\.(ffpfs|ffpfsc|pfs|dat|bin)$/i, '').replace(/[^A-Za-z0-9_.\-]/g, '_');
    const body = {
      mode: 'unpack',
      output_name: base,
      push_after: false,
    };
    if (kind === 'ftp') {
      if (!ftpIp) { onNotification?.('Select a PS5 first', 'error'); return false; }
      body.source_ftp = { ip: ftpIp, path: fullPath };
    } else if (kind === 'smb') {
      if (!smbId) { onNotification?.('Pick an SMB source first', 'error'); return false; }
      // Backend stages the .ffpfsc from the SMB share into a per-job temp dir
      // (smbclient one-shot get) and then runs mkpfs against the local copy.
      // Result lands in the mkpfs work dir, not back on the share.
      body.source_smb = { source_id: Number(smbId), path: fullPath };
    } else {
      body.source_path = fullPath;
    }
    try {
      const r = await fetch(`${API}/convert/convert/queue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'unpack queue failed');
      return true;
    } catch (e) { onNotification?.(`Unpack failed: ${e.message}`, 'error'); return false; }
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

    // Unified menu — for every queue-able operation the user gets two entries:
    //   "X now"   = enqueue + resume the queue   (auto-starts)
    //   "X queue" = enqueue + pause  the queue   (user must press ▶)
    // Items that don't apply for the current (kind, file type) combination
    // are filtered out entirely so the menu only shows actionable options.
    const canUpload   = kind !== 'ftp' && enableFtpUpload;       // not already on PS5
    const canDownload = kind !== 'local';                        // local files don't need a "download to your device" round-trip
    const canConvert  = kind !== 'smb';                          // SMB pack still needs Import (mkpfs needs seekable local source + folder traversal)
    const canExtract  = enableExtract && kind !== 'ftp' && !f.isDir && archiveFile;
    const pfsImage    = !f.isDir && isPfsImage(f.name);
    // Unpack works on local, PS5 FTP, and SMB (backend stages SMB → local
    // temp dir via smbclient before mkpfs runs). SMB only requires that an
    // SMB source is selected.
    const canUnpack   = !f.isDir && pfsImage && (kind !== 'smb' || !!smbId);

    const runUpload = async (auto) => {
      const ok = await uploadEntry(f);
      // uploadEntry returns nothing today — best-effort assume success unless
      // it surfaced an error via onNotification.
      await setQueueRunning('upload', auto);
      if (!auto) onNotification?.(`Upload queued for ${f.name} — press ▶ in Queue to start`, 'info');
    };
    // Convert now/queue used to enqueue with defaults immediately. UX feedback
    // showed users wanted a chance to tweak push target / advanced options
    // first, so both actions now just pick the entry into the Convert tab and
    // hand off the user's chosen intent ('now' = start, 'queue' = add paused).
    // Convert.jsx renders the matching action button highlighted.
    const sendToConvertWithIntent = (intent) => () => pickConvert(f, intent);
    const runExtract = async (auto) => {
      await startExtract(f.name);
      await setQueueRunning('extract', auto);
      if (!auto) onNotification?.(`Extract queued for ${f.name} — press ▶ in Queue to start`, 'info');
    };
    const runUnpack = async (auto) => {
      const ok = await enqueueUnpackDefault(f);
      if (!ok) return;
      // Unpack jobs share the convert queue (mkpfs only).
      await setQueueRunning('convert', auto);
      onNotification?.(
        auto ? `Unpacking ${f.name} — started` : `Unpack queued for ${f.name} — press ▶ in Queue to start`,
        auto ? 'success' : 'info',
      );
    };

    const secondaryActions = [
      // Each action is wrapped in a boolean guard so non-applicable items
      // are filtered out entirely (no greyed-out rows). Order is preserved
      // so the menu still feels stable across (kind, file-type) variations.
      canUpload && {
        label: '⬆ Upload now',
        action: () => runUpload(true),
        title: `Queue upload to ${uploadIp || 'PS5'} and start immediately`,
      },
      canUpload && {
        label: '🕒 Upload queue',
        action: () => runUpload(false),
        title: `Queue upload to ${uploadIp || 'PS5'} and pause — press ▶ in Queue when ready`,
      },
      canDownload && {
        label: '⬇ Download now',
        action: () => downloadEntry(f),
        title: f.isDir
          ? 'Download as ZIP to your device (immediate, via your browser)'
          : 'Download file to your device (immediate, via your browser)',
      },
      canDownload && onOpenQueue && {
        label: '🕒 Download queue',
        action: () => onOpenQueue?.('download'),
        title: 'Open the Tasks tab — manages background URL downloads from the Download tab',
      },
      canConvert && {
        label: '🔄 Convert now',
        action: sendToConvertWithIntent('now'),
        title: 'Pick this file/folder, switch to the Convert tab and pre-arm the "Convert now" button',
      },
      canConvert && {
        label: '🕒 Convert queue',
        action: sendToConvertWithIntent('queue'),
        title: 'Pick this file/folder, switch to the Convert tab and pre-arm the "Add to queue" button',
      },
      canUnpack && {
        label: '📂 Unpack now',
        action: () => runUnpack(true),
        title: 'Unpack .ffpfsc back into a folder (mkpfs unpack) and start now',
      },
      canUnpack && {
        label: '🕒 Unpack queue',
        action: () => runUnpack(false),
        title: 'Unpack .ffpfsc back into a folder and pause — press ▶ in Queue when ready',
      },
      canExtract && {
        label: '📦 Extract now',
        action: () => runExtract(true),
        title: 'Extract this archive and start now',
      },
      canExtract && {
        label: '🕒 Extract queue',
        action: () => runExtract(false),
        title: 'Extract this archive and pause — press ▶ in Queue when ready',
      },
      // Context-specific extras below the standardised actions.
      f.isDir && enablePickDir && kind !== 'ftp' && { label: '✓ Pick folder', action: () => pickDir(f) },
      f.isDir && enableImportFolder && kind !== 'ftp' && { label: '📥 Import folder', action: () => importFolder(f.name) },
      !f.isDir && enableImportFile && kind !== 'ftp' && { label: '📥 Import file', action: () => importFile(f.name) },
      enablePickConvert && { label: '⚙ Open in Convert tab', action: () => pickConvert(f), title: 'Pre-fill the Convert form to customise options' },
      enableDelete && { label: '🗑 Delete', action: () => deleteEntry(f), danger: true },
    ].filter(Boolean);

    return (
      <div
        key={f.name}
        data-file={f.name}
        className={`file-card ${isSelected ? 'file-card-selected' : ''} ${isActive ? 'file-card-active' : ''}`}
        onClick={() => {
          if (multiSelect) { toggleSelect(f.name); return; }
          if (f.isDir) open(f);
        }}
        style={{ position: 'relative', cursor: (multiSelect || f.isDir) ? 'pointer' : 'default' }}
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

          {secondaryActions.length > 0 && (
            <div onClick={(e) => e.stopPropagation()}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={(e) => openMenu(e, f.name)}
                style={{ minWidth: 36 }}
              >
                ⋮
              </button>
              {menuOpen === f.name && menuStyle && createPortal(
                // Portalled to <body> so `position: fixed` stays viewport-
                // relative even when an ancestor (`.app-main > *` has a
                // page-in `transform` animation) creates its own containing
                // block. Without this, the menu would render offset or be
                // clipped — especially inside the Convert tab and PS5 FTP
                // view, where the FileBrowser sits deep in the DOM.
                <div className="file-menu" style={menuStyle}>
                  {secondaryActions.length === 0 && (
                    <div className="file-menu-empty">
                      No actions available for this item
                    </div>
                  )}
                  {secondaryActions.map((action, i) => (
                    <button
                      key={i}
                      className={`file-menu-item ${action.danger ? 'text-danger' : ''}`}
                      title={action.title || action.label}
                      onClick={() => {
                        action.action();
                        setMenuOpen(null);
                        setMenuStyle(null);
                      }}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>,
                document.body,
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
          <button className={`tab-item ${kind === 'smb' ? 'active' : ''}`} onClick={() => setKind('smb')}>📡 Remote</button>
          {enableFtp && <button className={`tab-item ${kind === 'ftp' ? 'active' : ''}`} onClick={() => setKind('ftp')}>🎮 PS5 FTP</button>}
        </div>

        {kind === 'smb' && (
          <select className="select" value={smbId} onChange={e => setSmbId(e.target.value)}>
            <option value="">— pick remote source —</option>
            {smbSources.map(s => (
              <option key={s.id} value={s.id}>{s.type === 'ftp' ? '🌐 FTP' : '📂 SMB'} · {s.name}</option>
            ))}
          </select>
        )}

        {/* Upload widget: picks PS5 + destination used by the per-file and
            bulk Upload actions. Only shown when uploading is reachable
            (local files or a selected remote SMB/FTP source) AND the
            parent screen enabled uploads via enableFtpUpload. */}
        {enableFtpUpload && (kind === 'local' || (kind === 'smb' && smbId)) && (
          <div className="flex gap-sm flex-wrap items-end p-sm" style={{ background: 'var(--panel2)', borderRadius: 8 }}>
            <div className="flex-1" style={{ minWidth: 160 }}>
              <label className="text-xs text-muted mb-xs" style={{ display: 'block' }}>📤 Upload target PS5</label>
              <select className="select" value={uploadIp} onChange={e => setUploadIp(e.target.value)}>
                <option value="">— select —</option>
                {profiles.map(p => <option key={p.id} value={p.ip_address}>{p.name} ({p.ip_address})</option>)}
              </select>
            </div>
            <div className="flex-1" style={{ minWidth: 180 }}>
              <label className="text-xs text-muted mb-xs" style={{ display: 'block' }}>Destination on PS5</label>
              <input className="input" value={uploadDest} onChange={e => setUploadDest(e.target.value)} placeholder="/data/homebrew" />
            </div>
          </div>
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
            {enableFtpUpload && ((kind === 'smb' && smbId) || kind === 'local') && uploadIp && (
              <button className="btn btn-sm btn-success" onClick={uploadSelected}>⬆ Upload to PS5</button>
            )}
            <button className="btn btn-sm btn-danger" onClick={deleteSelected}>🗑 Delete</button>
            <button className="btn btn-sm btn-ghost" onClick={clearSelection}>✕ Cancel</button>
          </div>
        )}

      </div>
    </div>
  );
}
