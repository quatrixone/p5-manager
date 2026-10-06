import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import Modal from './UI/Modal';
import { BrowseButton } from './UI/PathField';
import { api, apiSafe } from '../lib/api.js';
import { entriesFromInput, topLevelNames, uploadOne } from '../lib/browserUpload.js';
import { crumbsOf } from '../lib/localPath.js';

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

// Download links are plain <a href>, so they bypass the api wrapper and
// need the prefix spelled out.
const API = '/api';

const isArchive = (n) => /\.(rar|7z|zip|tar\.gz|tgz|tar|r\d{2}|part\d+\.rar)$/i.test(n);
const isPfsImage = (n) => /\.(ffpfs|ffpfsc|pfs|dat|bin)$/i.test(n);
const isPkgFile  = (n) => /\.pkg$/i.test(n);

export default function FileBrowser({
  profiles = [],
  onNotification,
  enableFtp = false,
  enableExtract = false,
  enableDelete = false,
  enableImportFile = false,
  enableImportFolder = false,
  enablePickDir = false,
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
  // Dual-pane mode (DualPane.jsx) - all optional, a lone browser ignores them.
  //   paneId            'left' | 'right', echoed in drag payloads
  //   initialLocation   { kind, ftpIp, smbId, path } to open instead of the defaults
  //   onLocationChange  (loc) => void, fired whenever the open folder changes
  //   onDropItems       (payload, destPath, { x, y }) => void, makes rows draggable
  //                     and this pane (and its folder rows) a drop target
  //   onSendToOther     (op, payload) => void, touch fallback for drag & drop
  //   reloadSignal      bump to re-list the current folder
  //   enableDeviceUpload  show "⬆ Upload": files/folders from the device running
  //                       the browser into the folder that is open here
  enableDeviceUpload = false,
  paneId,
  initialLocation,
  onLocationChange,
  onDropItems,
  onSendToOther,
  reloadSignal,
}) {
  const [smbSources, setSmbSources] = useState([]);
  const [localRoots, setLocalRoots] = useState([]);
  const [browserPrefs, setBrowserPrefs] = useState({ local: '', smb: {} });

  const [kind, setKind] = useState(initialLocation?.kind || defaultKind);
  const [smbId, setSmbId] = useState(initialLocation?.smbId ? String(initialLocation.smbId) : '');
  const [ftpIp, setFtpIp] = useState(initialLocation?.ftpIp || '');
  // Folder to reopen for the store `initialLocation` points at; dropped as
  // soon as the user switches to another store.
  const initialRef = useRef(initialLocation?.path ? initialLocation : null);

  const [pathInput, setPathInput] = useState('/mnt');
  const [path, setPath] = useState('/mnt');
  const [files, setFiles] = useState([]);
  const [parent, setParent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // PS5 FTP only: the backend may be sending zftpd and waiting for its port,
  // which takes a few seconds - say so instead of a silent "loading…".
  const [ftpSlow, setFtpSlow] = useState(false);
  useEffect(() => {
    if (!(loading && kind === 'ftp')) { setFtpSlow(false); return; }
    const t = setTimeout(() => setFtpSlow(true), 1500);
    return () => clearTimeout(t);
  }, [loading, kind]);

  const [extractPwd, setExtractPwd] = useState('');
  const [extractDeleteAfter, setExtractDeleteAfter] = useState(false);

  // Upload-to-PS5 target. Used by the unified Upload action that handles
  // files and folders coming from either the local FS or any configured
  // remote source (SMB / external FTP). Sourced from the global Settings
  // ("Local upload target") - configure once there, the kebab Upload
  // actions reuse it everywhere. We still fall back to the default
  // profile's IP when the user hasn't filled the setting yet.
  const [uploadIp, setUploadIp] = useState('');
  const [uploadDest, setUploadDest] = useState('/data/homebrew');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await apiSafe.get('/settings');
      if (cancelled || !data) return;
      if (data.upload_target_ip) setUploadIp(data.upload_target_ip);
      if (data.upload_target_path) setUploadDest(data.upload_target_path);
    })();
    return () => { cancelled = true; };
  }, []);
  // Fall back to the default profile if Settings didn't supply an IP -
  // keeps existing single-PS5 setups working without forcing them to
  // visit Settings → Config first.
  useEffect(() => {
    if (!uploadIp && profiles.length) {
      const def = profiles.find(p => p.is_default) || profiles[0];
      if (def) setUploadIp(def.ip_address);
    }
  }, [profiles, uploadIp]);

  const [multiSelect, setMultiSelect] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [selectedFile, setSelectedFile] = useState(null);

  // Cut/Copy/Paste clipboard. Single global slot - copying again
  // replaces what was there. We snapshot the source context (kind,
  // smbId, ftpIp, sourcePath) at copy/cut time so the user can browse
  // around freely without losing the reference. Paste is restricted to
  // the same kind+source identifier (FTP/SMB can't paste into local
  // via rename - that path goes through the upload queue already).
  const [clipboard, setClipboard] = useState(null);
  const [pasteBusy, setPasteBusy] = useState(false);
  // menuOpen carries both the file name and the viewport-anchored style for
  // the floating ⋮ menu. We use position:fixed so the popover escapes the
  // scrollable list container (which used to clip menus on the last rows).
  const [menuOpen, setMenuOpen] = useState(null);
  const [menuStyle, setMenuStyle] = useState(null);

  // Rename / Show Info modal state. `renameTarget` and `infoTarget` carry the
  // full entry the user clicked on. `renameValue` mirrors the input field
  // so we can validate before issuing the move request.
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [infoTarget, setInfoTarget] = useState(null);

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
    // Phones get a bottom sheet instead (styled via .file-menu-sheet), so
    // no anchoring is needed there.
    if (window.innerWidth <= 768) {
      setMenuStyle({ sheet: true });
      setMenuOpen(fileName);
      return;
    }
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
    // Scrolling the menu's own (overflowing) list must not dismiss it.
    const onScroll = (e) => { if (!e.target?.closest?.('.file-menu')) close(); };
    document.addEventListener('click', handler);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', handler);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [menuOpen]);

  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState('asc');

  const listRef = useRef(null);

  // Mobile nav row shows breadcrumbs by default; this flips it to the raw
  // path input (from the ⋯ sheet or by tapping the current crumb).
  const [editingPath, setEditingPath] = useState(false);
  const crumbsRef = useRef(null);

  // Long-press on a row (touch only) enters selection mode and picks that
  // row. `longPressed` swallows the click that follows the touch release so
  // the row isn't immediately toggled back / the folder opened.
  const pressTimer = useRef(null);
  const longPressed = useRef(false);
  const pressStart = useRef(null);
  const startPress = (e, name) => {
    const t = e.touches[0];
    pressStart.current = { x: t.clientX, y: t.clientY };
    longPressed.current = false;
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      longPressed.current = true;
      setMultiSelect(true);
      setSelected(prev => new Set(prev).add(name));
      navigator.vibrate?.(15);
    }, 450);
  };
  const cancelPress = () => clearTimeout(pressTimer.current);
  // A resting finger jitters by a pixel or two - only a real drag (scroll)
  // should abort the press.
  const movePress = (e) => {
    const t = e.touches[0], s0 = pressStart.current;
    if (!s0 || Math.abs(t.clientX - s0.x) > 10 || Math.abs(t.clientY - s0.y) > 10) cancelPress();
  };
  useEffect(() => () => clearTimeout(pressTimer.current), []);

  useEffect(() => {
    // The "SMB" tab now lists every remote source (SMB + FTP). The backend
    // /sources/:id/browse endpoint handles both transports transparently.
    apiSafe.get('/convert/sources').then(rows => {
      setSmbSources((rows || []).filter(s => s.type === 'smb' || s.type === 'ftp'));
    });
    apiSafe.get('/convert/local/roots').then(d => { if (d) setLocalRoots(d.roots || []); });
    apiSafe.get('/convert/browser-prefs').then(d => {
      if (d) setBrowserPrefs({ local: d.local || '', smb: d.smb || {} });
    });
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
    setEditingPath(false);
    try {
      let d;
      if (kind === 'local') {
        d = await api.post('/convert/local/browse', { path: p });
      } else if (kind === 'smb') {
        if (!smbId) { setLoading(false); setError('Select SMB source'); return; }
        d = await api.post(`/convert/sources/${smbId}/browse`, { subPath: p });
      } else {
        if (!ftpIp) { setLoading(false); setError('Select PS5 IP'); return; }
        d = await api.post('/convert/ftp/browse', { ip: ftpIp, path: p });
        if (d.ftp_started) onNotification?.('FTP was not running on the console - started zftpd', 'info');
      }
      setPath(d.path); setPathInput(d.path);
      setFiles(d.files || []); setParent(d.parent);
    } catch (e) { setError(e.message); setFiles([]); }
    finally { setLoading(false); }
  }, [kind, smbId, ftpIp]);

  useEffect(() => {
    const init = initialRef.current;
    const initHere = init && init.kind === kind
      && String(init.smbId || '') === String(smbId || '')
      && (init.kind !== 'ftp' || init.ftpIp === ftpIp);
    if (init && !initHere) initialRef.current = null;
    if (kind === 'local') {
      const p = (initHere && init.path) || browserPrefs.local || '/mnt';
      setPathInput(p); setPath(p); browse(p);
    } else if (kind === 'smb' && smbId) {
      const def = (initHere && init.path) || browserPrefs.smb?.[smbId] || '';
      setPathInput(def); setPath(def); browse(def);
    } else if (kind === 'ftp' && ftpIp) {
      const p = (initHere && init.path) || '/data';
      setPathInput(p); setPath(p); browse(p);
    } else { setFiles([]); setPath(''); setParent(null); }
  }, [kind, smbId, ftpIp, browserPrefs.local]);

  // ─── Dual-pane plumbing ──────────────────────────────────────────────
  const onLocationChangeRef = useRef(onLocationChange);
  onLocationChangeRef.current = onLocationChange;
  useEffect(() => {
    onLocationChangeRef.current?.({ kind, ftpIp, smbId, path });
  }, [kind, ftpIp, smbId, path]);

  const pathRef = useRef(path);
  pathRef.current = path;
  const firstReload = useRef(true);
  useEffect(() => {
    if (firstReload.current) { firstReload.current = false; return; }
    browse(pathRef.current);
  }, [reloadSignal]);

  // ─── Upload from this device ─────────────────────────────────────────
  // Runs in the page (not the server queue): closing the tab stops it.
  const filesInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const uploadAbortRef = useRef(null);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [deviceUpload, setDeviceUpload] = useState(null); // { index, total, name, sent, bytes }
  const canDeviceUpload = enableDeviceUpload && (kind === 'local' || (kind === 'ftp' && !!ftpIp)) && !!path;
  const startDeviceUpload = async (fileList) => {
    const entries = entriesFromInput(fileList);
    if (entries.length === 0) return;
    const dest = kind === 'ftp' ? { kind: 'ftp', ip: ftpIp, path } : { kind: 'local', path };
    const clash = topLevelNames(entries).filter(n => files.some(f => f.name === n));
    if (clash.length > 0) {
      const shown = clash.slice(0, 5).join(', ') + (clash.length > 5 ? ` and ${clash.length - 5} more` : '');
      if (!window.confirm(`Already in this folder: ${shown}.\n\nOverwrite?`)) return;
    }
    const bytes = entries.reduce((n, e) => n + e.file.size, 0);
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    let done = 0;
    let failed = null;
    for (let i = 0; i < entries.length; i++) {
      const { file, rel } = entries[i];
      setDeviceUpload({ index: i + 1, total: entries.length, name: rel, sent: done, bytes });
      try {
        await uploadOne({
          file, rel, dest, overwrite: clash.length > 0, signal: controller.signal,
          onProgress: (loaded) => setDeviceUpload(u => (u ? { ...u, sent: done + loaded } : u)),
        });
        done += file.size;
      } catch (e) {
        failed = e;
        break;
      }
    }
    uploadAbortRef.current = null;
    setDeviceUpload(null);
    if (failed?.cancelled) onNotification?.('Upload cancelled', 'info');
    else if (failed) onNotification?.(`Upload failed: ${failed.message}`, 'error');
    else onNotification?.(`Uploaded ${entries.length} file${entries.length === 1 ? '' : 's'}`, 'success');
    browse(pathRef.current);
  };
  const onDeviceFilesPicked = (e) => {
    const list = e.target.files;
    setUploadMenuOpen(false);
    startDeviceUpload(list);
    e.target.value = ''; // let the same file be picked again
  };

  // New folder in the open folder (server disk or console; remote sources
  // have no mkdir endpoint).
  const canMakeFolder = enableDeviceUpload && (kind === 'local' || (kind === 'ftp' && !!ftpIp)) && !!path;
  const makeFolder = async () => {
    const name = (window.prompt('New folder name') || '').trim();
    if (!name) return;
    if (/[\\/]/.test(name) || name === '.' || name === '..') {
      onNotification?.('Folder name cannot contain slashes', 'error');
      return;
    }
    if (files.some(f => f.name === name)) {
      onNotification?.(`"${name}" already exists here`, 'error');
      return;
    }
    try {
      if (kind === 'local') await api.post('/convert/local/mkdir', { path: childPath(name) });
      else await api.post('/convert/ftp/mkdir', { ip: ftpIp, path: childPath(name) });
      onNotification?.(`Created folder ${name}`, 'success');
      browse(pathRef.current);
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const DRAG_MIME = 'application/x-p5m-items';
  const dragEnabled = !!onDropItems;
  // 'pane' | folder name | null - what a dragged selection currently hovers.
  const [dropTarget, setDropTarget] = useState(null);
  const childPath = (name) => (kind === 'local'
    ? (path === '/' ? `/${name}` : `${path.replace(/\/$/, '')}/${name}`)
    : (path ? `${path.replace(/\/+$/, '')}/${name}` : name));
  const buildTransferPayload = (names) => ({
    pane: paneId, kind, ftpIp, smbId, path,
    items: names
      .map(n => files.find(f => f.name === n))
      .filter(Boolean)
      .map(f => ({ name: f.name, isDir: !!f.isDir, size: f.size || 0 })),
  });
  const isTransferDrag = (e) => dragEnabled && Array.from(e.dataTransfer?.types || []).includes(DRAG_MIME);
  const onRowDragStart = (e, f) => {
    const names = selected.has(f.name) ? Array.from(selected) : [f.name];
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(buildTransferPayload(names)));
    e.dataTransfer.effectAllowed = 'copyMove';
  };
  const onTargetDragOver = (e, target) => {
    if (!isTransferDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (dropTarget !== target) setDropTarget(target);
  };
  const onTargetDrop = (e, destPath) => {
    if (!isTransferDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData(DRAG_MIME)); } catch (_) { return; }
    if (!payload?.items?.length) return;
    onDropItems(payload, destPath, { x: e.clientX, y: e.clientY });
  };

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
      await api.put('/convert/browser-prefs', next);
      setBrowserPrefs(next);
      onNotification?.(`Default saved: ${path}`, 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const navigateBreadcrumb = (segmentPath) => {
    browse(segmentPath);
  };

  const getBreadcrumbs = () => crumbsOf(path);

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

  const allSelected = files.length > 0 && selected.size === files.length;
  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(files.map(f => f.name)));
  };

  const toggleMultiSelect = () => {
    if (multiSelect) {
      clearSelection();
    } else {
      setMultiSelect(true);
    }
  };

  // Transport-specific delete, no confirm / notification - shared by the
  // single-entry and bulk paths.
  const deleteOne = async (entry) => {
    if (kind === 'local') {
      const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
      await api.post('/convert/local/delete', { path: fullPath, isDir: entry.isDir });
    } else if (kind === 'smb') {
      const sub = path ? `${path.replace(/\/+$/, '')}/${entry.name}` : entry.name;
      await api.post(`/convert/sources/${smbId}/delete`, { path: sub, isDir: entry.isDir });
    } else {
      const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
      await api.post('/convert/ftp/delete', { ip: ftpIp, path: fullPath, isDir: entry.isDir });
    }
  };

  const deleteEntry = async (entry) => {
    if (!window.confirm(`Delete ${entry.isDir ? 'folder' : 'file'}\n${entry.name}?`)) return;
    try {
      await deleteOne(entry);
      onNotification?.(`Deleted ${entry.name}`, 'success');
      browse(path);
    } catch (e) { onNotification?.(`Delete failed: ${e.message}`, 'error'); }
  };

  // Open the rename modal. Pre-fills the input with the current name and
  // pre-selects the basename part (everything before the last '.') so the
  // user lands directly on the editable portion for files; folders get the
  // full name selected.
  const openRename = (entry) => {
    setRenameTarget(entry);
    setRenameValue(entry.name);
  };

  // Commit the rename. Reuses the existing /move endpoint for each transport
  // since "rename" is just "move with same parent dir, different basename".
  // Validation rules:
  //   - new name must not be empty
  //   - must not contain '/' (would change directory; use Cut+Paste for that)
  //   - same as old → no-op
  const confirmRename = async () => {
    const target = renameTarget;
    if (!target) return;
    const newName = (renameValue || '').trim();
    if (!newName) { onNotification?.('Name cannot be empty', 'error'); return; }
    if (newName.includes('/') || newName.includes('\\')) {
      onNotification?.('Name cannot contain "/" or "\\"', 'error');
      return;
    }
    if (newName === target.name) { setRenameTarget(null); return; }

    setRenameBusy(true);
    try {
      const src = joinEntryPath(path, target.name);
      const dst = joinEntryPath(path, newName);
      if (kind === 'local') {
        await api.post('/convert/local/move', { src, dst, isDir: !!target.isDir });
      } else if (kind === 'ftp') {
        if (!ftpIp) throw new Error('Select PS5 first');
        await api.post('/convert/ftp/move', { ip: ftpIp, src, dst });
      } else {
        if (!smbId) throw new Error('Select remote source first');
        await api.post(`/convert/sources/${smbId}/move`, { src, dst });
      }
      onNotification?.(`Renamed → ${newName}`, 'success');
      setRenameTarget(null);
      browse(path);
    } catch (e) {
      onNotification?.(`Rename failed: ${e.message}`, 'error');
    } finally {
      setRenameBusy(false);
    }
  };

  // Show Info just opens a read-only modal with the metadata we already have
  // on the entry row (name, size, mtime, isDir) plus the full path. No
  // backend round-trip required.
  const showInfo = (entry) => setInfoTarget(entry);

  // Unified upload: handles files and folders from either local FS or a
  // configured remote (SMB / external FTP) source. Always enqueues into the
  // FTP upload queue - user starts/pauses jobs from the Queue tab.
  const uploadEntry = async (entry) => {
    if (kind === 'ftp') {
      onNotification?.('Items already on PS5 FTP - no upload needed', 'info');
      return;
    }
    if (!uploadIp) {
      onNotification?.('No upload target PS5 set - configure it in Settings → Config → Local upload target', 'error');
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
      const d = await api.post('/convert/ftp/upload/queue', body);
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
    if (!uploadIp) { onNotification?.('No upload target PS5 set - configure it in Settings → Config → Local upload target', 'error'); return; }
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
      await api.post('/convert/extract/queue', body);
      onNotification?.(`Extract added to queue: ${filename}`, 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const importFile = async (filename) => {
    if (kind === 'ftp') return;
    try {
      let d;
      if (kind === 'local') {
        const fullPath = path === '/' ? `/${filename}` : `${path.replace(/\/$/, '')}/${filename}`;
        d = await api.post('/convert/local/import-file', { local_path: fullPath });
      } else {
        d = await api.post(`/convert/sources/${smbId}/import-file`, { smb_path: path, filename });
      }
      onNotification?.(`Imported ${filename}`, 'success');
      onImported?.(d);
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const importFolder = async (folderName) => {
    if (kind === 'ftp') return;
    try {
      let d;
      if (kind === 'local') {
        const fullPath = path === '/' ? `/${folderName}` : `${path.replace(/\/$/, '')}/${folderName}`;
        d = await api.post('/convert/local/import-folder', { local_path: fullPath });
      } else {
        d = await api.post('/convert/mkpfs/import-folder-from-smb', {
          source_id: smbId, smb_path: path, folder_name: folderName,
        });
      }
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
    let ok = 0, fail = 0;
    for (const name of selected) {
      const f = files.find(f => f.name === name);
      if (!f) continue;
      try { await deleteOne(f); ok++; }
      catch (_) { fail++; }
    }
    onNotification?.(
      fail > 0 ? `Deleted ${ok}, ${fail} failed` : `Deleted ${ok} item(s)`,
      fail > 0 ? 'error' : 'success',
    );
    clearSelection();
    browse(path);
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
    upload:  '/convert/ftp/upload/queue',
    convert: '/convert/convert/queue',
    extract: '/convert/extract/queue',
    download:'/downloader/queue',
    install: '/convert/install/queue',
  };

  const setQueueRunning = async (type, running) => {
    const base = QUEUE_PATHS[type];
    if (!base) return;
    await apiSafe.post(`${base}/${running ? 'resume' : 'pause'}`);
  };

  // (Convert defaults are now applied inside Convert.jsx after the user picks
  // a target file/folder via the kebab menu, so we no longer need a
  // one-click enqueue helper here — `pickConvert` hands the entry over with
  // an intent ('now' / 'queue' / null) and the Convert tab arms the matching
  // action button.)

  // One-click install — sends a .pkg through the install queue. Backend will
  // stage to PS5 (or skip staging when source is already on PS5), then
  // trigger the configured installer payload. Preflight check ensures the
  // user sees a clear "configure installer payload in Settings" error
  // before we drop ten queued .pkg files that all fail the same way.
  const installEntry = async (entry) => {
    if (entry.isDir || !isPkgFile(entry.name)) {
      onNotification?.('Install expects a .pkg file', 'error');
      return false;
    }
    // Preflight: confirm an installer payload + stage dir are configured.
    try {
      await api.get('/convert/install/preflight');
    } catch (e) {
      onNotification?.(`Install setup: ${e.message}`, 'error');
      return false;
    }
    // We need a target PS5 IP. For ftp/local kinds we already track this
    // (uploadIp for local/SMB → PS5 upload; ftpIp for PS5 FTP browsing).
    const targetIp = kind === 'ftp' ? ftpIp : uploadIp;
    if (!targetIp) {
      onNotification?.('Pick a target PS5 first', 'error');
      return false;
    }

    let body;
    if (kind === 'local') {
      const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
      body = { ip: targetIp, source_kind: 'local', local_path: fullPath, pkg_name: entry.name };
    } else if (kind === 'ftp') {
      const fullPath = path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`;
      body = { ip: targetIp, source_kind: 'ftp', source_remote_path: fullPath, pkg_name: entry.name };
    } else if (kind === 'smb') {
      if (!smbId) { onNotification?.('Pick a remote source first', 'error'); return false; }
      const sub = path ? `${path.replace(/\/+$/, '')}/${entry.name}` : entry.name;
      body = {
        ip: targetIp,
        source_kind: 'remote-smb',
        source_id: Number(smbId),
        source_remote_path: sub,
        pkg_name: entry.name,
      };
    } else {
      onNotification?.('Install: unsupported source type', 'error');
      return false;
    }

    try {
      await api.post('/convert/install/queue', body);
      onNotification?.(`Install queued: ${entry.name} → ${targetIp}`, 'success');
      return true;
    } catch (e) {
      onNotification?.(`Install failed: ${e.message}`, 'error');
      return false;
    }
  };

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
      await api.post('/convert/convert/queue', body);
      return true;
    } catch (e) { onNotification?.(`Unpack failed: ${e.message}`, 'error'); return false; }
  };

  // ------------------------------------------------------------------
  // Cut / Copy / Paste
  // ------------------------------------------------------------------

  // Build the full path for an entry within a given path/kind context.
  // Mirrors how `open()` / `deleteEntry()` compose the path so the
  // backend sees identical strings regardless of which UI action
  // triggers them.
  const joinEntryPath = (basePath, name) =>
    basePath === '/' ? `/${name}` : `${(basePath || '').replace(/\/+$/, '')}/${name}`;

  // Returns true when the current view targets the same logical source
  // as the clipboard's snapshot. Pasting across a different source kind
  // (or different SMB share / different PS5) would have to go through
  // the queue worker; we surface the existing upload kebab actions for
  // that case rather than overload paste.
  const clipboardMatchesCurrent = () => {
    if (!clipboard) return false;
    if (clipboard.kind !== kind) return false;
    if (kind === 'smb') return String(clipboard.smbId) === String(smbId);
    if (kind === 'ftp') return clipboard.ftpIp === ftpIp;
    return true;
  };

  const stashClipboard = (operation, items, ctx = {}) => {
    const snapshot = items.map(f => ({ name: f.name, isDir: !!f.isDir }));
    setClipboard({
      operation,
      kind,
      smbId: kind === 'smb' ? smbId : null,
      ftpIp: kind === 'ftp' ? ftpIp : null,
      sourcePath: path,
      items: snapshot,
      ...ctx,
    });
    onNotification?.(
      `${operation === 'cut' ? 'Cut' : 'Copied'} ${snapshot.length} item${snapshot.length === 1 ? '' : 's'} to clipboard`,
      'info',
    );
  };

  const cutEntry = (entry) => stashClipboard('cut', [entry]);
  const copyEntry = (entry) => stashClipboard('copy', [entry]);
  const cutSelected = () => {
    const list = Array.from(selected)
      .map(name => files.find(f => f.name === name))
      .filter(Boolean);
    if (!list.length) return;
    stashClipboard('cut', list);
    clearSelection();
  };
  const copySelected = () => {
    const list = Array.from(selected)
      .map(name => files.find(f => f.name === name))
      .filter(Boolean);
    if (!list.length) return;
    stashClipboard('copy', list);
    clearSelection();
  };

  // Perform the paste against whichever backend matches the clipboard's
  // (kind, source) tuple. Move = rename in-place; Copy is only
  // implemented for local. FTP/SMB copy throws a clear notification so
  // the user knows to use the upload/import queue instead.
  const pasteHere = async () => {
    if (!clipboard) return;
    if (!clipboardMatchesCurrent()) {
      onNotification?.(
        'Paste only works within the same source. Use the kebab Upload / Import actions to move items across transports.',
        'error',
      );
      return;
    }
    // Same-folder paste of a cut is a no-op; surface a friendly hint
    // rather than firing a bunch of EEXIST conflicts.
    if (clipboard.operation === 'cut' && clipboard.sourcePath === path) {
      onNotification?.('Items are already in this folder', 'info');
      return;
    }
    if (clipboard.operation === 'copy' && kind !== 'local') {
      onNotification?.(
        `Copy on ${kind === 'ftp' ? 'PS5 FTP' : 'SMB'} is not supported. Use the upload / import queue instead.`,
        'error',
      );
      return;
    }
    setPasteBusy(true);
    let ok = 0;
    let fail = 0;
    let conflicts = 0;
    for (const item of clipboard.items) {
      const srcFull = joinEntryPath(clipboard.sourcePath, item.name);
      const dstFull = joinEntryPath(path, item.name);
      if (srcFull === dstFull) { fail++; continue; }
      try {
        if (kind === 'local') {
          const endpoint = clipboard.operation === 'cut' ? 'move' : 'copy';
          await api.post(`/convert/local/${endpoint}`, { src: srcFull, dst: dstFull, isDir: item.isDir });
        } else if (kind === 'ftp') {
          await api.post('/convert/ftp/move', { ip: ftpIp, src: srcFull, dst: dstFull });
        } else {
          // SMB cut → rename
          await api.post(`/convert/sources/${smbId}/move`, { src: srcFull, dst: dstFull });
        }
        ok++;
      } catch (e) {
        if (e.data?.code === 'EEXIST') conflicts++;
        else fail++;
      }
    }
    setPasteBusy(false);
    const opLabel = clipboard.operation === 'cut' ? 'Moved' : 'Copied';
    if (ok > 0) {
      const parts = [`${opLabel} ${ok} item${ok === 1 ? '' : 's'}`];
      if (conflicts) parts.push(`${conflicts} skipped (already exist)`);
      if (fail) parts.push(`${fail} failed`);
      onNotification?.(parts.join(' · '), fail ? 'warning' : 'success');
    } else if (conflicts) {
      onNotification?.(`All ${conflicts} item(s) already exist at destination`, 'warning');
    } else {
      onNotification?.('Paste failed', 'error');
    }
    if (clipboard.operation === 'cut') setClipboard(null); // one-shot: cut → paste consumes the clipboard
    browse(path);
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

  const toggleSort = (key) => {
    if (sortBy === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(key); setSortDir('asc'); }
  };

  const sortedFiles = [...files].sort(sortFiles);
  const breadcrumbs = getBreadcrumbs();

  // Keep the newest (deepest) crumb in view in the scrollable mobile row.
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path, editingPath]);

  // Names waiting on the clipboard as a cut from the folder we're looking
  // at - rendered dimmed so it's obvious what is about to move.
  const clipboardHere = !!clipboard && clipboardMatchesCurrent();
  const cutNames = clipboardHere && clipboard.operation === 'cut' && clipboard.sourcePath === path
    ? new Set(clipboard.items.map(i => i.name))
    : null;
  const pasteBlocked = !clipboardHere || (clipboard.operation === 'cut' && clipboard.sourcePath === path);
  const selectionBar = multiSelect && selected.size > 0;
  const showBar = selectionBar || !!clipboard;

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
    // Install only applies to .pkg files. ftp = already on PS5 (no stage);
    // local + smb get staged into pkg_stage_dir then triggered.
    const pkgFile     = !f.isDir && isPkgFile(f.name);
    const canInstall  = pkgFile && (kind !== 'smb' || !!smbId);

    const runUpload = async (auto) => {
      const ok = await uploadEntry(f);
      // uploadEntry returns nothing today — best-effort assume success unless
      // it surfaced an error via onNotification.
      await setQueueRunning('upload', auto);
      if (!auto) onNotification?.(`Upload queued for ${f.name} — press ▶ in Queue to start`, 'info');
    };
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
    const runInstall = async (auto) => {
      const ok = await installEntry(f);
      if (!ok) return;
      await setQueueRunning('install', auto);
      onNotification?.(
        auto ? `Install started for ${f.name}` : `Install queued for ${f.name} — press ▶ in Queue to start`,
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
      // One Convert action — the Convert tab is where the user picks
      // between "🚀 Convert now" and "🕒 Add to queue" anyway, so a single
      // kebab entry that hands the file off + scrolls to #conversion
      // is enough. Pass intent=null so neither button is pre-armed.
      canConvert && {
        label: '🔄 Convert',
        action: () => pickConvert(f),
        title: 'Pick this file/folder and switch to the Convert tab',
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
      canInstall && {
        label: '📥 Install now',
        action: () => runInstall(true),
        title: 'Stage to PS5 (if needed) and trigger the configured PKG installer payload',
      },
      canInstall && {
        label: '🕒 Install queue',
        action: () => runInstall(false),
        title: 'Add .pkg to install queue and pause — press ▶ in Queue when ready',
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
      // Clipboard actions. Cut = rename on paste; Copy = duplicate
      // (local only, see pasteHere). Both available regardless of
      // transport - paste itself validates capabilities.
      {
        label: '✂ Cut',
        action: () => cutEntry(f),
        title: 'Cut to clipboard - moves on paste (within same source)',
      },
      kind === 'local' && {
        label: '📋 Copy',
        action: () => copyEntry(f),
        title: 'Copy to clipboard - duplicates on paste (local FS only)',
      },
      // Rename uses the same `move` endpoint per transport (local / ftp / smb)
      // by passing src and dst pointing at the same directory with a different
      // basename. Available across all three transports.
      {
        label: '✎ Rename',
        action: () => openRename(f),
        title: 'Rename this item (in place, same folder)',
      },
      {
        label: 'ℹ Show info',
        action: () => showInfo(f),
        title: 'Show file/folder metadata',
      },
      enableDelete && { label: '🗑 Delete', action: () => deleteEntry(f), danger: true },
    ].filter(Boolean);

    return (
      <div
        key={f.name}
        data-file={f.name}
        className={`file-card ${isSelected ? 'file-card-selected' : ''} ${isActive ? 'file-card-active' : ''} ${cutNames?.has(f.name) ? 'file-card-cut' : ''} ${dropTarget === f.name ? 'file-card-drop' : ''}`}
        draggable={dragEnabled || undefined}
        onDragStart={dragEnabled ? (e) => onRowDragStart(e, f) : undefined}
        onDragOver={dragEnabled && f.isDir ? (e) => onTargetDragOver(e, f.name) : undefined}
        onDrop={dragEnabled && f.isDir ? (e) => onTargetDrop(e, childPath(f.name)) : undefined}
        onTouchStart={(e) => startPress(e, f.name)}
        onTouchMove={movePress}
        onTouchEnd={cancelPress}
        onTouchCancel={cancelPress}
        onContextMenu={(e) => { if (longPressed.current) e.preventDefault(); }}
        onClick={() => {
          if (longPressed.current) { longPressed.current = false; return; }
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
              readOnly
              tabIndex={-1}
              // The row's own click handler does the toggling.
              style={{ width: 20, height: 20, pointerEvents: 'none', accentColor: 'var(--accent)' }}
            />
          )}

          <span style={{ fontSize: '1.5rem' }}>{f.isDir ? '📁' : archiveFile ? '📦' : '📄'}</span>

          <div className="flex-1" style={{ minWidth: 0 }}>
            <div className="text-sm truncate" style={{ color: f.isDir ? 'var(--blue)' : 'var(--text)' }}>{f.name}</div>
            <div className="text-xs text-muted">{f.isDir ? (f.size ? fmtSize(f.size) : '—') : fmtSize(f.size)}</div>
          </div>

          {secondaryActions.length > 0 && !multiSelect && (
            <div onClick={(e) => e.stopPropagation()}>
              <button
                className="btn btn-ghost btn-sm file-card-kebab"
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
                <>
                {menuStyle.sheet && <div className="file-menu-backdrop" />}
                <div
                  className={`file-menu ${menuStyle.sheet ? 'file-menu-sheet' : ''}`}
                  style={menuStyle.sheet ? undefined : menuStyle}
                >
                  {menuStyle.sheet && <div className="file-menu-title truncate">{f.name}</div>}
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
                </div>
                </>,
                document.body,
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      className={`comp-card fb ${showBar ? 'fb-has-bar' : ''} ${dropTarget === 'pane' ? 'fb-drop-target' : ''}`}
      onDragOver={dragEnabled ? (e) => onTargetDragOver(e, 'pane') : undefined}
      onDragLeave={dragEnabled ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget(null); } : undefined}
      onDrop={dragEnabled ? (e) => onTargetDrop(e, path) : undefined}
    >
      <div className="comp-card-header fb-header">
        {multiSelect ? (
          <div className="flex justify-between items-center flex-1 gap-sm">
            <span className="comp-card-title">{selected.size} selected</span>
            <div className="flex gap-xs">
              <button className="btn btn-ghost btn-sm" onClick={toggleSelectAll} disabled={files.length === 0}>
                {allSelected ? 'Select none' : 'Select all'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={clearSelection}>✕ Done</button>
            </div>
          </div>
        ) : (
          <div className="flex justify-between items-center flex-1">
            <div>
              <span className="comp-card-title fb-title">{title}</span>
              {description && <div className="text-xs text-muted mt-xs fb-title">{description}</div>}
              <span className="text-sm text-muted fb-narrow">{files.length} items{loading ? ' · loading…' : ''}</span>
            </div>
            <div className="flex gap-xs items-center">
              {canDeviceUpload && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setUploadMenuOpen(o => !o)}
                  disabled={!!deviceUpload}
                  aria-expanded={uploadMenuOpen}
                  title="Upload files or a folder from this device into the open folder"
                >
                  ⬆ Upload
                </button>
              )}
              {canMakeFolder && (
                <button className="btn btn-ghost btn-sm" onClick={makeFolder} title="Create a folder in the open folder">
                  📁＋ New folder
                </button>
              )}
              <button className="btn btn-ghost btn-sm" onClick={toggleMultiSelect}>☰ Select</button>
            </div>
          </div>
        )}
      </div>

      {canDeviceUpload && (
        <>
          <input ref={filesInputRef} type="file" multiple hidden onChange={onDeviceFilesPicked} />
          <input ref={folderInputRef} type="file" webkitdirectory="" directory="" hidden onChange={onDeviceFilesPicked} />
        </>
      )}
      {canDeviceUpload && uploadMenuOpen && !deviceUpload && (
        <div className="fb-device-upload">
          <span className="text-xs text-muted truncate">From this device into {path}</span>
          <div className="flex gap-xs">
            <button className="btn btn-secondary btn-sm" onClick={() => filesInputRef.current?.click()}>📄 Files…</button>
            <button className="btn btn-secondary btn-sm" onClick={() => folderInputRef.current?.click()}>📁 Folder…</button>
          </div>
        </div>
      )}
      {deviceUpload && (
        <div className="fb-device-upload">
          <div className="flex-1" style={{ minWidth: 0 }}>
            <div className="text-xs truncate" title={deviceUpload.name}>
              ⬆ {deviceUpload.index}/{deviceUpload.total} · {deviceUpload.name}
            </div>
            <div className="fb-device-upload-bar">
              <div style={{ width: `${deviceUpload.bytes ? Math.min(100, Math.round((deviceUpload.sent / deviceUpload.bytes) * 100)) : 0}%` }} />
            </div>
          </div>
          <span className="text-xs text-muted">
            {deviceUpload.bytes ? Math.min(100, Math.round((deviceUpload.sent / deviceUpload.bytes) * 100)) : 0}%
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => uploadAbortRef.current?.abort()}>Cancel</button>
        </div>
      )}

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

        {/* Upload target + destination are configured globally in
            Settings → Config → "Local upload target (PS5 FTP)" and read
            into uploadIp / uploadDest on mount above. The per-screen
            widget that used to live here was removed to avoid two
            places to keep in sync. */}

        {kind === 'ftp' && (
          <select className="select" value={ftpIp} onChange={e => setFtpIp(e.target.value)}>
            <option value="">— pick PS5 —</option>
            {profiles.map(p => <option key={p.id} value={p.ip_address}>{p.name} ({p.ip_address})</option>)}
          </select>
        )}

        {kind === 'local' && localRoots.length > 0 && (() => {
          // Curated quick-tabs: keep the four entry points the user
          // actually browses to (top-level mounts + payloads). Hide
          // mkpfs / downloads / tmp / media — they're still reachable
          // via the FolderPickerModal where they make more sense.
          const allowed = ['/mnt', '/home', '/data', '/data/payloads'];
          const shown = allowed.filter(p => localRoots.includes(p));
          if (shown.length === 0) return null;
          return (
            <div className="flex gap-xs flex-wrap fb-wide">
              {shown.map(r => (
                <button key={r} className="btn btn-ghost btn-sm" onClick={() => browse(r)}>{r}</button>
              ))}
            </div>
          );
        })()}

        {/* Phone nav row: ↑ + scrollable breadcrumbs (or the path input
            while editing) + refresh + a ⋯ sheet holding the rarely used
            controls. The wide-screen rows below are hidden at this size. */}
        <div className="fb-nav fb-narrow">
          <button className="btn btn-sm btn-ghost" onClick={goUp} disabled={parent === null || parent === undefined}>↑</button>
          {editingPath ? (
            <>
              <input
                className="input flex-1"
                autoFocus
                value={pathInput}
                onChange={e => setPathInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') browse(pathInput);
                  if (e.key === 'Escape') { setPathInput(path); setEditingPath(false); }
                }}
                placeholder="/mnt"
              />
              <button className="btn btn-sm btn-primary" onClick={() => browse(pathInput)} disabled={loading}>▶</button>
              {kind === 'local' && <BrowseButton compact small value={path} onPick={browse} pickerTitle="Go to folder" />}
              <button className="btn btn-sm btn-ghost" onClick={() => { setPathInput(path); setEditingPath(false); }}>✕</button>
            </>
          ) : (
            <>
              <div className="fb-crumbs" ref={crumbsRef}>
                {breadcrumbs.length === 0 && <span className="text-muted">/</span>}
                {breadcrumbs.map((crumb, i) => {
                  const last = i === breadcrumbs.length - 1;
                  return (
                    <span key={i} className="fb-crumb-wrap">
                      {i > 0 && <span className="text-muted">›</span>}
                      <button
                        className={`fb-crumb ${last ? 'is-current' : ''}`}
                        title={last ? 'Edit path' : crumb.path}
                        onClick={() => (last ? setEditingPath(true) : navigateBreadcrumb(crumb.path))}
                      >
                        {crumb.label}
                      </button>
                    </span>
                  );
                })}
              </div>
              <button className="btn btn-sm btn-ghost" onClick={refresh} disabled={loading}>↻</button>
              {enablePickDir && kind !== 'ftp' && <button className="btn btn-sm btn-success" onClick={() => pickDir(null)}>✓ Use</button>}
              <button className="btn btn-sm btn-ghost" onClick={(e) => openMenu(e, '/tools')}>⋯</button>
            </>
          )}
        </div>
        {menuOpen === '/tools' && menuStyle && createPortal(
          <>
            <div className="file-menu-backdrop" />
            <div className="file-menu file-menu-sheet" onClick={() => { setMenuOpen(null); setMenuStyle(null); }}>
              <div className="file-menu-title">Sort by</div>
              {['name', 'size', 'type'].map(key => (
                <button key={key} className="file-menu-item" onClick={() => toggleSort(key)}>
                  {key[0].toUpperCase() + key.slice(1)}{sortBy === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              ))}
              <div className="file-menu-title">Go to</div>
              <button className="file-menu-item" onClick={() => setEditingPath(true)}>✎ Type a path…</button>
              {kind === 'local' && ['/mnt', '/home', '/data', '/data/payloads'].filter(r => localRoots.includes(r)).map(r => (
                <button key={r} className="file-menu-item" onClick={() => browse(r)}>📁 {r}</button>
              ))}
              {enableSaveDefault && kind !== 'ftp' && (
                <button className="file-menu-item" onClick={saveDefault}>★ Save this folder as default</button>
              )}
            </div>
          </>,
          document.body,
        )}

        <div className="flex gap-sm items-center fb-wide">
          <button className="btn btn-sm btn-ghost" onClick={goUp} disabled={parent === null || parent === undefined}>↑</button>
          <input
            className="input flex-1"
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') browse(pathInput); }}
            placeholder="/mnt"
          />
          <button className="btn btn-sm btn-primary" onClick={() => browse(pathInput)} disabled={loading}>▶</button>
          {kind === 'local' && <BrowseButton compact small value={path} onPick={browse} pickerTitle="Go to folder" />}
          <button className="btn btn-sm btn-ghost" onClick={refresh} disabled={loading}>↻</button>
          {enableSaveDefault && kind !== 'ftp' && <button className="btn btn-sm btn-ghost" onClick={saveDefault}>★</button>}
          {enablePickDir && kind !== 'ftp' && <button className="btn btn-sm btn-success" onClick={() => pickDir(null)}>✓ Use</button>}
        </div>

        {breadcrumbs.length > 0 && (
          <div className="flex items-center gap-xs text-sm flex-wrap fb-wide">
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

        {ftpSlow && (
          <div className="p-sm text-sm text-muted">
            ⏳ Connecting to the console… starting zftpd if FTP is not running.
          </div>
        )}

        <div className="flex justify-between items-center text-sm text-muted fb-wide">
          <span>{files.length} items{loading ? ' · loading…' : ''}</span>
          <div className="flex gap-xs">
            {['name', 'size', 'type'].map(key => (
              <button key={key} className={`btn btn-ghost btn-sm ${sortBy === key ? 'btn-primary' : ''}`} onClick={() => toggleSort(key)}>
                {key[0].toUpperCase() + key.slice(1)}
              </button>
            ))}
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
            className="flex-col gap-xs fb-list"
          >
            {sortedFiles.map(f => renderFileCard(f))}
          </div>
        )}

      </div>

      {/* Bottom action bar - bulk actions while items are selected, the
          pending clipboard otherwise. It stays up while the user browses to
          the destination, so Paste is always one tap away. Portalled for the
          same reason as the ⋮ menu (transformed ancestor vs position:fixed). */}
      {showBar && createPortal(
        <div className="fb-actionbar">
          {selectionBar ? (
            <>
              {enableFtpUpload && ((kind === 'smb' && smbId) || kind === 'local') && uploadIp && (
                <button className="btn btn-success" onClick={uploadSelected}>⬆ Upload</button>
              )}
              {onSendToOther && (
                <>
                  <button className="btn btn-secondary" onClick={() => onSendToOther('copy', buildTransferPayload(Array.from(selected)))}>⇄ Copy to other pane</button>
                  <button className="btn btn-secondary" onClick={() => onSendToOther('move', buildTransferPayload(Array.from(selected)))}>⇄ Move to other pane</button>
                </>
              )}
              <button className="btn btn-secondary" onClick={cutSelected}>✂ Cut</button>
              {kind === 'local' && (
                <button className="btn btn-secondary" onClick={copySelected}>📋 Copy</button>
              )}
              {enableDelete && (
                <button className="btn btn-danger" onClick={deleteSelected}>🗑 Delete</button>
              )}
            </>
          ) : (
            <>
              <div className="fb-actionbar-info">
                <div className="text-sm truncate">
                  {clipboard.operation === 'cut' ? '✂' : '📋'} {clipboard.items.length === 1 ? clipboard.items[0].name : `${clipboard.items.length} items`}
                </div>
                <div className="text-xs text-muted truncate">
                  {!clipboardHere
                    ? 'Switch back to the same source to paste'
                    : pasteBlocked
                      ? 'Open the destination folder, then paste'
                      : `from ${clipboard.sourcePath || '/'}`}
                </div>
              </div>
              <button className="btn btn-success" onClick={pasteHere} disabled={pasteBusy || pasteBlocked}>
                {pasteBusy ? '⏳' : (clipboard.operation === 'cut' ? 'Move here' : 'Paste here')}
              </button>
              <button
                className="btn btn-ghost fb-actionbar-x"
                onClick={() => setClipboard(null)}
                title="Discard clipboard"
                disabled={pasteBusy}
              >
                ✕
              </button>
            </>
          )}
        </div>,
        document.body,
      )}

      {/* Rename modal. Submitting the form triggers confirmRename which
          dispatches the appropriate transport-specific /move endpoint. */}
      <Modal
        isOpen={!!renameTarget}
        onClose={() => { if (!renameBusy) setRenameTarget(null); }}
        title={`Rename ${renameTarget?.isDir ? 'folder' : 'file'}`}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setRenameTarget(null)} disabled={renameBusy}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={confirmRename} disabled={renameBusy || !renameValue.trim()}>
              {renameBusy ? '⏳ Renaming…' : 'Rename'}
            </button>
          </>
        }
      >
        {renameTarget && (
          <form
            onSubmit={(e) => { e.preventDefault(); confirmRename(); }}
            className="flex-col gap-sm"
          >
            <div className="text-xs text-muted truncate" title={renameTarget.name}>
              Current: <span style={{ color: 'var(--text)' }}>{renameTarget.name}</span>
            </div>
            <input
              className="input"
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="New name"
              disabled={renameBusy}
            />
            <div className="text-xs text-muted">
              Use the kebab → Cut and Paste in another folder to also change location.
            </div>
          </form>
        )}
      </Modal>

      {/* Show Info modal. Read-only metadata pulled from the entry row
          (already loaded by the parent browse). No extra fetch needed. */}
      <Modal
        isOpen={!!infoTarget}
        onClose={() => setInfoTarget(null)}
        title="File info"
        footer={
          <button className="btn btn-primary" onClick={() => setInfoTarget(null)}>Close</button>
        }
      >
        {infoTarget && (() => {
          const fullPath = joinEntryPath(path, infoTarget.name);
          const mtime = infoTarget.mtime
            ? new Date(typeof infoTarget.mtime === 'number' ? infoTarget.mtime : Date.parse(infoTarget.mtime))
            : null;
          const isDir = !!infoTarget.isDir;
          const sizeBytes = typeof infoTarget.size === 'number' ? infoTarget.size : null;
          const transportLabel = kind === 'local'
            ? 'Local filesystem'
            : kind === 'ftp'
              ? `PS5 FTP (${ftpIp || '—'})`
              : `Remote source #${smbId || '—'}`;
          const rows = [
            ['Name', infoTarget.name],
            ['Type', isDir ? '📁 Folder' : '📄 File'],
            ['Location', transportLabel],
            ['Full path', fullPath],
            ['Size', sizeBytes != null
              ? (sizeBytes >= 1024 ? `${fmtSize(sizeBytes)} (${sizeBytes.toLocaleString()} B)` : `${sizeBytes} B`)
              : (isDir ? '—' : 'Unknown')],
            ['Modified', mtime && !isNaN(mtime.getTime()) ? mtime.toLocaleString() : '—'],
          ];
          return (
            <div className="flex-col gap-sm">
              {rows.map(([label, value]) => (
                <div key={label} className="flex" style={{ gap: 'var(--space-md)', alignItems: 'flex-start' }}>
                  <div
                    className="text-xs text-muted"
                    style={{ minWidth: 90, paddingTop: 2, flexShrink: 0 }}
                  >
                    {label}
                  </div>
                  <div className="text-sm" style={{ wordBreak: 'break-all', flex: 1 }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
