import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { ItemActions } from './MarketplaceItem.jsx';

export default function MarketplaceNews({ platform, profiles = [], consoleOnline = null, onNotification, onOpen, onBrowse }) {
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
    <div className="font-bold mb-xs">Marketplace activity</div>
    <div className="text-xs text-muted mb-sm">New items and changed listings, checked automatically every 15 minutes. On the first check, existing items appear as newly discovered. Dates show when this server detected a change.</div>
    <div className="marketplace-news-search mb-sm">
      <input className="input" aria-label="Search news" placeholder="Search news…" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} maxLength={200} />
      <select className="select" aria-label="News type" value={event} onChange={e => { setEvent(e.target.value); setPage(1); }}>
        <option value="all">All activity</option><option value="new">New items</option><option value="updated">Updated items</option>
      </select>
    </div>
    {loading && <div className="marketplace-loading mb-sm" role="status" aria-live="polite">Checking for new and updated items…</div>}
    {error && <div role="alert" className="text-sm marketplace-news-error">{error}</div>}
    {data?.checkedAt && <div className="text-xs text-muted mb-sm">Last check: {new Date(data.checkedAt).toLocaleString()} · {data.total} results</div>}
    {!!data?.warnings?.length && <details className="text-xs mb-sm"><summary>Some sources are unavailable; saved activity is shown</summary>{data.warnings.map(w => <div key={w}>{w}</div>)}</details>}
    {data && !data.items.length && !loading && <div className="empty-state marketplace-news-empty">
      <div className="empty-state-title">{query || event !== 'all' ? 'No activity matches these filters' : 'No new marketplace activity'}</div>
      <div className="empty-state-text">{query || event !== 'all' ? 'Clear the search or choose another activity type.' : 'New and updated items will appear here after the next check.'}</div>
      <div className="flex gap-sm flex-wrap">
        {(query || event !== 'all') && <button className="btn btn-secondary" onClick={() => { setQuery(''); setEvent('all'); setPage(1); }}>Clear filters</button>}
        {onBrowse && <button className="btn btn-primary" onClick={onBrowse}>Browse marketplace</button>}
      </div>
    </div>}
    <div className="marketplace-news-grid">
      {(data?.items || []).map(item => <div className="comp-card" key={item.newsId}>
        <div className="comp-card-body p-sm">
          <div className="flex items-center justify-between gap-sm"><span className={`badge ${item.event === 'updated' ? 'badge-warning' : 'badge-success'}`}>{item.event === 'updated' ? 'Updated' : 'New'}</span><span className="text-xs text-muted">{item.console_type?.toUpperCase() || 'PS4 + PS5'}</span></div>
          <div className="font-bold mt-xs marketplace-news-name">{item.name}</div>
          <div className="text-xs text-muted">{item.source === 'marketplace' ? 'Marketplace' : 'FPKGi Catalog Hub'} · {item.category || item.kind}{(item.app_version || item.version) ? ` · v${item.app_version || item.version}` : ''}</div>
          <div className="text-xs text-muted mt-xs">{new Date(item.detectedAt).toLocaleString()}</div>
          <div className="mt-sm">
            <ItemActions item={item} profiles={profiles} consoleOnline={consoleOnline} onNotification={onNotification} onDone={() => setRevision(v => v + 1)} />
          </div>
          <button className="btn btn-secondary mt-xs" onClick={() => onOpen(item)}>Show in the list</button>
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
