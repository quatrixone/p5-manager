import { useState, useEffect, useRef } from 'react';
import Modal from './UI/Modal';
import Badge from './UI/Badge';
import RemoteSourcesSection from './RemoteSourcesSection';
import { api, apiSafe, putSetting } from '../lib/api.js';

// Same defaults as backend/src/lib/ftpPort.js.
const defaultFtpPort = (consoleType) => (consoleType === 'ps4' ? 2121 : 2120);

function Settings({ profiles, onProfileCreate, onProfileUpdate, onProfileDelete, onProfileSetDefault }) {
  const [activeTab, setActiveTab] = useState('profiles');
  const [backupStatus, setBackupStatus] = useState('');
  const [restoreFile, setRestoreFile] = useState(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [editingProfile, setEditingProfile] = useState(null);
  // `consoleType` is null = "auto-detect via the Remote Play service's /discover on next
  // status poll" (default for newly-added profiles); explicit 'ps4' / 'ps5'
  // is the manual override. The status route already auto-fills it when
  // discovery succeeds, so leaving this blank is usually fine.
  // ftpPort: '' = the default for the console type (see defaultFtpPort).
  const [profileForm, setProfileForm] = useState({ name: '', ip: '', mac: '', consoleType: '', ftpPort: '' });
  const [scanning, setScanning] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState([]);
  // null until a search ran; then whether it came back empty, which is when
  // the "which network" field is offered.
  const [scanEmpty, setScanEmpty] = useState(false);
  // Network to search when the automatic one found nothing (a console on
  // another network, or the app in a bridged container). Only offered in
  // the "No console found" card; consoles are otherwise found without it.
  const [defaultSubnet, setDefaultSubnet] = useState('');
  // Default destination for the Convert-tab "Auto-upload .ffpfsc to PS5 FTP"
  // checkbox. Moved here from the per-job UI so users configure once and
  // every conversion picks the same target. Empty IP = fall back to the
  // current default profile at submit time (legacy behaviour).
  const [uploadTargetIp, setUploadTargetIp] = useState('');
  const [uploadTargetPath, setUploadTargetPath] = useState('/data/homebrew');
  // PKG installer settings. The install queue stages .pkg files to
  // `pkg_stage_dir` on the PS5 via FTP, drops a trigger file with the path
  // at `pkg_trigger_file`, then sends `pkg_installer_payload_id` over the
  // ELF loader port — that payload (user-supplied for now; build instructions
  // in p5managerclient/pkg-install/) reads the trigger file and calls
  // sceAppInstUtilInstallByPackage.
  const [pkgInstallerPayloadId, setPkgInstallerPayloadId] = useState('');
  const [pkgStageDir, setPkgStageDir] = useState('/data/pkg-stage');
  const [pkgTriggerFile, setPkgTriggerFile] = useState('/data/.p5manager-install');
  const [availablePayloads, setAvailablePayloads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState('');

  useEffect(() => {
    (async () => {
      const data = await apiSafe.get('/settings');
      if (data) {
        if (data.default_subnet) setDefaultSubnet(data.default_subnet);
        if (data.upload_target_ip !== undefined) setUploadTargetIp(data.upload_target_ip || '');
        if (data.upload_target_path) setUploadTargetPath(data.upload_target_path);
        if (data.pkg_installer_payload_id) setPkgInstallerPayloadId(String(data.pkg_installer_payload_id));
        if (data.pkg_stage_dir) setPkgStageDir(data.pkg_stage_dir);
        if (data.pkg_trigger_file) setPkgTriggerFile(data.pkg_trigger_file);
      }
      // Auto-bind the PKG installer to the payload literally named
      // `pkg-install.elf` instead of making the user pick it from a
      // dropdown — there's only ever one correct choice (sendInstallerPayload
      // only works with .elf on port 9021), so a manual picker was just an
      // extra step that could be pointed at the wrong file.
      const list = await apiSafe.get('/payloads');
      if (Array.isArray(list)) {
        const elfs = list.filter(p => /\.elf$/i.test(p.name || ''));
        setAvailablePayloads(elfs);
        const installer = elfs.find(p => (p.name || '').toLowerCase() === 'pkg-install.elf');
        if (installer) setPkgInstallerPayloadId(String(installer.id));
      }
    })();
  }, []);

  // Generic helper for the "save N settings keys + flash a status banner"
  // pattern. Centralised so the three save buttons below don't each carry
  // their own setLoading / try-catch / setTimeout boilerplate.
  const saveSettingsKeys = async (entries, successMsg) => {
    setLoading(true);
    setMessage('');
    try {
      for (const [key, value] of entries) await putSetting(key, value);
      setMessage(successMsg);
    } catch (err) {
      setMessage('Failed to save: ' + err.message);
    }
    setLoading(false);
    setTimeout(() => setMessage(''), 3000);
  };

  const saveUploadTarget = () => saveSettingsKeys([
    ['upload_target_ip', uploadTargetIp],
    ['upload_target_path', uploadTargetPath],
  ], 'Upload target saved!');

  // Three keys in one button so the user always saves a consistent install
  // setup: empty payload id is allowed (clears the binding so the install
  // queue errors out cleanly with "no installer configured" instead of
  // silently failing on /api/payloads/<old-id>).
  const savePkgInstaller = () => saveSettingsKeys([
    ['pkg_installer_payload_id', pkgInstallerPayloadId],
    ['pkg_stage_dir', pkgStageDir],
    ['pkg_trigger_file', pkgTriggerFile],
  ], 'PKG installer saved!');

  // One search, nothing to fill in: the backend works out this machine's
  // networks itself and asks every address plus the broadcast. `subnet` is
  // only passed from the fallback field shown after an empty search.
  const findConsoles = async (subnet) => {
    setScanning(true);
    setScanEmpty(false);
    setDiscoveredDevices([]);
    setMessage('');
    try {
      const q = subnet ? `?subnet=${encodeURIComponent(subnet)}` : '';
      const data = await api.get(`/ps5control/find${q}`);
      if (data?.success && Array.isArray(data.devices)) {
        setDiscoveredDevices(data.devices);
        setScanEmpty(data.devices.length === 0);
      } else {
        setMessage(data?.error || 'Search failed');
      }
    } catch (err) {
      setMessage('Search failed: ' + (err?.data?.error || err.message));
    }
    setScanning(false);
  };

  // First visit with no console yet: look right away instead of waiting for
  // a click. The short delay lets the profile list arrive first, so a page
  // opened straight on Settings does not search for consoles it already has.
  const autoSearched = useRef(false);
  useEffect(() => {
    if (autoSearched.current || activeTab !== 'profiles' || profiles.length > 0) return undefined;
    const timer = setTimeout(() => { autoSearched.current = true; findConsoles(); }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, profiles.length]);

  const handleAddDiscovered = async (device) => {
    const name = device.name || `${device.type || 'PS5'}-${device.ip?.split('.').pop()}`;
    const ip = device.ip || device.hostId;
    let mac = '';
    // Touch the host once so the kernel ARP cache has a fresh entry, then
    // read it back from /arp. Both calls are best-effort — we still create
    // the profile even if MAC lookup fails (user can fill it later).
    await apiSafe.get(`/ps5control/scan?host=${ip}&timeout=2`);
    await new Promise(resolve => setTimeout(resolve, 500));
    const arpData = await apiSafe.get(`/ps5control/arp?ip=${ip}`);
    if (arpData?.mac) mac = arpData.mac;
    // Pass the discovered console type so the new profile is correctly
    // typed (PS4 vs PS5) from the start — used by /ps5/status to pick
    // the right reachability probe.
    const consoleType = (device.type || '').toLowerCase() === 'ps4' ? 'ps4'
      : (device.type || '').toLowerCase() === 'ps5' ? 'ps5'
      : null;
    onProfileCreate(name, ip, mac, consoleType);
  };

  const openAddProfile = () => {
    setEditingProfile(null);
    setProfileForm({ name: '', ip: '', mac: '', consoleType: '', ftpPort: '' });
    setShowProfileModal(true);
  };

  const openEditProfile = (profile) => {
    setEditingProfile(profile);
    setProfileForm({
      name: profile.name,
      ip: profile.ip_address,
      mac: profile.mac_address || '',
      consoleType: profile.console_type || '',
      ftpPort: profile.ftp_port ? String(profile.ftp_port) : '',
    });
    setShowProfileModal(true);
  };

  const handleSaveProfile = () => {
    // Empty string from the <select> becomes null at the backend = auto-detect.
    const consoleType = profileForm.consoleType || null;
    if (editingProfile) {
      onProfileUpdate(editingProfile.id, profileForm.name, profileForm.ip, profileForm.mac, consoleType, profileForm.ftpPort);
    } else {
      onProfileCreate(profileForm.name, profileForm.ip, profileForm.mac, consoleType, profileForm.ftpPort);
    }
    setShowProfileModal(false);
  };

  const handleBackup = async () => {
    try {
      setBackupStatus('Creating backup...');
      const res = await api.raw('/backup');
      if (!res.ok) throw new Error('Backup failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `backup-${new Date().toISOString().split('T')[0]}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupStatus('Backup created successfully!');
      setTimeout(() => setBackupStatus(''), 3000);
    } catch (err) {
      setBackupStatus('Backup failed: ' + err.message);
    }
  };

  const handleRestore = async () => {
    if (!restoreFile) return;
    try {
      setBackupStatus('Restoring...');
      const arrayBuffer = await restoreFile.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
      await api.post('/backup', { zip: base64 });
      setBackupStatus('Restore completed!');
      setTimeout(() => setBackupStatus(''), 3000);
    } catch (err) {
      setBackupStatus('Restore failed: ' + err.message);
    }
  };

  const renderProfiles = () => (
    <div>
      <div className="flex justify-between items-center mb-md">
        <h2 className="font-bold" style={{ fontSize: '1.25rem' }}>Profiles</h2>
        <button className="btn btn-primary" onClick={openAddProfile}>+ Add</button>
      </div>

      {profiles.length === 0 && discoveredDevices.length === 0 && !scanEmpty && (
        <div className="comp-card mb-md" style={{ borderLeft: '3px solid var(--blue)' }}>
          <div className="comp-card-header">
            <span className="comp-card-title">🚀 Add your console</span>
          </div>
          <div className="comp-card-body flex-col gap-sm">
            <div className="text-sm">
              Switch the PS4 / PS5 on (rest mode is fine) on the same network as this computer.
              The app looks for it by itself.
            </div>
            <div className="flex gap-sm items-center flex-wrap">
              <button className="btn btn-primary" onClick={() => findConsoles()} disabled={scanning}>
                {scanning ? '⏳ Looking for consoles…' : '🔍 Find consoles'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={openAddProfile}>
                or add manually
              </button>
            </div>
            {message && <div className="text-sm" style={{ color: 'var(--red)' }}>{message}</div>}
          </div>
        </div>
      )}

      {scanEmpty && (
        <div className="comp-card mb-md" style={{ borderLeft: '3px solid var(--yellow, var(--blue))' }}>
          <div className="comp-card-header">
            <span className="comp-card-title">No console found</span>
          </div>
          <div className="comp-card-body flex-col gap-sm">
            <div className="text-sm">
              Check that the console is switched on or in rest mode and connected to the same network, then look again.
              If it sits on another network, enter that network here.
            </div>
            <div className="flex gap-sm items-center flex-wrap">
              <input
                className="input"
                type="text"
                placeholder="192.168.1.0/24"
                value={defaultSubnet}
                onChange={e => setDefaultSubnet(e.target.value)}
                onBlur={() => putSetting('default_subnet', defaultSubnet).catch(() => {})}
                style={{ maxWidth: 190 }}
                aria-label="Network to search"
              />
              <button className="btn btn-primary" onClick={() => findConsoles(defaultSubnet)} disabled={scanning}>
                {scanning ? '⏳ Looking…' : '🔍 Look again'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={openAddProfile}>add manually</button>
            </div>
          </div>
        </div>
      )}

      {discoveredDevices.length > 0 && (
        <div className="comp-card mb-md">
          <div className="comp-card-header">
            <span className="comp-card-title">🔍 Found on your network</span>
          </div>
          <div className="comp-card-body">
            {discoveredDevices.map((device, idx) => {
              const added = device.profile || profiles.find(p => p.ip_address === device.ip)?.name;
              return (
                <div key={idx} className="list-item">
                  <span style={{ fontSize: '1.5rem' }}>🎮</span>
                  <div className="list-item-content">
                    <div className="list-item-title">{device.name}</div>
                    <div className="list-item-subtitle">
                      {device.type} • {device.ip} • {device.state === 'standby' ? 'rest mode' : device.state === 'ready' ? 'on' : device.state}
                    </div>
                  </div>
                  {added
                    ? <span className="text-xs text-muted">✓ Added{added !== device.name ? ` as ${added}` : ''}</span>
                    : <button className="btn btn-sm btn-success" onClick={() => handleAddDiscovered(device)}>+ Add</button>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(profiles.length > 0 || discoveredDevices.length > 0) && (
        <div className="flex gap-sm mb-sm flex-wrap items-center">
          <button className="btn btn-secondary" onClick={() => findConsoles()} disabled={scanning}>
            {scanning ? '⏳ Looking for consoles…' : '🔍 Find consoles'}
          </button>
          {message && <span className="text-xs" style={{ color: 'var(--red)' }}>{message}</span>}
        </div>
      )}

      <div className="flex-col gap-sm">
        {profiles.map(profile => (
          <div key={profile.id} className="comp-card" style={{ borderLeft: profile.is_default ? '3px solid var(--green)' : '3px solid transparent' }}>
            <div className="flex items-center gap-md p-md">
              <span style={{ fontSize: '2rem' }}>🎮</span>
              <div className="flex-1" style={{ minWidth: 0 }}>
                <div className="flex items-center gap-sm">
                  <span className="list-item-title">{profile.name}</span>
                  {!!profile.is_default && <Badge variant="success">Default</Badge>}
                  {profile.console_type && (
                    <span className="console-type-badge" title="Console type stored on this profile">
                      {profile.console_type.toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="list-item-subtitle">{profile.ip_address} · FTP {profile.ftp_port || defaultFtpPort(profile.console_type)}</div>
                {profile.mac_address && <div className="text-xs text-muted">MAC: {profile.mac_address}</div>}
              </div>
              <div className="flex gap-sm">
                {!profile.is_default && (
                  <button className="btn btn-sm btn-ghost" onClick={() => onProfileSetDefault(profile.id)}>⭐</button>
                )}
                <button className="btn btn-sm btn-secondary" onClick={() => openEditProfile(profile)}>Edit</button>
                <button className="btn btn-sm btn-danger" onClick={() => onProfileDelete(profile.id)}>🗑</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // The backend exits and Docker's restart policy brings it back; we poll
  // /health until started_at changes, then reload so the UI re-syncs.
  const restartApp = async () => {
    if (!window.confirm('Restart the app? Running jobs are interrupted and go back to the queue.')) return;
    setRestarting(true);
    setRestartMessage('');
    const before = (await apiSafe.get('/health'))?.started_at;
    try {
      await api.post('/settings/restart');
    } catch (e) {
      setRestarting(false);
      setRestartMessage(`Failed to restart: ${e.message}`);
      return;
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
      const h = await apiSafe.get('/health');
      if (h?.started_at && h.started_at !== before) {
        window.location.reload();
        return;
      }
    }
    setRestarting(false);
    setRestartMessage('Failed: the app did not come back within 60 s. Check the container.');
  };

  const renderBackup = () => (
    <div>
      <h2 className="font-bold mb-md" style={{ fontSize: '1.25rem' }}>Backup & Restore</h2>

      <div className="comp-card mb-md">
        <div className="comp-card-body">
          <div className="flex items-center gap-md mb-md">
            <span style={{ fontSize: '3rem' }}>💾</span>
            <div className="flex-1">
              <div className="font-bold">Backup</div>
              <div className="text-sm text-muted">Download all profiles, payloads, and settings</div>
            </div>
          </div>
          <button className="btn btn-success btn-block" onClick={handleBackup}>📥 Download Backup</button>
        </div>
      </div>

      <div className="comp-card">
        <div className="comp-card-body">
          <div className="flex items-center gap-md mb-md">
            <span style={{ fontSize: '3rem' }}>📤</span>
            <div className="flex-1">
              <div className="font-bold">Restore</div>
              <div className="text-sm text-muted">Upload a backup ZIP to restore all data</div>
            </div>
          </div>
          <label className="btn btn-secondary btn-block" style={{ cursor: 'pointer' }}>
            📁 Select Backup File
            <input type="file" accept=".zip" onChange={e => setRestoreFile(e.target.files[0])} style={{ display: 'none' }} />
          </label>
          {restoreFile && (
            <div className="mt-sm text-sm text-muted">Selected: {restoreFile.name}</div>
          )}
          <button className="btn btn-primary btn-block mt-sm" onClick={handleRestore} disabled={!restoreFile}>
            Restore
          </button>
        </div>
      </div>

      {backupStatus && (
        <div className={`mt-md p-md ${backupStatus.includes('failed') ? 'badge-danger' : 'badge-success'}`} style={{ borderRadius: 8 }}>
          {backupStatus}
        </div>
      )}
    </div>
  );

  const renderConfig = () => (
    <div className="flex-col gap-md">
      <h2 className="font-bold" style={{ fontSize: '1.25rem' }}>Configuration</h2>

      <div className="comp-card">
        <div className="comp-card-body">
          <div className="font-bold mb-sm">Where files are sent on the console</div>
          <div className="text-xs text-muted mb-md">
            The console and the folder on it that <strong>Upload to console</strong> in Files and the
            automatic upload after a conversion use. Files travel over the console's FTP server,
            which P5 Manager starts by itself when it is needed.
          </div>
          <div className="mb-md">
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Console</label>
            <select
              className="select"
              value={uploadTargetIp}
              onChange={e => setUploadTargetIp(e.target.value)}
              style={{ maxWidth: 320 }}
            >
              <option value="">— the console selected at the top —</option>
              {profiles.map(p => (
                <option key={p.id} value={p.ip_address}>{p.name} ({p.ip_address})</option>
              ))}
            </select>
          </div>
          <div className="mb-md">
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Folder on the console</label>
            <input
              className="input"
              type="text"
              value={uploadTargetPath}
              onChange={e => setUploadTargetPath(e.target.value)}
              placeholder="/data/homebrew"
              style={{ maxWidth: 320 }}
            />
          </div>
          <button className="btn btn-primary" onClick={saveUploadTarget} disabled={loading}>
            {loading ? '⏳ Saving...' : '💾 Save'}
          </button>
        </div>
      </div>

      <div className="comp-card">
        <div className="comp-card-body">
          <div className="font-bold mb-sm">Installing .pkg files (PS5)</div>
          <div className="text-xs text-muted mb-md">
            <strong>Install</strong> in Files copies the .pkg to the console and then sends a small
            payload, <code>pkg-install.elf</code>, that installs it there. It comes with P5 Manager;
            the two paths below rarely need changing.
          </div>
          <div className="mb-md">
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Installer payload</label>
            {pkgInstallerPayloadId ? (
              <div className="text-sm">
                ✅ <code>pkg-install.elf</code> is in the payload library
              </div>
            ) : (
              <div className="text-xs text-muted">
                <code>pkg-install.elf</code> is missing from the payload library. Restart P5 Manager to get it back, or upload it in the Payloads tab.
              </div>
            )}
          </div>
          <div className="mb-md">
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Folder on the console the .pkg is copied to</label>
            <input
              className="input"
              type="text"
              value={pkgStageDir}
              onChange={e => setPkgStageDir(e.target.value)}
              placeholder="/data/pkg-stage"
              style={{ maxWidth: 420 }}
            />
          </div>
          <div className="mb-md">
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>File that tells the payload what to install</label>
            <input
              className="input"
              type="text"
              value={pkgTriggerFile}
              onChange={e => setPkgTriggerFile(e.target.value)}
              placeholder="/data/.p5manager-install"
              style={{ maxWidth: 420 }}
            />
          </div>
          <button className="btn btn-primary" onClick={savePkgInstaller} disabled={loading}>
            {loading ? '⏳ Saving...' : '💾 Save'}
          </button>
        </div>
      </div>

      <RemoteSourcesSection profiles={profiles} />

      <div className="comp-card">
        <div className="comp-card-body">
          <div className="font-bold mb-sm">Restart app</div>
          <div className="text-xs text-muted mb-md">
            Restarts the P5 Manager backend. Running jobs are interrupted and return to the queue;
            the page reloads once the app is back.
          </div>
          <button className="btn btn-danger" onClick={restartApp} disabled={restarting}>
            {restarting ? '⏳ Restarting...' : '🔄 Restart app'}
          </button>
          {restartMessage && <div className="mt-sm text-sm" style={{ color: 'var(--red)' }}>{restartMessage}</div>}
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <div className="tabs mb-md">
        <button className={`tab-item ${activeTab === 'profiles' ? 'active' : ''}`} onClick={() => setActiveTab('profiles')}>
          🎮 Profiles
        </button>
        <button className={`tab-item ${activeTab === 'backup' ? 'active' : ''}`} onClick={() => setActiveTab('backup')}>
          💾 Backup
        </button>
        <button className={`tab-item ${activeTab === 'config' ? 'active' : ''}`} onClick={() => setActiveTab('config')}>
          ⚙️ Config
        </button>
      </div>

      {activeTab === 'profiles' && renderProfiles()}
      {activeTab === 'backup' && renderBackup()}
      {activeTab === 'config' && renderConfig()}

      <Modal
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
        title={editingProfile ? 'Edit Profile' : 'Add Profile'}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setShowProfileModal(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSaveProfile}>Save</button>
          </>
        }
      >
        <div className="flex-col gap-md">
          <div>
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Name</label>
            <input className="input" type="text" placeholder="My PS5" value={profileForm.name} onChange={e => setProfileForm(p => ({ ...p, name: e.target.value }))} />
          </div>
          <div>
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>IP Address</label>
            <input className="input" type="text" placeholder="192.168.1.100" value={profileForm.ip} onChange={e => setProfileForm(p => ({ ...p, ip: e.target.value }))} />
          </div>
          <div>
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>MAC Address</label>
            <input className="input" type="text" placeholder="AA:BB:CC:DD:EE:FF" value={profileForm.mac} onChange={e => setProfileForm(p => ({ ...p, mac: e.target.value }))} />
            <div className="text-xs text-muted mt-sm">Pair the console in P5 Control to enable Wake on LAN - no credential field needed any more.</div>
          </div>
          <div>
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Console</label>
            <select
              className="select"
              value={profileForm.consoleType}
              onChange={e => setProfileForm(p => ({ ...p, consoleType: e.target.value }))}
            >
              <option value="">Auto-detect</option>
              <option value="ps5">PS5</option>
              <option value="ps4">PS4</option>
            </select>
            <div className="text-xs text-muted mt-sm">
              Drives which payloads, autoload templates and Convert sub-tabs the UI offers when
              this profile is the default. Auto-detect resolves on the next status poll via
              the Remote Play service's /discover and persists into the profile.
            </div>
          </div>
          <div>
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>FTP port</label>
            <input
              className="input"
              type="number"
              min={1}
              max={65535}
              placeholder={String(defaultFtpPort(profileForm.consoleType))}
              value={profileForm.ftpPort}
              onChange={e => setProfileForm(p => ({ ...p, ftpPort: e.target.value }))}
              style={{ maxWidth: 160 }}
            />
            <div className="text-xs text-muted mt-sm">
              Port of the FTP server on this console. Leave empty for the usual one:
              2120 on a PS5 (zftpd), 2121 on a PS4. File Ops, uploads, downloads to the
              console, the install queue and offline activation all use it.
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default Settings;