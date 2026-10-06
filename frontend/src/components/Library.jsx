import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from './UI/Modal';
import useVisiblePolling from '../hooks/useVisiblePolling';
import { api, apiSafe } from '../lib/api.js';

// Game library of a console, backed by the ShadowMountPlus API through
// /api/library/:ip (see backend/src/routes/library.js). Shows every title
// ShadowMount knows with its icon, where its files live (internal, extended
// storage, USB) and lets the user mount, move, copy, unpack, uninstall or
// delete it. Move / copy / unpack / delete run as ShadowMount's single
// storage job, shown as a progress bar at the top.

const fmtBytes = (n) => {
  if (!n && n !== 0) return '';
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
};
const OP_LABEL = { move: 'Move', copy: 'Copy', unpack: 'Unpack', delete: 'Delete' };
const sizeOf = (g) => g.size_bytes || g.app_db_size_bytes || 0;

function GameIcon({ game }) {
  const [broken, setBroken] = useState(false);
  if (!game.icon || broken) {
    return <div className="lib-icon lib-icon-fallback">{(game.title_name || game.title_id).slice(0, 2).toUpperCase()}</div>;
  }
  return <img className="lib-icon" src={game.icon} alt="" loading="lazy" onError={() => setBroken(true)} />;
}

export default function Library({ profiles = [], onNotification }) {
  const [ip, setIp] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [storage, setStorage] = useState('all');
  const [selected, setSelected] = useState(null); // title_id shown in the details modal
  const [picker, setPicker] = useState(null); // { game, op } - destination dialog
  const [dest, setDest] = useState('');
  const [customDest, setCustomDest] = useState('');
  const [deleteSource, setDeleteSource] = useState(false);
  const [deleting, setDeleting] = useState(null); // game pending delete confirmation
  const [deleteText, setDeleteText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ip || profiles.length === 0) return;
    const def = profiles.find(p => p.is_default) || profiles[0];
    if (def) setIp(def.ip_address);
  }, [profiles, ip]);

  const load = useCallback(async (quiet = false) => {
    if (!ip) return;
    if (!quiet) setLoading(true);
    try {
      const d = await api.get(`/library/${ip}/overview`);
      setData(d);
      setError(null);
    } catch (e) {
      if (!quiet) { setData(null); setError(e.message); }
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [ip]);

  useEffect(() => { setData(null); setSelected(null); load(); }, [load]);

  const job = data?.job && Number(data.job.job_id) > 0 ? data.job : null;
  const jobActive = !!job?.active;

  // Fast poll while a storage job runs, slow background refresh otherwise.
  useVisiblePolling(async () => {
    if (!ip || !data) return;
    if (!jobActive) { load(true); return; }
    const j = await apiSafe.get(`/library/${ip}/job`);
    if (!j) return;
    if (!j.active) {
      onNotification?.(
        j.state === 'failed' ? `${OP_LABEL[j.operation] || j.operation} ${j.title_id} failed: ${j.result_error || 'see ShadowMount log'}`
          : j.state === 'cancelled' ? `${OP_LABEL[j.operation] || j.operation} ${j.title_id} cancelled`
            : `${OP_LABEL[j.operation] || j.operation} ${j.title_id} finished`,
        j.state === 'failed' ? 'error' : 'success',
      );
      load(true);
    } else {
      setData(d => (d ? { ...d, job: j } : d));
    }
  }, jobActive ? 2000 : 15000, [ip, jobActive, !!data]);

  const games = data?.games || [];
  const counts = useMemo(() => {
    const c = {};
    for (const g of games) c[g.storage.id] = (c[g.storage.id] || 0) + 1;
    return c;
  }, [games]);
  const storages = useMemo(() => {
    const seen = new Map();
    for (const v of data?.volumes || []) seen.set(v.id, v.label);
    for (const g of games) if (!seen.has(g.storage.id)) seen.set(g.storage.id, g.storage.label);
    return Array.from(seen, ([id, label]) => ({ id, label }));
  }, [data, games]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return games
      .filter(g => storage === 'all' || g.storage.id === storage)
      .filter(g => !q || `${g.title_name} ${g.title_id}`.toLowerCase().includes(q))
      .sort((a, b) => (a.title_name || a.title_id).localeCompare(b.title_name || b.title_id));
  }, [games, query, storage]);
  const game = selected ? games.find(g => g.title_id === selected) : null;

  const run = async (g, op, body, okText) => {
    setBusy(true);
    try {
      await api.post(`/library/${ip}/games/${g.title_id}/${op}`, body || {});
      onNotification?.(okText, 'success');
      await load(true);
      return true;
    } catch (e) {
      onNotification?.(e.message, 'error');
      return false;
    } finally { setBusy(false); }
  };

  const mount = async (g) => {
    // ShadowMount keeps one image mounted at a time; its own page unmounts
    // the current one first, so do the same - after asking.
    const others = games.filter(x => x.mounted && x.title_id !== g.title_id);
    if (others.length && !window.confirm(`${others.map(x => x.title_name || x.title_id).join(', ')} is mounted. Unmount it and mount ${g.title_name || g.title_id}?`)) return;
    setBusy(true);
    try {
      for (const o of others) await api.post(`/library/${ip}/games/${o.title_id}/unmount`, {});
      await api.post(`/library/${ip}/games/${g.title_id}/mount`, {});
      onNotification?.(`Mounted ${g.title_name || g.title_id}`, 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
    setBusy(false);
    load(true);
  };

  const uninstall = (g) => {
    if (!window.confirm(`Remove ${g.title_name || g.title_id} from the console's home screen?\n\nThe game files stay where they are.`)) return;
    run(g, 'uninstall', {}, `Uninstalled ${g.title_name || g.title_id}`).then(ok => { if (ok) setSelected(null); });
  };

  const openPicker = (g, op) => {
    const first = (data?.destinations || []).find(d => d.connected && d.storage !== g.storage.id);
    setDest(first ? first.path : '');
    setCustomDest('');
    setDeleteSource(false);
    setPicker({ game: g, op });
  };
  const destPath = (dest === '__custom__' ? customDest : dest).trim();
  const startTransfer = async () => {
    const { game: g, op } = picker;
    const body = { destination_dir: destPath };
    if (op === 'unpack') body.delete_source = deleteSource;
    const ok = await run(g, op, body, `${OP_LABEL[op]} started: ${g.title_name || g.title_id} → ${destPath}`);
    if (ok) { setPicker(null); setSelected(null); }
  };
  const confirmDelete = async () => {
    const g = deleting;
    const ok = await run(g, 'delete', { confirm: true }, `Deleting ${g.title_name || g.title_id}`);
    if (ok) { setDeleting(null); setSelected(null); }
  };
  const cancelJob = async () => {
    try {
      await api.post(`/library/${ip}/job/cancel`, { job_id: job.job_id });
      onNotification?.('Cancel requested', 'info');
    } catch (e) { onNotification?.(e.message, 'error'); }
  };
  const rescan = async () => {
    try {
      await api.post(`/library/${ip}/scan`, { reset_attempts: false });
      onNotification?.('Rescan started on the console', 'success');
      setTimeout(() => load(true), 4000);
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const pct = job ? Math.max(0, Math.min(100, Number(job.progress_percent) || 0)) : 0;
  const pickerSize = picker ? sizeOf(picker.game) : 0;
  const pickedDest = (data?.destinations || []).find(d => d.path === dest);
  const tooSmall = !!pickedDest && pickedDest.available_bytes != null && pickerSize > pickedDest.available_bytes;

  return (
    <div className="flex-col gap-md">
      <div className="comp-card">
        <div className="comp-card-header">
          <div>
            <span className="comp-card-title">🎮 Library</span>
            <div className="text-xs text-muted mt-xs">
              Games ShadowMount knows on the console{data?.version ? ` · ShadowMount ${data.version}` : ''}
            </div>
          </div>
          <div className="flex gap-xs items-center flex-wrap">
            <select className="select" style={{ width: 'auto' }} value={ip} onChange={e => setIp(e.target.value)} aria-label="Console">
              <option value="">— pick console —</option>
              {profiles.map(p => <option key={p.id} value={p.ip_address}>{p.name} ({p.ip_address})</option>)}
            </select>
            <button className="btn btn-secondary btn-sm" onClick={rescan} disabled={!data} title="Ask ShadowMount to rescan its folders">🔍 Rescan</button>
            <button className="btn btn-ghost btn-sm" onClick={() => load()} disabled={loading || !ip}>↻</button>
          </div>
        </div>

        {data && (
          <div className="comp-card-body flex-col gap-md">
            <div className="lib-volumes">
              {data.volumes.map(v => {
                const used = v.total_bytes - v.available_bytes;
                const p = v.total_bytes ? Math.round((used / v.total_bytes) * 100) : 0;
                return (
                  <div key={v.id} className="lib-volume">
                    <div className="flex justify-between text-xs">
                      <span><b>{v.label}</b> <span className="text-muted">{v.path} · {counts[v.id] || 0} games</span></span>
                      <span className="text-muted">{fmtBytes(v.available_bytes)} free of {fmtBytes(v.total_bytes)}</span>
                    </div>
                    <div className="lib-bar"><div style={{ width: `${p}%` }} /></div>
                  </div>
                );
              })}
            </div>

            {/* Only a running job: ShadowMount keeps reporting its last job
                forever, so a failure from days ago would otherwise sit here.
                Failures of jobs watched from this page arrive as a toast. */}
            {jobActive && (
              <div className="lib-job">
                <div className="flex justify-between gap-sm text-xs items-center">
                  <span className="truncate" title={`${job.source} → ${job.destination}`}>
                    <b>{OP_LABEL[job.operation] || job.operation}</b> {job.title_id}
                    {job.destination ? ` → ${job.destination}` : ''}
                  </span>
                  <span className="flex items-center gap-sm" style={{ whiteSpace: 'nowrap' }}>
                    <span className="text-muted">
                      {job.state === 'measuring' ? 'calculating…' : `${Math.round(pct)}%`}
                      {job.total_bytes > 0 ? ` · ${fmtBytes(Number(job.processed_bytes))} / ${fmtBytes(Number(job.total_bytes))}` : ''}
                      {job.speed_bytes_per_second > 0 ? ` · ${fmtBytes(Number(job.speed_bytes_per_second))}/s` : ''}
                    </span>
                    {job.cancellable && <button className="btn btn-ghost btn-sm" onClick={cancelJob} disabled={job.cancel_requested}>{job.cancel_requested ? 'Cancelling…' : 'Cancel'}</button>}
                  </span>
                </div>
                <div className="lib-bar"><div style={{ width: `${pct}%` }} /></div>
              </div>
            )}

            <div className="flex gap-sm items-center flex-wrap">
              <input className="input" style={{ flex: '1 1 220px' }} type="search" placeholder="Search games…" value={query} onChange={e => setQuery(e.target.value)} />
              <div className="tabs" style={{ flex: '0 1 auto' }}>
                <button className={`tab-item ${storage === 'all' ? 'active' : ''}`} onClick={() => setStorage('all')}>All ({games.length})</button>
                {storages.map(s => (
                  <button key={s.id} className={`tab-item ${storage === s.id ? 'active' : ''}`} onClick={() => setStorage(s.id)}>
                    {s.label} ({counts[s.id] || 0})
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {!ip && <div className="text-sm text-muted">Add a console in Settings to see its library.</div>}
      {loading && !data && <div className="text-sm text-muted">Loading library…</div>}
      {error && (
        <div className="p-md badge-danger" style={{ borderRadius: 8 }}>
          {error}
        </div>
      )}

      {data && shown.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">🎮</div>
          <div className="empty-state-title">{games.length === 0 ? 'No games found' : 'Nothing matches'}</div>
          <div className="empty-state-text">{games.length === 0 ? 'ShadowMount has not registered any title yet - try Rescan.' : 'Change the search or the storage filter.'}</div>
        </div>
      )}

      <div className="lib-grid">
        {shown.map(g => (
          <button key={g.title_id} type="button" className="lib-card" onClick={() => setSelected(g.title_id)}>
            <GameIcon game={g} />
            <div className="lib-card-main">
              <div className="lib-card-title truncate" title={g.title_name}>{g.title_name || g.title_id}</div>
              <div className="text-xs text-muted">{g.title_id}{sizeOf(g) ? ` · ${fmtBytes(sizeOf(g))}` : ''}</div>
              <div className="lib-badges">
                <span className={`badge ${g.storage.id === 'internal' ? 'badge-info' : g.storage.id === 'other' ? 'badge-muted' : 'badge-success'}`}>{g.storage.label}</span>
                {g.mounted && <span className="badge badge-warning">Mounted</span>}
                {!g.source_available && <span className="badge badge-danger">Source missing</span>}
                {!g.installed && <span className="badge badge-muted">Not installed</span>}
              </div>
            </div>
          </button>
        ))}
      </div>

      <Modal
        isOpen={!!game}
        onClose={() => setSelected(null)}
        title={game ? (game.title_name || game.title_id) : ''}
      >
        {game && (
          <div className="flex-col gap-md">
            <div className="flex gap-md items-center">
              <GameIcon game={game} />
              <div style={{ minWidth: 0 }}>
                <div className="text-sm">{game.title_id} · {(game.platform || '').toUpperCase()} · {game.image_type || game.source_type}</div>
                <div className="text-xs text-muted">{fmtBytes(sizeOf(game))} · {game.storage.label}</div>
                <div className="text-xs text-muted" style={{ wordBreak: 'break-all' }}>{game.path}</div>
              </div>
            </div>
            {jobActive && <div className="text-xs text-muted">A storage operation is running - move, copy, unpack and delete are available when it finishes.</div>}
            <div className="lib-actions">
              {game.mounted
                ? <button className="btn btn-secondary" disabled={busy} onClick={() => run(game, 'unmount', {}, `Unmounted ${game.title_name || game.title_id}`)}>⏏ Unmount</button>
                : <button className="btn btn-primary" disabled={busy || !game.source_available} onClick={() => mount(game)}>▶ Mount</button>}
              <button className="btn btn-secondary" disabled={busy || jobActive || !game.source_available} onClick={() => openPicker(game, 'move')}>➡ Move to…</button>
              <button className="btn btn-secondary" disabled={busy || jobActive || !game.source_available} onClick={() => openPicker(game, 'copy')}>📋 Copy to…</button>
              {game.image_backed && (
                <button className="btn btn-secondary" disabled={busy || jobActive || !game.source_available} onClick={() => openPicker(game, 'unpack')}>📂 Unpack to…</button>
              )}
              <button className="btn btn-secondary" disabled={busy || !game.installed} onClick={() => uninstall(game)} title="Remove the title from the console's home screen; files stay">✖ Uninstall</button>
              <button className="btn btn-danger" disabled={busy || jobActive} onClick={() => { setDeleteText(''); setDeleting(game); }} title="Delete the game's files for good">🗑 Delete</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!picker}
        onClose={() => { if (!busy) setPicker(null); }}
        title={picker ? `${OP_LABEL[picker.op]} ${picker.game.title_name || picker.game.title_id}` : ''}
        footer={picker && (
          <>
            <button className="btn btn-ghost" onClick={() => setPicker(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={startTransfer} disabled={busy || !destPath.startsWith('/') || tooSmall}>
              {busy ? '⏳ Starting…' : OP_LABEL[picker.op]}
            </button>
          </>
        )}
      >
        {picker && (
          <div className="flex-col gap-sm">
            <div className="text-xs text-muted">
              {fmtBytes(pickerSize)} · now on {picker.game.storage.label}
              {picker.op === 'unpack' ? ' · the image is unpacked into a folder' : ''}
            </div>
            {(data?.destinations || []).map(d => (
              <label key={d.path} className={`lib-dest ${!d.connected ? 'lib-dest-off' : ''}`}>
                <input type="radio" name="lib-dest" checked={dest === d.path} disabled={!d.connected} onChange={() => setDest(d.path)} />
                <span className="flex-1" style={{ minWidth: 0 }}>
                  <span className="text-sm">{d.label}</span> <span className="text-xs text-muted">{d.path}</span>
                </span>
                <span className="text-xs text-muted">
                  {!d.connected ? 'not connected' : d.available_bytes != null ? `${fmtBytes(d.available_bytes)} free` : ''}
                </span>
              </label>
            ))}
            <label className="lib-dest">
              <input type="radio" name="lib-dest" checked={dest === '__custom__'} onChange={() => setDest('__custom__')} />
              <input className="input flex-1" placeholder="/mnt/usb0/games" value={customDest}
                onFocus={() => setDest('__custom__')} onChange={e => setCustomDest(e.target.value)} />
            </label>
            {picker.op === 'unpack' && (
              <label className="flex items-center gap-sm" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={deleteSource} onChange={e => setDeleteSource(e.target.checked)} />
                <span className="text-sm">Delete the image after unpacking</span>
              </label>
            )}
            {tooSmall && <div className="text-xs" style={{ color: 'var(--red)' }}>Not enough free space there for {fmtBytes(pickerSize)}.</div>}
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!deleting}
        onClose={() => { if (!busy) setDeleting(null); }}
        title="Delete game files"
        footer={deleting && (
          <>
            <button className="btn btn-ghost" onClick={() => setDeleting(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-danger" onClick={confirmDelete} disabled={busy || deleteText.trim() !== deleting.title_id}>
              {busy ? '⏳ Deleting…' : 'Delete for good'}
            </button>
          </>
        )}
      >
        {deleting && (
          <div className="flex-col gap-sm">
            <div className="text-sm">
              This deletes <b>{deleting.title_name || deleting.title_id}</b> ({fmtBytes(sizeOf(deleting))}) from the console. It cannot be undone.
            </div>
            <div className="text-xs text-muted" style={{ wordBreak: 'break-all' }}>{deleting.path}</div>
            <label className="text-xs text-muted">Type <b>{deleting.title_id}</b> to confirm</label>
            <input className="input" value={deleteText} onChange={e => setDeleteText(e.target.value)} placeholder={deleting.title_id} autoFocus />
          </div>
        )}
      </Modal>
    </div>
  );
}
