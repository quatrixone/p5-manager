// Catalogs the user added. A source is one https JSON file: either an
// FPKGi catalog or a P5 Manager index - the server works out which, and
// says so here, together with when it was last read and what went wrong.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export default function SourcesPanel({ onNotification, onChanged }) {
  const [sources, setSources] = useState([]);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [consoleType, setConsoleType] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setSources((await api.get('/store/sources')).sources || []); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/store/sources', { url: url.trim(), name: name.trim(), console_type: consoleType || undefined });
      onNotification?.(`${r.source.name} added: ${r.source.items} items`, 'success');
      setUrl(''); setName(''); setConsoleType('');
      await load();
      onChanged?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const toggle = async (source) => {
    try {
      await api.patch(`/store/sources/${source.id}`, { enabled: !source.enabled });
      await load();
      onChanged?.();
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const remove = async (source) => {
    if (!window.confirm(`Remove the source ${source.name}? Items installed from it stay installed.`)) return;
    try {
      await api.del(`/store/sources/${source.id}`);
      await load();
      onChanged?.();
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  return (
    <div className="comp-card mb-sm">
      <div className="comp-card-body">
        <div className="font-bold mb-xs">⚙ Catalog sources</div>
        <div className="text-xs text-muted mb-sm">
          Add an https link to a catalog JSON - an FPKGi catalog (a file with <code>DATA</code>) or a P5 Manager index
          (a file with <code>items</code>). Its items join the list beside the Marketplace and the FPKGi hub. Sources are
          read every 15 minutes; a source that is down leaves its last copy in place.
        </div>
        <div className="flex gap-sm flex-wrap mb-sm">
          <input className="input" aria-label="Catalog URL" placeholder="https://example.org/catalog.json" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2048} style={{ flex: '2 1 240px', minHeight: 40 }} />
          <input className="input" aria-label="Name for this source" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} style={{ flex: '1 1 140px', minHeight: 40 }} />
          <select className="select" aria-label="Console for this source" value={consoleType} onChange={(e) => setConsoleType(e.target.value)} style={{ flex: '1 1 120px', minHeight: 40 }}>
            <option value="">PS4 + PS5</option>
            <option value="ps5">PS5</option>
            <option value="ps4">PS4</option>
          </select>
          <button className="btn btn-primary" onClick={add} disabled={busy || !url.trim()} style={{ minHeight: 40 }}>{busy ? 'Checking…' : 'Add source'}</button>
        </div>
        {error && <div role="alert" className="text-sm mb-sm" style={{ color: 'var(--red)' }}>{error}</div>}
        {!sources.length && <div className="text-xs text-muted">No sources of your own yet.</div>}
        {sources.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-sm mt-xs" style={{ flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div className="font-bold" style={{ wordBreak: 'break-word' }}>{s.name} {!s.enabled && <span className="badge">off</span>}</div>
              <div className="text-xs text-muted" style={{ wordBreak: 'break-all' }}>{s.url}</div>
              <div className="text-xs text-muted">
                {s.format === 'fpkgi' ? 'FPKGi catalog' : s.format === 'store' ? 'P5 Manager index' : 'Not read yet'}
                {s.console_type ? ` · ${s.console_type.toUpperCase()}` : ''}
                {s.last_fetched_at ? ` · read ${new Date(s.last_fetched_at).toLocaleString()}` : ''}
              </div>
              {s.last_error && <div className="text-xs" style={{ color: 'var(--red)' }}>{s.last_error}</div>}
            </div>
            <div className="flex gap-xs">
              <button className="btn btn-sm btn-secondary" onClick={() => toggle(s)}>{s.enabled ? 'Disable' : 'Enable'}</button>
              <button className="btn btn-sm btn-danger" onClick={() => remove(s)}>Remove</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
