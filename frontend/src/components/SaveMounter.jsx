import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';

const API = '/saves';
// Where Apollo Save Tool on a PS4 puts "export decrypted save files": on
// the internal drive or on a USB drive.
// Kept in step with APOLLO_DIRS in backend/src/routes/saves.js.
const PS4_PLACES = ['/data/apollo/', '/mnt/usb0/PS4/APOLLO/', '/mnt/usb1/PS4/APOLLO/', '/data/fakeusb/PS4/APOLLO/', '/mnt/usb0/', '/mnt/usb1/'];

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
        {job.result?.ps4Backup && <div className="text-xs text-muted mt-xs" style={{ wordBreak: 'break-all' }}>PS4 export kept in {job.result.ps4Backup}</div>}
        {job.result?.ps5Backup && <div className="text-xs text-muted mt-xs" style={{ wordBreak: 'break-all' }}>The PS5 save it replaced is in {job.result.ps5Backup}</div>}
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

export default function SaveMounter({ profiles = [], onNotification, initialPick, onPickConsumed }) {
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

  // "Games on both consoles": what the PS4 and the PS5 both have installed,
  // crossed with the decrypted saves Apollo has exported on the PS4.
  const [match, setMatch] = useState(null);
  const [matchBusy, setMatchBusy] = useState(false);

  const notifyErr = (e) => onNotification?.(e.message, 'error');
  const refreshBackups = useCallback(async () => {
    try { setBackups((await api.get(`${API}/backups`)).backups); } catch (_) { /* none */ }
  }, []);
  const [job, setJob] = useJob(useCallback((j) => {
    if (j.state === 'done') {
      onNotification?.(j.kind === 'backup' ? 'Save backed up'
        : j.kind === 'export' ? 'PS4 save copied to this computer'
        : 'Save copied into the PS5', 'success');
    }
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
      return r;
    } catch (e) { notifyErr(e); return null; }
    finally { setBusy(''); }
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

  const loadMatch = useCallback(async () => {
    const ps4 = ps4s.find((p) => String(p.id) === String(srcPid));
    const ps5 = ps5s.find((p) => String(p.id) === String(pid));
    if (!ps4 || !ps5) return;
    setMatchBusy(true);
    try {
      const [lib4, lib5, exp] = await Promise.all([
        api.get(`/library/${ps4.ip_address}/ps4`),
        api.get(`/library/${ps5.ip_address}/overview`),
        api.get(`${API}/ps4/${srcPid}/saves`),
      ]);
      const id = (g) => String(g?.title_id || '').toUpperCase();
      const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const onPs5 = new Set((lib5.games || []).map(id));
      // A game can be on both consoles as two different builds - Red Dead
      // Redemption is CUSA… on the PS4 and PPSA… on the PS5. Same name, other
      // save format, so it is matched only to be able to say why it can't move.
      const ps5ByName = new Map();
      for (const g of lib5.games || []) {
        const n = norm(g.title_name || g.name);
        if (n && !ps5ByName.has(n)) ps5ByName.set(n, id(g));
      }
      // The newest save per game is the one offered; the rest are reachable
      // through the manual form below.
      const saves = new Map();
      for (const e of [...(exp.saves || [])].sort((a, b) => String(b.modified).localeCompare(String(a.modified)))) {
        if (!saves.has(e.title)) saves.set(e.title, e);
      }
      const rows = (lib4.games || []).filter((g) => id(g)).map((g) => ({
        title: id(g), name: g.title_name || id(g), icon: g.icon,
        onPs5: onPs5.has(id(g)),
        ps5Other: onPs5.has(id(g)) ? null : ps5ByName.get(norm(g.title_name)) || null,
        ps4Ip: ps4.ip_address, save: saves.get(id(g)) || null,
      }));
      // A save whose game is no longer installed on the PS4 still works.
      const known = new Set(rows.map((r) => r.title));
      for (const [title, e] of saves) {
        if (!known.has(title)) rows.push({ title, name: title, icon: null, onPs5: onPs5.has(title), ps5Other: null, ps4Ip: ps4.ip_address, save: e });
      }
      rows.sort((a, b) => a.name.localeCompare(b.name));
      setMatch({
        both: rows.filter((r) => r.onPs5),
        otherVersion: rows.filter((r) => r.ps5Other),
        exportOnly: rows.filter((r) => !r.onPs5 && !r.ps5Other && r.save),
      });
    } catch (e) { notifyErr(e); }
    setMatchBusy(false);
  }, [pid, srcPid, ps4s, ps5s]); // eslint-disable-line react-hooks/exhaustive-deps

  // The whole move, from one button: the PS4 save is mounted and copied off
  // decrypted by our payload, both sides are backed up, and the files go
  // into the PS5's save - which is created when the game has none there yet.
  const transferGame = async (row) => {
    try {
      // A game the PS5 has as its own build takes the save under *its* title
      // id. Whether that build reads a PS4 save is the game's business, not
      // ours - the PS5 save it replaces is backed up either way.
      const toTitle = row.ps5Other || row.title;
      const conn = info || await connect();
      const who = user || conn?.users?.[0]?.hex;
      if (!who) throw new Error('No PS5 user to put the save under - connect to the PS5 first.');
      if (!user) setUser(who);
      const existing = (await api.get(`${API}/ps5/${pid}/saves?user=${who}&title=${toTitle}`)).saves || [];
      const target = existing.find((x) => x.dir === row.save.dir) || existing[0];
      setJob((await api.post(`${API}/transfer`, {
        toPid: pid, user: who, title: toTitle, dir: target?.dir || row.save.dir,
        fromSave: { pid: srcPid, user: row.save.user, title: row.title, dir: row.save.dir },
        // A PS5 save has to be big enough for the PS4 one, with room for
        // what the game writes next.
        ...(target ? {} : { create: { sizeMb: Math.min(8192, Math.max(32, Math.ceil((row.save.size || 0) / (1024 * 1024)) + 16)) } }),
      })).job);
    } catch (e) { notifyErr(e); }
  };

  const exportGame = async (row) => {
    try { setJob((await api.post(`${API}/ps4/${srcPid}/export`, row.save)).job); } catch (e) { notifyErr(e); }
  };

  // A folder handed over from the file browser ("Send to PS5 save").
  useEffect(() => {
    if (!initialPick) return;
    const from = ps4s.find((p) => p.ip_address === initialPick.ip);
    setSrcKind('ps4');
    if (from) setSrcPid(String(from.id));
    pickFolder(initialPick.path);
    onPickConsumed?.();
    document.getElementById('save-transfer')?.scrollIntoView({ behavior: 'smooth' });
  }, [initialPick]); // eslint-disable-line react-hooks/exhaustive-deps

  const matchRow = (r) => (
    <div key={r.title} className="comp-card mt-xs">
      <div className="comp-card-body p-sm flex items-center justify-between gap-sm flex-wrap">
        <div className="flex items-center gap-sm" style={{ minWidth: 0, flex: '1 1 200px' }}>
          {r.icon && <img src={r.icon} alt="" width={40} height={40} style={{ borderRadius: 6 }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
          <div style={{ minWidth: 0 }}>
            <div className="font-bold truncate" title={r.name}>{r.name}</div>
            <div className="text-xs text-muted" style={{ wordBreak: 'break-all' }}>
              {r.title}{r.save ? ` · save: ${r.save.dir}` : ' · no save on the PS4'}
            </div>
          </div>
        </div>
        <div className="flex gap-xs flex-wrap items-center">
          {r.ps5Other && (
            <span className="text-xs text-muted" style={{ maxWidth: 280 }}>
              The PS5 has {r.ps5Other}, a build of its own. Whether it reads a PS4 save is up to the game - worth a
              try, and the save it replaces is backed up first.
            </span>
          )}
          {r.save ? (
            <>
              {(r.onPs5 || r.ps5Other) && (
                <button
                  className={`btn btn-sm ${r.ps5Other ? 'btn-secondary' : 'btn-primary'}`}
                  onClick={() => transferGame(r)}
                  disabled={job?.state === 'running' || !!busy}
                >
                  {r.ps5Other ? `→ Try it on ${r.ps5Other}` : '→ Transfer to PS5'}
                </button>
              )}
              <button className="btn btn-sm btn-secondary" onClick={() => exportGame(r)} disabled={job?.state === 'running'}>
                ⬇ Save a copy
              </button>
            </>
          ) : (
            <span className="text-xs text-muted">No save for this game on the PS4</span>
          )}
        </div>
      </div>
    </div>
  );

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
          <div className="flex items-center justify-between gap-sm flex-wrap mb-sm">
            <span className="font-bold">🎮 Games on both consoles</span>
            <button className="btn btn-sm btn-secondary" onClick={loadMatch} disabled={matchBusy || !srcPid || !pid}>
              {matchBusy ? 'Looking…' : match ? '↻ Refresh' : 'Show'}
            </button>
          </div>
          <div className="text-xs text-muted mb-sm">
            The PS4's list comes from its app.db, the PS5's from ShadowMountPlus, so both consoles have to be on.
            Transfer does the whole move by itself: a payload on the PS4 mounts that save decrypted (nothing to
            start on the console, its own copy is left alone), both sides are backed up here, and the files go
            into the PS5's save.
          </div>
          {ps4s.length === 0 && <div className="text-sm text-muted">No PS4 profile - add one under Settings → Profiles (console type PS4).</div>}
          {ps4s.length > 1 && (
            <select className="select mb-sm" value={srcPid} onChange={(e) => { setSrcPid(e.target.value); setMatch(null); }} style={{ width: '100%', minHeight: 40 }}>
              {ps4s.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.ip_address})</option>)}
            </select>
          )}
          {match && match.both.length === 0 && <div className="text-sm text-muted">No game is installed on both consoles.</div>}
          {match?.both.map(matchRow)}
          {match && match.otherVersion.length > 0 && (
            <>
              <div className="font-bold mt-md">On both consoles, but not the same version</div>
              <div className="text-xs text-muted">
                The PS5 runs its own build of these under a different title id. A PS4 save may or may not be
                readable by it - the transfer backs up what it replaces, so trying costs nothing but time.
              </div>
              {match.otherVersion.map(matchRow)}
            </>
          )}
          {match && match.exportOnly.length > 0 && (
            <>
              <div className="font-bold mt-md">Saves of games the PS5 does not have</div>
              <div className="text-xs text-muted">Nothing to transfer them into - you can still keep a decrypted copy here.</div>
              {match.exportOnly.map(matchRow)}
            </>
          )}
        </div>
      </div>
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
                <option value="">Homebrew title with saves… ({titles.length})</option>
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
          <ol className="text-sm text-muted save-transfer-steps">
            <li><b>Export from PS4.</b> In Apollo Save Tool, choose “Export decrypted save files”.</li>
            <li><b>Choose the source.</b> Select the exported folder or a backup below.</li>
            <li><b>Set the destination.</b> Enter the PS4 title ID and save name for the new PS5 save.</li>
          </ol>

          <h3 className="save-transfer-stage-title">Step 2 · Choose the source</h3>
          <div className="tabs mb-sm">
            <button className={`tab-item ${srcKind === 'ps4' ? 'active' : ''}`} aria-pressed={srcKind === 'ps4'} onClick={() => setSrcKind('ps4')}>From a PS4</button>
            <button className={`tab-item ${srcKind === 'backup' ? 'active' : ''}`} aria-pressed={srcKind === 'backup'} onClick={() => setSrcKind('backup')}>From a backup</button>
          </div>

          {srcKind === 'ps4' && (
            ps4s.length === 0
              ? <div className="text-sm text-muted">No PS4 profile - add one under Settings → Profiles (console type PS4).</div>
              : (
                <div>
                  <select className="select mb-sm save-transfer-select" value={srcPid} onChange={(e) => { setSrcPid(e.target.value); setSrcFolder(''); }}>
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

          <h3 className="save-transfer-stage-title">Step 3 · Set the destination</h3>
          <div className="flex gap-sm flex-wrap mt-sm save-transfer-destination">
            <input className="input" aria-label="PS4 title ID" placeholder="Title ID, e.g. CUSA12345" value={dstTitle} onChange={(e) => setDstTitle(e.target.value.toUpperCase())} />
            <input className="input" aria-label="Save name" placeholder="Save name, e.g. SAVEDATA00" value={dstDir} onChange={(e) => setDstDir(e.target.value)} />
          </div>
          <div className="flex gap-sm flex-wrap items-center mt-sm text-sm">
            <label className="flex items-center gap-xs save-transfer-option">
              <input type="radio" checked={dstNew} onChange={() => setDstNew(true)} /> New save of
              <input className="input save-transfer-size" type="number" min={1} max={8192} value={dstSize} onChange={(e) => setDstSize(Number(e.target.value))} /> MB
            </label>
            <label className="flex items-center gap-xs save-transfer-option">
              <input type="radio" checked={!dstNew} onChange={() => setDstNew(false)} /> Replace the files of an existing save
            </label>
          </div>
          {!ready && <div className="text-xs text-muted mt-xs">Connect to the PS5 above first.</div>}
          <button className="btn btn-primary mt-sm save-transfer-submit" onClick={transfer} disabled={!canTransfer}>
            Copy into the PS5 save
          </button>
          <div className="text-xs text-muted mt-xs">The save's sce_sys folder is left as the PS5 made it.</div>
        </div>
      </div>
    </div>
  );
}
