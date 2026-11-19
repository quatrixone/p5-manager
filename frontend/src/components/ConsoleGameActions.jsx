import { useEffect, useMemo, useState } from 'react';
import { api, apiSafe } from '../lib/api.js';

// "Convert to…" for one title, run by P5 Converter on the console itself.
// Every option is one of the engine's own jobs and carries the engine's own
// query arguments, so nothing is translated on the way there.
// What a title can become depends on what it is now: the engine refuses the
// rest, so there is no point offering it. Same rules as the engine's own
// screen (sourceKind plus the lz4 flags).
const kindOf = g => String(g?.sourceKind || '').toLowerCase();
const FORMATS = [
  { id: 'lz4', action: 'lz4-pack', args: {}, level: true,
    supports: g => g.lz4Supported === true && g.lz4Packed !== true,
    label: 'LZ4 packs — smallest, the game reads them while it runs',
    policies: ['keep', 'after', 'replace'] },
  { id: 'ffpfsc', action: 'compress', args: { format: 'exfat' },
    supports: g => ['folder', 'image'].includes(kindOf(g)),
    label: '.ffpfsc compressed image (exFAT inside)',
    policies: ['keep', 'after', 'stream'] },
  { id: 'ffpfsc-pfs', action: 'compress', args: { format: 'pfs' },
    supports: g => ['folder', 'image'].includes(kindOf(g)),
    label: '.ffpfsc compressed image (PFS inside, experimental)',
    policies: ['keep', 'after', 'stream'] },
  { id: 'exfat', action: 'make-image', args: { format: 'exfat' },
    supports: g => kindOf(g) === 'folder',
    label: 'Plain .exfat image', policies: ['keep', 'after'] },
  { id: 'ffpfs', action: 'make-image', args: { format: 'pfs' },
    supports: g => kindOf(g) === 'folder',
    label: 'Plain .ffpfs image', policies: ['keep', 'after'] },
  // uncompress is the one job that does not accept destination=keep: next to
  // the original is spelled "in-place" there.
  { id: 'folder', action: 'uncompress', args: { mode: 'folder' }, here: 'in-place',
    supports: g => ['compressed', 'image'].includes(kindOf(g)),
    label: 'Back to a normal folder', policies: ['keep', 'after'] },
  { id: 'unpack', action: 'lz4-unpack', args: {}, here: 'in-place',
    supports: g => g.lz4Packed === true,
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

// Give the engine a moment, then report the job's own error if it died.
async function failureFor(ip, id) {
  if (!id) return '';
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 1200));
    const job = await apiSafe.get(`/gamecompressor/${ip}/engine/lzc/job`);
    if (job?.busy) return '';
    const h = await apiSafe.get(`/gamecompressor/${ip}/engine/lzc/history`);
    const mine = (h?.history || []).find(e => e.id === id);
    if (mine && mine.status !== 'running') {
      return mine.status === 'failed' ? (mine.error || 'the job failed') : '';
    }
  }
  return '';
}

export default function ConsoleGameActions({ ip, game, busy, onStarted, onError }) {
  const [format, setFormat] = useState('lz4');
  const [level, setLevel] = useState('9');
  const [dest, setDest] = useState('keep');
  const [policy, setPolicy] = useState('keep');
  const [usb, setUsb] = useState([]);
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState('');

  const offered = useMemo(() => FORMATS.filter(f => f.supports(game || {})), [game]);
  const chosen = useMemo(() => offered.find(f => f.id === format) || offered[0] || null, [offered, format]);

  // The title decides the list, so the picked format has to follow it.
  useEffect(() => {
    if (offered.length && !offered.some(f => f.id === format)) setFormat(offered[0].id);
  }, [offered, format]);

  useEffect(() => {
    let live = true;
    apiSafe.get(`/gamecompressor/${ip}/engine/lzc/usb`).then(d => { if (live) setUsb(d?.usb || []); });
    return () => { live = false; };
  }, [ip]);

  // Each job accepts its own set of policies; keep the picker honest.
  useEffect(() => {
    if (chosen && !chosen.policies.includes(policy)) setPolicy(chosen.policies[0]);
  }, [chosen, policy]);

  const start = async () => {
    setStarting(true);
    setRefusal('');
    const q = new URLSearchParams({ titleId: game.titleId || '', ...chosen.args });
    if (game.sourcePath) q.set('sourcePath', game.sourcePath);
    if (chosen.level) { q.set('level', level); q.set('profile', 'auto'); }
    if (dest.startsWith('usb:')) { q.set('destination', 'usb'); q.set('usbId', dest.slice(4)); }
    else q.set('destination', dest === 'keep' ? (chosen.here || 'keep') : dest);
    q.set('deletePolicy', policy);
    try {
      const started = await api.post(`/gamecompressor/${ip}/engine/lzc/${chosen.action}?${q}`);
      // A 200 only means the engine took the job. It can still fail a second
      // later (a running game blocks mounting, for one) and then the reason
      // lives in its history, not in the job - so never claim it is running
      // without looking.
      const failed = await failureFor(ip, started?.id);
      if (failed) setRefusal(failed);
      else onStarted?.(chosen);
    } catch (e) {
      // 409 is the engine saying no (busy, wrong source kind, no room). Show
      // its own words and leave the form alone - retrying by itself helps nobody.
      if (e.status === 409 || e.status === 400) setRefusal(e.message);
      else onError?.(e.message);
    }
    setStarting(false);
  };

  const disabled = !!busy || starting || !chosen;

  return (
    <div className="flex-col gap-sm">
      {offered.length === 0 ? (
        <div className="text-xs text-muted">The console reports this title as “{game?.sourceKind || 'unknown'}”, which it cannot convert into anything.</div>
      ) : (
        <label className="text-xs text-muted">Convert to
          <select className="select mt-xs" value={chosen?.id || ''} disabled={disabled}
                  onChange={e => setFormat(e.target.value)}>
            {offered.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
      )}

      {chosen?.level && (
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
          {(chosen?.policies || []).map(p => <option key={p} value={p}>{POLICY_LABEL[p]}</option>)}
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
