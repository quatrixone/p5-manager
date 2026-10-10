import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export default function MarketplaceNews({ platform, onOpen }) {
  const [data, setData] = useState(null), [error, setError] = useState('');
  const [query, setQuery] = useState(''), [event, setEvent] = useState('all'), [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setRevision(v => v + 1), 15 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ platform, q: query, event, page: String(page) });
        const result = await api.get(`/store/news?${params}`);
        if (active) { setData(result); if (result.page !== page) setPage(result.page); }
      } catch (e) { if (active) setError(e.message); }
      finally { if (active) setLoading(false); }
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [platform, query, event, page, revision]);
  return <div>
    <div className="font-bold mb-xs">New · Marketplace activity</div>
    <div className="text-xs text-muted mb-sm">New items and changed listings, checked automatically every 15 minutes. On the first check, existing items appear as newly discovered. Dates show when this server detected a change.</div>
    <div className="flex gap-sm flex-wrap mb-sm">
      <input className="input" aria-label="Search news" placeholder="Search news…" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} maxLength={200} style={{ flex: '2 1 200px', minHeight: 44 }} />
      <select className="select" aria-label="News type" value={event} onChange={e => { setEvent(e.target.value); setPage(1); }} style={{ flex: '1 1 120px', minHeight: 44 }}>
        <option value="all">All activity</option><option value="new">New items</option><option value="updated">Updated items</option>
      </select>
    </div>
    {loading && <div className="text-xs text-muted mb-sm">Checking activity…</div>}
    {error && <div role="alert" className="text-sm" style={{ color: 'var(--red)' }}>{error}</div>}
    {data?.checkedAt && <div className="text-xs text-muted mb-sm">Last check: {new Date(data.checkedAt).toLocaleString()} · {data.total} results</div>}
    {!!data?.warnings?.length && <details className="text-xs mb-sm"><summary>Some sources are unavailable; saved activity is shown</summary>{data.warnings.map(w => <div key={w}>{w}</div>)}</details>}
    {data && !data.items.length && !loading && <div className="empty-state"><div className="empty-state-title">No matching activity yet</div></div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
      {(data?.items || []).map(item => <div className="comp-card" key={item.newsId}>
        <div className="comp-card-body p-sm">
          <div className="flex items-center justify-between gap-sm"><span className={`badge ${item.event === 'updated' ? 'badge-warning' : 'badge-success'}`}>{item.event === 'updated' ? 'Updated' : 'New'}</span><span className="text-xs text-muted">{item.console_type?.toUpperCase() || 'PS4 + PS5'}</span></div>
          <div className="font-bold mt-xs" style={{ wordBreak: 'break-word' }}>{item.name}</div>
          <div className="text-xs text-muted">{item.source === 'marketplace' ? 'Marketplace' : 'FPKGi Catalog Hub'} · {item.category || item.kind}{(item.app_version || item.version) ? ` · v${item.app_version || item.version}` : ''}</div>
          <div className="text-xs text-muted mt-xs">{new Date(item.detectedAt).toLocaleString()}</div>
          <button className="btn btn-secondary mt-sm" onClick={() => onOpen(item)}>{item.source === 'marketplace' ? 'View in Marketplace' : 'View in catalog'}</button>
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
