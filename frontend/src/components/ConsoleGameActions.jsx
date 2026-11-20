import { useEffect, useMemo, useState } from 'react';
import { api, apiSafe } from '../lib/api.js';

// "Convert to…" for one title, run by P5 Converter on the console itself.
// Every option is one of the engine's own jobs and carries the engine's own
// query arguments, so nothing is translated on the way there.
// What a title can become depends on what it is now: the engine refuses the
// rest, so there is no point offering it. Same rules as the engine's own
// screen (sourceKind plus the lz4 flags).
const kindOf = g => String(g?.sourceKind || '').toLowerCase();

// Asset packs need AMPR, and no codec packs what its own codec packed.
const noAmpr = (g) =>
  kindOf(g) !== 'folder' && g.isMounted === false
    ? 'the engine cannot see inside this image - mount it with ShadowMountPlus and reopen this'
    : 'this title does not use AMPR, so it cannot read asset packs - compress it to .ffpfsc instead';

const lz4PackWhyNot = (g) => {
  if (g.lz4Packed === true) return 'it is LZ4 packed already';
  if (g.zstdPacked === true) return 'it is zstd packed - undo the zstd packs first, then pack with LZ4';
  if (g.lz4Supported !== true) return noAmpr(g);
  return '';
};

// The engine undoes LZ4 packs by itself on the way to zstd.
const zstdPackWhyNot = (g) => {
  if (g.zstdPacked === true) return 'it is zstd packed already';
  if (g.lz4Supported !== true && g.lz4Packed !== true) return noAmpr(g);
  return '';
};
const imageWhyNot = g => kindOf(g) === 'folder' ? '' : 'a plain image is built from a folder - turn it back into a folder first';
const FORMATS = [
  { id: 'lz4', action: 'lz4-pack', args: {}, level: true,
    whyNot: lz4PackWhyNot,
    label: 'LZ4 packs — smallest, the game reads them while it runs',
    policies: ['keep', 'after', 'replace'] },
  { id: 'zstd', action: 'zstd-pack', args: {}, level: 'zstd',
    whyNot: zstdPackWhyNot,
    label: 'zstd packs — smaller than LZ4, read on the fly too',
    policies: ['keep', 'after'] },
  { id: 'ffpfsc', action: 'compress', args: { format: 'exfat' },
    whyNot: g => ['folder', 'image'].includes(kindOf(g)) ? '' : 'only a folder or a plain image can be compressed - this one is ' + (kindOf(g) || 'unknown'),
    label: '.ffpfsc compressed image (exFAT inside)',
    policies: ['keep', 'after', 'stream'] },
  { id: 'ffpfsc-pfs', action: 'compress', args: { format: 'pfs' },
    whyNot: g => ['folder', 'image'].includes(kindOf(g)) ? '' : 'only a folder or a plain image can be compressed - this one is ' + (kindOf(g) || 'unknown'),
    label: '.ffpfsc compressed image (PFS inside, experimental)',
    policies: ['keep', 'after', 'stream'] },
  { id: 'exfat', action: 'make-image', args: { format: 'exfat' },
    whyNot: imageWhyNot,
    label: 'Plain .exfat image', policies: ['keep', 'after'] },
  { id: 'ffpfs', action: 'make-image', args: { format: 'pfs' },
    whyNot: imageWhyNot,
    label: 'Plain .ffpfs image', policies: ['keep', 'after'] },
  // uncompress is the one job that does not accept destination=keep: next to
  // the original is spelled "in-place" there.
  { id: 'folder', action: 'uncompress', args: { mode: 'folder' }, here: 'in-place',
    whyNot: g => ['compressed', 'image'].includes(kindOf(g)) ? '' : 'it is already a folder',
    label: 'Back to a normal folder', policies: ['keep', 'after'] },
  { id: 'unpack', action: 'lz4-unpack', args: {}, here: 'in-place',
    whyNot: g => g.lz4Packed === true ? '' : 'this title has no LZ4 packs to undo',
    label: 'Undo LZ4 packs — put the loose files back', policies: ['keep', 'after'] },
  { id: 'unpack-zstd', action: 'zstd-unpack', args: {}, here: 'in-place',
    whyNot: g => g.zstdPacked === true ? '' : 'this title has no zstd packs to undo',
    label: 'Undo zstd packs — put the loose files back', policies: ['keep', 'after'] },
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
  const [zstdLevel, setZstdLevel] = useState('9');
  const [dest, setDest] = useState('keep');
  const [policy, setPolicy] = useState('keep');
  const [usb, setUsb] = useState([]);
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState('');

  // Every format is listed, whatever the title is: a hidden option only
  // leaves you wondering. The ones it cannot do say why, and cannot start.
  const reasons = useMemo(() => {
    const out = {};
    for (const f of FORMATS) out[f.id] = f.whyNot(game || {});
    return out;
  }, [game]);
  const chosen = useMemo(() => FORMATS.find(f => f.id === format) || FORMATS[0], [format]);
  const reason = reasons[chosen.id];

  // Start on something this title can actually become.
  useEffect(() => {
    if (reasons[format]) {
      const ok = FORMATS.find(f => !reasons[f.id]);
      if (ok) setFormat(ok.id);
    }
  }, [reasons, format]);

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
    if (chosen.level === 'zstd') q.set('level', zstdLevel);
    else if (chosen.level) { q.set('level', level); q.set('profile', 'auto'); }
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
      else onStarted?.(chosen, started);
    } catch (e) {
      // 409 is the engine saying no (busy, wrong source kind, no room). Show
      // its own words and leave the form alone - retrying by itself helps nobody.
      if (e.status === 409 || e.status === 400) setRefusal(e.message);
      else onError?.(e.message);
    }
    setStarting(false);
  };

  const disabled = !!busy || starting || !!reason;

  return (
    <div className="flex-col gap-sm">
      <label className="text-xs text-muted">Convert to
        <select className="select mt-xs" value={chosen.id} disabled={!!busy || starting}
                onChange={e => setFormat(e.target.value)}>
          {FORMATS.map(f => (
            <option key={f.id} value={f.id}>{reasons[f.id] ? `${f.label} — not for this title` : f.label}</option>
          ))}
        </select>
      </label>
      {reason && <div className="text-xs" style={{ color: 'var(--warning, var(--muted))' }}>Not possible here: {reason}</div>}
      {!reason && chosen.id === 'zstd' && game?.lz4Packed === true && (
        <div className="text-xs text-muted">
          It is LZ4 packed, so the console undoes those packs first and then writes the zstd ones. That needs room for both for a while.
        </div>
      )}

      {chosen?.level === 'zstd' ? (
        <label className="text-xs text-muted">zstd level (1 to 22; higher is smaller and slower)
          <select className="select mt-xs" value={zstdLevel} disabled={disabled}
                  onChange={e => setZstdLevel(e.target.value)}>
            {Array.from({ length: 22 }, (_, i) => String(i + 1)).map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      ) : chosen?.level ? (
        <label className="text-xs text-muted">LZ4 level (9 is the engine's default; higher is smaller and slower)
          <select className="select mt-xs" value={level} disabled={disabled}
                  onChange={e => setLevel(e.target.value)}>
            {Array.from({ length: 12 }, (_, i) => String(i + 1)).map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      ) : null}

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
