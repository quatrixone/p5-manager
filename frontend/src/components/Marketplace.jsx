import { useCallback, useEffect, useState } from 'react';
import { api, apiSafe } from '../lib/api.js';
import { usePlatform } from '../contexts/PlatformContext';
import { usePs5Status } from '../contexts/Ps5StatusContext';
import MarketplaceNews from './MarketplaceNews.jsx';
import SourcesPanel from './SourcesPanel.jsx';
import { ItemActions, ItemCard, StoreIcon } from './MarketplaceItem.jsx';
import { KIND_LABEL, sizeLabel } from '../lib/marketplaceView.js';
import { useMarketplaceUpdates } from '../App.jsx';

const API = '/store';
const mb = (n) => sizeLabel(n);

function Detail({ entry, profiles, consoleOnline, onClose, onInstalled, onNotification }) {
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');
  const targets = profiles.filter((p) => !entry.console_type || (p.console_type || 'ps5') === entry.console_type);
  const needsConsole = (entry.kind === 'template' && entry.requiresProfile !== false) || (entry.kind === 'homebrew' && (entry.files || []).includes('pkg'));

  useEffect(() => {
    api.get(`${API}/item/${entry.kind}/${entry.id}`).then((r) => setItem(r.item)).catch((e) => setError(e.message));
  }, [entry]);

  const uninstall = async () => {
    if (!window.confirm(`Remove ${entry.name}?`)) return;
    try {
      await api.post(`${API}/uninstall`, { kind: entry.kind, id: entry.id });
      onNotification?.(`${entry.name} removed`, 'success');
      onInstalled();
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  return (
    <div className="comp-card mt-sm" style={{ borderColor: 'var(--accent, var(--blue))' }}>
      <div className="comp-card-body">
        <div className="flex items-center justify-between gap-sm">
          <div className="flex items-center gap-sm"><StoreIcon entry={entry} size={64} /><div className="font-bold">{entry.name}</div></div>
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
        {needsConsole && !targets.length && (
          <div className="text-sm text-muted mb-sm">No {(entry.console_type || 'console').toUpperCase()} profile to install it on.</div>
        )}
        <div className="flex gap-sm flex-wrap">
          <div style={{ flex: '1 1 160px' }}>
            <ItemActions item={entry} profiles={profiles} consoleOnline={consoleOnline} onNotification={onNotification} onDone={onInstalled} />
          </div>
          {entry.installed && !['homebrew', 'payload'].includes(entry.kind) && (
            <button className="btn btn-danger" onClick={uninstall} style={{ minHeight: 44 }}>Remove</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Publish({ onNotification, entries }) {
  const [githubLogin, setGithubLogin] = useState(() => {
    try { return localStorage.getItem('marketplaceGithubLogin') || ''; } catch { return ''; }
  });
  const [showAll, setShowAll] = useState(false);
  const login = githubLogin.trim();
  const validLogin = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(login);
  useEffect(() => {
    setStoreId(''); setResult(null);
    try { localStorage.setItem('marketplaceGithubLogin', login); } catch { /* Optional preference. */ }
  }, [login]);
  const [kind, setKind] = useState('script');
  const [publishMode, setPublishMode] = useState('new');
  const [storeId, setStoreId] = useState('');
  const [itemJson, setItemJson] = useState('{}');
  const [itemLoading, setItemLoading] = useState(false);
  const packaged = kind === 'homebrew' || kind === 'payload';
  const owned = (entries || []).filter(i => i.kind === kind && (showAll || i.author?.toLowerCase() === login.toLowerCase()));
  const updating = owned.find(i => i.id === storeId);
  const [mine, setMine] = useState({ script: [], template: [] });
  const [localId, setLocalId] = useState('');
  const [description, setDescription] = useState('');

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
  useEffect(() => {
    setLocalId(''); setStoreId(''); setResult(null); setDescription(''); setConsoleType(packaged ? 'ps4' : '');
    setItemJson(JSON.stringify({ name: '', console_type: 'ps4', app_version: '1.0', files: [{ type: kind === 'payload' ? 'bin' : 'pkg', url: 'https://example.org/release/app.' + (kind === 'payload' ? 'bin' : 'pkg') }] }, null, 2));
  }, [kind, publishMode]);
  useEffect(() => {
    if (!packaged || !storeId) { setItemLoading(false); return; }
    let cancelled = false;
    setItemLoading(true);
    api.get(`${API}/item/${kind}/${storeId}`).then(r => { if (!cancelled) setItemJson(JSON.stringify(r.item, null, 2)); })
      .catch(e => { if (!cancelled) onNotification?.(e.message, 'error'); })
      .finally(() => { if (!cancelled) setItemLoading(false); });
    return () => { cancelled = true; };
  }, [kind, storeId, packaged]);

  const publish = async () => {
    try {
      const r = await api.post(`${API}/publish`, { kind, localId, description, author: login, item: packaged ? JSON.parse(itemJson) : undefined, storeId: publishMode === 'update' ? storeId : undefined, console_type: consoleType || undefined });
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
          Share your scripts, Autoload sequences, homebrew apps or payloads. This opens a prefilled GitHub issue (a GitHub account is needed);
          Sign in and submit the issue on GitHub. Your identity and update ownership are verified there before maintainer acceptance.
        </div>
        <label className="text-sm" htmlFor="marketplace-github-login">GitHub username</label>
        <input id="marketplace-github-login" className="input mb-sm" value={githubLogin} onChange={e => setGithubLogin(e.target.value)} placeholder="Your GitHub username" autoComplete="username" maxLength={39} style={{ width: '100%' }} />
        <div className="text-xs text-muted mb-sm">This name filters your items. Submit the issue with your own GitHub account; GitHub verifies the author. No OAuth setup is needed.</div>
        <div className="tabs mb-sm">
          <button className={`tab-item ${kind === 'script' ? 'active' : ''}`} onClick={() => setKind('script')}>Input script</button>
          <button className={`tab-item ${kind === 'template' ? 'active' : ''}`} onClick={() => setKind('template')}>Autoload sequence</button>
          <button className={`tab-item ${kind === 'homebrew' ? 'active' : ''}`} onClick={() => setKind('homebrew')}>Homebrew</button>
          <button className={`tab-item ${kind === 'payload' ? 'active' : ''}`} onClick={() => setKind('payload')}>Payload</button>
        </div>
        <div className="tabs mb-sm">
          <button className={`tab-item ${publishMode === 'new' ? 'active' : ''}`} onClick={() => setPublishMode('new')}>New item</button>
          <button className={`tab-item ${publishMode === 'update' ? 'active' : ''}`} onClick={() => setPublishMode('update')}>Update my item</button>
        </div>
        {publishMode === 'update' && (
          <>
            <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}><input type="checkbox" checked={showAll} onChange={e => { setShowAll(e.target.checked); setStoreId(''); setResult(null); }} /> Show all items (for example, after a GitHub username change)</label>
            <select className="select mb-sm" value={storeId} onChange={e => {
              setStoreId(e.target.value); setResult(null);
              const item = owned.find(i => i.id === e.target.value);
              if (item) { setDescription(item.description || ''); setConsoleType(item.console_type || ''); }
            }} style={{ width: '100%', minHeight: 40 }}>
              <option value="">{owned.length ? 'Pick your published item…' : 'No published items for this account'}</option>
              {owned.map(i => <option key={i.id} value={i.id}>{i.name} · v{i.version}</option>)}
            </select>
            {updating && <div className="text-xs text-muted mb-sm">Submitting v{updating.version + 1}. {packaged ? 'Edit the release information below.' : `Select your updated local ${kind === 'script' ? 'script' : 'sequence'} below.`} The update is listed after maintainer review.</div>}
          </>
        )}
        {packaged ? <textarea className="input mb-sm" rows={9} aria-label="Homebrew item JSON" value={itemJson} disabled={itemLoading} onChange={e => setItemJson(e.target.value)} style={{ width: '100%', fontFamily: 'monospace' }} /> : <select className="select mb-sm" value={localId} onChange={(e) => setLocalId(e.target.value)} style={{ width: '100%', minHeight: 40 }}>
          <option value="">{list.length ? 'Pick one of yours…' : 'You have none yet'}</option>
          {(list || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>}
        <textarea className="input mb-sm" rows={3} placeholder="What it does, and what it needs (firmware, payloads…)" value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: '100%' }} />
        <div className="flex gap-sm flex-wrap mb-sm">
          <div className="text-sm" style={{ flex: '1 1 160px' }}>{validLogin ? `GitHub username: @${login}` : 'Enter your GitHub username above.'}</div>
          <select className="select" value={consoleType} onChange={(e) => setConsoleType(e.target.value)} style={{ flex: '1 1 120px', minHeight: 40 }}>
            <option value="">PS4 + PS5</option>
            <option value="ps5">PS5</option>
            <option value="ps4">PS4</option>
          </select>
        </div>
        <button className="btn btn-primary" onClick={publish} disabled={!validLogin || (!packaged && !localId) || itemLoading || !description.trim() || (publishMode === 'update' && !storeId)} style={{ width: '100%', minHeight: 44 }}>
          {publishMode === 'update' ? 'Submit update on GitHub' : 'Publish on GitHub'}
        </button>
        {result && <a className="btn btn-secondary mt-sm" href={result.issueUrl} target="_blank" rel="noreferrer">Open submission on GitHub</a>}
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

// Marketplace: one list for the curated store, the FPKGi Catalog Hub and
// any catalog the user added, with New activity in front of it.
const KINDS = [
  { id: 'all', label: 'All' },
  { id: 'payload', label: '📦 Payloads' },
  { id: 'homebrew', label: '🎮 Homebrew' },
  { id: 'template', label: '⚡ Autoload' },
  { id: 'script', label: '🕹️ Scripts' },
  { id: 'catalog', label: '💿 Packages' },
];

function CatalogDetail({ item, profiles, consoleOnline, onClose, onNotification, onDone }) {
  return (
    <div className="comp-card mt-sm" style={{ borderColor: 'var(--accent, var(--blue))' }}>
      <div className="comp-card-body">
        <div className="flex items-center justify-between gap-sm">
          <div className="flex items-center gap-sm"><StoreIcon entry={item} size={64} /><div className="font-bold">{item.name}</div></div>
          <button className="btn btn-sm btn-secondary" onClick={onClose}>✕</button>
        </div>
        <div className="text-xs text-muted mb-sm">
          {[item.title_id, item.region, item.version && `v${item.version}`, item.min_fw && `FW ${item.min_fw}`, item.size && mb(item.size)].filter(Boolean).join(' · ')}
        </div>
        <div className="text-xs mb-sm">Listed by {item.author}. {item.verified ? 'The source pins a SHA-256, which is checked after the download.' : 'The source gives no SHA-256, so the package cannot be checked.'}</div>
        {item.sha256 && <details className="text-xs mb-sm"><summary>SHA-256</summary><code style={{ wordBreak: 'break-all' }}>{item.sha256}</code></details>}
        {item.package_url && <div className="text-xs mb-sm" style={{ wordBreak: 'break-all' }}>📦 <a href={item.package_url} target="_blank" rel="noreferrer">{item.package_url}</a></div>}
        <ItemActions item={item} profiles={profiles} consoleOnline={consoleOnline} onNotification={onNotification} onDone={onDone} />
      </div>
    </div>
  );
}

export default function Marketplace({ profiles = [], onNotification }) {
  const { mode } = usePlatform();
  const { state } = usePs5Status();
  const storeUpdates = useMarketplaceUpdates();
  // Unknown ('waking') never blocks an action; the install says the truth.
  const consoleOnline = state === 'online' ? true : state === 'waking' ? null : false;
  const [section, setSection] = useState('new');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [platform, setPlatform] = useState(mode === 'ps4' ? 'ps4' : 'ps5');
  const [source, setSource] = useState('all');
  const [category, setCategory] = useState('all');
  const [kind, setKind] = useState('all');
  const [query, setQuery] = useState('');
  const [updatesOnly, setUpdatesOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState(null);

  useEffect(() => { if (mode === 'ps4' || mode === 'ps5') { setPlatform(mode); setOpen(null); } }, [mode]);
  // Opening the Marketplace is the user seeing what changed in the curated
  // built-ins, so the badge stops counting them.
  useEffect(() => {
    apiSafe.post(`${API}/updates/seen`, {}).then(() => storeUpdates.refresh?.());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPage(1); }, [platform, source, category, kind, query, updatesOnly]);
  useEffect(() => {
    const timer = setInterval(() => setRevision((v) => v + 1), 15 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async ({ refresh = false } = {}) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        platform, source, category, kind, q: query, page: String(page), limit: '48',
        updates: updatesOnly ? '1' : '0', refresh: refresh ? '1' : '0',
      });
      const result = await api.get(`${API}/browse?${params}`);
      setData(result);
      if (result.page !== page) setPage(result.page);
      return true;
    } catch (e) { setError(e.message); return false; }
    finally { setLoading(false); }
  }, [platform, source, category, kind, query, updatesOnly, page]);

  useEffect(() => {
    if (section !== 'browse') return undefined;
    const timer = setTimeout(() => { load(); }, 250);
    return () => clearTimeout(timer);
  }, [section, load, revision]);

  const checkUpdates = async () => {
    setRefreshing(true);
    try {
      const [builtins, loaded] = await Promise.all([
        api.post(`${API}/refresh-builtins`, {}).catch((e) => ({ error: e.message })),
        load({ refresh: true }),
      ]);
      if (!loaded) return;
      if (builtins.error) { onNotification?.(`Checked, but the curated scripts could not refresh: ${builtins.error}`, 'error'); return; }
      onNotification?.('Marketplace checked; curated scripts, templates and the default payload list refreshed. Local edits kept.', 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
    finally { setRefreshing(false); }
  };

  const items = data?.items || [];
  const openItem = open && items.find((i) => i.origin === open.origin && i.kind === open.kind && String(i.id) === String(open.id));

  return (
    <div>
      <div className="flex gap-sm flex-wrap mb-sm">
        <button className={`btn ${section === 'new' ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={section === 'new'} onClick={() => setSection('new')}>New</button>
        <button className={`btn ${section === 'browse' ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={section === 'browse'} onClick={() => setSection('browse')}>Marketplace</button>
        {['ps4', 'ps5'].map((p) => (
          <button key={p} className={`btn ${platform === p ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={platform === p} onClick={() => setPlatform(p)}>{p.toUpperCase()}</button>
        ))}
        <button className="btn btn-secondary" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((v) => !v)}>⚙ Sources</button>
      </div>

      {sourcesOpen && (
        <SourcesPanel onNotification={onNotification} onChanged={() => { setSource('all'); load({ refresh: true }); }} />
      )}

      {section === 'new' ? (
        <MarketplaceNews
          key={platform}
          platform={platform}
          profiles={profiles}
          consoleOnline={consoleOnline}
          onNotification={onNotification}
          onOpen={(item) => {
            setSection('browse');
            setSource(item.origin || 'all');
            setKind('all');
            setQuery(item.title_id || item.name);
            setUpdatesOnly(false);
          }}
        />
      ) : (
        <>
          <div className="flex gap-sm flex-wrap mb-sm">
            <input className="input" aria-label="Search the marketplace" placeholder="🔍 Search name, title ID or author" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={200} style={{ flex: '2 1 200px', minHeight: 40 }} />
            <select className="select" aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)} style={{ flex: '1 1 160px', minHeight: 40 }}>
              <option value="all">All sources</option>
              {(data?.sources || []).map((srv) => <option key={srv.id} value={srv.id}>{srv.label}</option>)}
            </select>
            <select className="select" aria-label="Catalog category" value={category} onChange={(e) => setCategory(e.target.value)} style={{ flex: '1 1 140px', minHeight: 40 }}>
              <option value="all">All categories</option>
              {(data?.categories || []).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <button className="btn btn-secondary" onClick={checkUpdates} disabled={refreshing} style={{ minHeight: 40 }}>{refreshing ? 'Checking…' : '↻ Check updates'}</button>
            <button className={`btn ${updatesOnly ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={updatesOnly} onClick={() => setUpdatesOnly((v) => !v)} style={{ minHeight: 40 }}>Updates</button>
          </div>
          <div className="flex gap-xs flex-wrap mb-sm">
            {KINDS.map((k) => (
              <button key={k.id} className={`btn btn-sm ${kind === k.id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setKind(k.id)} style={{ minHeight: 36 }}>{k.label}</button>
            ))}
          </div>

          {loading && <div className="text-xs text-muted mb-sm">Loading the {platform.toUpperCase()} list…</div>}
          {error && <div role="alert" className="text-sm" style={{ color: 'var(--red)' }}>Marketplace unreachable: {error}</div>}
          {!!data?.warnings?.length && (
            <details className="text-xs mb-sm"><summary>Some sources are unavailable; the last saved copy is shown</summary>{data.warnings.map((w) => <div key={w}>{w}</div>)}</details>
          )}
          {data?.libraryTakenAt && (
            <div className="text-xs text-muted mb-sm">What is on the console is from the Library check on {new Date(data.libraryTakenAt).toLocaleString()}.</div>
          )}

          {openItem && (openItem.kind === 'catalog'
            ? <CatalogDetail item={openItem} profiles={profiles} consoleOnline={consoleOnline} onClose={() => setOpen(null)} onNotification={onNotification} onDone={() => load({ refresh: false })} />
            : <Detail entry={openItem} profiles={profiles} consoleOnline={consoleOnline} onClose={() => setOpen(null)} onInstalled={() => load({ refresh: false })} onNotification={onNotification} />)}

          {data && !items.length && !loading && (
            <div className="empty-state">
              <div className="empty-state-icon">🛒</div>
              <div className="empty-state-title">{updatesOnly ? 'No available updates' : 'Nothing matches'}</div>
              <div className="empty-state-text">No {platform.toUpperCase()} items match these filters.</div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8, marginTop: 8 }}>
            {items.map((i) => (
              <ItemCard
                key={`${i.origin}:${i.kind}:${i.id}`}
                item={i}
                profiles={profiles}
                consoleOnline={consoleOnline}
                onOpen={() => setOpen({ origin: i.origin, kind: i.kind, id: i.id })}
                onNotification={onNotification}
                onDone={() => load({ refresh: false })}
              />
            ))}
          </div>

          {data && data.pages > 1 && (
            <div className="flex items-center justify-between gap-sm mt-sm">
              <button className="btn btn-secondary" disabled={loading || data.page <= 1} onClick={() => setPage(data.page - 1)}>Previous</button>
              <span className="text-sm">Page {data.page} / {data.pages} · {data.total} items</span>
              <button className="btn btn-secondary" disabled={loading || data.page >= data.pages} onClick={() => setPage(data.page + 1)}>Next</button>
            </div>
          )}

          <Publish onNotification={onNotification} entries={items.filter((i) => i.origin === 'marketplace')} />
        </>
      )}
    </div>
  );
}
