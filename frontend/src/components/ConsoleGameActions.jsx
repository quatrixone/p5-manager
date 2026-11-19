import { useEffect, useMemo, useState } from 'react';
import { api, apiSafe } from '../lib/api.js';

// "Convert to…" for one title, run by P5 Converter on the console itself.
// Every option is one of the engine's own jobs and carries the engine's own
// query arguments, so nothing is translated on the way there.
const FORMATS = [
  { id: 'lz4', action: 'lz4-pack', args: {}, level: true,
    label: 'LZ4 packs — smallest, the game reads them while it runs',
    policies: ['keep', 'after', 'replace'] },
  { id: 'ffpfsc', action: 'compress', args: { format: 'exfat' },
    label: '.ffpfsc compressed image (exFAT inside)',
    policies: ['keep', 'after', 'stream'] },
  { id: 'ffpfsc-pfs', action: 'compress', args: { format: 'pfs' },
    label: '.ffpfsc compressed image (PFS inside, experimental)',
    policies: ['keep', 'after', 'stream'] },
  { id: 'exfat', action: 'make-image', args: { format: 'exfat' },
    label: 'Plain .exfat image', policies: ['keep', 'after'] },
  { id: 'ffpfs', action: 'make-image', args: { format: 'pfs' },
    label: 'Plain .ffpfs image', policies: ['keep', 'after'] },
  { id: 'folder', action: 'uncompress', args: { mode: 'folder' },
    label: 'Back to a normal folder', policies: ['keep', 'after'] },
  { id: 'unpack', action: 'lz4-unpack', args: {},
    label: 'Undo LZ4 packs — put the loose files back', policies: ['keep', 'after'] },
];

const POLICY_LABEL = {
  keep: 'Keep the original',
  after: 'Delete the original once it is verified',
  replace: 'In place — rewrite the folder itself (no second copy needed)',
  stream: 'Destructive — free space as it goes (no way back)',
};

const bytes = (n) => {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

export default function ConsoleGameActions({ ip, game, busy, onStarted, onError }) {
  const [format, setFormat] = useState('lz4');
  const [level, setLevel] = useState('9');
  const [dest, setDest] = useState('keep');
  const [policy, setPolicy] = useState('keep');
  const [usb, setUsb] = useState([]);
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState('');

  const chosen = useMemo(() => FORMATS.find(f => f.id === format) || FORMATS[0], [format]);

  useEffect(() => {
    let live = true;
    apiSafe.get(`/gamecompressor/${ip}/engine/lzc/usb`).then(d => { if (live) setUsb(d?.usb || []); });
    return () => { live = false; };
  }, [ip]);

  // Each job accepts its own set of policies; keep the picker honest.
  useEffect(() => {
    if (!chosen.policies.includes(policy)) setPolicy(chosen.policies[0]);
  }, [chosen, policy]);

  const start = async () => {
    setStarting(true);
    setRefusal('');
    const q = new URLSearchParams({ titleId: game.titleId || '', ...chosen.args });
    if (game.sourcePath) q.set('sourcePath', game.sourcePath);
    if (chosen.level) { q.set('level', level); q.set('profile', 'auto'); }
    if (dest.startsWith('usb:')) { q.set('destination', 'usb'); q.set('usbId', dest.slice(4)); }
    else q.set('destination', dest);
    q.set('deletePolicy', policy);
    try {
      await api.post(`/gamecompressor/${ip}/engine/lzc/${chosen.action}?${q}`);
      onStarted?.(chosen);
    } catch (e) {
      // 409 is the engine saying no (busy, wrong source kind, no room). Show
      // its own words and leave the form alone - retrying by itself helps nobody.
      if (e.status === 409 || e.status === 400) setRefusal(e.message);
      else onError?.(e.message);
    }
    setStarting(false);
  };

  const disabled = !!busy || starting;

  return (
    <div className="flex-col gap-sm">
      <label className="text-xs text-muted">Convert to
        <select className="select mt-xs" value={format} disabled={disabled}
                onChange={e => setFormat(e.target.value)}>
          {FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </label>

      {chosen.level && (
        <label className="text-xs text-muted">LZ4 level (9 is the engine's default; higher is smaller and slower)
          <select className="select mt-xs" value={level} disabled={disabled}
                  onChange={e => setLevel(e.target.value)}>
            {Array.from({ length: 12 }, (_, i) => String(i + 1)).map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      )}

      <label className="text-xs text-muted">Where it lands
        <select className="select mt-xs" value={dest} disabled={disabled}
                onChange={e => setDest(e.target.value)}>
          <option value="keep">Next to the original</option>
          <option value="internal">Internal SSD</option>
          {usb.map(u => (
            <option key={u.id} value={`usb:${u.id}`}>{u.name || u.path} — {bytes(u.freeBytes)} free</option>
          ))}
        </select>
      </label>

      <label className="text-xs text-muted">The original
        <select className="select mt-xs" value={policy} disabled={disabled}
                onChange={e => setPolicy(e.target.value)}>
          {chosen.policies.map(p => <option key={p} value={p}>{POLICY_LABEL[p]}</option>)}
        </select>
      </label>

      {refusal && <div className="text-xs" style={{ color: 'var(--danger)' }}>The console refused: {refusal}</div>}

      <button className="btn btn-primary btn-sm" onClick={start} disabled={disabled || !game?.titleId}>
        {starting ? '⏳ Starting…' : '🗜 Convert on the console'}
      </button>
      <div className="text-xs text-muted">
        The job runs on the console and keeps going when this page is closed.
      </div>
    </div>
  );
}
