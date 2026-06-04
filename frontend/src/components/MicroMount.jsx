import { useState, useEffect, useCallback } from 'react';
import FileBrowser, { ExtractLogPanel } from './FileBrowser';

const API = '/api';

const C = {
  bg: 'var(--bg)',
  panel: 'var(--bg-elev)',
  panel2: 'var(--bg-elev-2)',
  accent: 'var(--accent)',
  blue: 'var(--blue)',
  green: 'var(--accent)',
  red: 'var(--red)',
  text: '#fff',
  muted: '#aaa',
  border: 'var(--bg-elev-2)',
};

const styles = {
  section: { background: C.panel, padding: '1rem', borderRadius: 12, marginBottom: '1rem' },
  h: { fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', color: C.text },
  h2: { fontSize: '0.9rem', fontWeight: 500, marginBottom: '0.5rem', color: C.text },
  label: { display: 'block', fontSize: '0.8rem', color: C.muted, marginBottom: '0.25rem' },
  input: {
    padding: '0.6rem', borderRadius: 6, background: C.bg, color: C.text,
    border: `1px solid ${C.border}`, fontSize: '0.9rem', width: '100%', boxSizing: 'border-box',
  },
  row: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' },
  col: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.5rem' },
  btn: (color, disabled) => ({
    padding: '0.4rem 0.75rem', background: disabled ? '#555' : color, color: C.text,
    border: 'none', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '0.8rem', fontWeight: 500, minHeight: 'auto',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
  }),
  pill: (color) => {
    // Map the raw color to a soft, readable tinted-badge palette so light
    // accents (mint, blue, magenta) don't print as light-on-light text.
    const tint = (bg, fg, border) => ({ bg, fg, border });
    const map = {
      'var(--accent)': tint('var(--accent-dim)', 'var(--accent)', 'rgba(124,255,179,0.28)'),
      'var(--red)':    tint('var(--red-dim)',    'var(--red)',    'rgba(255,93,122,0.28)'),
      'var(--blue)':   tint('var(--blue-dim)',   'var(--blue)',   'rgba(125,223,245,0.28)'),
      'var(--amber)':  tint('var(--amber-dim)',  'var(--amber)',  'rgba(255,184,107,0.28)'),
      'var(--magenta)': tint('rgba(196,144,255,0.16)', 'var(--magenta)', 'rgba(196,144,255,0.28)'),
    };
    const t = map[color] || tint('rgba(255,255,255,0.06)', '#cfd2dc', 'var(--border)');
    return {
      display: 'inline-block', padding: '0.18rem 0.55rem',
      background: t.bg, color: t.fg, border: `1px solid ${t.border}`,
      borderRadius: 999, fontSize: '0.7rem', fontWeight: 600, lineHeight: 1.4,
      whiteSpace: 'nowrap',
    };
  },
  card: { padding: '0.75rem', background: C.panel2, borderRadius: 8, marginBottom: '0.5rem' },
  tab: (active) => ({
    padding: '0.4rem 0.85rem',
    background: active ? 'var(--accent-dim)' : C.panel2,
    color: active ? 'var(--accent)' : C.text,
    border: `1px solid ${active ? 'rgba(124,255,179,0.28)' : 'transparent'}`,
    borderRadius: 8, cursor: 'pointer',
    fontSize: '0.82rem', fontWeight: 500, textTransform: 'capitalize',
  }),
};

const isSmbPath = (s) => /^smb:\/\//i.test(s || '');

function ConfigSection({ config, setConfig, onSave, onPush, onDownload, profiles, ftp, setFtp, onSaveFtp, onTestFtp }) {
  const [ip, setIp] = useState(profiles.find(p => p.is_default)?.ip_address || profiles[0]?.ip_address || '');
  const [pushing, setPushing] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (!ip) {
      const p = profiles.find(x => x.is_default) || profiles[0];
      if (p) setIp(p.ip_address);
    }
  }, [profiles]);

  const update = (k, v) => setConfig({ ...config, [k]: v });

  const handlePush = async () => {
    if (!ip) return alert('Select PS5 IP');
    setPushing(true);
    try { await onPush(ip); } finally { setPushing(false); }
  };

  const handleTest = async () => {
    if (!ip) return alert('Select PS5 IP');
    setTesting(true);
    try { await onTestFtp(ip); } finally { setTesting(false); }
  };

  return (
    <>
      <section style={styles.section}>
        <div style={styles.h}>General</div>
        <div style={styles.col}>
          <div>
            <label style={styles.label}>Target directory (where managed mounts are created on PS5)</label>
            <input style={styles.input} value={config.target_directory}
              onChange={e => update('target_directory', e.target.value)} placeholder="/data/homebrew" />
          </div>
          <div style={styles.grid2}>
            <div>
              <label style={styles.label}>Scan depth</label>
              <input type="number" min="0" max="10" style={styles.input}
                value={config.scan_depth} onChange={e => update('scan_depth', parseInt(e.target.value) || 0)} />
            </div>
            <div>
              <label style={styles.label}>Scan interval (seconds)</label>
              <input type="number" min="5" style={styles.input}
                value={config.scan_interval_seconds}
                onChange={e => update('scan_interval_seconds', parseInt(e.target.value) || 30)} />
            </div>
            <div>
              <label style={styles.label}>Debug</label>
              <select style={styles.input} value={config.debug ? 1 : 0}
                onChange={e => update('debug', parseInt(e.target.value))}>
                <option value={1}>Enabled (popups)</option>
                <option value={0}>Disabled</option>
              </select>
            </div>
          </div>
        </div>
      </section>

      <section style={styles.section}>
        <div style={styles.h}>Mount profile (advanced)</div>
        <div style={styles.grid2}>
          {[
            ['lvd_image_type', 'LVD image type', 'number'],
            ['lvd_sector_size', 'LVD sector size', 'number'],
            ['lvd_secondary_unit', 'LVD secondary unit', 'number'],
            ['lvd_raw_flags', 'LVD raw flags', 'text'],
            ['pfs_fstype', 'PFS fstype', 'text'],
            ['pfs_mkeymode', 'PFS mkeymode', 'text'],
            ['pfs_budgetid', 'PFS budgetid', 'text'],
            ['pfs_sigverify', 'PFS sigverify', 'number'],
            ['pfs_playgo', 'PFS playgo', 'number'],
            ['pfs_disc', 'PFS disc', 'number'],
            ['pfs_use_ekpfs', 'PFS use_ekpfs', 'number'],
            ['pfs_read_only', 'PFS read_only', 'number'],
            ['pfs_force', 'PFS force', 'number'],
          ].map(([k, label, type]) => (
            <div key={k}>
              <label style={styles.label}>{label}</label>
              <input type={type} style={styles.input} value={config[k] ?? ''}
                onChange={e => update(k, type === 'number' ? (parseInt(e.target.value) || 0) : e.target.value)} />
            </div>
          ))}
        </div>
      </section>

      <section style={styles.section}>
        <div style={styles.h}>FTP (used to push config &amp; sync .ffpfsc)</div>
        <div style={styles.grid2}>
          <div>
            <label style={styles.label}>Port</label>
            <input type="number" style={styles.input} value={ftp.port}
              onChange={e => setFtp({ ...ftp, port: parseInt(e.target.value) || 2121 })} />
          </div>
          <div>
            <label style={styles.label}>Username</label>
            <input style={styles.input} value={ftp.username}
              onChange={e => setFtp({ ...ftp, username: e.target.value })} placeholder="anonymous" />
          </div>
          <div>
            <label style={styles.label}>Password</label>
            <input type="password" style={styles.input} value={ftp.password === '__set__' ? '' : (ftp.password || '')}
              onChange={e => setFtp({ ...ftp, password: e.target.value })}
              placeholder={ftp.password === '__set__' ? '(saved)' : ''} />
          </div>
        </div>
        <div style={{ ...styles.row, marginTop: '0.75rem' }}>
          <button style={styles.btn(C.green)} onClick={onSaveFtp}>Save FTP</button>
        </div>
      </section>

      <section style={styles.section}>
        <div style={styles.h}>Apply</div>
        <div style={styles.col}>
          <div style={styles.row}>
            <label style={{ ...styles.label, marginBottom: 0 }}>Target PS5:</label>
            <select style={{ ...styles.input, maxWidth: 280 }} value={ip} onChange={e => setIp(e.target.value)}>
              <option value="">— select profile —</option>
              {profiles.map(p => (
                <option key={p.id} value={p.ip_address}>{p.name} ({p.ip_address})</option>
              ))}
            </select>
          </div>
          <div style={{ ...styles.row, marginTop: '0.5rem' }}>
            <button style={styles.btn(C.blue)} onClick={onSave}>Save Config</button>
            <button style={styles.btn(C.green, !ip || pushing)} disabled={!ip || pushing} onClick={handlePush}>
              {pushing ? 'Pushing…' : 'Push config.ini → PS5'}
            </button>
            <button style={styles.btn('#7f8c8d', !ip || testing)} disabled={!ip || testing} onClick={handleTest}>
              {testing ? 'Testing…' : 'Test FTP'}
            </button>
            <button style={styles.btn('#34495e')} onClick={onDownload}>Download config.ini</button>
          </div>
        </div>
      </section>
    </>
  );
}

