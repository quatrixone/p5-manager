import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

const icons = { games: '🎮', apps: '📱', updates: '↻', dlc: '🧩', demos: '🕹️', homebrew: '🔧', emulators: '💻', themes: '🎨', ps1: '🎮', ps2: '🎮', psp: '🎮' };
function Cover({ item }) {
  const [broken, setBroken] = useState(false);
  return item.icon && !broken
    ? <img src={item.icon} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} style={{ width: 64, height: 64, objectFit: 'contain', borderRadius: 8 }} />
    : <span aria-hidden="true" style={{ fontSize: 32 }}>{icons[item.category]}</span>;
}
const size = n => n ? (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`) : 'Size unavailable';

export default function CatalogHub({ platform, initialCategory = 'homebrew', initialQuery = '' }) {
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState(initialCategory);
  const [query, setQuery] = useState(initialQuery);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshed = useRef(0);

  useEffect(() => {
    let active = true;
    api.get('/store/catalog/categories').then(r => { if (active) setCategories(r.categories); })
      .catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setData(null);
    const timer = setTimeout(async () => {
      const refresh = refreshToken !== refreshed.current;
      refreshed.current = refreshToken;
      try {
        const params = new URLSearchParams({ platform, category, q: query, page: String(page), limit: '48', refresh: refresh ? '1' : '0' });
        const result = await api.get(`/store/catalog?${params}`);
        if (active) { setData(result); if (result.page !== page) setPage(result.page); }
      } catch (e) { if (active) setError(e.message); }
      finally { if (active) setLoading(false); }
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [platform, category, query, page, refreshToken]);

  return <div>
    <div className="text-xs text-muted mb-sm">
      External catalogs by <a href="https://github.com/Dinos17/FPKGi-Catalog-Hub" target="_blank" rel="noreferrer">Dinos17 / FPKGi Catalog Hub</a>.
      {' '}These listings link to source packages; reviewed installs and their update tracking are in Marketplace.
    </div>
    <div className="flex gap-sm flex-wrap mb-sm">
      <select className="select" aria-label="Catalog category" value={category} onChange={e => { setCategory(e.target.value); setPage(1); }} style={{ minHeight: 44, flex: '1 1 160px' }}>
        {!categories.length && <option value="homebrew">Homebrew</option>}
        {categories.map(c => <option key={c.id} value={c.id}>{icons[c.id]} {c.label}</option>)}
      </select>
      <input className="input" aria-label="Search catalog" placeholder="Search name, title ID, region or version…" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} maxLength={200} style={{ minHeight: 44, flex: '2 1 200px' }} />
      <button className="btn btn-secondary" disabled={loading} onClick={() => setRefreshToken(v => v + 1)}>↻ Refresh catalog</button>
    </div>
    {loading && <div className="text-sm text-muted">Loading {platform.toUpperCase()} catalog…</div>}
    {error && <div role="alert" className="text-sm" style={{ color: 'var(--red)' }}>{error}</div>}
    {data?.warning && <div role="alert" className="text-sm mb-sm" style={{ color: 'var(--red)' }}>{data.warning}. {data.fetchedAt ? 'Showing the last saved catalog.' : 'No saved catalog is available yet.'}</div>}
    {data && <div className="text-xs text-muted mb-sm">
      {data.total} results · {data.catalogTotal} entries in this catalog · {platform.toUpperCase()}
      {data.sharedCatalog ? ' · Shared PS4-format classics catalog' : ''}
      {data.fetchedAt && ` · Fetched ${new Date(data.fetchedAt).toLocaleString()}`}
      {' · '}<a href={data.sourceUrl} target="_blank" rel="noreferrer">Source JSON</a>
      {' · '}<a href="https://github.com/Dinos17/FPKGi-Catalog-Hub/blob/main/CATALOG-LICENSE.md" target="_blank" rel="noreferrer">Catalog terms</a>
    </div>}
    {data && !data.items.length && !data.warning && <div className="empty-state">
      <div className="empty-state-title">{data.catalogTotal ? 'Nothing matches your search' : 'This source catalog is currently empty'}</div>
      <div className="empty-state-text">{data.catalogTotal ? 'Try another name, title ID or category.' : 'New source entries will appear after the next refresh.'}</div>
    </div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
      {(data?.items || []).map(item => <div className="comp-card" key={item.id}>
        <div className="comp-card-body p-sm">
          <div className="flex items-center gap-sm"><Cover item={item} /><div className="font-bold" style={{ wordBreak: 'break-word' }}>{item.name}</div></div>
          <div className="text-xs text-muted mt-xs">{[item.title_id, item.version && `v${item.version}`, item.region, size(item.size)].filter(Boolean).join(' · ')}</div>
          {item.min_fw && <div className="text-xs">Minimum firmware: {item.min_fw}</div>}
          {item.release && <div className="text-xs">{item.release}</div>}
          <div className="text-xs text-muted mt-xs">{item.sha256 ? 'Source provides SHA-256' : 'Source does not provide a SHA-256 checksum'}</div>
          {item.sha256 && <details className="text-xs"><summary>SHA-256</summary><code style={{ wordBreak: 'break-all' }}>{item.sha256}</code></details>}
          {item.package_url ? <a className="btn btn-secondary mt-sm" href={item.package_url} target="_blank" rel="noreferrer" style={{ minHeight: 40 }}>Open package link ↗</a> : <div className="text-xs text-muted mt-sm">No usable HTTPS package link</div>}
        </div>
      </div>)}
    </div>
    {data && data.pages > 1 && <div className="flex items-center justify-between gap-sm mt-sm">
      <button className="btn btn-secondary" disabled={loading || data.page <= 1} onClick={() => setPage(data.page - 1)}>Previous</button>
      <span className="text-sm">Page {data.page} / {data.pages}</span>
      <button className="btn btn-secondary" disabled={loading || data.page >= data.pages} onClick={() => setPage(data.page + 1)}>Next</button>
    </div>}
  </div>;
}
