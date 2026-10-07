import { useCallback, useEffect, useState } from 'react';
import useVisiblePolling from '../hooks/useVisiblePolling';
import { api, apiSafe } from '../lib/api.js';

// "Convert on console": starts PS5 Game Compressor (a payload by Juma Sayeh
// that compresses / unpacks / validates ShadowMountPlus titles on the PS5
// itself) and shows its own web UI inside the Convert tab. P5 Manager only
// installs, starts and stops it; every operation happens in its UI, on the
// console, and keeps running when this page is closed.
export default function GameCompressor({ profiles = [], onNotification }) {
  const ps5Profiles = profiles.filter(p => String(p.console_type || 'ps5').toLowerCase() !== 'ps4');
  const [ip, setIp] = useState('');
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(null); // 'start' | 'stop'
  const [open, setOpen] = useState(false);
  const [embed, setEmbed] = useState(true);
  // An http:// console page cannot be framed by an https:// app.
  const canEmbed = typeof window !== 'undefined' && window.location.protocol !== 'https:';

  useEffect(() => {
    if (ip || ps5Profiles.length === 0) return;
    const def = ps5Profiles.find(p => p.is_default) || ps5Profiles[0];
    if (def) setIp(def.ip_address);
  }, [ps5Profiles, ip]);

  const refresh = useCallback(async () => {
    if (!ip || !open) return;
    const d = await apiSafe.get(`/gamecompressor/${ip}/status`);
    if (d) setSt(d);
  }, [ip, open]);
  useEffect(() => { setSt(null); refresh(); }, [refresh]);
  useVisiblePolling(refresh, open ? 5000 : 0, [open, ip]);

  const start = async () => {
    setBusy('start');
    try {
      await api.post(`/gamecompressor/${ip}/start`);
      onNotification?.('Game Compressor is running on the console', 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
    setBusy(null);
    refresh();
  };
  const stop = async () => {
    if (!window.confirm('Stop Game Compressor on the console?\n\nStop it only when no compression or move is running.')) return;
    setBusy('stop');
    try {
      await api.post(`/gamecompressor/${ip}/stop`);
      onNotification?.('Game Compressor stopped', 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
    setBusy(null);
    // It answers at once but needs several seconds to wind down.
    setTimeout(refresh, 4000);
    setTimeout(refresh, 10000);
  };

  return (
    <div className="comp-card">
      <div className="comp-card-header" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <div>
          <span className="comp-card-title">🗜️ Convert on console</span>
          <div className="text-xs text-muted mt-xs">
            Compress, unpack, validate and repair games on the PS5 itself with PS5 Game Compressor - no copying to this server.
          </div>
        </div>
        <span style={{ color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div className="comp-card-body flex-col gap-md">
          <div className="flex gap-sm items-center flex-wrap">
            <select className="select" style={{ width: 'auto' }} value={ip} onChange={e => setIp(e.target.value)} aria-label="Console">
              <option value="">— pick console —</option>
              {ps5Profiles.map(p => <option key={p.id} value={p.ip_address}>{p.name} ({p.ip_address})</option>)}
            </select>
            {st && (
              <span className={`badge ${st.running ? 'badge-success' : 'badge-muted'}`}>
                {st.running ? 'Running' : 'Not running'}
              </span>
            )}
            {st && !st.running && (
              <button className="btn btn-primary btn-sm" onClick={start} disabled={!!busy || !st.loader}>
                {busy === 'start' ? '⏳ Starting…' : `▶ Start Game Compressor ${st.version}`}
              </button>
            )}
            {st?.running && (
              <>
                <a className="btn btn-secondary btn-sm" href={st.url} target="_blank" rel="noreferrer">↗ Open in new tab</a>
                {canEmbed && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setEmbed(e => !e)}>{embed ? 'Hide here' : 'Show here'}</button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={stop} disabled={!!busy}>{busy === 'stop' ? '⏳ Stopping…' : '⏹ Stop'}</button>
              </>
            )}
          </div>

          {st && !st.running && (
            <div className="text-xs text-muted">
              {!st.loader
                ? 'The console\'s ELF loader is not reachable - turn the console on and run the jailbreak first.'
                : !st.shadowmount
                  ? 'ShadowMountPlus does not answer on the console. Game Compressor works on titles ShadowMountPlus manages, so start that first.'
                  : st.installed
                    ? 'Ready to start. Needs ShadowMountPlus and kstuff-lite 1.07 or newer on the console.'
                    : `First start downloads game-compressor.elf ${st.version} from its author's release page and checks its SHA-256.`}
            </div>
          )}

          {st?.running && canEmbed && embed && (
            <iframe className="gc-frame" src={st.url} title="PS5 Game Compressor" />
          )}
          {st?.running && !canEmbed && (
            <div className="text-xs text-muted">
              This page is served over HTTPS, so the console's page cannot be shown inside it - use "Open in new tab".
            </div>
          )}

          <div className="text-xs text-muted">
            PS5 Game Compressor is made by Juma Sayeh:{' '}
            <a href="https://github.com/juma-sayeh/PS5-Game-Compressor" target="_blank" rel="noreferrer">github.com/juma-sayeh/PS5-Game-Compressor</a>.
            Jobs run on the console and continue when this page is closed. Stop it when you are done.
          </div>
        </div>
      )}
    </div>
  );
}
