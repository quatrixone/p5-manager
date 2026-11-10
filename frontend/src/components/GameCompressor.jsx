import { useCallback, useEffect, useState } from 'react';
import useVisiblePolling from '../hooks/useVisiblePolling';
import { api, apiSafe } from '../lib/api.js';

// Starts the LZ4 Compression engine on the PS5. Its own web UI exposes the
// console-side LZ4, PFSC and exFAT workflows; P5 Manager handles its lifecycle.
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
      onNotification?.('LZ4 Compression is running on the console', 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
    setBusy(null);
    refresh();
  };
  const stop = async () => {
    if (!window.confirm('Stop LZ4 Compression on the console?\n\nStop it only when no compression or move is running.')) return;
    setBusy('stop');
    try {
      await api.post(`/gamecompressor/${ip}/stop`);
      onNotification?.('LZ4 Compression stopped', 'success');
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
            On the PS5, pack AMPR-supported Homebrew titles directly from mounted `.exfat` or `.ffpfsc` images as LZ4. You can also compress or unpack `.ffpfsc`, build exFAT/PFS images, and validate or repair titles. Jobs continue if you close this page.
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
              <span className={`badge ${st.running ? 'badge-success' : 'badge-muted'}`}>
                {st.running ? 'Running' : 'Not running'}
              </span>
            )}
            {st && !st.running && (
              <button className="btn btn-primary btn-sm" onClick={start} disabled={!!busy || !st.loader}>
                {busy === 'start' ? '⏳ Starting…' : `▶ Start LZ4 Compression ${st.version}`}
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
                  ? 'ShadowMountPlus does not answer on the console. Start ShadowMountPlus and kstuff-lite before using the console compression engine.'
                  : st.installed
                    ? 'Ready to start. Needs ShadowMountPlus and kstuff-lite 1.07 or newer on the console.'
                    : `Built-in LZ4 payload ${st.version} will be installed and checksum-checked before it is sent.`}
            </div>
          )}

          {st?.running && canEmbed && embed && (
            <iframe className="gc-frame" src={st.url} title="LZ4 Compression on console" />
          )}
          {st?.running && !canEmbed && (
            <div className="text-xs text-muted">
              This page is served over HTTPS, so the console's page cannot be shown inside it - use "Open in new tab".
            </div>
          )}

          <div className="text-xs text-muted">
            LZ4 Compression is by theghostonline, licensed GPL-3.0-or-later:{' '}
            <a href="https://theghostonline.dev/theghostonline/PS5-LZ4-Compression" target="_blank" rel="noreferrer">project source and license</a>.
            Jobs run on the console and continue when this page is closed. Stop it when you are done.
          </div>
        </div>
      )}
    </div>
  );
}
