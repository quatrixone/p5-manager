import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';

const API = '/saves';
// Where Apollo Save Tool on a PS4 puts "export decrypted save files": on
// the internal drive or on a USB drive.
const PS4_PLACES = ['/data/apollo/', '/mnt/usb0/PS4/APOLLO/', '/mnt/usb0/', '/mnt/usb1/'];

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');

function useJob(onDone) {
  const [job, setJob] = useState(null);
  useEffect(() => {
    if (!job || job.state !== 'running') return undefined;
    const t = setInterval(async () => {
      try {
        const r = await api.get(`${API}/jobs/${job.id}`);
        setJob(r.job);
        if (r.job.state !== 'running') onDone?.(r.job);
      } catch (_) { /* keep polling */ }
    }, 1000);
    return () => clearInterval(t);
  }, [job, onDone]);
  return [job, setJob];
}

function JobBox({ job, onClose }) {
  if (!job) return null;
  const color = job.state === 'failed' ? 'var(--red)' : job.state === 'done' ? 'var(--green)' : 'var(--accent, var(--blue))';
  return (
    <div className="comp-card mt-sm" style={{ borderColor: color }}>
      <div className="comp-card-body p-sm">
        <div className="flex items-center justify-between gap-sm">
          <span className="font-bold" style={{ color }}>
            {job.state === 'running' ? '⏳ ' : job.state === 'done' ? '✅ ' : '❌ '}
            {job.state === 'failed' ? job.error : job.step}
          </span>
          {job.state !== 'running' && <button className="btn btn-sm btn-secondary" onClick={onClose}>Close</button>}
        </div>
        {job.result?.folder && <div className="text-xs text-muted mt-xs" style={{ wordBreak: 'break-all' }}>Saved in {job.result.folder}</div>}
        <details className="mt-xs">
          <summary className="text-xs text-muted" style={{ cursor: 'pointer' }}>Steps</summary>
          <pre className="text-xs" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{job.log.join('\n')}</pre>
        </details>
      </div>
    </div>
  );
}