function ScanPathsSection({ config, setConfig, onSave }) {
  const [newPath, setNewPath] = useState('');
  const paths = config.scan_paths || [];

  const addPath = () => {
    if (!newPath.trim()) return;
    setConfig({ ...config, scan_paths: [...paths, newPath.trim()] });
    setNewPath('');
  };

  const removePath = (idx) => {
    setConfig({ ...config, scan_paths: paths.filter((_, i) => i !== idx) });
  };

  return (
    <section style={styles.section}>
      <div style={styles.h}>Scan paths</div>
      <p style={{ color: C.muted, fontSize: '0.8rem', marginBottom: '0.75rem' }}>
        Local PS5 paths are written into <code>config.ini</code> as <code>scanpath=</code> entries.
        Paths starting with <code>smb://</code> are excluded from the PS5 config but remembered here as a hint —
        for SMB browsing &amp; sync use the <strong>SMB Sources</strong> tab.
      </p>
      <div style={styles.col}>
        {paths.length === 0 && <div style={{ color: C.muted, fontSize: '0.85rem' }}>No paths configured.</div>}
        {paths.map((p, idx) => (
          <div key={idx} style={{ ...styles.row, ...styles.card, marginBottom: 0, justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flex: 1, minWidth: 0 }}>
              <span style={styles.pill(isSmbPath(p) ? 'var(--magenta)' : C.blue)}>{isSmbPath(p) ? 'SMB' : 'PS5'}</span>
              <code style={{ color: C.text, fontSize: '0.85rem', wordBreak: 'break-all' }}>{p}</code>
            </div>
            <button style={styles.btn(C.red)} onClick={() => removePath(idx)}>Remove</button>
          </div>
        ))}

        <div style={{ ...styles.row, marginTop: '0.5rem' }}>
          <input style={{ ...styles.input, flex: 1, minWidth: 200 }}
            placeholder="/data/homebrew  •  /mnt/usb0/homebrew  •  smb://host/share/games"
            value={newPath} onChange={e => setNewPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addPath()} />
          <button style={styles.btn(C.green)} onClick={addPath}>Add</button>
        </div>
        <div style={styles.row}>
          <button style={styles.btn(C.blue)} onClick={onSave}>Save Paths</button>
        </div>
      </div>
    </section>
  );
}

