import { useState, useEffect } from 'react';
import Modal from './UI/Modal';
import Badge from './UI/Badge';
import RemoteSourcesSection from './RemoteSourcesSection';

const API = '/api';

function Settings({ profiles, onProfileCreate, onProfileUpdate, onProfileDelete, onProfileSetDefault }) {
  const [activeTab, setActiveTab] = useState('profiles');
  const [backupStatus, setBackupStatus] = useState('');
  const [restoreFile, setRestoreFile] = useState(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [editingProfile, setEditingProfile] = useState(null);
  // `consoleType` is null = "auto-detect via pyremoteplay /discover on next
  // status poll" (default for newly-added profiles); explicit 'ps4' / 'ps5'
  // is the manual override. The status route already auto-fills it when
  // discovery succeeds, so leaving this blank is usually fine.
  const [profileForm, setProfileForm] = useState({ name: '', ip: '', mac: '', consoleType: '' });
  const [scanning, setScanning] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState([]);
  const [scanMode, setScanMode] = useState('local');
  // Single source of truth for the subnet - same value drives both the
  // "Default subnet" config field and the scan input, so saving in one place
  // is reflected in the other.
  const [defaultSubnet, setDefaultSubnet] = useState('10.0.0.0/24');
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

  useEffect(() => {
    fetchSettings();
    fetchPayloads();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch(`${API}/settings`);
      const data = await res.json();
      if (data.default_subnet) setDefaultSubnet(data.default_subnet);
      if (data.upload_target_ip !== undefined) setUploadTargetIp(data.upload_target_ip || '');
      if (data.upload_target_path) setUploadTargetPath(data.upload_target_path);
      if (data.pkg_installer_payload_id) setPkgInstallerPayloadId(String(data.pkg_installer_payload_id));
      if (data.pkg_stage_dir) setPkgStageDir(data.pkg_stage_dir);
      if (data.pkg_trigger_file) setPkgTriggerFile(data.pkg_trigger_file);
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    }
  };

  // Only show ELF payloads in the "PKG installer payload" picker — .lua and
  // .bin won't be sent to port 9021 by sendInstallerPayload, so listing them
  // would let the user save a non-functional config.
  const fetchPayloads = async () => {
    try {
      const res = await fetch(`${API}/payloads`);
      if (!res.ok) return;
      const list = await res.json();
      if (Array.isArray(list)) {
        setAvailablePayloads(list.filter(p => /\.elf$/i.test(p.name || '')));
      }
    } catch (err) {
      console.error('Failed to load payloads:', err);
    }
  };

  const saveConfigSettings = async () => {
    setLoading(true);
    setMessage('');
    try {
      await fetch(`${API}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'default_subnet', value: defaultSubnet })
      });
      setMessage('Settings saved!');
    } catch (err) {
      setMessage('Failed to save: ' + err.message);
    }
    setLoading(false);
    setTimeout(() => setMessage(''), 3000);
  };

  const saveUploadTarget = async () => {
    setLoading(true);
    setMessage('');
    try {
      await fetch(`${API}/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'upload_target_ip', value: uploadTargetIp })
      });
      await fetch(`${API}/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'upload_target_path', value: uploadTargetPath })
      });
      setMessage('Upload target saved!');
    } catch (err) {
      setMessage('Failed to save: ' + err.message);
    }
    setLoading(false);
    setTimeout(() => setMessage(''), 3000);
  };

  // Three keys in one button so the user always saves a consistent install
  // setup: empty payload id is allowed (clears the binding so the install
  // queue errors out cleanly with "no installer configured" instead of
  // silently failing on /api/payloads/<old-id>).
  const savePkgInstaller = async () => {
    setLoading(true);
    setMessage('');
    try {
      await fetch(`${API}/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'pkg_installer_payload_id', value: pkgInstallerPayloadId })
      });
      await fetch(`${API}/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'pkg_stage_dir', value: pkgStageDir })
      });
      await fetch(`${API}/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'pkg_trigger_file', value: pkgTriggerFile })
      });
      setMessage('PKG installer saved!');
    } catch (err) {
      setMessage('Failed to save: ' + err.message);
    }
    setLoading(false);
    setTimeout(() => setMessage(''), 3000);
  };

  const handleScan = async () => {
    setScanning(true);
    setDiscoveredDevices([]);
    try {
      // Pass the saved default subnet so the backend can pick the right NIC
      // for the directed broadcast (255.255.255.255 alone often lands on a
      // docker bridge instead of the LAN).
      const q = defaultSubnet ? `&subnet=${encodeURIComponent(defaultSubnet)}` : '';
      const res = await fetch(`${API}/ps5control/scan?timeout=3${q}`);
      const data = await res.json();
      if (data.success) setDiscoveredDevices(data.devices);
    } catch (err) {
      console.error('Scan error:', err);
    }
    setScanning(false);
  };

  const handleScanSubnet = async () => {
    setScanning(true);
    setDiscoveredDevices([]);
    try {
      const res = await fetch(`${API}/ps5control/scan-subnet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subnet: defaultSubnet, timeout: 3 })
      });
      const data = await res.json();
      if (data.success) setDiscoveredDevices(data.devices);
    } catch (err) {
      console.error('Subnet scan error:', err);
    }
    setScanning(false);
  };

  const handleScanClick = () => {
    if (scanMode === 'local') handleScan();
    else handleScanSubnet();
  };

  const handleAddDiscovered = async (device) => {
    const name = device.name || `PS5-${device.ip?.split('.').pop()}`;
    const ip = device.ip || device.hostId;
    let mac = '';
    try {
      await fetch(`${API}/ps5control/scan?host=${ip}&timeout=2`);
      await new Promise(resolve => setTimeout(resolve, 500));
      const arpRes = await fetch(`${API}/ps5control/arp?ip=${ip}`);
      const arpData = await arpRes.json();
      if (arpData.mac) mac = arpData.mac;
    } catch (err) {
      console.error('MAC lookup failed:', err);
    }
    onProfileCreate(name, ip, mac);
  };

  const openAddProfile = () => {
    setEditingProfile(null);
    setProfileForm({ name: '', ip: '', mac: '', consoleType: '' });
    setShowProfileModal(true);
  };

  const openEditProfile = (profile) => {
    setEditingProfile(profile);
    setProfileForm({
      name: profile.name,
      ip: profile.ip_address,
      mac: profile.mac_address || '',
      consoleType: profile.console_type || '',
    });
    setShowProfileModal(true);
  };

  const handleSaveProfile = () => {
    // Empty string from the <select> becomes null at the backend = auto-detect.
    const consoleType = profileForm.consoleType || null;
    if (editingProfile) {
      onProfileUpdate(editingProfile.id, profileForm.name, profileForm.ip, profileForm.mac, consoleType);
    } else {
      onProfileCreate(profileForm.name, profileForm.ip, profileForm.mac, consoleType);
    }
    setShowProfileModal(false);
  };

  const handleBackup = async () => {
    try {
      setBackupStatus('Creating backup...');
      const res = await fetch(`${API}/backup`);
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
      const res = await fetch(`${API}/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zip: base64 })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Restore failed');
      }
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

      {profiles.length === 0 && discoveredDevices.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">🎮</div>
          <div className="empty-state-title">No profiles yet</div>
          <div className="empty-state-text">Add a PS5 profile or scan to discover devices</div>
        </div>
      )}

      {discoveredDevices.length > 0 && (
        <div className="comp-card mb-md">
          <div className="comp-card-header">
            <span className="comp-card-title">🔍 Discovered Devices</span>
          </div>
          <div className="comp-card-body">
            {discoveredDevices.map((device, idx) => (
              <div key={idx} className="list-item">
                <span style={{ fontSize: '1.5rem' }}>🎮</span>
                <div className="list-item-content">
                  <div className="list-item-title">{device.name}</div>
                  <div className="list-item-subtitle">{device.ip} • {device.type}</div>
                </div>
                <button className="btn btn-sm btn-success" onClick={() => handleAddDiscovered(device)}>+ Add</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-sm mb-sm flex-wrap items-center">
        <select className="select" value={scanMode} onChange={e => setScanMode(e.target.value)} style={{ maxWidth: 130 }}>
          <option value="local">Broadcast</option>
          <option value="subnet">Subnet sweep</option>
        </select>
        <input
          className="input"
          type="text"
          placeholder="10.0.0.0/24"
          value={defaultSubnet}
          onChange={e => setDefaultSubnet(e.target.value)}
          onBlur={saveConfigSettings}
          style={{ maxWidth: 170 }}
          title="Subnet used for scanning. Saved on blur."
        />
        <button className="btn btn-secondary" onClick={handleScanClick} disabled={scanning}>
          {scanning ? '⏳ Scanning...' : '🔍 Scan'}
        </button>
      </div>

      <div className="flex-col gap-sm">
        {profiles.map(profile => (
          <div key={profile.id} className="comp-card" style={{ borderLeft: profile.is_default ? '3px solid var(--green)' : '3px solid transparent' }}>
            <div className="flex items-center gap-md p-md">
              <span style={{ fontSize: '2rem' }}>🎮</span>
              <div className="flex-1" style={{ minWidth: 0 }}>
                <div className="flex items-center gap-sm">
                  <span className="list-item-title">{profile.name}</span>
                  {profile.is_default && <Badge variant="success">Default</Badge>}
                  {profile.console_type && (
                    <span className="console-type-badge" title="Console type stored on this profile">
                      {profile.console_type.toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="list-item-subtitle">{profile.ip_address}</div>
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
          <div className="mb-md">
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Default Subnet</label>
            <input
              className="input"
              type="text"
              value={defaultSubnet}
              onChange={e => setDefaultSubnet(e.target.value)}
              placeholder="10.0.2.0/24"
              style={{ maxWidth: 250 }}
            />
          </div>
          <button className="btn btn-primary" onClick={saveConfigSettings} disabled={loading}>
            {loading ? '⏳ Saving...' : '💾 Save Settings'}
          </button>
          {message && <div className="mt-sm text-sm" style={{ color: message.includes('Failed') ? 'var(--red)' : 'var(--green)' }}>{message}</div>}
        </div>
      </div>

      <div className="comp-card">
        <div className="comp-card-body">
          <div className="font-bold mb-sm">Local upload target (PS5 FTP)</div>
          <div className="text-xs text-muted mb-md">
            Used by the Convert tab when "Auto-upload .ffpfsc to PS5 FTP when conversion finishes" is enabled.
            Configure once here and every conversion will push to the same console + path.
          </div>
          <div className="mb-md">
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Target PS5</label>
            <select
              className="select"
              value={uploadTargetIp}
              onChange={e => setUploadTargetIp(e.target.value)}
              style={{ maxWidth: 320 }}
            >
              <option value="">— use current default profile —</option>
              {profiles.map(p => (
                <option key={p.id} value={p.ip_address}>{p.name} ({p.ip_address})</option>
              ))}
            </select>
          </div>
          <div className="mb-md">
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Destination on PS5</label>
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
            {loading ? '⏳ Saving...' : '💾 Save Upload Target'}
          </button>
        </div>
      </div>

      <div className="comp-card">
        <div className="comp-card-body">
          <div className="font-bold mb-sm">PKG installer (fake .pkg)</div>
          <div className="text-xs text-muted mb-md">
            The install queue stages .pkg files to <code>{pkgStageDir}</code> on the PS5 via FTP,
            drops a trigger file at <code>{pkgTriggerFile}</code> with the staged path, then sends
            the configured installer payload over the ELF loader port (9021). The payload reads
            the trigger file and calls <code>sceAppInstUtilInstallByPackage</code>.
            Build instructions are in <code>p5managerclient/pkg-install/README.md</code> in the repo.
          </div>
          <div className="mb-md">
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Installer payload (ELF)</label>
            <select
              className="select"
              value={pkgInstallerPayloadId}
              onChange={e => setPkgInstallerPayloadId(e.target.value)}
              style={{ maxWidth: 420 }}
            >
              <option value="">— select an installer ELF —</option>
              {availablePayloads.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {availablePayloads.length === 0 && (
              <div className="text-xs text-muted mt-sm">
                No ELF payloads found. Upload <code>pkg-install.elf</code> in the Payloads tab first.
              </div>
            )}
          </div>
          <div className="mb-md">
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Staging directory on PS5</label>
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
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Trigger file on PS5</label>
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
            {loading ? '⏳ Saving...' : '💾 Save PKG Installer'}
          </button>
        </div>
      </div>

      <RemoteSourcesSection profiles={profiles} />
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
              <option value="">Auto-detect (pyremoteplay)</option>
              <option value="ps5">PS5</option>
              <option value="ps4">PS4</option>
            </select>
            <div className="text-xs text-muted mt-sm">
              Drives which payloads, autoload templates and Convert sub-tabs the UI offers when
              this profile is the default. Auto-detect resolves on the next status poll via
              pyremoteplay /discover and persists into the profile.
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default Settings;