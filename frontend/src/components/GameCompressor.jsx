import { useCallback, useEffect, useMemo, useState } from 'react';
import useVisiblePolling from '../hooks/useVisiblePolling';
import { api, apiSafe } from '../lib/api.js';
import ProgressBar from './UI/ProgressBar';
import ConsoleGameActions from './ConsoleGameActions';

// Converting on the console with PS5 Dump Forge. P5 Manager sends the
// payload and then drives its REST API through /api/forge/<ip>/api/*, so the
// titles, the job queue and the convert form are our own screen. Forge reads
// the drives itself, so this works without ShadowMountPlus; it also runs
// several jobs, unlike one-at-a-time engines, so the queue is a list.
const bytes = (n) => {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

const KIND_LABEL = {
  folder: 'folder', exfat: '.exfat', ffpkg: '.ffpkg',
  ffpfs: '.ffpfs', ffpfsc: '.ffpfsc', pkg: '.pkg',
};

function jobResult(job) {
  const r = job?.done?.result;
  if (!r) return null;
  if (r.Ok) return { ok: true, output: r.Ok.output, bytes: r.Ok.bytes, checks: r.Ok.checks || [] };
  return { ok: false, error: typeof r.Err === 'string' ? r.Err : JSON.stringify(r.Err) };
}

export default function GameCompressor({ profiles = [], onNotification }) {
  const ps5Profiles = profiles.filter(p => String(p.console_type || 'ps5').toLowerCase() !== 'ps4');
  const [ip, setIp] = useState('');
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(null); // 'start' | 'stop' | 'scan'
  const [open, setOpen] = useState(false);
  const [lib, setLib] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState('');

  useEffect(() => {
    if (ip || ps5Profiles.length === 0) return;
    const def = ps5Profiles.find(p => p.is_default) || ps5Profiles[0];
    if (def) setIp(def.ip_address);
  }, [ps5Profiles, ip]);

  const refresh = useCallback(async () => {
    if (!ip) return;
    const d = await apiSafe.get(`/forge/${ip}/status`);
    if (d) setSt(d);
  }, [ip]);
  useEffect(() => { setSt(null); setLib(null); setJobs([]); setPicked(''); refresh(); }, [refresh]);
  useVisiblePolling(refresh, open ? 5000 : 15000, [open, ip]);

  const running = !!st?.running;
  const loadJobs = useCallback(async () => {
    if (!running) return;
    const d = await apiSafe.get(`/forge/${ip}/api/jobs`);
    if (d?.jobs) setJobs(d.jobs);
  }, [ip, running]);
  const scan = useCallback(async () => {
    if (!running) return;
    const d = await apiSafe.post(`/forge/${ip}/api/library_scan`, {});
    if (d) setLib(d);
  }, [ip, running]);

  useEffect(() => { loadJobs(); }, [loadJobs]);
  useEffect(() => { if (running && open && !lib) scan(); }, [running, open, lib, scan]);

  const anyRunning = jobs.some(j => !j.done);
  // A job outlives this card, so follow it closed too, just slower.
  useVisiblePolling(loadJobs, running ? (anyRunning ? (open ? 2000 : 5000) : (open ? 10000 : 30000)) : 0,
    [running, anyRunning, open, ip]);

  const start = async () => {
    setBusy('start');
    try {
      await api.post(`/forge/${ip}/start`);
      onNotification?.('PS5 Dump Forge is running on the console', 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
    setBusy(null);
    refresh();
  };
  const stop = async () => {
    if (!window.confirm('Stop PS5 Dump Forge on the console?\n\nIt only stops when no job is running.')) return;
    setBusy('stop');
    try {
      await api.post(`/forge/${ip}/stop`);
      onNotification?.('PS5 Dump Forge stopped', 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
    setBusy(null);
    setTimeout(refresh, 3000);
  };
  const rescan = async () => { setBusy('scan'); await scan(); setBusy(null); };
  const cancel = async (id) => {
    try { await api.post(`/forge/${ip}/api/cancel_job`, { id }); } catch (e) { onNotification?.(e.message, 'error'); }
    loadJobs();
  };

  const entries = lib?.entries || [];
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(e => `${e.title_name || ''} ${e.title_id || ''} ${e.path}`.toLowerCase().includes(q));
  }, [entries, filter]);
  const game = entries.find(e => e.path === picked) || null;

  return (
    <div className="comp-card">
      <div className="comp-card-header" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <div>
          <span className="comp-card-title">🗜️ Convert on console</span>
          {anyRunning && (() => {
            const j = jobs.find(x => !x.done);
            const p = j?.progress;
            const pct = p && Number(p.total) > 0 ? Math.floor(Number(p.done) / Number(p.total) * 100) : null;
            return (
              <span className="badge badge-info" style={{ marginLeft: 'var(--space-sm)' }}>
                ⏳ {p?.stage || 'working'}{pct !== null ? ` · ${pct}%` : ''}
                {jobs.filter(x => !x.done).length > 1 ? ` · ${jobs.filter(x => !x.done).length} jobs` : ''}
              </span>
            );
          })()}
        </div>
        <span style={{ color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div className="comp-card-body flex-col gap-md">
          <div className="flex gap-sm items-center flex-wrap">
            <select className="select" style={{ width: 'auto' }} value={ip} onChange={e => setIp(e.target.value)} aria-label="Console">
              <option value="">— Select a console —</option>
              {ps5Profiles.map(p => <option key={p.id} value={p.ip_address}>{p.name} ({p.ip_address})</option>)}
            </select>
            {st && (
              <span className={`badge ${running ? 'badge-success' : 'badge-muted'}`}>
                {running ? `Running ${st.session?.version || st.version}` : 'Not running'}
              </span>
            )}
            {st && !running && (
              <button className="btn btn-primary btn-sm" onClick={start} disabled={!!busy || !st.loader}>
                {busy === 'start' ? '⏳ Starting…' : `▶ Start PS5 Dump Forge ${st.version}`}
              </button>
            )}
            {running && (
              <>
                <button className="btn btn-secondary btn-sm" onClick={rescan} disabled={!!busy}>
                  {busy === 'scan' ? '⏳ Scanning…' : '🔄 Rescan titles'}
                </button>
                <a className="btn btn-ghost btn-sm" href={st.url} target="_blank" rel="noreferrer">↗ Forge's own page</a>
                <button className="btn btn-ghost btn-sm" onClick={stop} disabled={!!busy}>{busy === 'stop' ? '⏳ Stopping…' : '⏹ Stop'}</button>
              </>
            )}
            {lib?.storage && (
              <span className="text-xs text-muted">{bytes(lib.storage.free)} free of {bytes(lib.storage.total)}</span>
            )}
          </div>

          {st && !running && (
            <div className="text-xs text-muted">
              {!st.loader
                ? 'The console\'s ELF loader is not reachable - turn the console on and run the jailbreak first.'
                : st.installed
                  ? 'Ready to start. It reads the drives itself, so ShadowMountPlus is not needed to convert.'
                  : `The built-in PS5 Dump Forge payload ${st.version} will be installed and checksum-checked before it is sent.`}
            </div>
          )}

          {jobs.length > 0 && (
            <div className="flex-col gap-xs">
              <div className="text-xs text-muted">Jobs on this console</div>
              {jobs.map(j => {
                const res = jobResult(j);
                const p = j.progress;
                const req = j.request || {};
                const name = String(req.output || req.source || '').split('/').pop();
                return (
                  <div key={j.id} className="flex-col gap-xs" style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-xs)' }}>
                    {!res ? (
                      <>
                        <ProgressBar value={Number(p?.done) || 0} max={Number(p?.total) || 1}
                                     label={`${p?.stage || 'queued'} · ${name}`} />
                        <div className="flex gap-sm items-center text-xs text-muted">
                          <span>{bytes(p?.done)} of {bytes(p?.total)}</span>
                          {(j.stages || []).length > 0 && <span>· {(j.stages || []).join(' → ')}</span>}
                          <button className="btn btn-ghost btn-sm" onClick={() => cancel(j.id)}>✖ Cancel</button>
                        </div>
                      </>
                    ) : (
                      <div className="text-xs" style={{ color: res.ok ? 'var(--success)' : 'var(--danger)' }}>
                        {res.ok
                          ? `✓ ${String(res.output).split('/').pop()} · ${bytes(res.bytes)} · ${res.checks.length} checks passed`
                          : `✗ ${name}: ${res.error}`}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {running && (
            <div className="flex-col gap-sm">
              <input className="input" placeholder="Search titles on the console…" value={filter}
                     onChange={e => setFilter(e.target.value)} />
              {!lib && <div className="text-xs text-muted">Scanning the console…</div>}
              {lib && entries.length === 0 && <div className="text-xs text-muted">Forge found no titles on this console.</div>}
              {lib?.truncated && <div className="text-xs text-muted">The scan stopped early, so this list may be short - Rescan to try again.</div>}
              <div style={{ maxHeight: 280, overflowY: 'auto' }} className="flex-col gap-xs">
                {shown.map(e => (
                  <button key={e.path} className={`btn btn-ghost btn-sm ${picked === e.path ? 'btn-secondary' : ''}`}
                          style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                          onClick={() => setPicked(picked === e.path ? '' : e.path)}>
                    <span className="flex-col" style={{ alignItems: 'flex-start' }}>
                      <span>{e.title_name || e.title_id}</span>
                      <span className="text-xs text-muted">
                        {e.title_id} · {KIND_LABEL[e.kind] || e.kind}
                        {e.zstd_packed ? ' · zstd packs' : ''}{e.lz4_packed ? ' · LZ4 packs' : ''}
                        {e.version ? ` · ${e.version}` : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>

              {game && (
                <div className="flex-col gap-sm" style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-sm)' }}>
                  <div className="text-sm">{game.title_name || game.title_id}</div>
                  <div className="text-xs text-muted" style={{ wordBreak: 'break-all' }}>{game.path}</div>
                  <ConsoleGameActions ip={ip} game={game} roots={lib?.roots || []}
                                      onStarted={() => { onNotification?.('Conversion started on the console', 'success'); loadJobs(); }}
                                      onError={m => onNotification?.(m, 'error')} />
                </div>
              )}
            </div>
          )}

          <div className="text-xs text-muted">
            PS5 Dump Forge is by quer3q, licensed GPL-3.0-or-later:{' '}
            <a href="https://github.com/quer3q/ps5-dump-forge" target="_blank" rel="noreferrer">project source and license</a>.
            Jobs run on the console, are verified against the source, and continue when this page is closed.
          </div>
        </div>
      )}
    </div>
  );
}
