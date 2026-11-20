import { useCallback, useEffect, useMemo, useState } from 'react';
import useVisiblePolling from '../hooks/useVisiblePolling';
import { api, apiSafe } from '../lib/api.js';
import ProgressBar from './UI/ProgressBar';
import ConsoleGameActions from './ConsoleGameActions';

// P5 Converter: converting on the console itself. P5 Manager starts the
// engine payload and then drives its REST API through
// /api/gamecompressor/<ip>/engine/*, so the games, the running job and the
// convert form are our own screen rather than the engine's embedded page.
// Its own page stays one click away for the parts we do not mirror
// (validate and repair, moves, history, compatibility reports).

const bytes = (n) => {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};
const clock = (s) => {
  const t = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

export default function GameCompressor({ profiles = [], onNotification }) {
  const ps5Profiles = profiles.filter(p => String(p.console_type || 'ps5').toLowerCase() !== 'ps4');
  const [ip, setIp] = useState('');
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(null); // 'start' | 'stop'
  const [open, setOpen] = useState(false);
  const [games, setGames] = useState([]);
  const [job, setJob] = useState(null);
  const [history, setHistory] = useState([]);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState('');

  useEffect(() => {
    if (ip || ps5Profiles.length === 0) return;
    const def = ps5Profiles.find(p => p.is_default) || ps5Profiles[0];
    if (def) setIp(def.ip_address);
  }, [ps5Profiles, ip]);

  const refresh = useCallback(async () => {
    if (!ip) return;
    const d = await apiSafe.get(`/gamecompressor/${ip}/status`);
    if (d) setSt(d);
  }, [ip]);
  useEffect(() => { setSt(null); setGames([]); setJob(null); setPicked(''); refresh(); }, [refresh]);
  useVisiblePolling(refresh, open ? 5000 : 15000, [open, ip]);

  const running = !!st?.running;
  const loadGames = useCallback(async () => {
    if (!running) return;
    const d = await apiSafe.get(`/gamecompressor/${ip}/engine/lzc/games`);
    if (d?.games) setGames(d.games);
  }, [ip, running]);
  const loadJob = useCallback(async () => {
    if (!running) return;
    setJob(await apiSafe.get(`/gamecompressor/${ip}/engine/lzc/job`));
    // A job that failed early leaves nothing in `job` - its reason is here.
    const h = await apiSafe.get(`/gamecompressor/${ip}/engine/lzc/history`);
    if (h?.history) setHistory(h.history.slice(0, 5));
  }, [ip, running]);
  useEffect(() => { loadGames(); loadJob(); }, [loadGames, loadJob]);
  // A console job outlives this card, so follow it closed too, just slower.
  useVisiblePolling(loadJob, running ? (open ? 2000 : 5000) : 0, [running, open, ip]);
  useVisiblePolling(loadGames, running && open ? 15000 : 0, [running, open, ip]);

  const start = async () => {
    setBusy('start');
    try {
      await api.post(`/gamecompressor/${ip}/start`);
      onNotification?.('P5 Converter is running on the console', 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
    setBusy(null);
    refresh();
  };
  const stop = async () => {
    if (!window.confirm('Stop P5 Converter on the console?\n\nStop it only when no conversion or move is running.')) return;
    setBusy('stop');
    try {
      await api.post(`/gamecompressor/${ip}/stop`);
      onNotification?.('P5 Converter stopped', 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
    setBusy(null);
    // It answers at once but needs several seconds to wind down.
    setTimeout(refresh, 4000);
    setTimeout(refresh, 10000);
  };
  const cancelJob = async () => {
    try { await api.post(`/gamecompressor/${ip}/engine/lzc/job/cancel`); } catch (e) { onNotification?.(e.message, 'error'); }
    loadJob();
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return games;
    return games.filter(g => `${g.name} ${g.titleId}`.toLowerCase().includes(q));
  }, [games, filter]);
  const game = games.find(g => g.titleId === picked) || null;
  const jobBusy = !!job?.busy;

  return (
    <div className="comp-card">
      <div className="comp-card-header" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <div>
          <span className="comp-card-title">🗜️ Convert on console</span>
          {jobBusy && (
            <span className="badge badge-info" style={{ marginLeft: 'var(--space-sm)' }}>
              ⏳ {job.verb || 'working'}
              {job.current ? ` · ${job.current}` : ''}
              {Number(job.totalBytes) > 0
                ? ` · ${Math.floor((Number(job.copiedBytes) || 0) / Number(job.totalBytes) * 100)}%`
                : ''}
            </span>
          )}
          <div className="text-xs text-muted mt-xs">
            P5 Converter turns a title on the PS5 into LZ4 packs, a `.ffpfsc` image, a plain `.exfat`/`.ffpfs` image, or back into a folder - all on the console, with nothing copied to this machine. Jobs continue if you close this page.
          </div>
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
                {running ? 'Running' : 'Not running'}
              </span>
            )}
            {st && !running && (
              <button className="btn btn-primary btn-sm" onClick={start} disabled={!!busy || !st.loader}>
                {busy === 'start' ? '⏳ Starting…' : `▶ Start P5 Converter ${st.version}`}
              </button>
            )}
            {running && (
              <>
                <a className="btn btn-secondary btn-sm" href={st.url} target="_blank" rel="noreferrer">↗ Engine's own page</a>
                <button className="btn btn-ghost btn-sm" onClick={stop} disabled={!!busy}>{busy === 'stop' ? '⏳ Stopping…' : '⏹ Stop'}</button>
              </>
            )}
          </div>

          {st && !running && (
            <div className="text-xs text-muted">
              {!st.loader
                ? 'The console\'s ELF loader is not reachable - turn the console on and run the jailbreak first.'
                : !st.shadowmount
                  ? 'ShadowMountPlus does not answer on the console. Start ShadowMountPlus and kstuff-lite before using P5 Converter.'
                  : st.installed
                    ? 'Ready to start. Needs ShadowMountPlus and kstuff-lite 1.07 or newer on the console.'
                    : `The built-in P5 Converter payload ${st.version} will be installed and checksum-checked before it is sent.`}
            </div>
          )}

          {running && job && jobBusy && (
            <div className="flex-col gap-xs">
              <ProgressBar
                value={Number(job.copiedBytes) || 0}
                max={Number(job.totalBytes) || 1}
                label={`${job.verb || 'Working'} ${job.current || ''} · ${job.phase || ''}${job.phaseCount ? ` (${job.phaseStep}/${job.phaseCount})` : ''}`}
              />
              <div className="flex gap-sm items-center flex-wrap text-xs text-muted">
                <span>{bytes(job.copiedBytes)} of {bytes(job.totalBytes)}</span>
                {job.speedBytesPerSec ? <span>· {bytes(job.speedBytesPerSec)}/s</span> : null}
                <span>· {clock(job.elapsedSeconds)}</span>
                <button className="btn btn-ghost btn-sm" onClick={cancelJob}
                        disabled={!!job.cancelDisabled || !!job.cancelRequested}
                        title={job.cancelDisabledReason || ''}>
                  {job.cancelRequested ? 'Cancelling…' : '✖ Cancel'}
                </button>
              </div>
              {job.error && <div className="text-xs" style={{ color: 'var(--danger)' }}>{job.error}</div>}
            </div>
          )}

          {running && history.length > 0 && (
            <div className="flex-col gap-xs">
              <div className="text-xs text-muted">Last jobs on this console</div>
              {history.map(h => (
                <div key={h.id} className="text-xs" style={{ color: h.status === 'failed' ? 'var(--danger)' : 'var(--muted)' }}>
                  {h.displayName || h.titleId} · {h.action} · {h.status}{h.error ? ` — ${h.error}` : ''}
                </div>
              ))}
            </div>
          )}

          {running && (
            <div className="flex-col gap-sm">
              <input className="input" placeholder="Search titles on the console…" value={filter}
                     onChange={e => setFilter(e.target.value)} />
              {games.length === 0 && <div className="text-xs text-muted">No titles reported yet. ShadowMountPlus has to be running for the engine to see them.</div>}
              <div style={{ maxHeight: 280, overflowY: 'auto' }} className="flex-col gap-xs">
                {shown.map(g => (
                  <button key={g.titleId} className={`btn btn-ghost btn-sm flex gap-sm items-center ${picked === g.titleId ? 'btn-secondary' : ''}`}
                          style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                          onClick={() => setPicked(picked === g.titleId ? '' : g.titleId)}>
                    {g.hasIcon && (
                      <img alt="" width="32" height="32" style={{ borderRadius: 4 }}
                           src={`/api/gamecompressor/${ip}/engine/lzc/icon?titleId=${encodeURIComponent(g.titleId)}&size=thumb`} />
                    )}
                    <span className="flex-col" style={{ alignItems: 'flex-start' }}>
                      <span>{g.name || g.titleId}</span>
                      <span className="text-xs text-muted">
                        {g.titleId} · {g.storage || g.sourceKind} · {bytes(g.sourceSize)}
                        {g.savedBytes ? ` · ${bytes(g.savedBytes)} saved` : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>

              {game && (
                <div className="flex-col gap-sm" style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-sm)' }}>
                  <div className="text-sm">{game.name || game.titleId}</div>
                  {jobBusy && <div className="text-xs text-muted">The console is busy with {job.current || 'another title'} - it runs one job at a time.</div>}
                  <ConsoleGameActions ip={ip} game={game} busy={jobBusy}
                                      onStarted={() => { onNotification?.('Conversion started on the console', 'success'); loadJob(); }}
                                      onError={m => onNotification?.(m, 'error')} />
                </div>
              )}
            </div>
          )}

          <div className="text-xs text-muted">
            P5 Converter is P5 Manager's build of LZ4 Compression by theghostonline, licensed GPL-3.0-or-later:{' '}
            <a href="https://theghostonline.dev/theghostonline/PS5-LZ4-Compression" target="_blank" rel="noreferrer">project source and license</a>.
            Jobs run on the console and continue when this page is closed. Stop it when you are done.
          </div>
        </div>
      )}
    </div>
  );
}