// A folder browser over FTP for the PS4 side.
function FtpPicker({ pid, value, onPick }) {
  const [path, setPath] = useState(PS4_PLACES[0]);
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (p) => {
    if (!pid) return;
    setLoading(true);
    setError('');
    try {
      const r = await api.get(`${API}/ftp/${pid}/list?path=${encodeURIComponent(p)}`);
      setPath(r.path.endsWith('/') ? r.path : `${r.path}/`);
      setList(r.entries);
    } catch (e) {
      setList(null);
      setError(e.message);
    }
    setLoading(false);
  }, [pid]);

  useEffect(() => { load(PS4_PLACES[0]); }, [load]);

  const up = () => {
    const parts = path.replace(/\/$/, '').split('/');
    parts.pop();
    load(`${parts.join('/') || ''}/`);
  };
  const here = path.replace(/\/$/, '') || '/';

  return (
    <div>
      <div className="flex gap-xs flex-wrap mb-sm">
        {PS4_PLACES.map((p) => (
          <button key={p} className={`btn btn-sm ${path === p ? 'btn-primary' : 'btn-secondary'}`} onClick={() => load(p)}>{p}</button>
        ))}
      </div>
      <div className="flex items-center gap-sm mb-sm">
        <button className="btn btn-sm btn-secondary" onClick={up} disabled={path === '/'}>⬆</button>
        <code className="text-sm flex-1" style={{ wordBreak: 'break-all' }}>{path}</code>
        <button className="btn btn-sm btn-primary" onClick={() => onPick(here)} disabled={path === '/'}>
          {value === here ? '✓ Picked' : 'Use this folder'}
        </button>
      </div>
      {loading && <div className="text-sm text-muted">Loading…</div>}
      {error && <div className="text-sm" style={{ color: 'var(--red)' }}>{error}</div>}
      {list && (
        <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          {list.length === 0 && <div className="text-sm text-muted p-sm">Empty folder</div>}
          {list.map((e) => (
            <button
              key={e.name}
              type="button"
              className="flex items-center gap-sm"
              onClick={() => (e.dir ? load(`${path}${e.name}/`) : null)}
              style={{
                width: '100%', textAlign: 'left', padding: '10px 12px', background: 'none', border: 'none',
                borderBottom: '1px solid var(--border)', color: 'inherit', cursor: e.dir ? 'pointer' : 'default', minHeight: 44,
              }}
            >
              <span>{e.dir ? '📁' : '📄'}</span>
              <span className="flex-1" style={{ wordBreak: 'break-all' }}>{e.name}</span>
              {!e.dir && <span className="text-xs text-muted">{Math.ceil((e.size || 0) / 1024)} KB</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Guesses the game and the save's name from an Apollo export folder, which
// is named after them (CUSA12345_SAVEDATA00 and the like).
function guessFromFolder(folder) {
  const name = (folder || '').split('/').filter(Boolean).pop() || '';
  const m = /([A-Z]{4}\d{5})[-_ ]?(.*)$/.exec(name);
  if (!m) return {};
  const dir = (m[2] || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 31);
  return { title: m[1], dir: dir || undefined };
}

export default function SaveMounter({ profiles = [], onNotification }) {
  const ps5s = useMemo(() => profiles.filter((p) => p.console_type !== 'ps4'), [profiles]);
  const ps4s = useMemo(() => profiles.filter((p) => p.console_type === 'ps4'), [profiles]);
  const [pid, setPid] = useState('');
  const [info, setInfo] = useState(null); // { firmware, users }
  const [user, setUser] = useState('');
  const [titles, setTitles] = useState([]);
  const [title, setTitle] = useState('');
  const [saves, setSaves] = useState([]);
  const [mounted, setMounted] = useState(null);
  const [busy, setBusy] = useState('');
  const [backups, setBackups] = useState([]);

  // "Copy a decrypted save into the PS5"
  const [srcKind, setSrcKind] = useState('ps4');
  const [srcPid, setSrcPid] = useState('');
  const [srcFolder, setSrcFolder] = useState('');
  const [srcBackup, setSrcBackup] = useState('');
  const [dstTitle, setDstTitle] = useState('');
  const [dstDir, setDstDir] = useState('');
  const [dstNew, setDstNew] = useState(true);
  const [dstSize, setDstSize] = useState(32);

  const notifyErr = (e) => onNotification?.(e.message, 'error');
  const refreshBackups = useCallback(async () => {
    try { setBackups((await api.get(`${API}/backups`)).backups); } catch (_) { /* none */ }
  }, []);
  const [job, setJob] = useJob(useCallback((j) => {
    if (j.state === 'done') onNotification?.(j.kind === 'backup' ? 'Save backed up' : 'Save copied into the PS5', 'success');
    refreshBackups();
  }, [onNotification, refreshBackups]));

  useEffect(() => {
    if (!pid && ps5s.length) setPid(String((ps5s.find((p) => p.is_default) || ps5s[0]).id));
    if (!srcPid && ps4s.length) setSrcPid(String(ps4s[0].id));
  }, [ps5s, ps4s, pid, srcPid]);
  useEffect(() => { refreshBackups(); }, [refreshBackups]);
  useEffect(() => { setInfo(null); setUser(''); setTitles([]); setTitle(''); setSaves([]); setMounted(null); }, [pid]);

  const connect = async () => {
    setBusy('connect');
    try {
      const r = await api.get(`${API}/ps5/${pid}/users`);
      setInfo(r);
      if (r.users.length) setUser(r.users[0].hex);
      const st = await api.get(`${API}/ps5/${pid}/state`);
      setMounted(st.mounted);
    } catch (e) { notifyErr(e); }
    setBusy('');
  };

  useEffect(() => {
    if (!user) return;
    setTitle('');
    setSaves([]);
    api.get(`${API}/ps5/${pid}/titles?user=${user}`).then((r) => setTitles(r.titles)).catch(notifyErr);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSaves = useCallback(async (t = title) => {
    if (!t || !user) return;
    try { setSaves((await api.get(`${API}/ps5/${pid}/saves?user=${user}&title=${t}`)).saves); } catch (e) { notifyErr(e); }
  }, [pid, user, title]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadSaves(title); }, [title]); // eslint-disable-line react-hooks/exhaustive-deps

  const mount = async (dir) => {
    setBusy(`mount:${dir}`);
    try {
      const r = await api.post(`${API}/ps5/${pid}/mount`, { user, title, dir });
      setMounted({ user, title, dir, mountPoint: r.mountPoint });
    } catch (e) { notifyErr(e); }
    setBusy('');
  };
  const unmount = async () => {
    setBusy('unmount');
    try {
      await api.post(`${API}/ps5/${pid}/unmount`, {});
      setMounted(null);
      onNotification?.('Save unmounted and written back', 'success');
    } catch (e) { notifyErr(e); }
    setBusy('');
  };
  const backup = async (dir) => {
    try { setJob((await api.post(`${API}/backup`, { pid, user, title, dir })).job); } catch (e) { notifyErr(e); }
  };
  const fillInto = (dir) => {
    setDstTitle(title);
    setDstDir(dir);
    setDstNew(false);
    document.getElementById('save-transfer')?.scrollIntoView({ behavior: 'smooth' });
  };

  const pickFolder = (folder) => {
    setSrcFolder(folder);
    const g = guessFromFolder(folder);
    if (g.title) setDstTitle(g.title);
    if (g.dir) setDstDir(g.dir);
  };

  const transfer = async () => {
    try {
      const body = {
        toPid: pid, user, title: dstTitle.trim().toUpperCase(), dir: dstDir.trim(),
        ...(srcKind === 'ps4' ? { fromPid: srcPid, fromPath: srcFolder } : { fromFolder: srcBackup }),
        ...(dstNew ? { create: { sizeMb: dstSize } } : {}),
      };
      setJob((await api.post(`${API}/transfer`, body)).job);
    } catch (e) { notifyErr(e); }
  };

  const ready = info && user;
  const canTransfer = ready && /^[A-Z]{4}\d{5}$/i.test(dstTitle.trim()) && /^[A-Za-z0-9_.-]{1,31}$/.test(dstDir.trim())
    && (srcKind === 'ps4' ? srcPid && srcFolder : srcBackup) && job?.state !== 'running';

  if (ps5s.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">💾</div>
        <div className="empty-state-title">No PS5 profile</div>
        <div className="empty-state-text">The save mounter runs on a PS5. Add one under Settings → Profiles.</div>
      </div>
    );
  }

  return (
    <div>
      <JobBox job={job} onClose={() => setJob(null)} />
      <div className="comp-card mt-sm">
        <div className="comp-card-body">
          <div className="font-bold mb-sm">💾 PS5 saves</div>
          <div className="text-xs text-muted mb-sm">
            Mounts a save read/write so its files can be copied over FTP, backs saves up to this computer and fills a
            save with a decrypted one - from a PS4 or from a backup. Needs the ELF loader on the PS5; FTP starts by itself.
          </div>
          <div className="flex gap-sm flex-wrap items-center">
            <select className="select" value={pid} onChange={(e) => setPid(e.target.value)} style={{ flex: '1 1 180px', minHeight: 40 }}>
              {ps5s.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.ip_address})</option>)}
            </select>
            <button className="btn btn-primary" onClick={connect} disabled={busy === 'connect'} style={{ minHeight: 40 }}>
              {busy === 'connect' ? 'Connecting…' : info ? 'Reconnect' : 'Connect'}
            </button>
            {info && <span className="text-xs text-muted">firmware {info.firmware}</span>}
          </div>

          {info && (
            <div className="flex gap-sm flex-wrap mt-sm">
              <select className="select" value={user} onChange={(e) => setUser(e.target.value)} style={{ flex: '1 1 160px', minHeight: 40 }}>
                {info.users.map((u) => <option key={u.hex} value={u.hex}>👤 {u.name}</option>)}
              </select>
              <select className="select" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: '1 1 160px', minHeight: 40 }}>
                <option value="">Game with saves… ({titles.length})</option>
                {titles.map((t) => <option key={t} value={t}>{t}{t.startsWith('CUSA') ? ' (PS4)' : t.startsWith('PPSA') ? ' (PS5)' : ''}</option>)}
              </select>
            </div>
          )}

          {mounted && (
            <div className="comp-card mt-sm" style={{ borderColor: 'var(--green)' }}>
              <div className="comp-card-body p-sm flex items-center gap-sm flex-wrap">
                <span className="flex-1 text-sm" style={{ minWidth: 200, wordBreak: 'break-all' }}>
                  📂 <b>{mounted.title}/{mounted.dir}</b> is mounted at <code>{mounted.mountPoint}</code> - open it in File Ops on the
                  console side. Unmount when done: that writes it back.
                </span>
                <button className="btn btn-success" onClick={unmount} disabled={busy === 'unmount'} style={{ minHeight: 40 }}>
                  {busy === 'unmount' ? 'Unmounting…' : 'Unmount'}
                </button>
              </div>
            </div>
          )}

          {title && (
            <div className="mt-sm">
              {saves.length === 0 && <div className="text-sm text-muted">No saves of {title} for this user.</div>}
              {saves.map((s) => (
                <div key={s.dir} className="comp-card mt-xs">
                  <div className="comp-card-body p-sm">
                    <div className="flex items-center justify-between gap-sm flex-wrap">
                      <div style={{ minWidth: 0, flex: '1 1 200px' }}>
                        <div className="font-bold" style={{ wordBreak: 'break-all' }}>{s.subtitle || s.title || s.dir}</div>
                        <div className="text-xs text-muted" style={{ wordBreak: 'break-all' }}>
                          {s.dir}{s.detail ? ` · ${s.detail}` : ''}{s.modified ? ` · ${fmtTime(s.modified)}` : ''}
                        </div>
                      </div>
                      <div className="flex gap-xs flex-wrap">
                        <button className="btn btn-sm btn-secondary" onClick={() => mount(s.dir)} disabled={!!busy || mounted?.dir === s.dir}>
                          {busy === `mount:${s.dir}` ? 'Mounting…' : 'Mount'}
                        </button>
                        <button className="btn btn-sm btn-secondary" onClick={() => backup(s.dir)} disabled={job?.state === 'running'}>Back up</button>
                        <button className="btn btn-sm btn-secondary" onClick={() => fillInto(s.dir)}>Replace…</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="comp-card mt-md" id="save-transfer">
        <div className="comp-card-body">
          <div className="font-bold mb-sm">➡️ PS4 save to PS5</div>
          <ol className="text-xs text-muted" style={{ paddingLeft: 18, margin: '0 0 8px' }}>
            <li>On the PS4 (GoldHEN), open <b>Apollo Save Tool</b>, pick the save and choose <b>Export decrypted save files</b> (to the internal drive or a USB drive).</li>
            <li>Pick that folder below - or a backup on this computer.</li>
            <li>The game's PS4 title id (CUSA…) and a save name; a new save is created on the PS5 unless you replace one.</li>
          </ol>

          <div className="tabs mb-sm">
            <button className={`tab-item ${srcKind === 'ps4' ? 'active' : ''}`} onClick={() => setSrcKind('ps4')}>From a PS4</button>
            <button className={`tab-item ${srcKind === 'backup' ? 'active' : ''}`} onClick={() => setSrcKind('backup')}>From a backup</button>
          </div>

          {srcKind === 'ps4' && (
            ps4s.length === 0
              ? <div className="text-sm text-muted">No PS4 profile - add one under Settings → Profiles (console type PS4).</div>
              : (
                <div>
                  <select className="select mb-sm" value={srcPid} onChange={(e) => { setSrcPid(e.target.value); setSrcFolder(''); }} style={{ width: '100%', minHeight: 40 }}>
                    {ps4s.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.ip_address})</option>)}
                  </select>
                  <FtpPicker pid={srcPid} value={srcFolder} onPick={pickFolder} />
                </div>
              )
          )}
          {srcKind === 'backup' && (
            backups.length === 0
              ? <div className="text-sm text-muted">No backups yet - use Back up on a save above.</div>
              : (
                <select className="select" value={srcBackup} onChange={(e) => {
                  setSrcBackup(e.target.value);
                  const b = backups.find((x) => x.folder === e.target.value);
                  if (b) { setDstTitle(b.title); setDstDir(b.name.replace(/_\d{4}-\d{2}-\d{2}-.*$/, '')); }
                }} style={{ width: '100%', minHeight: 40 }}>
                  <option value="">Pick a backup…</option>
                  {backups.map((b) => <option key={b.folder} value={b.folder}>{b.title} / {b.name}</option>)}
                </select>
              )
          )}

          <div className="flex gap-sm flex-wrap mt-sm">
            <input className="input" placeholder="Title id, e.g. CUSA12345" value={dstTitle} onChange={(e) => setDstTitle(e.target.value.toUpperCase())} style={{ flex: '1 1 150px', minHeight: 40 }} />
            <input className="input" placeholder="Save name, e.g. SAVEDATA00" value={dstDir} onChange={(e) => setDstDir(e.target.value)} style={{ flex: '1 1 150px', minHeight: 40 }} />
          </div>
          <div className="flex gap-sm flex-wrap items-center mt-sm text-sm">
            <label className="flex items-center gap-xs" style={{ minHeight: 40 }}>
              <input type="radio" checked={dstNew} onChange={() => setDstNew(true)} /> New save of
              <input className="input" type="number" min={1} max={8192} value={dstSize} onChange={(e) => setDstSize(Number(e.target.value))} style={{ width: 80 }} /> MB
            </label>
            <label className="flex items-center gap-xs" style={{ minHeight: 40 }}>
              <input type="radio" checked={!dstNew} onChange={() => setDstNew(false)} /> Replace the files of an existing save
            </label>
          </div>
          {!ready && <div className="text-xs text-muted mt-xs">Connect to the PS5 above first.</div>}
          <button className="btn btn-primary mt-sm" onClick={transfer} disabled={!canTransfer} style={{ width: '100%', minHeight: 44 }}>
            Copy into the PS5 save
          </button>
          <div className="text-xs text-muted mt-xs">The save's sce_sys folder is left as the PS5 made it.</div>
        </div>
      </div>
    </div>
  );
}
