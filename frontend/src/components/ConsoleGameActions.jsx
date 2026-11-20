import { useEffect, useMemo, useState } from 'react';
import { api, apiSafe } from '../lib/api.js';

// "Convert to…" for one title, run by PS5 Dump Forge on the console itself.
// Every option here is one of its own targets and the arguments go through
// as its ConvertRequest, so nothing is translated on the way.
//
// Forge takes any source to any target: a folder, an image of any of its
// kinds, a .pkg, even a .zip/.7z/.rar holding a game. Packs are flags rather
// than formats - zstd_pack writes zstd packs into the chosen target, and a
// source that already holds packs is unpacked on the way by zstd_unpack or
// lz4: 'unpack', which is why nothing here is ever a dead end.
const TARGETS = [
  { id: 'folder', label: 'Folder — plain files, nothing packed', format: 'folder' },
  { id: 'zstd', label: 'Folder with zstd packs — smallest, read while the game runs',
    format: 'folder', zstd: true },
  { id: 'lz4', label: 'Folder with LZ4 packs — read while the game runs',
    format: 'lz4', lz4: true },
  { id: 'exfat', label: '.exfat image', format: 'exfat' },
  { id: 'exfat-zstd', label: '.exfat image with zstd packs inside', format: 'exfat', zstd: true },
  { id: 'ffpkg', label: '.ffpkg image', format: 'ffpkg' },
  { id: 'ffpfs', label: '.ffpfs image', format: 'ffpfs' },
  { id: 'ffpfsc', label: '.ffpfsc compressed image', format: 'ffpfsc', inner: true },
  { id: 'pkg', label: '.pkg package — firmware 11.60 and older', format: 'pkg', kraken: true },
];

const ORIGINAL = {
  keep: 'Keep the original',
  delete: 'Delete the original once the output is verified',
};

