import { useState, useEffect } from 'react';
import Modal from './UI/Modal';
import Badge from './UI/Badge';

const API = '/api';

function Settings({ profiles, onProfileCreate, onProfileUpdate, onProfileDelete, onProfileSetDefault }) {
  const [activeTab, setActiveTab] = useState('profiles');
  const [backupStatus, setBackupStatus] = useState('');
  const [restoreFile, setRestoreFile] = useState(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [editingProfile, setEditingProfile] = useState(null);
  const [profileForm, setProfileForm] = useState({ name: '', ip: '', mac: '', credential: '' });
  const [scanning, setScanning] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState([]);
  const [scanMode, setScanMode] = useState('local');
  const [subnet, setSubnet] = useState('10.0.2.0/24');
  const [defaultSubnet, setDefaultSubnet] = useState('10.0.2.0/24');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch(`${API}/settings`);
      const data = await res.json();
      if (data.default_subnet) setDefaultSubnet(data.default_subnet);
    } catch (err) {
      console.error('Failed to fetch settings:', err);
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

  const handleScan = async () => {
    setScanning(true);
    setDiscoveredDevices([]);
    try {
      const res = await fetch(`${API}/ps5control/scan?timeout=5`);
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
        body: JSON.stringify({ subnet, timeout: 1, concurrency: 50 })
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
    onProfileCreate(name, ip, mac, '');
  };

  const openAddProfile = () => {
    setEditingProfile(null);
    setProfileForm({ name: '', ip: '', mac: '', credential: '' });
    setShowProfileModal(true);
  };

  const openEditProfile = (profile) => {
    setEditingProfile(profile);
    setProfileForm({ name: profile.name, ip: profile.ip_address, mac: profile.mac_address || '', credential: profile.credential || '' });
    setShowProfileModal(true);
  };

  const handleSaveProfile = () => {
    if (editingProfile) {
      onProfileUpdate(editingProfile.id, profileForm.name, profileForm.ip, profileForm.mac, profileForm.credential);
    } else {
      onProfileCreate(profileForm.name, profileForm.ip, profileForm.mac, profileForm.credential);
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

      <div className="flex gap-sm mb-sm">
        <select className="select" value={scanMode} onChange={e => setScanMode(e.target.value)} style={{ maxWidth: 120 }}>
          <option value="local">Local</option>
          <option value="subnet">Subnet</option>
        </select>
        {scanMode === 'subnet' && (
          <input className="input" type="text" placeholder="10.0.2.0/24" value={subnet} onChange={e => setSubnet(e.target.value)} style={{ maxWidth: 150 }} />
        )}
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
    <div>
      <h2 className="font-bold mb-md" style={{ fontSize: '1.25rem' }}>Configuration</h2>

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
          </div>
          <div>
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>Credential</label>
            <input className="input" type="text" placeholder="For Wake on LAN" value={profileForm.credential} onChange={e => setProfileForm(p => ({ ...p, credential: e.target.value }))} />
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default Settings;