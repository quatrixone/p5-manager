import { useState, useEffect, useCallback } from 'react';
import FolderPickerModal from './UI/FolderPickerModal';

const API = '/api';

// Compact download form. Job history / progress moved entirely to the Queue
// tab, so this view focuses on the single task of "add a URL to the queue".
// The user can pick a destination folder from the Browse tab via the file
// browser's ✓ Pick action and paste it here, or just type a path.
export default function Downloader({ profiles = [], onNotification, onOpenQueue }) {
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [destKind, setDestKind] = useState('local');
  // Default to the canonical /data/downloads folder. We fetch the
  // authoritative path from /api/convert/paths once on mount so the
  // value tracks server-side overrides (USER_DATA_DIR env, etc.).
  const [destPath, setDestPath] = useState('/data/downloads');
  const [smbSourceId, setSmbSourceId] = useState('');
  const [smbSubdir, setSmbSubdir] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [smbSources, setSmbSources] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const refreshSources = useCallback(async () => {
    try {
      const r = await fetch(`${API}/downloader/sources`);
      const d = await r.json();
      setSmbSources(d.smb || []);
      if (!smbSourceId && d.smb && d.smb[0]) setSmbSourceId(String(d.smb[0].id));
    } catch (_) {}
  }, [smbSourceId]);

  useEffect(() => { refreshSources(); }, [refreshSources]);

  // Pull the server-side default download folder so the input reflects
  // wherever USER_DATA_DIR actually points to (useful when tests
  // override it or when running outside Docker).
  useEffect(() => {
    fetch(`${API}/convert/paths`).then(r => r.json()).then(d => {
      if (d?.downloads) setDestPath(d.downloads);
    }).catch(() => {});
  }, []);

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
      onOpenQueue?.();
    } catch (e) { onNotification?.(e.message, 'error'); }
    setSubmitting(false);
  };

  return (
    <div className="comp-card">
      <div className="comp-card-header">
        <div>
          <span className="comp-card-title">⬇️ Download from URL</span>
          <div className="text-xs text-muted mt-xs">
            Adds an HTTP(S) or magnet URL to the download queue. Press ▶ in the Tasks tab to start.
          </div>
        </div>
      </div>

      <div className="comp-card-body">
        <div className="flex-col gap-md">
          <div>
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>URL</label>
            <input
              className="input"
              value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://example.com/file.iso  ·  magnet:?xt=urn:btih:…"
            />
          </div>

          <div>
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Filename <span className="text-muted">(optional)</span></label>
            <input className="input" value={filename} onChange={e => setFilename(e.target.value)} placeholder="(auto-detected)" />
          </div>

          <div className="downloader-dest">
            <div className="flex items-center justify-between flex-wrap gap-sm">
              <span className="text-sm font-medium">📍 Destination</span>
              <div className="tabs" style={{ borderBottom: 'none' }}>
                <button
                  type="button"
                  className={`tab-item ${destKind === 'local' ? 'active' : ''}`}
                  onClick={() => setDestKind('local')}
                >
                  💾 Local
                </button>
                <button
                  type="button"
                  className={`tab-item ${destKind === 'smb' ? 'active' : ''}`}
                  onClick={() => setDestKind('smb')}
                >
                  📂 SMB
                </button>
              </div>
            </div>

            {destKind === 'local' ? (
              <div>
                <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Folder on the manager</label>
                <div className="flex gap-xs items-center">
                  <input
                    className="input flex-1"
                    value={destPath}
                    onChange={e => setDestPath(e.target.value)}
                    placeholder="/data/downloads"
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setPickerOpen(true)}
                    title="Browse folders graphically"
                  >
                    📁 Browse…
                  </button>
                </div>
                <div className="text-xs text-muted mt-sm">
                  Default <code>/data/downloads</code>. Click <b>Browse…</b> to pick a folder, or type a path directly.
                </div>
              </div>
            ) : (
              <div className="grid-2">
                <div>
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>SMB source</label>
                  <select className="select" value={smbSourceId} onChange={e => setSmbSourceId(e.target.value)}>
                    <option value="">— pick source —</option>
                    {smbSources.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Sub-folder</label>
                  <input className="input" value={smbSubdir} onChange={e => setSmbSubdir(e.target.value)} placeholder="downloads" />
                </div>
              </div>
            )}
          </div>

          <label className="flex items-center gap-sm" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />
            <span className="text-sm">Overwrite if file already exists</span>
          </label>

          <button className="btn btn-success btn-block" onClick={start} disabled={submitting}>
            {submitting ? '⏳ Adding…' : '＋ Add to queue'}
          </button>
        </div>
      </div>

      <FolderPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(p) => setDestPath(p)}
        initialPath={destPath}
        title="Pick download folder"
      />
    </div>
  );
}
