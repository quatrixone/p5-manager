import { useState, useEffect, useCallback } from 'react';
import FileBrowser from './FileBrowser';

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

const styles = {
  section: { background: C.panel, padding: '1rem', borderRadius: 12, marginBottom: '1rem' },
  h: { fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', color: C.text },
  h2: { fontSize: '0.9rem', fontWeight: 500, marginBottom: '0.5rem', color: C.text },
  label: { display: 'block', fontSize: '0.8rem', color: C.muted, marginBottom: '0.25rem' },
  input: {
    padding: '0.6rem', borderRadius: 6, background: C.bg, color: C.text,
    border: `1px solid ${C.border}`, fontSize: '0.9rem', width: '100%', boxSizing: 'border-box',
  },
  row: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' },
  col: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.5rem' },
  btn: (color, disabled) => ({
    padding: '0.4rem 0.75rem', background: disabled ? '#555' : color, color: C.text,
    border: 'none', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '0.8rem', fontWeight: 500, minHeight: 'auto',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
  }),
  pill: (color) => {
    // Map the raw color to a soft, readable tinted-badge palette so light
    // accents (mint, blue, magenta) don't print as light-on-light text.
    const tint = (bg, fg, border) => ({ bg, fg, border });
    const map = {
      'var(--accent)': tint('var(--accent-dim)', 'var(--accent)', 'rgba(124,255,179,0.28)'),
      'var(--red)':    tint('var(--red-dim)',    'var(--red)',    'rgba(255,93,122,0.28)'),
      'var(--blue)':   tint('var(--blue-dim)',   'var(--blue)',   'rgba(125,223,245,0.28)'),
      'var(--amber)':  tint('var(--amber-dim)',  'var(--amber)',  'rgba(255,184,107,0.28)'),
      'var(--magenta)': tint('rgba(196,144,255,0.16)', 'var(--magenta)', 'rgba(196,144,255,0.28)'),
    };
    const t = map[color] || tint('rgba(255,255,255,0.06)', '#cfd2dc', 'var(--border)');
    return {
      display: 'inline-block', padding: '0.18rem 0.55rem',
      background: t.bg, color: t.fg, border: `1px solid ${t.border}`,
      borderRadius: 999, fontSize: '0.7rem', fontWeight: 600, lineHeight: 1.4,
      whiteSpace: 'nowrap',
    };
  },
  card: { padding: '0.75rem', background: C.panel2, borderRadius: 8, marginBottom: '0.5rem' },
  tab: (active) => ({
    padding: '0.4rem 0.85rem',
    background: active ? 'var(--accent-dim)' : C.panel2,
    color: active ? 'var(--accent)' : C.text,
    border: `1px solid ${active ? 'rgba(124,255,179,0.28)' : 'transparent'}`,
    borderRadius: 8, cursor: 'pointer',
    fontSize: '0.82rem', fontWeight: 500, textTransform: 'capitalize',
  }),
};

function path_basename(p) {
  if (!p) return '';
  const s = String(p).replace(/[\\/]+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}


function ConvertSection({ profiles, onNotification, onOpenQueue, initialPick, onPickConsumed }) {
  const [mkpfsStatus, setMkpfsStatus] = useState(null);
  const [mkpfsUpgrading, setMkpfsUpgrading] = useState(false);
  const [files, setFiles] = useState([]);
  const [sub, setSub] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [sources, setSources] = useState([]);

  // scan path = default local browser path (configured in FileBrowser via "Save as default")
  // when set, Work files section browses that path absolutely instead of just workdir
  const [scanRoot, setScanRoot] = useState('');
  const [scanCurrent, setScanCurrent] = useState('');
  const [scanParent, setScanParent] = useState(null);

  const [folderImportJob, setFolderImportJob] = useState(null);

  const [mode, setMode] = useState('pack-file');
  const [selected, setSelected] = useState('');
  // When source lives on PS5 FTP, we keep ip+path here and present them as
  // ftp://ip/path in the Source field. The backend stages the file locally,
  // runs mkpfs, then pushes the .ffpfsc back next to the original.
  const [sourceFtp, setSourceFtp] = useState(null); // { ip, path, name } | null
  const [outputName, setOutputName] = useState('');
  const [compress, setCompress] = useState(true);
  const [verify, setVerify] = useState(true);
  const [version, setVersion] = useState('PS5');
  const [compressionLevel, setCompressionLevel] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [skipExecComp, setSkipExecComp] = useState(false);
  const [signed, setSigned] = useState(false);
  const [requireGameFiles, setRequireGameFiles] = useState(false);
  // Auto-push the resulting .ffpfsc to PS5 FTP as soon as mkpfs finishes.
  // mkpfs writes a structured binary file (it seeks back to patch headers),
  // so true streaming-into-FTP isn't possible. Default OFF — most local
  // conversions don't need the auto-upload (user stages files separately
  // or wants to inspect the .ffpfsc first); the user explicitly opts in
  // by checking the box when they actually want the chained push.
  const [pushAfter, setPushAfter] = useState(false);
  const [pushIp, setPushIp] = useState('');
  const [pushDest, setPushDest] = useState('/data/homebrew');
  const [deleteSource, setDeleteSource] = useState(false);

  const [job, setJob] = useState(null);
  const [running, setRunning] = useState(false);

  // When a file/folder is sent here from the Files tab kebab menu with an
  // intent ('now' or 'queue'), we highlight the matching action button so
  // it's obvious which one the user originally clicked. Cleared after the
  // user actually starts/queues the conversion (or picks a new source).
  const [pendingIntent, setPendingIntent] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/convert/mkpfs/status`);
      setMkpfsStatus(await r.json());
    } catch (_) { setMkpfsStatus({ installed: false }); }

    let savedScanRoot = '';
    try {
      const r = await fetch(`${API}/convert/browser-prefs`);
      if (r.ok) {
        const prefs = await r.json();
        savedScanRoot = prefs?.local?.path || '';
        setScanRoot(savedScanRoot);
      }
    } catch (_) {}

    if (savedScanRoot) {
      const target = scanCurrent && scanCurrent.startsWith(savedScanRoot) ? scanCurrent : savedScanRoot;
      try {
        const r = await fetch(`${API}/convert/local/browse`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: target }),
        });
        const d = await r.json();
        if (r.ok) {
          setWorkdir(d.path);
          setScanCurrent(d.path);
          setScanParent(d.parent || null);
          setFiles(d.files || []);
        } else {
          // fallback: try the saved root again
          const r2 = await fetch(`${API}/convert/local/browse`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: savedScanRoot }),
          });
          const d2 = await r2.json();
          if (r2.ok) {
            setWorkdir(d2.path); setScanCurrent(d2.path);
            setScanParent(d2.parent || null); setFiles(d2.files || []);
          }
        }
      } catch (_) {}
    } else {
      try {
        const r = await fetch(`${API}/convert/mkpfs/files?sub=${encodeURIComponent(sub)}`);
        const d = await r.json();
        setWorkdir(d.workdir);
        setFiles(d.files || []);
        setScanCurrent('');
        setScanParent(null);
      } catch (_) {}
    }

    try {
      const r = await fetch(`${API}/convert/sources`);
      setSources((await r.json()).filter(s => s.type === 'smb'));
    } catch (_) {}
    // Recent jobs were previously listed inline here; the Queue tab now owns
    // job history so we don't refetch it on every refresh.
  }, [sub, scanCurrent]);

  useEffect(() => { refresh(); }, [refresh]);

  const doMkpfsUpgrade = useCallback(async () => {
    if (mkpfsUpgrading) return;
    const target = mkpfsStatus?.latest_version || 'latest';
    if (!window.confirm(`Update mkpfs to ${target}?\n\nThe new version is installed live into the running container — no rebuild or restart required.`)) {
      return;
    }
    setMkpfsUpgrading(true);
    try {
      const r = await fetch(`${API}/convert/mkpfs/upgrade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        const msg = d.stderr || d.error || `HTTP ${r.status}`;
        throw new Error(msg.split('\n').slice(-4).join('\n'));
      }
      onNotification?.(`mkpfs updated to ${d.version || 'latest'}`, 'success');
      // Re-fetch status with refresh=1 to bust the PyPI cache and pick
      // up update_available=false right away.
      try {
        const rr = await fetch(`${API}/convert/mkpfs/status?refresh=1`);
        if (rr.ok) setMkpfsStatus(await rr.json());
      } catch (_) {}
    } catch (e) {
      onNotification?.(`mkpfs update failed: ${e.message}`, 'error');
    } finally {
      setMkpfsUpgrading(false);
    }
  }, [mkpfsUpgrading, mkpfsStatus?.latest_version, onNotification]);

  useEffect(() => {
    if (!pushIp) {
      const p = profiles.find(x => x.is_default) || profiles[0];
      if (p) setPushIp(p.ip_address);
    }
  }, [profiles]);

  useEffect(() => {
    const id = localStorage.getItem('mm.job.convert');
    if (!id) return;
    fetch(`${API}/convert/convert/${id}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d && d.id) {
          setJob(d);
          if (d.status === 'running' || d.status === 'pushing') setRunning(true);
        } else {
          localStorage.removeItem('mm.job.convert');
        }
      })
      .catch(() => localStorage.removeItem('mm.job.convert'));
  }, []);

  useEffect(() => {
    if (!job) return;
    const isActive = job.status === 'running' || job.status === 'pushing';
    if (isActive) {
      localStorage.setItem('mm.job.convert', job.id);
    } else {
      localStorage.removeItem('mm.job.convert');
    }
    if (!isActive) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${API}/convert/convert/${job.id}`);
        const d = await r.json();
        setJob(d);
        if (d.status !== 'running' && d.status !== 'pushing') {
          setRunning(false);
          refresh();
          if (d.status === 'completed') onNotification?.('Conversion completed', 'success');
          else if (d.status === 'failed') onNotification?.(`Conversion failed: ${d.error || `exit ${d.exit_code}`}`, 'error');
          else if (d.status === 'push_failed') onNotification?.(`Push failed: ${d.error}`, 'error');
          else if (d.status === 'cancelled') onNotification?.('Conversion cancelled', 'warning');
        }
      } catch (_) {}
    }, 1500);
    return () => clearInterval(t);
  }, [job?.id, job?.status, onNotification, refresh]);

  const goUp = () => {
    if (scanRoot && scanCurrent) {
      // limit traversal to scanRoot when set
      if (scanCurrent === scanRoot || scanParent === null) return;
      if (scanParent && scanParent.startsWith(scanRoot)) setScanCurrent(scanParent);
      else setScanCurrent(scanRoot);
      return;
    }
    const parts = sub.split('/').filter(Boolean);
    parts.pop();
    setSub(parts.join('/'));
  };
  const enter = (name) => {
    if (scanRoot && scanCurrent) {
      const next = scanCurrent.endsWith('/') ? `${scanCurrent}${name}` : `${scanCurrent}/${name}`;
      setScanCurrent(next);
      return;
    }
    setSub(sub ? `${sub}/${name}` : name);
  };

  const deleteFile = async (rel, fullPath, isDir) => {
    const label = scanRoot ? fullPath : rel;
    if (!confirm(`Delete ${label}?`)) return;
    try {
      if (scanRoot) {
        const r = await fetch(`${API}/convert/local/delete`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: fullPath, isDir: !!isDir }),
        });
        if (!r.ok) throw new Error((await r.json()).error);
      } else {
        await fetch(`${API}/convert/mkpfs/files?sub=${encodeURIComponent(rel)}`, { method: 'DELETE' });
      }
      refresh();
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  // Extract progress used to be polled here for an inline log panel. Job
  // tracking now lives entirely in the Queue tab, so we drop the local state
  // and the 1.5s polling loop — the Queue's own poller covers it.

  useEffect(() => {
    const id = localStorage.getItem('mm.job.folderImport');
    if (!id) return;
    fetch(`${API}/convert/mkpfs/import-folder-from-smb/${id}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && d.id) setFolderImportJob(d); else localStorage.removeItem('mm.job.folderImport'); })
      .catch(() => localStorage.removeItem('mm.job.folderImport'));
  }, []);

  useEffect(() => {
    if (!folderImportJob) return;
    if (folderImportJob.status === 'running') {
      localStorage.setItem('mm.job.folderImport', folderImportJob.id);
    } else {
      localStorage.removeItem('mm.job.folderImport');
      return;
    }
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${API}/convert/mkpfs/import-folder-from-smb/${folderImportJob.id}`);
        const d = await r.json();
        setFolderImportJob(d);
        if (d.status !== 'running') {
          refresh();
          if (d.status === 'completed') onNotification?.('Folder imported', 'success');
          else if (d.status === 'failed') onNotification?.(`Import failed: ${d.error}`, 'error');
        }
      } catch (_) {}
    }, 2000);
    return () => clearInterval(t);
  }, [folderImportJob?.id, folderImportJob?.status]);

  // Unified "submit" used by both the "🚀 Convert now" and "🕒 Add to queue"
  // buttons. `autoStart` controls whether we resume or pause the convert
  // queue after enqueuing — matching the kebab-menu semantics elsewhere in
  // the app:
  //   autoStart = true  → enqueue + resume queue (immediate start)
  //   autoStart = false → enqueue + pause queue  (user starts later via ▶)
  const submitConvert = async (autoStart) => {
    if (!selected && !sourceFtp) return onNotification?.('Pick a source first', 'error');
    setRunning(true);
    try {
      const r = await fetch(`${API}/convert/convert/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConvertParams()),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      try {
        await fetch(`${API}/convert/convert/queue/${autoStart ? 'resume' : 'pause'}`, { method: 'POST' });
      } catch (_) { /* best-effort — Queue tab still works either way */ }
      onNotification?.(
        autoStart
          ? `Started: ${d.item.source_name} → ${d.item.output_name}`
          : `Added to queue: ${d.item.source_name} → ${d.item.output_name} — press ▶ in Queue to start`,
        autoStart ? 'success' : 'info',
      );
      setSelected('');
      setSourceFtp(null);
      setOutputName('');
      setPendingIntent(null);
      onOpenQueue?.();
    } catch (e) {
      onNotification?.(`Failed to queue: ${e.message}`, 'error');
    } finally {
      setRunning(false);
    }
  };

  const pickItem = (relPath, isDir, name) => {
    setSelected(relPath);
    if (isDir) {
      const safeName = name.replace(/[^A-Za-z0-9_.\-]/g, '_');
      setOutputName(safeName + '.ffpfsc');
      if (mode === 'pack-file') setMode('pack-folder');
    } else {
      setOutputName(name.replace(/\.(exfat|ffpkg|ffpfsc)$/i, '') + '.ffpfsc');
      if (mode !== 'pack-file') setMode('pack-file');
    }
  };

  const cancelJob = async () => {
    if (!job) return;
    await fetch(`${API}/convert/convert/${job.id}/cancel`, { method: 'POST' });
  };

  const buildConvertParams = () => ({
    mode,
    // Either local source_path OR PS5-FTP source_ftp - never both.
    source_path: sourceFtp ? undefined : selected,
    source_ftp: sourceFtp ? { ip: sourceFtp.ip, path: sourceFtp.path } : undefined,
    output_name: outputName || undefined,
    compress, verify, version,
    compression_level: compressionLevel || undefined,
    case_sensitive: caseSensitive,
    skip_executable_compression: skipExecComp,
    signed,
    require_game_files: requireGameFiles,
    push_after: pushAfter,
    push_ip: pushIp || undefined,
    push_dest: pushDest || undefined,
    delete_source_after: deleteSource,
  });

  // Legacy addToQueue() removed — both convert-now and convert-queue go
  // through the unified `submitConvert(autoStart)` above so the queue
  // pause/resume side-effect stays in one place.

  const [queueState, setQueueState] = useState({ paused: false, items: [] });
  const refreshQueue = useCallback(async () => {
    try {
      const r = await fetch(`${API}/convert/convert/queue`);
      setQueueState(await r.json());
    } catch (_) {}
  }, []);

  useEffect(() => {
    refreshQueue();
    const t = setInterval(refreshQueue, 2000);
    return () => clearInterval(t);
  }, [refreshQueue]);

  const queueRemove = async (id) => {
    try {
      const r = await fetch(`${API}/convert/convert/queue/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error);
      refreshQueue();
    } catch (e) { onNotification?.(e.message, 'error'); }
  };
  const queueMove = async (id, direction) => {
    try {
      await fetch(`${API}/convert/convert/queue/${id}/move`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
      refreshQueue();
    } catch (_) {}
  };
  const queueRetry = async (id) => {
    try {
      const r = await fetch(`${API}/convert/convert/queue/${id}/retry`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json()).error);
      refreshQueue();
    } catch (e) { onNotification?.(e.message, 'error'); }
  };
  const queuePause = async () => {
    await fetch(`${API}/convert/convert/queue/pause`, { method: 'POST' });
    refreshQueue();
  };
  const queueResume = async () => {
    await fetch(`${API}/convert/convert/queue/resume`, { method: 'POST' });
    refreshQueue();
  };
  const queueClearPending = async () => {
    if (!window.confirm('Clear all queued items?')) return;
    await fetch(`${API}/convert/convert/queue/clear`, { method: 'POST' });
    refreshQueue();
  };
  const queueClearFinished = async () => {
    await fetch(`${API}/convert/convert/queue/clear-finished`, { method: 'POST' });
    refreshQueue();
  };

  const isExfatLike = (n) => /\.(exfat|ffpkg)$/i.test(n);
  const isArchive = (n) => /\.(rar|7z|zip|tar\.gz|tgz|tar|r\d{2}|part\d+\.rar)$/i.test(n);

  // Shared "this is what 'Pick' / 'Convert now' does" logic. Used directly by
  // the nested FileBrowser inside the Convert tab AND by the parent FileOps
  // when the user clicks "Convert now" / "Convert queue" / "Open in Convert
  // tab" from a different sub-tab. The optional `intent` ('now' | 'queue' |
  // null) is stashed so the submit row can highlight the matching button.
  const applyConvertPick = useCallback(({ kind, ftpIp, path: abs, isDir, name, intent }) => {
    if (kind === 'ftp') {
      setMode(isDir ? 'pack-folder' : 'pack-file');
      setSourceFtp({ ip: ftpIp, path: abs, name, is_dir: isDir });
      setSelected(`ftp://${ftpIp}${abs}${isDir ? '/' : ''}`);
      if (isDir) {
        const safe = name.replace(/[^A-Za-z0-9_.\-]/g, '_');
        setOutputName(safe + '.ffpfsc');
      } else {
        setOutputName(name.replace(/\.(exfat|ffpkg|ffpfsc)$/i, '') + '.ffpfsc');
      }
    } else {
      setSourceFtp(null);
      setSelected(abs);
      if (isDir) {
        const safe = name.replace(/[^A-Za-z0-9_.\-]/g, '_');
        setOutputName(safe + '.ffpfsc');
        setMode(prev => prev === 'pack-file' ? 'pack-folder' : prev);
      } else {
        setOutputName(name.replace(/\.(exfat|ffpkg|ffpfsc)$/i, '') + '.ffpfsc');
        setMode(prev => prev !== 'pack-file' ? 'pack-file' : prev);
      }
    }
    setPendingIntent(intent || null);
  }, []);

  // Consume a pending pick handed in by FileOps (e.g. user clicked
  // "Convert now" on a file inside the Files sub-tab). Only run once per pick.
  useEffect(() => {
    if (!initialPick) return;
    applyConvertPick(initialPick);
    const intentSuffix = initialPick.intent === 'now'
      ? ' — press 🚀 to start'
      : initialPick.intent === 'queue'
      ? ' — press 🕒 to add to queue'
      : '';
    onNotification?.(`Loaded ${initialPick.name} into Convert${intentSuffix}`, 'success');
    onPickConsumed?.();
  }, [initialPick, applyConvertPick, onPickConsumed, onNotification]);

  return (
    <>
      <section className="convert-intro">
        <div className="convert-intro-row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          <div className="convert-intro-title">🔄 mkpfs converter</div>
          {mkpfsStatus && (
            mkpfsStatus.installed
              ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <span className="badge badge-success">
                    mkpfs installed{mkpfsStatus.version ? ` · v${mkpfsStatus.version}` : ''}
                  </span>
                  {mkpfsStatus.update_available && mkpfsStatus.latest_version && (
                    <>
                      <span
                        className="badge"
                        style={{
                          background: 'var(--amber-dim, rgba(255,184,107,0.16))',
                          color: 'var(--amber, #ffb86b)',
                          border: '1px solid rgba(255,184,107,0.32)',
                        }}
                        title={`PyPI has mkpfs ${mkpfsStatus.latest_version}; you have ${mkpfsStatus.version || '?'}.`}
                      >
                        update available · v{mkpfsStatus.latest_version}
                      </span>
                      <button
                        type="button"
                        disabled={mkpfsUpgrading}
                        onClick={doMkpfsUpgrade}
                        style={{
                          ...styles.btn(C.blue, mkpfsUpgrading),
                          padding: '0.25rem 0.6rem',
                          fontSize: '0.72rem',
                          fontWeight: 600,
                        }}
                      >
                        {mkpfsUpgrading
                          ? 'Updating…'
                          : `⤴ Update to ${mkpfsStatus.latest_version}`}
                      </button>
                    </>
                  )}
                  {!mkpfsStatus.update_available && mkpfsStatus.version && mkpfsStatus.latest_version && (
                    <span className="text-xs text-muted" title="Checked against pypi.org">
                      latest
                    </span>
                  )}
                  {mkpfsStatus.latest_check_error && !mkpfsStatus.latest_version && (
                    <span className="text-xs text-muted" title={mkpfsStatus.latest_check_error}>
                      (offline – cannot check PyPI)
                    </span>
                  )}
                </span>
              )
              : <span className="badge badge-danger">mkpfs not installed — run: pip install mkpfs</span>
          )}
        </div>
        <div className="convert-intro-hint">
          Pack <code>.exfat</code> / <code>.ffpkg</code> files or game-dump folders into <code>.ffpfsc</code>.
          Sources scanned from <code>{workdir || 'data/mkpfs'}</code>.
        </div>
      </section>

      <FileBrowser
        profiles={profiles}
        onNotification={onNotification}
        enableExtract enableDelete enablePickConvert enableFtp enableFtpUpload
        onOpenQueue={onOpenQueue}
        onImported={() => refresh()}
        onPickConvert={applyConvertPick}
        title="Pick file or folder to convert"
        description="Local FS, SMB (after import) or PS5 FTP. Use the ⋮ menu → 🔄 Convert now to load it here."
      />

      <section style={styles.section}>
        <div style={styles.h}>Conversion</div>
        <div style={styles.col}>
          <div>
            <label style={styles.label}>Mode</label>
            <div style={{ ...styles.row, gap: '0.4rem' }}>
              {[
                { id: 'pack-file', label: 'File → ffpfsc' },
                { id: 'pack-folder', label: 'Folder → ffpfsc' },
              ].map(m => (
                <button key={m.id} style={styles.tab(mode === m.id)} onClick={() => {
                  setMode(m.id);
                  if (outputName) {
                    const base = outputName.replace(/\.(exfat|ffpfsc)$/i, '');
                    setOutputName(base + '.ffpfsc');
                  }
                }}>{m.label}</button>
              ))}
            </div>
          </div>

          <div>
            <label style={styles.label}>
              {mode === 'pack-file' ? 'Source file' : 'Source folder'}
              {sourceFtp ? (
                <span style={{ color: 'var(--blue)', fontWeight: 500 }}> · PS5 FTP (will stage locally before mkpfs)</span>
              ) : scanRoot
                ? <span style={{ color: C.muted, fontWeight: 400 }}> · absolute path or relative to work dir</span>
                : <span style={{ color: C.muted, fontWeight: 400 }}> · relative to work dir</span>}
            </label>
            <input
              style={styles.input}
              value={selected}
              onChange={e => { setSelected(e.target.value); setSourceFtp(null); }}
              placeholder={scanRoot
                ? (mode === 'pack-file' ? '/mnt/sda1/.../GAME1234.exfat' : '/mnt/sda1/.../GAME1234/')
                : (mode === 'pack-file' ? 'GAME1234.exfat' : 'GAME1234/')}
            />
            {sourceFtp && (
              <button
                type="button"
                style={{ ...styles.btn('var(--bg-elev-2)', false), marginTop: 6 }}
                onClick={() => { setSourceFtp(null); setSelected(''); }}
              >
                ↺ Clear FTP source (pick local instead)
              </button>
            )}
          </div>
          <div>
            <label style={styles.label}>Output filename</label>
            <input style={styles.input} value={outputName} onChange={e => setOutputName(e.target.value)}
              placeholder="GAME1234.ffpfsc" />
          </div>

          <div style={styles.grid2}>
            <label style={{ ...styles.row, fontSize: '0.85rem' }}>
              <input type="checkbox" checked={compress} onChange={e => setCompress(e.target.checked)} /> Compress (PFSC)
            </label>
            <label style={{ ...styles.row, fontSize: '0.85rem' }}>
              <input type="checkbox" checked={verify} onChange={e => setVerify(e.target.checked)} /> Verify after pack
            </label>
          </div>

          <details className="convert-advanced">
            <summary>⚙️ Advanced options</summary>
            <div className="convert-advanced-body">
              <div style={styles.grid2}>
                <div>
                  <label style={styles.label}>PFS version</label>
                  <select style={styles.input} value={version} onChange={e => setVersion(e.target.value)}>
                    <option value="PS5">PS5</option>
                    <option value="PS4">PS4</option>
                  </select>
                </div>
                <div>
                  <label style={styles.label}>Compression level (0-9)</label>
                  <input type="number" min="0" max="9" style={styles.input} value={compressionLevel} onChange={e => setCompressionLevel(e.target.value)} placeholder="9" />
                </div>
              </div>
              {mode === 'pack-folder' && (
                <div style={styles.grid2}>
                  <label style={{ ...styles.row, fontSize: '0.85rem' }}>
                    <input type="checkbox" checked={caseSensitive} onChange={e => setCaseSensitive(e.target.checked)} /> Case-sensitive
                  </label>
                  <label style={{ ...styles.row, fontSize: '0.85rem' }}>
                    <input type="checkbox" checked={skipExecComp} onChange={e => setSkipExecComp(e.target.checked)} /> Skip exec compression
                  </label>
                  <label style={{ ...styles.row, fontSize: '0.85rem' }}>
                    <input type="checkbox" checked={signed} onChange={e => setSigned(e.target.checked)} /> Signed (zero EKPFS)
                  </label>
                  <label style={{ ...styles.row, fontSize: '0.85rem' }}>
                    <input type="checkbox" checked={requireGameFiles} onChange={e => setRequireGameFiles(e.target.checked)} /> Require game files
                  </label>
                </div>
              )}
            </div>
          </details>

          <div style={{ ...styles.card, background: C.bg, marginBottom: 0 }}>
            <label style={{ ...styles.row, fontSize: '0.85rem', marginBottom: '0.5rem' }}>
              <input type="checkbox" checked={pushAfter} onChange={e => setPushAfter(e.target.checked)} /> Auto-upload .ffpfsc to PS5 FTP when conversion finishes
            </label>
            {pushAfter && (
              <div style={styles.grid2}>
                <div>
                  <label style={styles.label}>PS5</label>
                  <select style={styles.input} value={pushIp} onChange={e => setPushIp(e.target.value)}>
                    <option value="">— select —</option>
                    {profiles.map(p => <option key={p.id} value={p.ip_address}>{p.name} ({p.ip_address})</option>)}
                  </select>
                </div>
                <div>
                  <label style={styles.label}>Destination on PS5</label>
                  <input style={styles.input} value={pushDest} onChange={e => setPushDest(e.target.value)} />
                </div>
              </div>
            )}
            <label style={{ ...styles.row, fontSize: '0.85rem', marginTop: '0.5rem' }}>
              <input type="checkbox" checked={deleteSource} onChange={e => setDeleteSource(e.target.checked)} /> Delete source after success
            </label>
          </div>

          <div style={{ ...styles.row, gap: '0.5rem' }}>
            <button
              type="button"
              disabled={(!selected && !sourceFtp) || !mkpfsStatus?.installed || running}
              onClick={() => submitConvert(true)}
              style={{
                ...styles.btn(C.green, (!selected && !sourceFtp) || !mkpfsStatus?.installed || running),
                fontWeight: 600,
                boxShadow: pendingIntent === 'now' ? '0 0 0 2px var(--accent)' : 'none',
                outline: pendingIntent === 'now' ? '2px solid var(--accent-dim)' : 'none',
                outlineOffset: 2,
              }}
              title="Enqueue this conversion and resume the convert queue so it starts immediately"
            >
              🚀 Convert now
            </button>
            <button
              type="button"
              disabled={(!selected && !sourceFtp) || !mkpfsStatus?.installed || running}
              onClick={() => submitConvert(false)}
              style={{
                ...styles.btn(C.panel2, (!selected && !sourceFtp) || !mkpfsStatus?.installed || running),
                border: `1px solid ${pendingIntent === 'queue' ? 'var(--blue)' : C.border}`,
                color: '#fff',
                fontWeight: 500,
                boxShadow: pendingIntent === 'queue' ? '0 0 0 2px var(--blue)' : 'none',
                outline: pendingIntent === 'queue' ? '2px solid var(--blue-dim, rgba(125,223,245,0.3))' : 'none',
                outlineOffset: 2,
              }}
              title="Enqueue this conversion and pause the convert queue — start it later from the Tasks tab"
            >
              🕒 Add to queue
            </button>
            {pendingIntent && (
              <span
                style={{
                  fontSize: '0.72rem',
                  color: C.muted,
                  fontStyle: 'italic',
                  alignSelf: 'center',
                }}
                title="The kebab menu pre-armed one of these buttons. You can still pick the other."
              >
                pre-armed: {pendingIntent === 'now' ? '🚀 Convert now' : '🕒 Add to queue'}
              </span>
            )}
            {job && (job.status === 'running' || job.status === 'pushing') && (
              <button type="button" style={styles.btn(C.red)} onClick={cancelJob}>Cancel</button>
            )}
          </div>
        </div>
      </section>

    </>
  );
}

// Convert tab — thin shell around ConvertSection. The page-level title is
// already shown by the FileOps wrapper, so we don't render another h2 here.
export default function Convert({ profiles, onNotification, onOpenQueue, initialPick, onPickConsumed }) {
  return (
    <ConvertSection
      profiles={profiles}
      onNotification={onNotification}
      onOpenQueue={onOpenQueue}
      initialPick={initialPick}
      onPickConsumed={onPickConsumed}
    />
  );
}
