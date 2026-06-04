import { useState, useEffect, useCallback, useRef } from 'react';
import FileBrowser, { ExtractLogPanel } from './FileBrowser';
import { ExtractQueuePanel } from './MicroMount';

const API = '/api';

const C = {
  bg: 'var(--bg)',
  panel: 'var(--bg-elev)',
  panel2: 'var(--bg-elev-2)',
  accent: 'var(--accent)',
  blue: 'var(--blue)',
  green: 'var(--accent)',
  red: 'var(--red)',
  amber: 'var(--amber)',
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
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.5rem' },
  btn: (color, disabled) => ({
    padding: '0.55rem 1rem', background: disabled ? '#555' : color, color: C.text,
    border: 'none', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '0.85rem', fontWeight: 500, minHeight: 36,
  }),
  pill: (color) => ({
    padding: '0.2rem 0.55rem', background: color, color: C.text,
    borderRadius: 999, fontSize: '0.7rem', fontWeight: 600,
  }),
  card: { padding: '0.75rem', background: C.panel2, borderRadius: 8, marginBottom: '0.5rem' },
};

const fmtMB = (b) => (b / (1024 * 1024)).toFixed(b >= 1024 * 1024 * 1024 ? 2 : 1) + ' MB';

const STATUS_COLOR = {
  queued: 'var(--magenta)',
  running: C.blue,
  completed: C.green,
  failed: C.red,
  cancelled: C.amber,
};

