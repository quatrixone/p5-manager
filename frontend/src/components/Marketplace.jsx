import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiSafe } from '../lib/api.js';
import { usePlatform } from '../contexts/PlatformContext';

const API = '/store';
const KINDS = [
  { id: 'all', label: 'All' },
  { id: 'payload', label: '📦 Payloads' },
  { id: 'homebrew', label: '🎮 Homebrew' },
  { id: 'template', label: '⚡ Autoload' },
  { id: 'script', label: '🕹️ Scripts' },
];
const KIND_LABEL = { payload: 'Payload', homebrew: 'Homebrew', template: 'Autoload template', script: 'Input script' };

const mb = (n) => (n ? `${(n / 1e6).toFixed(n > 1e7 ? 0 : 1)} MB` : '');

function Detail({ entry, profiles, onClose, onInstalled, onNotification }) {
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');
  const [pid, setPid] = useState('');
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const targets = profiles.filter((p) => !entry.console_type || (p.console_type || 'ps5') === entry.console_type);
  const needsConsole = (entry.kind === 'template' && entry.requiresProfile !== false) || (entry.kind === 'homebrew' && (entry.files || []).includes('pkg'));

  useEffect(() => {
    api.get(`${API}/item/${entry.kind}/${entry.id}`).then((r) => setItem(r.item)).catch((e) => setError(e.message));
  }, [entry]);
  useEffect(() => { if (!pid && targets.length) setPid(String(targets[0].id)); }, [targets, pid]);
  useEffect(() => {
    if (!job || job.state !== 'running') return undefined;
    const t = setInterval(async () => {
      const r = await apiSafe.get(`${API}/jobs/${job.id}`);
      if (!r?.job) return;
      setJob(r.job);
      if (r.job.state === 'done') { onNotification?.(`${entry.name} installed`, 'success'); onInstalled(); }
      if (r.job.state === 'failed') onNotification?.(r.job.error, 'error');
    }, 1000);
    return () => clearInterval(t);
  }, [job, entry, onInstalled, onNotification]);

  const install = async () => {
    setBusy(true);
    try {
      const r = await api.post(`${API}/install`, { kind: entry.kind, id: entry.id, profileId: pid || undefined });
      if (r.job) setJob(r.job);
      else { onNotification?.(`${entry.name} installed`, 'success'); onInstalled(); }
    } catch (e) { onNotification?.(e.message, 'error'); }
    setBusy(false);
  };
  const uninstall = async () => {
    if (!window.confirm(`Remove ${entry.name}?`)) return;
    try {
      await api.post(`${API}/uninstall`, { kind: entry.kind, id: entry.id });
      onNotification?.(`${entry.name} removed`, 'success');
      onInstalled();
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const running = job?.state === 'running';
  return (
    <div className="comp-card mt-sm" style={{ borderColor: 'var(--accent, var(--blue))' }}>
      <div className="comp-card-body">
        <div className="flex items-center justify-between gap-sm">
          <div className="font-bold">{entry.name}</div>
          <button className="btn btn-sm btn-secondary" onClick={onClose}>✕</button>
        </div>
        <div className="text-xs text-muted mb-sm">
          {KIND_LABEL[entry.kind]} · by {entry.author} · v{entry.app_version || entry.version}
          {entry.console_type ? ` · ${entry.console_type.toUpperCase()}` : ' · PS4 + PS5'}
        </div>
        <div className="text-sm mb-sm">{entry.description}</div>
        {error && <div className="text-sm" style={{ color: 'var(--red)' }}>{error}</div>}
        {item?.kind === 'template' && (
          <ol className="text-xs" style={{ paddingLeft: 18 }}>
            {item.steps.map((s, i) => <li key={i}><b>{s.type}</b>{s.name ? ` - ${s.name}` : ''}</li>)}
          </ol>
        )}
        {item?.kind === 'script' && (
          <pre className="text-xs" style={{ maxHeight: 200, overflow: 'auto', background: 'var(--bg-secondary, rgba(0,0,0,.2))', padding: 8, borderRadius: 6 }}>{item.script}</pre>
        )}
        {['homebrew', 'payload'].includes(item?.kind) && (
          <div className="text-xs mb-sm">
            {item.files.map((f) => (
              <div key={f.url} style={{ wordBreak: 'break-all' }}>📦 {f.type.toUpperCase()} · {mb(f.size)} · <a href={f.url} target="_blank" rel="noreferrer">{f.url}</a></div>
            ))}
            {item.homepage && <div className="mt-xs"><a href={item.homepage} target="_blank" rel="noreferrer">Project page</a>{item.license ? ` · ${item.license}` : ''}</div>}
            <div className="text-muted mt-xs">
              Downloaded from the author&apos;s page and checked against the listed checksum.
              {(item.files.some((f) => f.type !== 'pkg')) && ' Payloads go into the payload library.'}
              {needsConsole && (entry.console_type === 'ps5'
                ? ' The PKG goes into the install queue (needs the ELF loader).'
                : ' The PKG is sent to Remote Package Installer - open it on the PS4 first.')}
            </div>
          </div>
        )}
        {needsConsole && (
          targets.length
            ? (
              <select className="select mb-sm" value={pid} onChange={(e) => setPid(e.target.value)} style={{ width: '100%', minHeight: 40 }}>
                {targets.map((p) => <option key={p.id} value={p.id}>Install on {p.name} ({p.ip_address})</option>)}
              </select>
            )
            : <div className="text-sm text-muted mb-sm">No {(entry.console_type || 'console').toUpperCase()} profile to install it on.</div>
        )}
        {job && (
          <div className="text-sm mb-sm" style={{ color: job.state === 'failed' ? 'var(--red)' : undefined }}>
            {running ? '⏳ ' : job.state === 'done' ? '✅ ' : '❌ '}{job.state === 'failed' ? job.error : job.step}
          </div>
        )}
        <div className="flex gap-sm flex-wrap">
          <button className="btn btn-primary" onClick={install} disabled={busy || running || !item || (needsConsole && !pid)} style={{ flex: '1 1 160px', minHeight: 44 }}>
            {entry.update ? 'Update' : entry.kind === 'homebrew' ? 'Install' : entry.installed ? 'Import again' : 'Import'}
          </button>
          {entry.installed && !['homebrew', 'payload'].includes(entry.kind) && (
            <button className="btn btn-danger" onClick={uninstall} style={{ minHeight: 44 }}>Remove</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Publish({ onNotification }) {
  const [kind, setKind] = useState('script');
  const [mine, setMine] = useState({ script: [], template: [] });
  const [localId, setLocalId] = useState('');
  const [description, setDescription] = useState('');
  const [author, setAuthor] = useState(() => { try { return localStorage.getItem('store.author') || ''; } catch (_) { return ''; } });
  const [consoleType, setConsoleType] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    Promise.all([apiSafe.get('/input-scripts'), apiSafe.get('/sequences')]).then(([s, q]) => {
      setMine({
        script: (s || []).map((x) => ({ id: x.id, name: x.name })),
        template: (q || []).map((x) => ({ id: x.id, name: x.name })),
      });
    });
  }, []);
  useEffect(() => { setLocalId(''); setResult(null); }, [kind]);

  const publish = async () => {
    try { localStorage.setItem('store.author', author); } catch (_) { /* private mode */ }
    try {
      const r = await api.post(`${API}/publish`, { kind, localId, description, author, console_type: consoleType || undefined });
      setResult(r);
      window.open(r.issueUrl, '_blank', 'noopener');
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const list = mine[kind];
  return (
    <div className="comp-card mt-md">
      <div className="comp-card-body">
        <div className="font-bold mb-xs">📤 Publish</div>
        <div className="text-xs text-muted mb-sm">
          Share one of your input scripts or Autoload sequences. This opens a prefilled GitHub issue (a GitHub account is needed);
          once a maintainer accepts it, it shows up here for everyone. Homebrew is added the same way, by editing the issue&apos;s JSON.
        </div>
        <div className="tabs mb-sm">
          <button className={`tab-item ${kind === 'script' ? 'active' : ''}`} onClick={() => setKind('script')}>Input script</button>
          <button className={`tab-item ${kind === 'template' ? 'active' : ''}`} onClick={() => setKind('template')}>Autoload sequence</button>
        </div>
        <select className="select mb-sm" value={localId} onChange={(e) => setLocalId(e.target.value)} style={{ width: '100%', minHeight: 40 }}>
          <option value="">{list.length ? 'Pick one of yours…' : 'You have none yet'}</option>
          {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <textarea className="input mb-sm" rows={3} placeholder="What it does, and what it needs (firmware, payloads…)" value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: '100%' }} />
        <div className="flex gap-sm flex-wrap mb-sm">
          <input className="input" placeholder="Your name" value={author} onChange={(e) => setAuthor(e.target.value)} style={{ flex: '1 1 160px', minHeight: 40 }} />
          <select className="select" value={consoleType} onChange={(e) => setConsoleType(e.target.value)} style={{ flex: '1 1 120px', minHeight: 40 }}>
            <option value="">PS4 + PS5</option>
            <option value="ps5">PS5</option>
            <option value="ps4">PS4</option>
          </select>
        </div>
        <button className="btn btn-primary" onClick={publish} disabled={!localId || !description.trim() || !author.trim()} style={{ width: '100%', minHeight: 44 }}>
          Publish on GitHub
        </button>
        {result && !result.prefilled && (
          <div className="mt-sm text-xs">
            It is too long to prefill: paste this into the issue&apos;s Item field.
            <textarea className="input mt-xs" readOnly rows={6} value={result.json} style={{ width: '100%', fontFamily: 'monospace' }} onFocus={(e) => e.target.select()} />
          </div>
        )}
      </div>
    </div>
  );
}

// Tools -> Marketplace: homebrew apps, Autoload templates and input scripts
// shared by users (store/ in the repository), installed with a tap.
export default function Marketplace({ profiles = [], onNotification }) {
  const { mode } = usePlatform();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null);
  // Only what fits the console of the active profile - unless asked for all.
  const [platform, setPlatform] = useState(mode === 'ps4' ? 'ps4' : 'ps5');
  useEffect(() => { if (mode === 'ps4' || mode === 'ps5') { setPlatform(mode); setOpen(null); } }, [mode]);
  const fits = (i) => !i.console_type || i.console_type === platform;

  const load = useCallback(async (refresh = false) => {
    setError('');
    try { setData(await api.get(`${API}/index${refresh ? '?refresh=1' : ''}`)); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.items || [])
      .filter((i) => kind === 'all' || i.kind === kind)
      .filter(fits)
      .filter((i) => !q || `${i.name} ${i.description} ${i.author}`.toLowerCase().includes(q));
  }, [data, kind, query, platform]); // eslint-disable-line react-hooks/exhaustive-deps

  const reopen = useCallback(async () => {
    await load(true);
    setOpen((o) => (o ? { ...o } : o));
  }, [load]);
  const openEntry = open && (data?.items || []).find((i) => i.kind === open.kind && i.id === open.id);

  return (
    <div>
      <div className="flex gap-sm flex-wrap mb-sm">
        <input className="input" placeholder="🔍 Search" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: '1 1 200px', minHeight: 40 }} />
        <button className="btn btn-secondary" onClick={() => load(true)} style={{ minHeight: 40 }}>↻</button>
      </div>
      <div className="flex gap-xs flex-wrap mb-sm">
        {KINDS.map((k) => (
          <button key={k.id} className={`btn btn-sm ${kind === k.id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setKind(k.id)} style={{ minHeight: 36 }}>{k.label}</button>
        ))}
        {['ps4', 'ps5'].map(p => (
          <button key={p} className={`btn btn-sm ${platform === p ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setPlatform(p); setOpen(null); }} aria-pressed={platform === p} style={{ minHeight: 36 }}>
            {p.toUpperCase()}
          </button>
        ))}
      </div>
      {error && <div className="text-sm" style={{ color: 'var(--red)' }}>Marketplace unreachable: {error}</div>}
      {data && items.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">🛒</div>
          <div className="empty-state-title">{data.items.length ? 'Nothing matches' : 'The marketplace is empty so far'}</div>
          <div className="empty-state-text">
            {!data.items.length ? 'Publish the first one below.' : `No ${platform.toUpperCase()} items match these filters.`}
          </div>
        </div>
      )}
      {openEntry && (
        <Detail entry={openEntry} profiles={profiles} onClose={() => setOpen(null)} onInstalled={reopen} onNotification={onNotification} />
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8, marginTop: 8 }}>
        {items.map((i) => (
          <button
            key={`${i.kind}:${i.id}`}
            type="button"
            className="comp-card"
            onClick={() => setOpen({ kind: i.kind, id: i.id })}
            style={{ textAlign: 'left', cursor: 'pointer', color: 'inherit', padding: 0 }}
          >
            <div className="comp-card-body p-sm">
              <div className="flex items-center justify-between gap-xs">
                <span className="font-bold" style={{ wordBreak: 'break-word' }}>{i.name}</span>
                {i.update ? <span className="badge badge-warning">update</span> : i.installed ? <span className="badge badge-success">✓</span> : null}
              </div>
              <div className="text-xs text-muted">
                {KIND_LABEL[i.kind]}{i.console_type ? ` · ${i.console_type.toUpperCase()}` : ''} · {i.author}
                {['homebrew', 'payload'].includes(i.kind) && i.size ? ` · ${mb(i.size)}` : ''}
              </div>
              <div className="text-xs mt-xs" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{i.description}</div>
            </div>
          </button>
        ))}
      </div>
      <Publish onNotification={onNotification} />
    </div>
  );
}