function SmbSourcesSection({ profiles, ftp, refreshSources }) {
  const [sources, setSources] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [browseFor, setBrowseFor] = useState(null);
  const [browseFiles, setBrowseFiles] = useState([]);
  const [browseSubPath, setBrowseSubPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncIp, setSyncIp] = useState('');
  const [syncDest, setSyncDest] = useState('/data/homebrew');
  const [message, setMessage] = useState(null);

  function emptyForm() {
    return { name: '', type: 'smb', path: '', smb_host: '', smb_share: '', smb_username: '', smb_password: '', smb_domain: '', enabled: true };
  }

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/micromount/sources`);
      setSources(await r.json());
    } catch (_) {}
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!syncIp) {
      const p = profiles.find(x => x.is_default) || profiles[0];
      if (p) setSyncIp(p.ip_address);
    }
  }, [profiles]);

  const showMsg = (text, type = 'info') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  };

  const startNew = () => { setEditing('new'); setForm(emptyForm()); };
  const startEdit = (s) => {
    setEditing(s.id);
    setForm({
      name: s.name, type: s.type, path: s.path || '',
      smb_host: s.smb_host || '', smb_share: s.smb_share || '',
      smb_username: s.smb_username || '', smb_password: s.smb_password || '',
      smb_domain: s.smb_domain || '', enabled: !!s.enabled,
    });
  };
  const cancel = () => { setEditing(null); setForm(emptyForm()); };

  const save = async () => {
    if (!form.name) return showMsg('Name is required', 'error');
    if (form.type === 'smb' && (!form.smb_host || !form.smb_share)) return showMsg('SMB host and share required', 'error');

    try {
      if (editing === 'new') {
        const r = await fetch(`${API}/micromount/sources`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
        if (!r.ok) throw new Error((await r.json()).error);
      } else {
        const r = await fetch(`${API}/micromount/sources/${editing}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
        if (!r.ok) throw new Error((await r.json()).error);
      }
      showMsg('Saved', 'success');
      cancel();
      load();
    } catch (e) {
      showMsg(e.message, 'error');
    }
  };

  const remove = async (id) => {
    if (!confirm('Delete this source?')) return;
    await fetch(`${API}/micromount/sources/${id}`, { method: 'DELETE' });
    load();
  };

  const test = async (id) => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/micromount/sources/${id}/test`, { method: 'POST' });
      const d = await r.json();
      showMsg(d.success ? 'Connection OK' : (d.error || 'Failed'), d.success ? 'success' : 'error');
    } catch (e) { showMsg(e.message, 'error'); }
    setBusy(false);
  };

  const browse = async (src, subPath = '') => {
    setBusy(true);
    setBrowseFor(src);
    try {
      let r = await fetch(`${API}/micromount/sources/${src.id}/browse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subPath }),
      });
      let d = await r.json();
      if (!d.success && subPath && d.smb_status === 'NT_STATUS_OBJECT_NAME_NOT_FOUND') {
        showMsg(`${d.error}. Falling back to share root.`, 'error');
        r = await fetch(`${API}/micromount/sources/${src.id}/browse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subPath: '' }),
        });
        d = await r.json();
        subPath = '';
      }
      setBrowseSubPath(subPath);
      if (d.success) setBrowseFiles(d.files || []);
      else { setBrowseFiles([]); showMsg(d.error || 'Browse failed', 'error'); }
    } catch (e) { showMsg(e.message, 'error'); setBrowseFiles([]); }
    setBusy(false);
  };

  const sync = async (src) => {
    if (!syncIp) return showMsg('Select PS5 IP', 'error');
    setBusy(true);
    try {
      const r = await fetch(`${API}/micromount/sources/${src.id}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: syncIp, dest_path: syncDest, subPath: browseFor?.id === src.id ? browseSubPath : (src.path || '') }),
      });
      const d = await r.json();
      if (d.success) {
        const okCount = (d.synced || []).length;
        const failCount = (d.failed || []).length;
        showMsg(`Synced ${okCount} files${failCount ? `, ${failCount} failed` : ''}`, failCount ? 'error' : 'success');
      } else showMsg(d.error || 'Sync failed', 'error');
    } catch (e) { showMsg(e.message, 'error'); }
    setBusy(false);
  };

  const enterDir = (name) => {
    const next = browseSubPath ? `${browseSubPath}/${name}` : name;
    browse(browseFor, next);
  };
  const goUp = () => {
    const parts = browseSubPath.split('/').filter(Boolean);
    parts.pop();
    browse(browseFor, parts.join('/'));
  };

  return (
    <section style={styles.section}>
      <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: '0.75rem' }}>
        <div style={styles.h}>SMB sources</div>
        {!editing && <button style={styles.btn(C.green)} onClick={startNew}>+ Add source</button>}
      </div>

      <p style={{ color: C.muted, fontSize: '0.8rem', marginBottom: '0.75rem' }}>
        Browse a Samba share for <code>.ffpfsc</code> images and push them to the PS5 over FTP.
        MicroMount on the PS5 will then auto-mount them from <code>{syncDest || '/data/homebrew'}</code>.
      </p>

      {editing && (
        <div style={{ ...styles.card, marginBottom: '0.75rem' }}>
          <div style={styles.h2}>{editing === 'new' ? 'New source' : `Edit source #${editing}`}</div>
          <div style={styles.col}>
            <div style={styles.grid2}>
              <div>
                <label style={styles.label}>Name</label>
                <input style={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <label style={styles.label}>Type</label>
                <select style={styles.input} value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                  <option value="smb">SMB / Samba</option>
                  <option value="local">Local PS5 path (note only)</option>
                </select>
              </div>
            </div>
            {form.type === 'smb' ? (
              <>
                <div style={styles.grid2}>
                  <div>
                    <label style={styles.label}>Host / IP</label>
                    <input style={styles.input} value={form.smb_host} onChange={e => setForm({ ...form, smb_host: e.target.value })} placeholder="192.168.1.10" />
                  </div>
                  <div>
                    <label style={styles.label}>Share</label>
                    <input style={styles.input} value={form.smb_share} onChange={e => setForm({ ...form, smb_share: e.target.value })} placeholder="games" />
                  </div>
                  <div>
                    <label style={styles.label}>Sub-path (optional)</label>
                    <input style={styles.input} value={form.path} onChange={e => setForm({ ...form, path: e.target.value })} placeholder="ps5/ffpfsc" />
                  </div>
                  <div>
                    <label style={styles.label}>Domain (optional)</label>
                    <input style={styles.input} value={form.smb_domain} onChange={e => setForm({ ...form, smb_domain: e.target.value })} />
                  </div>
                  <div>
                    <label style={styles.label}>Username</label>
                    <input style={styles.input} value={form.smb_username} onChange={e => setForm({ ...form, smb_username: e.target.value })} placeholder="(blank = anonymous)" />
                  </div>
                  <div>
                    <label style={styles.label}>Password</label>
                    <input type="password" style={styles.input}
                      value={form.smb_password === '__set__' ? '' : form.smb_password}
                      onChange={e => setForm({ ...form, smb_password: e.target.value })}
                      placeholder={form.smb_password === '__set__' ? '(saved)' : ''} />
                  </div>
                </div>
              </>
            ) : (
              <div>
                <label style={styles.label}>PS5 path</label>
                <input style={styles.input} value={form.path} onChange={e => setForm({ ...form, path: e.target.value })} placeholder="/mnt/usb0/homebrew" />
              </div>
            )}
            <div style={styles.row}>
              <button style={styles.btn(C.green)} onClick={save}>Save</button>
              <button style={styles.btn('#666')} onClick={cancel}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {sources.length === 0 && !editing && (
        <div style={{ color: C.muted, fontSize: '0.85rem' }}>No sources yet.</div>
      )}

      <div style={styles.col}>
        {sources.map(s => (
          <div key={s.id} style={styles.card}>
            <div style={{ ...styles.row, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                  <span style={styles.pill(s.type === 'smb' ? 'var(--magenta)' : C.blue)}>{s.type.toUpperCase()}</span>
                  <strong>{s.name}</strong>
                </div>
                <div style={{ fontSize: '0.8rem', color: C.muted, wordBreak: 'break-all' }}>
                  {s.type === 'smb' ? (
                    <>
                      <code>smb://{s.smb_host}/{s.smb_share}{s.path ? `/${s.path}` : ''}</code>
                      {s.smb_username && <> • user: <code>{s.smb_username}</code></>}
                    </>
                  ) : <code>{s.path}</code>}
                </div>
              </div>
              <div style={{ ...styles.row, gap: '0.4rem' }}>
                {s.type === 'smb' && <button style={styles.btn(C.blue, busy)} disabled={busy} onClick={() => test(s.id)}>Test</button>}
                {s.type === 'smb' && <button style={styles.btn('#34495e', busy)} disabled={busy} onClick={() => browse(s, s.path || '')}>Browse</button>}
                {s.type === 'smb' && <button style={styles.btn(C.green, busy)} disabled={busy} onClick={() => sync(s)}>Sync → PS5</button>}
                <button style={styles.btn('#7f8c8d')} onClick={() => startEdit(s)}>Edit</button>
                <button style={styles.btn(C.red)} onClick={() => remove(s.id)}>Delete</button>
              </div>
            </div>

            {browseFor?.id === s.id && (
              <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: C.bg, borderRadius: 6 }}>
                <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <div style={{ fontSize: '0.8rem', color: C.muted }}>
                    Path: <code>/{browseSubPath}</code>
                  </div>
                  <div style={styles.row}>
                    {browseSubPath && <button style={styles.btn('#7f8c8d', busy)} disabled={busy} onClick={goUp}>↑ Up</button>}
                    {browseSubPath && <button style={styles.btn('#7f8c8d', busy)} disabled={busy} onClick={() => browse(s, '')}>⌂ Root</button>}
                    <button style={styles.btn('#7f8c8d', busy)} disabled={busy} onClick={() => browse(s, browseSubPath)}>Refresh</button>
                    <button style={styles.btn('#666')} onClick={() => { setBrowseFor(null); setBrowseFiles([]); }}>Close</button>
                  </div>
                </div>
                {browseFiles.length === 0 ? (
                  <div style={{ color: C.muted, fontSize: '0.85rem' }}>{busy ? 'Loading…' : 'No items.'}</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', maxHeight: 320, overflowY: 'auto' }}>
                    {browseFiles.map((f, idx) => (
                      <div key={idx} style={{ ...styles.row, padding: '0.4rem 0.6rem', background: C.panel2, borderRadius: 4, justifyContent: 'space-between' }}>
                        <div style={{ fontSize: '0.85rem', flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
                          {f.isDir ? '📁 ' : '📄 '}{f.name}
                          {!f.isDir && <span style={{ color: C.muted, marginLeft: 8 }}>{(f.size / (1024 * 1024)).toFixed(1)} MB</span>}
                        </div>
                        {f.isDir && <button style={styles.btn(C.blue, busy)} disabled={busy} onClick={() => enterDir(f.name)}>Open</button>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ ...styles.card, marginTop: '0.75rem' }}>
        <div style={styles.h2}>Sync target</div>
        <div style={styles.grid2}>
          <div>
            <label style={styles.label}>PS5</label>
            <select style={styles.input} value={syncIp} onChange={e => setSyncIp(e.target.value)}>
              <option value="">— select profile —</option>
              {profiles.map(p => <option key={p.id} value={p.ip_address}>{p.name} ({p.ip_address})</option>)}
            </select>
          </div>
          <div>
            <label style={styles.label}>Destination on PS5</label>
            <input style={styles.input} value={syncDest} onChange={e => setSyncDest(e.target.value)} />
          </div>
        </div>
      </div>

      {message && (
        <div style={{
          marginTop: '0.75rem', padding: '0.6rem 0.9rem', borderRadius: 6,
          background: message.type === 'error' ? C.red : C.green,
          color: C.text, fontSize: '0.85rem',
        }}>
          {message.text}
        </div>
      )}
    </section>
  );
}

function ReleaseSection({ onNotification }) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [latestInfo, setLatestInfo] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/micromount/release/status`);
      const d = await r.json();
      setStatus(d);
    } catch (_) {}
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const check = async () => {
    setChecking(true);
    try {
      const r = await fetch(`${API}/micromount/release/check`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setLatestInfo(d);
      onNotification?.(d.update_available
        ? `Update available: ${d.latest_version} (current: ${d.current_version || 'none'})`
        : `Up to date (${d.current_version})`,
        d.update_available ? 'info' : 'success');
      refresh();
    } catch (e) { onNotification?.(`Check failed: ${e.message}`, 'error'); }
    setChecking(false);
  };

  const update = async () => {
    setUpdating(true);
    try {
      const r = await fetch(`${API}/micromount/release/update`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setLatestInfo(d);
      if (d.downloaded) {
        const names = d.downloaded.downloaded.map(f => f.name).join(', ');
        onNotification?.(`Updated to ${d.current_version}: ${names}`, 'success');
      } else {
        onNotification?.(`Already at latest: ${d.current_version}`, 'success');
      }
      refresh();
    } catch (e) { onNotification?.(`Update failed: ${e.message}`, 'error'); }
    setUpdating(false);
  };

  const fmtDate = (s) => s ? new Date(s).toLocaleString() : 'never';

  const updateAvailable = latestInfo?.update_available
    || (status?.version && latestInfo?.latest_version && status.version !== latestInfo.latest_version);

  return (
    <section style={styles.section}>
      <div style={styles.h}>MicroMount release</div>
      <p style={{ color: C.muted, fontSize: '0.8rem', marginBottom: '0.75rem' }}>
        Manually pull new MicroMount releases from{' '}
        <a href="https://github.com/PSBrew/MicroMount/releases" target="_blank" rel="noreferrer"
          style={{ color: C.blue }}>PSBrew/MicroMount</a>{' '}
        and store assets (<code>.elf</code>/<code>.lua</code>/<code>.zip</code>) in the local payloads folder,
        replacing previous versions.
      </p>

      <div style={styles.grid2}>
        <div style={{ ...styles.card, background: C.bg, marginBottom: 0 }}>
          <div style={styles.label}>Current installed</div>
          <div style={{ fontSize: '1.05rem', fontWeight: 600 }}>{status?.version || '— not installed —'}</div>
          {status?.assets?.length > 0 && (
            <div style={{ color: C.muted, fontSize: '0.75rem', marginTop: '0.3rem' }}>
              {status.assets.join(', ')}
            </div>
          )}
          <div style={{ color: C.muted, fontSize: '0.7rem', marginTop: '0.3rem' }}>
            last update: {fmtDate(status?.last_update_at)} · last check: {fmtDate(status?.checked_at)}
          </div>
        </div>
        <div style={{ ...styles.card, background: C.bg, marginBottom: 0 }}>
          <div style={styles.label}>Latest on GitHub</div>
          <div style={{ fontSize: '1.05rem', fontWeight: 600 }}>{latestInfo?.latest_version || (checking ? 'checking…' : '— click Check —')}</div>
          {latestInfo?.assets?.length > 0 && (
            <div style={{ color: C.muted, fontSize: '0.75rem', marginTop: '0.3rem' }}>
              {latestInfo.assets.map(a => a.name).join(', ')}
            </div>
          )}
          {latestInfo?.latest_published_at && (
            <div style={{ color: C.muted, fontSize: '0.7rem', marginTop: '0.3rem' }}>
              published: {fmtDate(latestInfo.latest_published_at)}
            </div>
          )}
        </div>
      </div>

      <div style={{ ...styles.row, marginTop: '0.75rem' }}>
        <button style={styles.btn(C.blue, checking)} disabled={checking} onClick={check}>
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
        <button style={styles.btn(updateAvailable ? C.green : '#7f8c8d', updating)}
          disabled={updating} onClick={update}>
          {updating ? 'Downloading…' : (updateAvailable ? 'Update now' : 'Re-download latest')}
        </button>
        {updateAvailable && (
          <span style={styles.pill(C.accent)}>Update available</span>
        )}
      </div>
    </section>
  );
}

function path_basename(p) {
  if (!p) return '';
  const s = String(p).replace(/[\\/]+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

export function ExtractQueuePanel({ onView }) {
  const [state, setState] = useState({ paused: false, items: [] });

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/micromount/extract/queue`);
      if (r.ok) setState(await r.json());
    } catch (_) {}
  }, []);

  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, [refresh]);

  const post = async (url) => { try { await fetch(url, { method: 'POST' }); refresh(); } catch (_) {} };
  const del = async (id) => { try { const r = await fetch(`${API}/micromount/extract/queue/${id}`, { method: 'DELETE' }); if (!r.ok) throw new Error((await r.json()).error); refresh(); } catch (e) { alert(e.message); } };

  const items = state.items || [];
  if (items.length === 0) return null;

  const queued = items.filter(i => i.status === 'queued');
  const running = items.filter(i => i.status === 'running' || i.status === 'starting');
  const finished = items.filter(i => ['completed', 'failed', 'cancelled'].includes(i.status));

  const statusColor = (s) => {
    if (s === 'completed') return C.green;
    if (s === 'failed') return C.red;
    if (s === 'cancelled') return '#7f8c8d';
    if (s === 'running' || s === 'starting') return C.blue;
    return 'var(--magenta)';
  };

  const Row = ({ item, idx }) => (
    <div style={{ ...styles.row, ...styles.card, marginBottom: 0, justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <div style={{ fontSize: '0.8rem', flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
        <span style={{ color: C.muted, marginRight: 6 }}>{idx != null ? `#${idx + 1}` : ''}</span>
        <strong>{item.archive}</strong> <span style={{ color: C.muted }}>[{item.archive_type}]</span>
        <div style={{ color: C.muted, fontSize: '0.7rem' }}>
          {item.source}{item.dest && <> → {item.dest}</>}
          {item.added_at && <> · added {new Date(item.added_at).toLocaleTimeString()}</>}
          {item.finished_at && <> · finished {new Date(item.finished_at).toLocaleTimeString()}</>}
        </div>
        {item.error && <div style={{ color: C.red, fontSize: '0.7rem' }}>Error: {item.error}</div>}
      </div>
      <span style={styles.pill(statusColor(item.status))}>{item.status}</span>
      <div style={styles.row}>
        {item.status === 'queued' && (
          <>
            <button style={styles.btn('#7f8c8d')} onClick={async () => { await fetch(`${API}/micromount/extract/queue/${item.id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'up' }) }); refresh(); }}>↑</button>
            <button style={styles.btn('#7f8c8d')} onClick={async () => { await fetch(`${API}/micromount/extract/queue/${item.id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'down' }) }); refresh(); }}>↓</button>
            <button style={styles.btn(C.red)} onClick={() => del(item.id)}>Remove</button>
          </>
        )}
        {item.job_id && <button style={styles.btn(C.blue)} onClick={() => onView?.(item.job_id)}>View log</button>}
        {(item.status === 'failed' || item.status === 'cancelled') && (
          <button style={styles.btn(C.green)} onClick={async () => { const r = await fetch(`${API}/micromount/extract/queue/${item.id}/retry`, { method: 'POST' }); if (!r.ok) alert((await r.json()).error); refresh(); }}>Retry</button>
        )}
        {(item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled') && (
          <button style={styles.btn(C.red)} onClick={() => del(item.id)}>Remove</button>
        )}
      </div>
    </div>
  );

  return (
    <section style={styles.section}>
      <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <div style={styles.h}>
          Extract queue
          <span style={{ ...styles.pill(state.paused ? '#7f8c8d' : C.green), marginLeft: '0.5rem' }}>
            {state.paused ? 'paused' : 'running'}
          </span>
          <span style={{ color: C.muted, fontSize: '0.75rem', marginLeft: '0.5rem', fontWeight: 400 }}>
            {running.length} running · {queued.length} queued · {finished.length} done · control Start/Pause from the Queue tab
          </span>
        </div>
      </div>

      {running.length > 0 && (
        <div style={{ marginBottom: '0.6rem' }}>
          <div style={{ ...styles.h2, color: C.blue }}>Running</div>
          <div style={styles.col}>{running.map(i => <Row key={i.id} item={i} />)}</div>
        </div>
      )}
      {queued.length > 0 && (
        <div style={{ marginBottom: '0.6rem' }}>
          <div style={styles.h2}>Queued ({queued.length})</div>
          <div style={styles.col}>{queued.map((i, idx) => <Row key={i.id} item={i} idx={idx} />)}</div>
        </div>
      )}
      {finished.length > 0 && (
        <div>
          <div style={{ ...styles.h2, color: C.muted }}>Finished ({finished.length})</div>
          <div style={styles.col}>{finished.slice(-10).reverse().map(i => <Row key={i.id} item={i} />)}</div>
        </div>
      )}
    </section>
  );
}

function QueuePanel({ state, onRemove, onMove, onRetry, onView }) {
  const items = state?.items || [];
  if (items.length === 0) return null;

  const queued = items.filter(i => i.status === 'queued');
  const running = items.filter(i => i.status === 'running' || i.status === 'starting');
  const finished = items.filter(i => ['completed', 'failed', 'cancelled'].includes(i.status));

  const statusColor = (s) => {
    if (s === 'completed') return C.green;
    if (s === 'failed') return C.red;
    if (s === 'cancelled') return '#7f8c8d';
    if (s === 'running' || s === 'starting') return C.blue;
    return 'var(--magenta)';
  };

  const Row = ({ item, idx }) => (
    <div style={{ ...styles.row, ...styles.card, marginBottom: 0, justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <div style={{ fontSize: '0.8rem', flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
        <span style={{ color: C.muted, marginRight: 6 }}>{idx != null ? `#${idx + 1}` : ''}</span>
        <strong>{item.source_name}</strong>
        <span style={{ color: C.muted }}> → {item.output_name}</span>
        <div style={{ color: C.muted, fontSize: '0.7rem' }}>
          {item.mode}
          {item.added_at && ` · added ${new Date(item.added_at).toLocaleTimeString()}`}
          {item.finished_at && ` · finished ${new Date(item.finished_at).toLocaleTimeString()}`}
        </div>
        {item.error && <div style={{ color: C.red, fontSize: '0.7rem' }}>Error: {item.error}</div>}
      </div>
      <span style={styles.pill(statusColor(item.status))}>{item.status}</span>
      <div style={styles.row}>
        {item.status === 'queued' && (
          <>
            <button style={styles.btn('#7f8c8d')} onClick={() => onMove(item.id, 'up')} title="Move up">↑</button>
            <button style={styles.btn('#7f8c8d')} onClick={() => onMove(item.id, 'down')} title="Move down">↓</button>
            <button style={styles.btn(C.red)} onClick={() => onRemove(item.id)}>Remove</button>
          </>
        )}
        {(item.status === 'running' || item.status === 'starting' || item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled') && item.job_id && (
          <button style={styles.btn(C.blue)} onClick={() => onView(item.job_id)}>View log</button>
        )}
        {(item.status === 'failed' || item.status === 'cancelled') && (
          <button style={styles.btn(C.green)} onClick={() => onRetry(item.id)}>Retry</button>
        )}
        {(item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled') && (
          <button style={styles.btn(C.red)} onClick={() => onRemove(item.id)}>Remove</button>
        )}
      </div>
    </div>
  );

  return (
    <section style={styles.section}>
      <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <div style={styles.h}>
          Queue
          <span style={{ ...styles.pill(state.paused ? '#7f8c8d' : C.green), marginLeft: '0.5rem' }}>
            {state.paused ? 'paused' : 'running'}
          </span>
          <span style={{ color: C.muted, fontSize: '0.75rem', marginLeft: '0.5rem', fontWeight: 400 }}>
            {running.length} running · {queued.length} queued · {finished.length} done · control Start/Pause from the Queue tab
          </span>
        </div>
      </div>

      {running.length > 0 && (
        <div style={{ marginBottom: '0.6rem' }}>
          <div style={{ ...styles.h2, color: C.blue }}>Running</div>
          <div style={styles.col}>
            {running.map(i => <Row key={i.id} item={i} />)}
          </div>
        </div>
      )}

      {queued.length > 0 && (
        <div style={{ marginBottom: '0.6rem' }}>
          <div style={styles.h2}>Queued ({queued.length})</div>
          <div style={styles.col}>
            {queued.map((i, idx) => <Row key={i.id} item={i} idx={idx} />)}
          </div>
        </div>
      )}

      {finished.length > 0 && (
        <div>
          <div style={{ ...styles.h2, color: C.muted }}>Finished ({finished.length})</div>
          <div style={styles.col}>
            {finished.slice(-10).reverse().map(i => <Row key={i.id} item={i} />)}
          </div>
        </div>
      )}
    </section>
  );
}

function ConvertSection({ profiles, onNotification }) {
  const [mkpfsStatus, setMkpfsStatus] = useState(null);
  const [files, setFiles] = useState([]);
  const [sub, setSub] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [sources, setSources] = useState([]);

  // scan path = default local browser path (configured in FileBrowser via "Save as default")
  // when set, Work files section browses that path absolutely instead of just workdir
  const [scanRoot, setScanRoot] = useState('');
  const [scanCurrent, setScanCurrent] = useState('');
  const [scanParent, setScanParent] = useState(null);

  const [folderImportJob, setFolderImportJob] = useState(null);

  const [mode, setMode] = useState('pack-file');
  const [selected, setSelected] = useState('');
  const [outputName, setOutputName] = useState('');
  const [compress, setCompress] = useState(true);
  const [verify, setVerify] = useState(true);
  const [version, setVersion] = useState('PS5');
  const [compressionLevel, setCompressionLevel] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [skipExecComp, setSkipExecComp] = useState(false);
  const [signed, setSigned] = useState(false);
  const [requireGameFiles, setRequireGameFiles] = useState(false);
  const [pushAfter, setPushAfter] = useState(false);
  const [pushIp, setPushIp] = useState('');
  const [pushDest, setPushDest] = useState('/data/homebrew');
  const [deleteSource, setDeleteSource] = useState(false);

  const [job, setJob] = useState(null);
  const [running, setRunning] = useState(false);
  const [recentJobs, setRecentJobs] = useState([]);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/micromount/mkpfs/status`);
      setMkpfsStatus(await r.json());
    } catch (_) { setMkpfsStatus({ installed: false }); }

    let savedScanRoot = '';
    try {
      const r = await fetch(`${API}/micromount/browser-prefs`);
      if (r.ok) {
        const prefs = await r.json();
        savedScanRoot = prefs?.local?.path || '';
        setScanRoot(savedScanRoot);
      }
    } catch (_) {}

    if (savedScanRoot) {
      const target = scanCurrent && scanCurrent.startsWith(savedScanRoot) ? scanCurrent : savedScanRoot;
      try {
        const r = await fetch(`${API}/micromount/local/browse`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: target }),
        });
        const d = await r.json();
        if (r.ok) {
          setWorkdir(d.path);
          setScanCurrent(d.path);
          setScanParent(d.parent || null);
          setFiles(d.files || []);
        } else {
          // fallback: try the saved root again
          const r2 = await fetch(`${API}/micromount/local/browse`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: savedScanRoot }),
          });
          const d2 = await r2.json();
          if (r2.ok) {
            setWorkdir(d2.path); setScanCurrent(d2.path);
            setScanParent(d2.parent || null); setFiles(d2.files || []);
          }
        }
      } catch (_) {}
    } else {
      try {
        const r = await fetch(`${API}/micromount/mkpfs/files?sub=${encodeURIComponent(sub)}`);
        const d = await r.json();
        setWorkdir(d.workdir);
        setFiles(d.files || []);
        setScanCurrent('');
        setScanParent(null);
      } catch (_) {}
    }

    try {
      const r = await fetch(`${API}/micromount/sources`);
      setSources((await r.json()).filter(s => s.type === 'smb'));
    } catch (_) {}
    try {
      const r = await fetch(`${API}/micromount/convert`);
      setRecentJobs(await r.json());
    } catch (_) {}
  }, [sub, scanCurrent]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!pushIp) {
      const p = profiles.find(x => x.is_default) || profiles[0];
      if (p) setPushIp(p.ip_address);
    }
  }, [profiles]);

  useEffect(() => {
    const id = localStorage.getItem('mm.job.convert');
    if (!id) return;
    fetch(`${API}/micromount/convert/${id}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d && d.id) {
          setJob(d);
          if (d.status === 'running' || d.status === 'pushing') setRunning(true);
        } else {
          localStorage.removeItem('mm.job.convert');
        }
      })
      .catch(() => localStorage.removeItem('mm.job.convert'));
  }, []);

  useEffect(() => {
    if (!job) return;
    const isActive = job.status === 'running' || job.status === 'pushing';
    if (isActive) {
      localStorage.setItem('mm.job.convert', job.id);
    } else {
      localStorage.removeItem('mm.job.convert');
    }
    if (!isActive) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${API}/micromount/convert/${job.id}`);
        const d = await r.json();
        setJob(d);
        if (d.status !== 'running' && d.status !== 'pushing') {
          setRunning(false);
          refresh();
          if (d.status === 'completed') onNotification?.('Conversion completed', 'success');
          else if (d.status === 'failed') onNotification?.(`Conversion failed: ${d.error || `exit ${d.exit_code}`}`, 'error');
          else if (d.status === 'push_failed') onNotification?.(`Push failed: ${d.error}`, 'error');
          else if (d.status === 'cancelled') onNotification?.('Conversion cancelled', 'warning');
        }
      } catch (_) {}
    }, 1500);
    return () => clearInterval(t);
  }, [job?.id, job?.status, onNotification, refresh]);

  const goUp = () => {
    if (scanRoot && scanCurrent) {
      // limit traversal to scanRoot when set
      if (scanCurrent === scanRoot || scanParent === null) return;
      if (scanParent && scanParent.startsWith(scanRoot)) setScanCurrent(scanParent);
      else setScanCurrent(scanRoot);
      return;
    }
    const parts = sub.split('/').filter(Boolean);
    parts.pop();
    setSub(parts.join('/'));
  };
  const enter = (name) => {
    if (scanRoot && scanCurrent) {
      const next = scanCurrent.endsWith('/') ? `${scanCurrent}${name}` : `${scanCurrent}/${name}`;
      setScanCurrent(next);
      return;
    }
    setSub(sub ? `${sub}/${name}` : name);
  };

  const deleteFile = async (rel, fullPath, isDir) => {
    const label = scanRoot ? fullPath : rel;
    if (!confirm(`Delete ${label}?`)) return;
    try {
      if (scanRoot) {
        const r = await fetch(`${API}/micromount/local/delete`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: fullPath, isDir: !!isDir }),
        });
        if (!r.ok) throw new Error((await r.json()).error);
      } else {
        await fetch(`${API}/micromount/mkpfs/files?sub=${encodeURIComponent(rel)}`, { method: 'DELETE' });
      }
      refresh();
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const [extractJob, setExtractJob] = useState(null);
  const [extractPwd, setExtractPwd] = useState('');
  const [extractDeleteAfter, setExtractDeleteAfter] = useState(false);

  const startExtractLocal = async (relPath, fullPath, opts = {}) => {
    try {
      const isAbs = !!scanRoot;
      const body = isAbs
        ? { source: 'local-fs', local_path: fullPath, password: extractPwd, delete_archive_after: extractDeleteAfter }
        : { source: 'local', local_path: relPath, password: extractPwd, delete_archive_after: extractDeleteAfter };
      if (extractDeleteAfter && !window.confirm(`Delete source archive after extract?\n${fullPath || relPath}`)) return;
      const url = `${API}/micromount/extract/queue`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onNotification?.(`Extract queued: ${path_basename(fullPath || relPath)}`, 'success');
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  useEffect(() => {
    const id = localStorage.getItem('mm.job.extract');
    if (!id) return;
    fetch(`${API}/micromount/extract/${id}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && d.id) setExtractJob(d); else localStorage.removeItem('mm.job.extract'); })
      .catch(() => localStorage.removeItem('mm.job.extract'));
  }, []);

  useEffect(() => {
    if (!extractJob) return;
    if (extractJob.status === 'running') {
      localStorage.setItem('mm.job.extract', extractJob.id);
    } else {
      localStorage.removeItem('mm.job.extract');
      return;
    }
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${API}/micromount/extract/${extractJob.id}`);
        const d = await r.json();
        setExtractJob(d);
        if (d.status !== 'running') {
          refresh();
          if (d.status === 'completed') onNotification?.('Extracted', 'success');
          else if (d.status === 'failed') onNotification?.(`Extract failed: ${d.error}`, 'error');
        }
      } catch (_) {}
    }, 1500);
    return () => clearInterval(t);
  }, [extractJob?.id, extractJob?.status]);

  useEffect(() => {
    const id = localStorage.getItem('mm.job.folderImport');
    if (!id) return;
    fetch(`${API}/micromount/mkpfs/import-folder-from-smb/${id}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && d.id) setFolderImportJob(d); else localStorage.removeItem('mm.job.folderImport'); })
      .catch(() => localStorage.removeItem('mm.job.folderImport'));
  }, []);

  useEffect(() => {
    if (!folderImportJob) return;
    if (folderImportJob.status === 'running') {
      localStorage.setItem('mm.job.folderImport', folderImportJob.id);
    } else {
      localStorage.removeItem('mm.job.folderImport');
      return;
    }
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${API}/micromount/mkpfs/import-folder-from-smb/${folderImportJob.id}`);
        const d = await r.json();
        setFolderImportJob(d);
        if (d.status !== 'running') {
          refresh();
          if (d.status === 'completed') onNotification?.('Folder imported', 'success');
          else if (d.status === 'failed') onNotification?.(`Import failed: ${d.error}`, 'error');
        }
      } catch (_) {}
    }, 2000);
    return () => clearInterval(t);
  }, [folderImportJob?.id, folderImportJob?.status]);

  const startConvert = async () => {
    if (!selected) return onNotification?.('Pick a source first', 'error');
    setRunning(true);
    try {
      const r = await fetch(`${API}/micromount/convert/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConvertParams()),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onNotification?.(`Queued: ${d.item.source_name} → ${d.item.output_name}`, 'success');
      setSelected('');
      setOutputName('');
    } catch (e) {
      setRunning(false);
      onNotification?.(`Failed to queue: ${e.message}`, 'error');
    }
  };

  const pickItem = (relPath, isDir, name) => {
    setSelected(relPath);
    if (isDir) {
      const safeName = name.replace(/[^A-Za-z0-9_.\-]/g, '_');
      setOutputName(safeName + '.ffpfsc');
      if (mode === 'pack-file') setMode('pack-folder');
    } else {
      setOutputName(name.replace(/\.(exfat|ffpkg|ffpfsc)$/i, '') + '.ffpfsc');
      if (mode !== 'pack-file') setMode('pack-file');
    }
  };

  const cancelJob = async () => {
    if (!job) return;
    await fetch(`${API}/micromount/convert/${job.id}/cancel`, { method: 'POST' });
  };

  const buildConvertParams = () => ({
    mode,
    source_path: selected,
    output_name: outputName || undefined,
    compress, verify, version,
    compression_level: compressionLevel || undefined,
    case_sensitive: caseSensitive,
    skip_executable_compression: skipExecComp,
    signed,
    require_game_files: requireGameFiles,
    push_after: pushAfter,
    push_ip: pushIp,
    push_dest: pushDest,
    delete_source_after: deleteSource,
  });

  const addToQueue = async () => {
    if (!selected) return onNotification?.('Pick a source first', 'error');
    try {
      const r = await fetch(`${API}/micromount/convert/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConvertParams()),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onNotification?.(`Queued: ${d.item.source_name} → ${d.item.output_name}`, 'success');
      setSelected('');
      setOutputName('');
      refreshQueue();
    } catch (e) { onNotification?.(`Add to queue failed: ${e.message}`, 'error'); }
  };

  const [queueState, setQueueState] = useState({ paused: false, items: [] });
  const refreshQueue = useCallback(async () => {
    try {
      const r = await fetch(`${API}/micromount/convert/queue`);
      setQueueState(await r.json());
    } catch (_) {}
  }, []);

  useEffect(() => {
    refreshQueue();
    const t = setInterval(refreshQueue, 2000);
    return () => clearInterval(t);
  }, [refreshQueue]);

  const queueRemove = async (id) => {
    try {
      const r = await fetch(`${API}/micromount/convert/queue/${id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error);
      refreshQueue();
    } catch (e) { onNotification?.(e.message, 'error'); }
  };
  const queueMove = async (id, direction) => {
    try {
      await fetch(`${API}/micromount/convert/queue/${id}/move`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
      refreshQueue();
    } catch (_) {}
  };
  const queueRetry = async (id) => {
    try {
      const r = await fetch(`${API}/micromount/convert/queue/${id}/retry`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json()).error);
      refreshQueue();
    } catch (e) { onNotification?.(e.message, 'error'); }
  };
  const queuePause = async () => {
    await fetch(`${API}/micromount/convert/queue/pause`, { method: 'POST' });
    refreshQueue();
  };
  const queueResume = async () => {
    await fetch(`${API}/micromount/convert/queue/resume`, { method: 'POST' });
    refreshQueue();
  };
  const queueClearPending = async () => {
    if (!window.confirm('Clear all queued items?')) return;
    await fetch(`${API}/micromount/convert/queue/clear`, { method: 'POST' });
    refreshQueue();
  };
  const queueClearFinished = async () => {
    await fetch(`${API}/micromount/convert/queue/clear-finished`, { method: 'POST' });
    refreshQueue();
  };

  const isExfatLike = (n) => /\.(exfat|ffpkg)$/i.test(n);
  const isArchive = (n) => /\.(rar|7z|zip|tar\.gz|tgz|tar|r\d{2}|part\d+\.rar)$/i.test(n);

  return (
    <>
      <section style={styles.section}>
        <div style={{ ...styles.row, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={styles.h}>Converter</div>
          {mkpfsStatus && (
            mkpfsStatus.installed
              ? <span style={styles.pill(C.green)}>mkpfs installed</span>
              : <span style={styles.pill(C.red)}>mkpfs NOT installed (run: pip install mkpfs)</span>
          )}
        </div>
        <p style={{ color: C.muted, fontSize: '0.8rem', marginBottom: '0.5rem' }}>
          Two modes:
        </p>
        <ul style={{ color: C.muted, fontSize: '0.8rem', marginTop: 0, paddingLeft: '1.25rem' }}>
          <li><strong>File → ffpfsc</strong> — pack <code>.exfat</code>/<code>.ffpkg</code> into compressed <code>.ffpfsc</code> (mkpfs).</li>
          <li><strong>Folder → ffpfsc</strong> — pack a game dump folder directly into <code>.ffpfsc</code> (mkpfs).</li>
        </ul>
        <p style={{ color: C.muted, fontSize: '0.75rem' }}>
          Sources live in <code>{workdir || 'data/mkpfs'}</code>. Drop files there manually, or pull from a configured SMB source.
        </p>
      </section>

      <FileBrowser
        profiles={profiles}
        onNotification={onNotification}
        enableExtract enableDelete enablePickConvert
        onExtractStarted={(j) => setExtractJob(j)}
        onImported={() => refresh()}
        onPickConvert={({ path: abs, isDir, name }) => {
          setSelected(abs);
          if (isDir) {
            const safe = name.replace(/[^A-Za-z0-9_.\-]/g, '_');
            setOutputName(safe + '.ffpfsc');
            if (mode === 'pack-file') setMode('pack-folder');
          } else {
            setOutputName(name.replace(/\.(exfat|ffpkg|ffpfsc)$/i, '') + '.ffpfsc');
            if (mode !== 'pack-file') setMode('pack-file');
          }
        }}
        title="Pick file or folder to convert"
        description="Pick a file or folder — output .ffpfsc is written next to the source. Works on local filesystem (incl. SMB-mounted). Use FTP / File browser tab for SMB shares."
      />

      <ExtractLogPanel job={extractJob} />

      <section style={styles.section}>
        <div style={styles.h}>Conversion</div>
        <div style={styles.col}>
          <div>
            <label style={styles.label}>Mode</label>
            <div style={{ ...styles.row, gap: '0.4rem' }}>
              {[
                { id: 'pack-file', label: 'File → ffpfsc' },
                { id: 'pack-folder', label: 'Folder → ffpfsc' },
              ].map(m => (
                <button key={m.id} style={styles.tab(mode === m.id)} onClick={() => {
                  setMode(m.id);
                  if (outputName) {
                    const base = outputName.replace(/\.(exfat|ffpfsc)$/i, '');
                    setOutputName(base + '.ffpfsc');
                  }
                }}>{m.label}</button>
              ))}
            </div>
          </div>

          <div>
            <label style={styles.label}>
              {mode === 'pack-file' ? 'Source file' : 'Source folder'}
              {scanRoot
                ? <span style={{ color: C.muted, fontWeight: 400 }}> · absolute path or relative to work dir</span>
                : <span style={{ color: C.muted, fontWeight: 400 }}> · relative to work dir</span>}
            </label>
            <input style={styles.input} value={selected} onChange={e => setSelected(e.target.value)}
              placeholder={scanRoot
                ? (mode === 'pack-file' ? '/mnt/sda1/.../GAME1234.exfat' : '/mnt/sda1/.../GAME1234/')
                : (mode === 'pack-file' ? 'GAME1234.exfat' : 'GAME1234/')} />
          </div>
          <div>
            <label style={styles.label}>Output filename</label>
            <input style={styles.input} value={outputName} onChange={e => setOutputName(e.target.value)}
              placeholder="GAME1234.ffpfsc" />
          </div>

          <div style={styles.grid2}>
            <label style={{ ...styles.row, fontSize: '0.85rem' }}>
              <input type="checkbox" checked={compress} onChange={e => setCompress(e.target.checked)} /> Compress (PFSC)
            </label>
            <label style={{ ...styles.row, fontSize: '0.85rem' }}>
              <input type="checkbox" checked={verify} onChange={e => setVerify(e.target.checked)} /> Verify after pack
            </label>
            <div>
              <label style={styles.label}>PFS version</label>
              <select style={styles.input} value={version} onChange={e => setVersion(e.target.value)}>
                <option value="PS5">PS5</option>
                <option value="PS4">PS4</option>
              </select>
            </div>
            <div>
              <label style={styles.label}>Compression level (0-9)</label>
              <input type="number" min="0" max="9" style={styles.input} value={compressionLevel} onChange={e => setCompressionLevel(e.target.value)} placeholder="9" />
            </div>
          </div>

          {mode === 'pack-folder' && (
            <div style={styles.grid2}>
              <label style={{ ...styles.row, fontSize: '0.85rem' }}>
                <input type="checkbox" checked={caseSensitive} onChange={e => setCaseSensitive(e.target.checked)} /> Case-sensitive
              </label>
              <label style={{ ...styles.row, fontSize: '0.85rem' }}>
                <input type="checkbox" checked={skipExecComp} onChange={e => setSkipExecComp(e.target.checked)} /> Skip exec compression
              </label>
              <label style={{ ...styles.row, fontSize: '0.85rem' }}>
                <input type="checkbox" checked={signed} onChange={e => setSigned(e.target.checked)} /> Signed (zero EKPFS)
              </label>
              <label style={{ ...styles.row, fontSize: '0.85rem' }}>
                <input type="checkbox" checked={requireGameFiles} onChange={e => setRequireGameFiles(e.target.checked)} /> Require game files
              </label>
            </div>
          )}

          <div style={{ ...styles.card, background: C.bg, marginBottom: 0 }}>
            <label style={{ ...styles.row, fontSize: '0.85rem', marginBottom: '0.5rem' }}>
              <input type="checkbox" checked={pushAfter} onChange={e => setPushAfter(e.target.checked)} /> Push to PS5 via FTP after conversion
            </label>
            {pushAfter && (
              <div style={styles.grid2}>
                <div>
                  <label style={styles.label}>PS5</label>
                  <select style={styles.input} value={pushIp} onChange={e => setPushIp(e.target.value)}>
                    <option value="">— select —</option>
                    {profiles.map(p => <option key={p.id} value={p.ip_address}>{p.name} ({p.ip_address})</option>)}
                  </select>
                </div>
                <div>
                  <label style={styles.label}>Destination on PS5</label>
                  <input style={styles.input} value={pushDest} onChange={e => setPushDest(e.target.value)} />
                </div>
              </div>
            )}
            <label style={{ ...styles.row, fontSize: '0.85rem', marginTop: '0.5rem' }}>
              <input type="checkbox" checked={deleteSource} onChange={e => setDeleteSource(e.target.checked)} /> Delete source after success
            </label>
          </div>

          <div style={styles.row}>
            <button style={styles.btn(C.green, !selected || !mkpfsStatus?.installed)}
              disabled={!selected || !mkpfsStatus?.installed} onClick={startConvert}>
              {mode === 'pack-file' ? '＋ Pack file → Queue' : '＋ Pack folder → Queue'}
            </button>
            {job && (job.status === 'running' || job.status === 'pushing') && (
              <button style={styles.btn(C.red)} onClick={cancelJob}>Cancel</button>
            )}
          </div>
        </div>
      </section>

      <QueuePanel
        state={queueState}
        onRemove={queueRemove}
        onMove={queueMove}
        onRetry={queueRetry}
        onView={async (jobId) => {
          if (!jobId) return;
          const r = await fetch(`${API}/micromount/convert/${jobId}`);
          if (r.ok) setJob(await r.json());
        }}
      />

      <ExtractQueuePanel
        onView={async (jobId) => {
          if (!jobId) return;
          const r = await fetch(`${API}/micromount/extract/${jobId}`);
          if (r.ok) setExtractJob(await r.json());
        }}
      />

      {job && (
        <section style={styles.section}>
          <div style={{ ...styles.row, justifyContent: 'space-between' }}>
            <div style={styles.h}>Job {job.id} {job.mode && <span style={{ ...styles.pill('#34495e'), marginLeft: '0.5rem' }}>{job.mode}</span>}</div>
            <span style={styles.pill(
              job.status === 'completed' ? C.green :
              job.status === 'failed' || job.status === 'push_failed' ? C.red :
              job.status === 'cancelled' ? '#7f8c8d' :
              C.blue
            )}>{job.status}</span>
          </div>
          <div style={{ fontSize: '0.75rem', color: C.muted, wordBreak: 'break-all', marginBottom: '0.5rem' }}>
            <code>{job.command || '(building…)'}</code>
          </div>
          <pre style={{
            background: '#000', color: '#9ee493', padding: '0.75rem', borderRadius: 6,
            fontSize: '0.75rem', maxHeight: 360, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
          }}>{job.log || '(waiting for output…)'}</pre>
        </section>
      )}

      {recentJobs.length > 0 && (
        <section style={styles.section}>
          <div style={styles.h2}>Recent jobs</div>
          <div style={styles.col}>
            {recentJobs.map(j => (
              <div key={j.id} style={{ ...styles.row, ...styles.card, marginBottom: 0, justifyContent: 'space-between' }}>
                <div style={{ fontSize: '0.8rem', flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
                  <strong>{j.output?.split('/').pop() || j.id}</strong>
                  <div style={{ color: C.muted }}>{j.started_at}</div>
                </div>
                <span style={styles.pill(
                  j.status === 'completed' ? C.green :
                  j.status === 'failed' || j.status === 'push_failed' ? C.red :
                  j.status === 'cancelled' ? '#7f8c8d' : C.blue
                )}>{j.status}</span>
                <button style={styles.btn('#7f8c8d')} onClick={async () => {
                  const r = await fetch(`${API}/micromount/convert/${j.id}`);
                  setJob(await r.json());
                }}>View</button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function FtpUploadQueuePanel() {
  const [state, setState] = useState({ paused: false, items: [] });
  const refresh = useCallback(async () => {
    try { const r = await fetch(`${API}/micromount/ftp/upload/queue`); if (r.ok) setState(await r.json()); } catch (_) {}
  }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, [refresh]);
  const post = async (url) => { try { await fetch(url, { method: 'POST' }); refresh(); } catch (_) {} };
  const del = async (id) => { try { await fetch(`${API}/micromount/ftp/upload/queue/${id}`, { method: 'DELETE' }); refresh(); } catch (_) {} };

  const items = state.items || [];
  if (items.length === 0) return null;
  const queued = items.filter(i => i.status === 'queued');
  const running = items.filter(i => i.status === 'running' || i.status === 'starting');
  const finished = items.filter(i => ['completed', 'failed', 'cancelled'].includes(i.status));
  const statusColor = (s) => s === 'completed' ? C.green : s === 'failed' ? C.red : s === 'running' || s === 'starting' ? C.blue : 'var(--magenta)';

  return (
    <section style={styles.section}>
      <div style={{ ...styles.row, justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <div style={styles.h}>
          FTP upload queue
          <span style={{ ...styles.pill(state.paused ? '#7f8c8d' : C.green), marginLeft: '0.5rem' }}>{state.paused ? 'paused' : 'running'}</span>
          <span style={{ color: C.muted, fontSize: '0.75rem', marginLeft: '0.5rem', fontWeight: 400 }}>
            {running.length} running · {queued.length} queued · {finished.length} done · control Start/Pause from the Queue tab
          </span>
        </div>
      </div>
      {[...running, ...queued, ...finished.slice(-10).reverse()].map(i => (
        <div key={i.id} style={{ ...styles.row, ...styles.card, marginBottom: 0, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '0.8rem', flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
            <strong>{i.file_name}</strong>
            <div style={{ color: C.muted, fontSize: '0.7rem' }}>{i.ip} → {i.dest_path}</div>
            {i.error && <div style={{ color: C.red, fontSize: '0.7rem' }}>Error: {i.error}</div>}
          </div>
          <span style={styles.pill(statusColor(i.status))}>{i.status}</span>
          {(i.status === 'completed' || i.status === 'failed') && <button style={styles.btn(C.red)} onClick={() => del(i.id)}>Remove</button>}
        </div>
      ))}
    </section>
  );
}

function BrowserSection({ profiles, onNotification }) {
  const [extractJob, setExtractJob] = useState(null);
  const [refreshFn, setRefreshFn] = useState(null);

  useEffect(() => {
    const id = localStorage.getItem('mm.job.browserExtract');
    if (!id) return;
    fetch(`${API}/micromount/extract/${id}`).then(r => r.ok ? r.json() : null).then(d => {
      if (d && d.id) setExtractJob(d);
      else localStorage.removeItem('mm.job.browserExtract');
    }).catch(() => localStorage.removeItem('mm.job.browserExtract'));
  }, []);

  useEffect(() => {
    if (!extractJob) return;
    if (extractJob.status === 'running') {
      localStorage.setItem('mm.job.browserExtract', extractJob.id);
    } else {
      localStorage.removeItem('mm.job.browserExtract');
      return;
    }
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${API}/micromount/extract/${extractJob.id}`);
        const d = await r.json();
        setExtractJob(d);
        if (d.status !== 'running') {
          if (d.status === 'completed') { onNotification?.('Extracted', 'success'); refreshFn?.(); }
          else if (d.status === 'failed') onNotification?.(`Extract failed: ${d.error}`, 'error');
        }
      } catch (_) {}
    }, 1500);
    return () => clearInterval(t);
  }, [extractJob?.id, extractJob?.status, refreshFn]);

  return (
    <>
      <FileBrowser
        profiles={profiles}
        onNotification={onNotification}
        enableFtp enableExtract enableDelete enableFtpUpload
        onExtractStarted={(job, refresh) => { setExtractJob(job); setRefreshFn(() => refresh); }}
        title="FTP / File browser"
        description="Browse the manager's local filesystem, configured SMB shares, or your PS5 over FTP. Upload local files to PS5 FTP server (target from config)."
      />
      <ExtractQueuePanel onView={async (jobId) => {
        if (!jobId) return;
        const r = await fetch(`${API}/micromount/extract/${jobId}`);
        if (r.ok) setExtractJob(await r.json());
      }} />
      <FtpUploadQueuePanel />
      <ExtractLogPanel job={extractJob} />
    </>
  );
}

export default function MicroMount({ profiles, onNotification }) {
  const [config, setConfig] = useState(null);
  const [ftp, setFtp] = useState({ port: 2121, username: 'anonymous', password: '' });
  const [activeTab, setActiveTab] = useState('convert');
  const [savedAt, setSavedAt] = useState(null);

  const loadConfig = useCallback(async () => {
    try {
      const r = await fetch(`${API}/micromount/config`);
      setConfig(await r.json());
    } catch (e) { onNotification?.(`Load failed: ${e.message}`, 'error'); }
  }, [onNotification]);

  const loadFtp = useCallback(async () => {
    try {
      const r = await fetch(`${API}/micromount/ftp`);
      setFtp(await r.json());
    } catch (_) {}
  }, []);

  useEffect(() => { loadConfig(); loadFtp(); }, [loadConfig, loadFtp]);

  const saveConfig = async () => {
    try {
      const r = await fetch(`${API}/micromount/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      onNotification?.('MicroMount config saved', 'success');
      setSavedAt(new Date());
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const saveFtpHandler = async () => {
    try {
      const r = await fetch(`${API}/micromount/ftp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ftp),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      onNotification?.('FTP saved', 'success');
      loadFtp();
    } catch (e) { onNotification?.(e.message, 'error'); }
  };

  const pushConfig = async (ip) => {
    try {
      await saveConfig();
      const r = await fetch(`${API}/micromount/push-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onNotification?.(d.message || 'Pushed', 'success');
    } catch (e) { onNotification?.(`Push failed: ${e.message}`, 'error'); }
  };

  const testFtp = async (ip) => {
    try {
      const r = await fetch(`${API}/micromount/test-ftp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onNotification?.(`FTP OK (${d.count} entries in /data)`, 'success');
    } catch (e) { onNotification?.(`FTP failed: ${e.message}`, 'error'); }
  };

  const downloadIni = () => {
    window.open(`${API}/micromount/config-ini`, '_blank');
  };

  if (!config) return <div style={{ color: C.muted, padding: '2rem', textAlign: 'center' }}>Loading…</div>;

  const tabs = [
    { id: 'convert', label: '🔄 Convert' },
    { id: 'config', label: '⚙️ Config' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      <div className="flex justify-between items-center">
        <h2 className="font-bold" style={{ fontSize: '1.25rem' }}>Convert & Manage</h2>
      </div>

      <div className="tabs">
        {tabs.map(t => (
          <button
            key={t.id}
            className={`tab-item ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'config' && (
        <>
          <ConfigSection
            config={config} setConfig={setConfig}
            onSave={saveConfig} onPush={pushConfig} onDownload={downloadIni}
            profiles={profiles} ftp={ftp} setFtp={setFtp}
            onSaveFtp={saveFtpHandler} onTestFtp={testFtp}
          />
          <ReleaseSection onNotification={onNotification} />
          <ScanPathsSection config={config} setConfig={setConfig} onSave={saveConfig} />
          <SmbSourcesSection profiles={profiles} ftp={ftp} />
        </>
      )}
      {activeTab === 'convert' && (
        <ConvertSection profiles={profiles} onNotification={onNotification} />
      )}

      {savedAt && (
        <div style={{ color: C.muted, fontSize: '0.75rem', textAlign: 'right' }}>
          Last saved {savedAt.toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