export default function Downloader({ profiles = [], onNotification }) {
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [destKind, setDestKind] = useState('local');
  const [destPath, setDestPath] = useState('/mnt');
  const [smbSourceId, setSmbSourceId] = useState('');
  const [smbSubdir, setSmbSubdir] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [smbSources, setSmbSources] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [extractJob, setExtractJob] = useState(null);
  const pollRef = useRef(null);

  const refreshJobs = useCallback(async () => {
    try {
      const r = await fetch(`${API}/downloader`);
      setJobs(await r.json());
    } catch (_) {}
  }, []);

  const refreshSources = useCallback(async () => {
    try {
      const r = await fetch(`${API}/downloader/sources`);
      const d = await r.json();
      setSmbSources(d.smb || []);
      if (!smbSourceId && d.smb && d.smb[0]) setSmbSourceId(String(d.smb[0].id));
    } catch (_) {}
  }, [smbSourceId]);

  useEffect(() => {
    refreshSources();
    refreshJobs();
  }, [refreshSources, refreshJobs]);

  useEffect(() => {
    if (jobs.some(j => j.status === 'running')) {
      pollRef.current = setInterval(refreshJobs, 1500);
      return () => clearInterval(pollRef.current);
    }
  }, [jobs, refreshJobs]);

  useEffect(() => {
    if (!extractJob || extractJob.status !== 'running') return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${API}/micromount/extract/${extractJob.id}`);
        if (!r.ok) return;
        setExtractJob(await r.json());
      } catch (_) {}
    }, 1500);
    return () => clearInterval(t);
  }, [extractJob?.id, extractJob?.status]);

  const isTorrentInput = (s) => /^magnet:\?/i.test(s) || /\.torrent(\?.*)?$/i.test(s);

  const handlePickDir = ({ kind, smbId, path }) => {
    if (kind === 'local') {
      setDestKind('local');
      setDestPath(path);
    } else if (kind === 'smb') {
      setDestKind('smb');
      setSmbSourceId(String(smbId));
      setSmbSubdir(path || '');
    }
  };

  const start = async () => {
    const trimmed = url.trim();
    if (!trimmed) return onNotification?.('URL required', 'error');
    if (!/^https?:\/\//i.test(trimmed) && !/^magnet:\?/i.test(trimmed)) {
      return onNotification?.('URL must be http(s) or magnet:?', 'error');
    }
    if (destKind === 'local' && !destPath.trim()) return onNotification?.('Destination directory required', 'error');
    if (destKind === 'smb' && !smbSourceId) return onNotification?.('SMB source required', 'error');

    setSubmitting(true);
    try {
      const body = {
        url: trimmed,
        filename: filename.trim() || undefined,
        dest_kind: destKind,
        overwrite,
      };
      if (destKind === 'local') body.dest_path = destPath.trim();
      else { body.smb_source_id = smbSourceId; body.smb_subdir = smbSubdir.trim() || undefined; }

      const r = await fetch(`${API}/downloader/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onNotification?.('Download added to queue', 'success');
      setUrl('');
      setFilename('');
      refreshJobs();
    } catch (e) { onNotification?.(e.message, 'error'); }
    setSubmitting(false);
  };

  const cancel = async (id) => {
    try {
      const r = await fetch(`${API}/downloader/${id}/cancel`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json()).error);
      refreshJobs();
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const remove = async (id) => {
    try {
      const r = await fetch(`${API}/downloader/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error);
      refreshJobs();
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-md">
        <div>
          <h2 className="font-bold" style={{ fontSize: '1.25rem' }}>Download</h2>
          <span className="text-muted text-sm">{jobs.length} downloads</span>
        </div>
        <button className="btn btn-sm btn-secondary" onClick={refreshJobs}>🔄 Refresh</button>
      </div>

      <div className="comp-card mb-md">
        <div className="comp-card-body">
          <div className="flex-col gap-md">
            <div>
              <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>URL</label>
              <input
                className="input"
                value={url} onChange={e => setUrl(e.target.value)}
                placeholder="https://example.com/file.iso or magnet:?xt=urn:btih:..."
              />
            </div>

            <div className="grid-2">
              <div>
                <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Filename (optional)</label>
                <input className="input" value={filename} onChange={e => setFilename(e.target.value)} placeholder="(auto)" />
              </div>
              <div>
                <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Destination</label>
                <select className="select" value={destKind} onChange={e => setDestKind(e.target.value)}>
                  <option value="local">💾 Local filesystem</option>
                  <option value="smb">📂 SMB share</option>
                </select>
              </div>
            </div>

            {destKind === 'local' ? (
              <div>
                <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Destination folder</label>
                <input className="input" value={destPath} onChange={e => setDestPath(e.target.value)} placeholder="/mnt/sda1/downloads" />
              </div>
            ) : (
              <div className="grid-2">
                <div>
                  <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>SMB source</label>
                  <select className="select" value={smbSourceId} onChange={e => setSmbSourceId(e.target.value)}>
                    <option value="">— pick source —</option>
                    {smbSources.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Sub-folder</label>
                  <input className="input" value={smbSubdir} onChange={e => setSmbSubdir(e.target.value)} placeholder="downloads" />
                </div>
              </div>
            )}

            <div className="flex items-center gap-md">
              <label className="flex items-center gap-sm" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />
                <span className="text-sm">Overwrite if exists</span>
              </label>
            </div>

            <button className="btn btn-success btn-block" onClick={start} disabled={submitting}>
              {submitting ? '⏳ Adding...' : '＋ Add Download to Queue'}
            </button>
            <div className="text-xs text-muted" style={{ textAlign: 'center' }}>
              Press <strong>Start</strong> in the Queue tab to begin downloads.
            </div>
          </div>
        </div>
      </div>

      <FileBrowser
        profiles={profiles}
        onNotification={onNotification}
        enableFtp enableExtract enableDelete enablePickDir
        onExtractStarted={(j) => setExtractJob(j)}
        onPickDir={handlePickDir}
        title="Pick destination folder"
        description="Use 'Pick' button on a folder to set it as download destination"
      />

      <ExtractQueuePanel onView={async (jobId) => {
        if (!jobId) return;
        const r = await fetch(`${API}/micromount/extract/${jobId}`);
        if (r.ok) setExtractJob(await r.json());
      }} />

      <ExtractLogPanel job={extractJob} />

      <div className="comp-card">
        <div className="comp-card-header">
          <span className="comp-card-title">Recent Downloads ({jobs.length})</span>
        </div>
        <div className="comp-card-body">
          {jobs.length === 0 && (
            <div className="empty-state" style={{ padding: 'var(--space-lg)' }}>
              <div className="empty-state-icon">⬇️</div>
              <div className="empty-state-title">No downloads yet</div>
              <div className="empty-state-text">Start your first download above</div>
            </div>
          )}
          {jobs.map(j => {
            const pct = j.bytes_total ? Math.min(100, (j.bytes_downloaded / j.bytes_total) * 100) : 0;
            return (
              <div key={j.id} className="list-item" style={{ flexWrap: 'wrap' }}>
                <div className="list-item-content">
                  <div className="list-item-title">{j.filename}</div>
                  <div className="list-item-subtitle truncate">{j.url}</div>
                  {j.bytes_total > 0 && (
                    <div className="mt-sm">
                      <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${pct}%`, background: STATUS_COLOR[j.status] || C.blue }} />
                      </div>
                      <div className="text-xs text-muted mt-sm">
                        {fmtMB(j.bytes_downloaded || 0)} / {fmtMB(j.bytes_total)} ({pct.toFixed(1)}%)
                      </div>
                    </div>
                  )}
                  {j.error && <div className="text-xs" style={{ color: 'var(--red)', marginTop: '0.25rem' }}>Error: {j.error}</div>}
                </div>
                <div className="list-item-actions">
                  <span className="badge" style={{ background: STATUS_COLOR[j.status] || C.muted }}>{j.status}</span>
                  <button className="btn btn-sm btn-ghost" onClick={() => remove(j.id)} title={j.status === 'running' ? 'Cancel & remove' : 'Remove'}>✕</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
