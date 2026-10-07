import { useCallback, useEffect, useState } from 'react';
import { api, apiSafe } from '../lib/api.js';
import { parseNetworkPath } from '../lib/networkPath.js';

// Standalone source manager used in Settings → Sources. Handles SMB, FTP and
// (note-only) local PS5 paths. The backend `/api/convert/sources*`
// endpoints already cover all three types - this component is purely UI.
function RemoteSourcesSection({ profiles = [] }) {
  const [sources, setSources] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [browseFor, setBrowseFor] = useState(null);
  const [browseFiles, setBrowseFiles] = useState([]);
  const [browseSubPath, setBrowseSubPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  // Windows: a share is opened by its \\server\share address like a folder,
  // so there it is added by that address alone (see the backend's
  // /convert/network-folders) and the SMB source form is not offered.
  const [net, setNet] = useState({ supported: false, folders: [] });
  const [netForm, setNetForm] = useState({ address: '', username: '', password: '' });
  const [netBusy, setNetBusy] = useState(false);
  const [smbAddress, setSmbAddress] = useState('');

  function emptyForm() {
    return {
      name: '', type: 'smb', path: '',
      smb_host: '', smb_share: '', smb_username: '', smb_password: '', smb_domain: '',
      ftp_host: '', ftp_port: 21, ftp_username: '', ftp_password: '',
      enabled: true,
    };
  }

  const load = useCallback(async () => {
    const rows = await apiSafe.get('/convert/sources');
    // Remote Sources now only manages SMB and FTP. Older 'local' rows are
    // hidden from the UI but kept in the DB so existing autoloads keep
    // working until the user explicitly deletes them.
    if (Array.isArray(rows)) setSources(rows.filter(s => s.type === 'smb' || s.type === 'ftp'));
    const n = await apiSafe.get('/convert/network-folders');
    if (n && Array.isArray(n.folders)) setNet(n);
  }, []);

  useEffect(() => { load(); }, [load]);

  const showMsg = (text, type = 'info') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  };

  const startNew = () => { setEditing('new'); setSmbAddress(''); setForm({ ...emptyForm(), type: net.supported ? 'ftp' : 'smb' }); };

  const addNetworkFolder = async () => {
    if (!parseNetworkPath(netForm.address)) {
      return showMsg('Paste the address from Explorer, for example \\\\nas\\games', 'error');
    }
    setNetBusy(true);
    try {
      await api.post('/convert/network-folders', netForm);
      setNetForm({ address: '', username: '', password: '' });
      showMsg('Added - it is now a tab in Files → Local', 'success');
      load();
    } catch (e) { showMsg(e.message, 'error'); }
    setNetBusy(false);
  };

  const removeNetworkFolder = async (id) => {
    await apiSafe.del(`/convert/network-folders/${id}`);
    load();
  };

  // One pasted address fills server, share and folder.
  const onSmbAddress = (text) => {
    setSmbAddress(text);
    const p = parseNetworkPath(text);
    if (p) setForm(f => ({ ...f, smb_host: p.host, smb_share: p.share, path: p.subPath, name: f.name || p.share }));
  };
  const startEdit = (s) => {
    setEditing(s.id);
    setSmbAddress('');
    setForm({
      name: s.name, type: s.type, path: s.path || '',
      smb_host: s.smb_host || '', smb_share: s.smb_share || '',
      smb_username: s.smb_username || '', smb_password: s.smb_password || '',
      smb_domain: s.smb_domain || '',
      ftp_host: s.ftp_host || '', ftp_port: s.ftp_port || 21,
      ftp_username: s.ftp_username || '', ftp_password: s.ftp_password || '',
      enabled: !!s.enabled,
    });
  };
  const cancel = () => { setEditing(null); setForm(emptyForm()); };

  const save = async () => {
    if (!form.name) return showMsg('Name is required', 'error');
    if (form.type === 'smb' && (!form.smb_host || !form.smb_share)) return showMsg('SMB host and share required', 'error');
    if (form.type === 'ftp' && !form.ftp_host) return showMsg('FTP host required', 'error');

    try {
      if (editing === 'new') await api.post('/convert/sources', form);
      else await api.put(`/convert/sources/${editing}`, form);
      showMsg('Saved', 'success');
      cancel();
      load();
    } catch (e) {
      showMsg(e.message, 'error');
    }
  };

  const remove = async (id) => {
    if (!confirm('Delete this source?')) return;
    await apiSafe.del(`/convert/sources/${id}`);
    load();
  };

  const test = async (id) => {
    setBusy(true);
    try {
      const d = await api.post(`/convert/sources/${id}/test`);
      showMsg(d.success ? (d.message || 'Connection OK') : (d.error || 'Failed'), d.success ? 'success' : 'error');
    } catch (e) { showMsg(e.message, 'error'); }
    setBusy(false);
  };

  const browse = async (src, subPath = '') => {
    setBusy(true);
    setBrowseFor(src);
    try {
      let d = await api.post(`/convert/sources/${src.id}/browse`, { subPath });
      if (!d.success && subPath && d.smb_status === 'NT_STATUS_OBJECT_NAME_NOT_FOUND') {
        showMsg(`${d.error}. Falling back to share root.`, 'error');
        d = await api.post(`/convert/sources/${src.id}/browse`, { subPath: '' });
        subPath = '';
      }
      setBrowseSubPath(subPath);
      if (d.success) setBrowseFiles(d.files || []);
      else { setBrowseFiles([]); showMsg(d.error || 'Browse failed', 'error'); }
    } catch (e) { showMsg(e.message, 'error'); setBrowseFiles([]); }
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

  const subCardStyle = {
    background: 'var(--panel2)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: 'var(--space-md)',
  };

  const typeBadgeVariant = (t) => (t === 'smb' ? 'info' : t === 'ftp' ? 'warning' : 'default');
  const renderSourceUri = (s) => {
    if (s.type === 'smb') return `smb://${s.smb_host}/${s.smb_share}${s.path ? `/${s.path}` : ''}`;
    if (s.type === 'ftp') return `ftp://${s.ftp_username ? s.ftp_username + '@' : ''}${s.ftp_host}${s.ftp_port && s.ftp_port !== 21 ? ':' + s.ftp_port : ''}/${s.path || ''}`;
    return s.path;
  };

  return (
    <div className="comp-card">
      <div className="comp-card-header" style={{ flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
        <span className="comp-card-title">🌐 Remote sources</span>
        {!editing && (
          <button className="btn btn-success btn-sm" onClick={startNew}>＋ Add source</button>
        )}
      </div>

      <div className="comp-card-body flex-col gap-md">
        {net.supported && (
          <div style={subCardStyle} className="flex-col gap-sm">
            <div className="text-sm" style={{ fontWeight: 500 }}>📂 Network folder</div>
            <p className="text-xs text-muted" style={{ margin: 0 }}>
              A folder on another computer or a NAS. Open it in Explorer, copy the
              address from the address bar and paste it here. It then shows up as a
              tab in <strong>Files → Local</strong> and works like any folder.
            </p>
            <input
              className="input"
              value={netForm.address}
              onChange={e => setNetForm({ ...netForm, address: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') addNetworkFolder(); }}
              placeholder={'\\\\nas\\games\\ps5'}
            />
            <div className="grid-2">
              <div>
                <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Name (only if it asks for one)</label>
                <input className="input" value={netForm.username} onChange={e => setNetForm({ ...netForm, username: e.target.value })} autoComplete="off" />
              </div>
              <div>
                <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Password</label>
                <input className="input" type="password" value={netForm.password} onChange={e => setNetForm({ ...netForm, password: e.target.value })} autoComplete="new-password" />
              </div>
            </div>
            <div className="flex gap-sm items-center flex-wrap">
              <button className="btn btn-success btn-sm" disabled={netBusy || !netForm.address.trim()} onClick={addNetworkFolder}>
                {netBusy ? 'Connecting…' : '＋ Add folder'}
              </button>
              <span className="text-xs text-muted">Windows keeps the sign-in; the password is not stored by P5 Manager.</span>
            </div>
            {net.folders.map(f => (
              <div key={f.id} className="flex justify-between items-center gap-sm flex-wrap">
                <div className="text-sm" style={{ minWidth: 0, wordBreak: 'break-all' }}>
                  🌐 <strong>{f.name}</strong> <code className="text-xs text-muted">{f.path.replace(/\//g, '\\')}</code>
                </div>
                <button className="btn btn-danger btn-sm" onClick={() => removeNetworkFolder(f.id)}>Remove</button>
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-muted" style={{ margin: 0 }}>
          {net.supported
            ? <>FTP servers to browse in the <strong>Files</strong> tab under Remote.</>
            : <>SMB shares and FTP servers. They show up in the <strong>Files</strong> tab
              under Remote, where you can browse them and push files to the PS5 over FTP.</>}
        </p>

        {editing && (
          <div style={subCardStyle} className="flex-col gap-md">
            <div className="text-sm" style={{ fontWeight: 500 }}>
              {editing === 'new' ? 'New source' : `Edit source #${editing}`}
            </div>
            <div className="grid-2">
              <div>
                <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Name</label>
                <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="My NAS / seedbox" />
              </div>
              <div>
                <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Type</label>
                <select className="select" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                  {!net.supported && <option value="smb">SMB / Samba</option>}
                  <option value="ftp">FTP</option>
                </select>
              </div>
            </div>
            {form.type === 'smb' && (
              <div className="grid-2">
                <div className="col-span-2">
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Address - paste it and the fields below fill in</label>
                  <input className="input" value={smbAddress} onChange={e => onSmbAddress(e.target.value)} placeholder={'\\\\nas\\games\\ps5  or  smb://nas/games/ps5'} />
                </div>
                <div>
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Host / IP</label>
                  <input className="input" value={form.smb_host} onChange={e => setForm({ ...form, smb_host: e.target.value })} placeholder="192.168.1.10" />
                </div>
                <div>
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Share</label>
                  <input className="input" value={form.smb_share} onChange={e => setForm({ ...form, smb_share: e.target.value })} placeholder="games" />
                </div>
                <div>
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Sub-path (optional)</label>
                  <input className="input" value={form.path} onChange={e => setForm({ ...form, path: e.target.value })} placeholder="ps5/ffpfsc" />
                </div>
                <div>
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Domain (optional)</label>
                  <input className="input" value={form.smb_domain} onChange={e => setForm({ ...form, smb_domain: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Username</label>
                  <input className="input" value={form.smb_username} onChange={e => setForm({ ...form, smb_username: e.target.value })} placeholder="(blank = anonymous)" />
                </div>
                <div>
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Password</label>
                  <input
                    type="password"
                    className="input"
                    value={form.smb_password === '__set__' ? '' : form.smb_password}
                    onChange={e => setForm({ ...form, smb_password: e.target.value })}
                    placeholder={form.smb_password === '__set__' ? '(saved)' : ''}
                  />
                </div>
              </div>
            )}
            {form.type === 'ftp' && (
              <div className="grid-2">
                <div>
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Host / IP</label>
                  <input className="input" value={form.ftp_host} onChange={e => setForm({ ...form, ftp_host: e.target.value })} placeholder="192.168.1.20" />
                </div>
                <div>
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Port</label>
                  <input className="input" type="number" value={form.ftp_port} onChange={e => setForm({ ...form, ftp_port: parseInt(e.target.value) || 21 })} placeholder="21" />
                </div>
                <div>
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Username</label>
                  <input className="input" value={form.ftp_username} onChange={e => setForm({ ...form, ftp_username: e.target.value })} placeholder="(blank = anonymous)" />
                </div>
                <div>
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Password</label>
                  <input
                    type="password"
                    className="input"
                    value={form.ftp_password === '__set__' ? '' : form.ftp_password}
                    onChange={e => setForm({ ...form, ftp_password: e.target.value })}
                    placeholder={form.ftp_password === '__set__' ? '(saved)' : ''}
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-xs text-muted mb-sm" style={{ display: 'block' }}>Sub-path (optional)</label>
                  <input className="input" value={form.path} onChange={e => setForm({ ...form, path: e.target.value })} placeholder="ffpfsc" />
                </div>
              </div>
            )}
            <div className="flex gap-sm flex-wrap">
              <button className="btn btn-success btn-sm" onClick={save}>💾 Save</button>
              <button className="btn btn-ghost btn-sm" onClick={cancel}>Cancel</button>
            </div>
          </div>
        )}

        {sources.filter(s => !(net.supported && s.type === 'smb')).length === 0 && !editing && !net.supported && (
          <div className="text-sm text-muted">No sources yet. Click ＋ Add source to create one.</div>
        )}

        <div className="flex-col gap-sm">
          {sources.filter(s => !(net.supported && s.type === 'smb')).map(s => (
            <div key={s.id} style={subCardStyle} className="flex-col gap-sm">
              <div className="flex justify-between items-start flex-wrap gap-sm">
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div className="flex items-center gap-sm mb-sm flex-wrap">
                    <span className={`badge badge-${typeBadgeVariant(s.type)}`}>{(s.type || '').toUpperCase()}</span>
                    <strong>{s.name}</strong>
                  </div>
                  <div className="text-xs text-muted" style={{ wordBreak: 'break-all' }}>
                    <code>{renderSourceUri(s)}</code>
                    {s.type === 'smb' && s.smb_username && <> · user: <code>{s.smb_username}</code></>}
                  </div>
                </div>
                <div className="flex gap-sm flex-wrap">
                  {(s.type === 'smb' || s.type === 'ftp') && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => test(s.id)}>Test</button>}
                  {(s.type === 'smb' || s.type === 'ftp') && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => browse(s, s.path || '')}>Browse</button>}
                  <button className="btn btn-ghost btn-sm" onClick={() => startEdit(s)}>Edit</button>
                  <button className="btn btn-danger btn-sm" onClick={() => remove(s.id)}>Delete</button>
                </div>
              </div>

              {browseFor?.id === s.id && (
                <div
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 'var(--space-md)',
                  }}
                  className="flex-col gap-sm"
                >
                  <div className="flex justify-between items-center flex-wrap gap-sm">
                    <div className="text-xs text-muted" style={{ wordBreak: 'break-all' }}>
                      Path: <code>/{browseSubPath}</code>
                    </div>
                    <div className="flex gap-sm flex-wrap">
                      {browseSubPath && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={goUp}>↑ Up</button>}
                      {browseSubPath && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => browse(s, '')}>⌂ Root</button>}
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => browse(s, browseSubPath)}>↻ Refresh</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => { setBrowseFor(null); setBrowseFiles([]); }}>✕ Close</button>
                    </div>
                  </div>
                  {browseFiles.length === 0 ? (
                    <div className="text-sm text-muted">{busy ? 'Loading…' : 'No items.'}</div>
                  ) : (
                    <div className="flex-col" style={{ gap: 4, maxHeight: 320, overflowY: 'auto' }}>
                      {browseFiles.map((f, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between"
                          style={{
                            padding: '6px 10px',
                            background: 'var(--panel2)',
                            borderRadius: 6,
                          }}
                        >
                          <div className="text-sm" style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
                            {f.isDir ? '📁 ' : '📄 '}{f.name}
                            {!f.isDir && <span className="text-muted text-xs" style={{ marginLeft: 8 }}>{(f.size / (1024 * 1024)).toFixed(1)} MB</span>}
                          </div>
                          {f.isDir && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => enterDir(f.name)}>Open</button>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {message && (
          <div
            className={`badge badge-${message.type === 'error' ? 'danger' : 'success'}`}
            style={{ alignSelf: 'flex-start' }}
          >
            {message.text}
          </div>
        )}
      </div>
    </div>
  );
}

export default RemoteSourcesSection;