const bytes = (n) => {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

const parentOf = (p) => {
  const cut = String(p || '').replace(/\/+$/, '').lastIndexOf('/');
  return cut > 0 ? p.slice(0, cut) : '/';
};

export default function ConsoleGameActions({ ip, game, busy, roots = [], onStarted, onError }) {
  const [target, setTarget] = useState('zstd');
  const [zstdLevel, setZstdLevel] = useState('5');
  const [lz4Level, setLz4Level] = useState('9');
  const [ffpfscLevel, setFfpfscLevel] = useState('6');
  const [inner, setInner] = useState('ffpkg');
  const [kraken, setKraken] = useState('fast');
  const [dir, setDir] = useState('');
  const [original, setOriginal] = useState('keep');
  const [fullVerify, setFullVerify] = useState(false);
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState('');
  const [preview, setPreview] = useState('');

  const chosen = useMemo(() => TARGETS.find(t => t.id === target) || TARGETS[0], [target]);
  const sourceDir = parentOf(game?.path);
  const dirs = useMemo(() => {
    const all = [sourceDir, ...roots, ...roots.map(r => `${r}/homebrew`)];
    return [...new Set(all.filter(Boolean))];
  }, [sourceDir, roots]);

  useEffect(() => { if (!dir && sourceDir) setDir(sourceDir); }, [dir, sourceDir]);

  // Forge refuses an output that exists, and it knows how to name one.
  useEffect(() => {
    let live = true;
    setPreview('');
    if (!game?.path || !dir) return undefined;
    (async () => {
      const body = { source: game.path, format: chosen.format, dir, taken: [] };
      if (chosen.zstd) body.pack = 'zstd';
      else if (chosen.lz4) body.pack = 'lz4';
      const out = await apiSafe.post(`/forge/${ip}/api/generated_output`, body);
      if (live && typeof out === 'string') setPreview(out);
    })();
    return () => { live = false; };
  }, [ip, game?.path, dir, chosen]);

  const request = () => {
    const r = { source: game.path, format: chosen.format, output: preview };
    if (chosen.zstd) { r.zstd_pack = true; r.zstd_level = Number(zstdLevel); }
    // format 'lz4' already means packed; lz4: 'pack' is the other way to ask.
    if (chosen.lz4) r.lz4_level = Number(lz4Level);
    if (chosen.inner) { r.inner = inner; r.ffpfsc_level = Number(ffpfscLevel); }
    if (chosen.kraken) r.kraken_level = kraken;
    // Packs in the source have to come apart before anything else is written.
    if (game.zstd_packed && !chosen.zstd) r.zstd_unpack = true;
    if (game.lz4_packed && !chosen.lz4) r.lz4 = 'unpack';
    if (original === 'delete') r.delete_source = true;
    if (fullVerify) r.full_verify = true;
    return r;
  };

  const start = async () => {
    setStarting(true);
    setRefusal('');
    try {
      const id = await api.post(`/forge/${ip}/api/start_job`, { request: request() });
      onStarted?.(chosen, id);
    } catch (e) {
      // Forge answers its own words on a refusal; retrying helps nobody.
      if (e.status === 400 || e.status === 409 || e.status === 429) setRefusal(e.message);
      else onError?.(e.message);
    }
    setStarting(false);
  };

  const disabled = !!busy || starting || !preview;

  return (
    <div className="flex-col gap-sm">
      <label className="text-xs text-muted">Convert to
        <select className="select mt-xs" value={chosen.id} disabled={!!busy || starting}
                onChange={e => setTarget(e.target.value)}>
          {TARGETS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>

      {chosen.zstd && (
        <label className="text-xs text-muted">zstd level (1 to 22; 5 is Forge's default, higher is smaller and slower)
          <select className="select mt-xs" value={zstdLevel} disabled={disabled}
                  onChange={e => setZstdLevel(e.target.value)}>
            {Array.from({ length: 22 }, (_, i) => String(i + 1)).map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      )}
      {chosen.lz4 && (
        <label className="text-xs text-muted">LZ4 level (0 fast, or 3 to 12; 9 is medium)
          <select className="select mt-xs" value={lz4Level} disabled={disabled}
                  onChange={e => setLz4Level(e.target.value)}>
            {['0', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      )}
      {chosen.inner && (
        <>
          <label className="text-xs text-muted">Image inside the .ffpfsc
            <select className="select mt-xs" value={inner} disabled={disabled}
                    onChange={e => setInner(e.target.value)}>
              <option value="ffpkg">.ffpkg (Forge's default)</option>
              <option value="exfat">.exfat</option>
              <option value="ffpfs">.ffpfs</option>
            </select>
          </label>
          <label className="text-xs text-muted">zlib level (0 stores, 9 is smallest, 6 by default)
            <select className="select mt-xs" value={ffpfscLevel} disabled={disabled}
                    onChange={e => setFfpfscLevel(e.target.value)}>
              {Array.from({ length: 10 }, (_, i) => String(i)).map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
        </>
      )}
      {chosen.kraken && (
        <label className="text-xs text-muted">Kraken compression
          <select className="select mt-xs" value={kraken} disabled={disabled}
                  onChange={e => setKraken(e.target.value)}>
            <option value="fast">Fast</option>
            <option value="balanced">Balanced</option>
            <option value="smallest">Smallest</option>
            <option value="stored">Stored (no compression)</option>
          </select>
        </label>
      )}

      <label className="text-xs text-muted">Where it lands
        <select className="select mt-xs" value={dir} disabled={disabled}
                onChange={e => setDir(e.target.value)}>
          {dirs.map(d => <option key={d} value={d}>{d === sourceDir ? `${d}  (beside the original)` : d}</option>)}
        </select>
      </label>

      <label className="text-xs text-muted">The original
        <select className="select mt-xs" value={original} disabled={disabled}
                onChange={e => setOriginal(e.target.value)}>
          {Object.entries(ORIGINAL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>

      <label className="flex gap-xs items-center text-xs text-muted">
        <input type="checkbox" checked={fullVerify} disabled={disabled}
               onChange={e => setFullVerify(e.target.checked)} />
        Re-read every byte of the output (slower; a sample is checked either way)
      </label>

      {(game?.zstd_packed || game?.lz4_packed) && (
        <div className="text-xs text-muted">
          This title holds {game.zstd_packed ? 'zstd' : 'LZ4'} packs; the console takes them apart on the way.
        </div>
      )}
      {preview && <div className="text-xs text-muted" style={{ wordBreak: 'break-all' }}>Output: {preview}</div>}
      {refusal && <div className="text-xs" style={{ color: 'var(--danger)' }}>The console refused: {refusal}</div>}

      <button className="btn btn-primary btn-sm" onClick={start} disabled={disabled || !game?.path}>
        {starting ? '⏳ Starting…' : '🗜 Convert on the console'}
      </button>
      <div className="text-xs text-muted">
        {bytes(game?.size)} · the job runs on the console, is verified against the source, and keeps going when this page is closed.
      </div>
    </div>
  );
}
