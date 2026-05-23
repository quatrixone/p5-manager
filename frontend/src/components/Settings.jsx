import { useState } from 'react';

const API = '/api';

const KNOWN_GAMES = [
  { titleId: 'CUSA03474', name: 'Star Wars Racer Revenge (USA)' },
  { titleId: 'CUSA03492', name: 'Star Wars Racer Revenge (EU)' },
];

function Settings({ profiles, onProfileCreate, onProfileUpdate, onProfileDelete, onProfileSetDefault, onLaunch, onWake, onSendInput }) {
  const [activeSection, setActiveSection] = useState('profiles');
  const [backupStatus, setBackupStatus] = useState('');
  const [restoreFile, setRestoreFile] = useState(null);
  const [editingProfile, setEditingProfile] = useState(null);
  const [profileForm, setProfileForm] = useState({ name: '', ip: '', mac: '' });
  const [selectedGame, setSelectedGame] = useState('');
  const [customTitleId, setCustomTitleId] = useState('');

  const handleAddProfile = () => {
    setEditingProfile('new');
    setProfileForm({ name: '', ip: '', mac: '' });
  };

  const handleEditProfile = (profile) => {
    setEditingProfile(profile.id);
    setProfileForm({ name: profile.name, ip: profile.ip_address, mac: profile.mac_address || '' });
  };

  const handleSaveProfile = async () => {
    if (editingProfile === 'new') {
      onProfileCreate(profileForm.name, profileForm.ip, profileForm.mac);
    } else {
      onProfileUpdate(editingProfile, profileForm.name, profileForm.ip, profileForm.mac);
    }
    setEditingProfile(null);
    setProfileForm({ name: '', ip: '', mac: '' });
  };

  const handleCancelEdit = () => {
    setEditingProfile(null);
    setProfileForm({ name: '', ip: '', mac: '' });
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
      if (onProfileCreate) onProfileCreate();
    } catch (err) {
      setBackupStatus('Restore failed: ' + err.message);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {['profiles', 'remote', 'backup'].map(section => (
          <button
            key={section}
            onClick={() => setActiveSection(section)}
            style={{
              padding: '0.5rem 1rem',
              background: activeSection === section ? '#e94560' : '#0f3460',
              color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', textTransform: 'capitalize'
            }}
          >
            {section}
          </button>
        ))}
      </div>

      {/* PROFILES SECTION */}
      {activeSection === 'profiles' && (
        <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 500 }}>Profiles ({profiles.length})</h3>
            {!editingProfile && (
              <button onClick={handleAddProfile} style={{ padding: '0.5rem 1rem', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' }}>
                Add Profile
              </button>
            )}
          </div>

          {editingProfile && (
            <div style={{ padding: '1rem', background: '#0f3460', borderRadius: 8, marginBottom: '1rem' }}>
              <h4 style={{ color: '#fff', marginBottom: '1rem' }}>{editingProfile === 'new' ? 'Add New Profile' : 'Edit Profile'}</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <input type="text" placeholder="Name" value={profileForm.name} onChange={e => setProfileForm(p => ({ ...p, name: e.target.value }))}
                  style={{ padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '1rem' }} />
                <input type="text" placeholder="IP Address" value={profileForm.ip} onChange={e => setProfileForm(p => ({ ...p, ip: e.target.value }))}
                  style={{ padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '1rem' }} />
                <input type="text" placeholder="MAC Address (for Wake on LAN)" value={profileForm.mac} onChange={e => setProfileForm(p => ({ ...p, mac: e.target.value }))}
                  style={{ padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '1rem' }} />
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button onClick={handleSaveProfile} style={{ padding: '0.75rem', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '1rem', flex: 1 }}>
                    {editingProfile === 'new' ? 'Add' : 'Save'}
                  </button>
                  <button onClick={handleCancelEdit} style={{ padding: '0.75rem', background: '#666', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '1rem' }}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {profiles.length === 0 ? (
            <p style={{ color: '#888' }}>No profiles yet. Add one above.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {profiles.map(profile => (
                <div key={profile.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '0.75rem', background: profile.is_default ? '#1a5276' : '#0f3460',
                  borderRadius: 8, flexWrap: 'wrap', gap: '0.5rem'
                }}>
                  <div>
                    <div style={{ fontWeight: 500 }}>
                      {profile.name}
                      {profile.is_default && <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: '#27ae60' }}>(Default)</span>}
                    </div>
                    <div style={{ fontSize: '0.85rem', color: '#aaa' }}>
                      {profile.ip_address} {profile.mac_address && `• ${profile.mac_address}`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {!profile.is_default && (
                      <button onClick={() => onProfileSetDefault(profile.id)} style={{ padding: '0.4rem 0.75rem', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem' }}>
                        Set Default
                      </button>
                    )}
                    <button onClick={() => handleEditProfile(profile)} style={{ padding: '0.4rem 0.75rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem' }}>
                      Edit
                    </button>
                    <button onClick={() => onProfileDelete(profile.id)} style={{ padding: '0.4rem 0.75rem', background: '#c0392b', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem' }}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* REMOTE SECTION */}
      {activeSection === 'remote' && (
        <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '1rem' }}>Remote Control</h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Wake on LAN */}
            <div style={{ padding: '1rem', background: '#0f3460', borderRadius: 8 }}>
              <h4 style={{ color: '#fff', marginBottom: '0.5rem' }}>Wake on LAN</h4>
              <p style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '1rem' }}>
                {profiles.find(p => p.is_default)?.mac_address
                  ? `Using MAC: ${profiles.find(p => p.is_default).mac_address}`
                  : 'Add a profile with MAC address to use Wake on LAN'}
              </p>
              <button
                onClick={onWake}
                disabled={!profiles.find(p => p.is_default)?.mac_address}
                style={{ padding: '0.75rem 1.5rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '1rem' }}
              >
                Wake on LAN
              </button>
            </div>

            {/* Launch Application */}
            <div style={{ padding: '1rem', background: '#0f3460', borderRadius: 8 }}>
              <h4 style={{ color: '#fff', marginBottom: '0.5rem' }}>Launch Application</h4>
              <select value={selectedGame} onChange={e => { setSelectedGame(e.target.value); setCustomTitleId(''); }}
                style={{ width: '100%', padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '1rem', marginBottom: '0.5rem' }}>
                <option value="">Select known game...</option>
                {KNOWN_GAMES.map(g => <option key={g.titleId} value={g.titleId}>{g.name}</option>)}
              </select>
              <div style={{ color: '#888', fontSize: '0.85rem', textAlign: 'center', marginBottom: '0.5rem' }}>or</div>
              <input type="text" placeholder="Custom titleId (e.g. CUSAXXXXX)" value={customTitleId}
                onChange={e => { setCustomTitleId(e.target.value); setSelectedGame(''); }}
                style={{ width: '100%', padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '1rem', marginBottom: '0.75rem' }} />
              <button
                onClick={() => onLaunch(customTitleId || selectedGame)}
                disabled={!selectedGame && !customTitleId}
                style={{ padding: '0.75rem', background: (!selectedGame && !customTitleId) ? '#555' : '#27ae60', color: '#fff', border: 'none', borderRadius: 6, cursor: (!selectedGame && !customTitleId) ? 'not-allowed' : 'pointer', fontSize: '1rem' }}
              >
                Launch
              </button>
            </div>

            {/* Script Runner Reference */}
            <div style={{ padding: '1rem', background: '#0f3460', borderRadius: 8 }}>
              <h4 style={{ color: '#fff', marginBottom: '0.5rem' }}>Script Runner Commands</h4>
              <p style={{ color: '#aaa', fontSize: '0.85rem', lineHeight: 1.6 }}>
                Available commands for Script Runner in Remote tab:
                <br/><code style={{ background: '#1a1a2e', padding: '0.1rem 0.3rem', borderRadius: 3 }}>left, right, up, down</code> - D-pad
                <br/><code style={{ background: '#1a1a2e', padding: '0.1rem 0.3rem', borderRadius: 3 }}>x, cross, circle, square, triangle</code> - Face buttons
                <br/><code style={{ background: '#1a1a2e', padding: '0.1rem 0.3rem', borderRadius: 3 }}>ps, options, touchpad</code> - System buttons
                <br/><code style={{ background: '#1a1a2e', padding: '0.1rem 0.3rem', borderRadius: 3 }}>L1, R1, L2, R2, L3, R3</code> - Triggers
                <br/><code style={{ background: '#1a1a2e', padding: '0.1rem 0.3rem', borderRadius: 3 }}>wait X</code> - Wait X milliseconds
              </p>
            </div>
          </div>
        </section>
      )}

      {/* BACKUP/RESTORE SECTION */}
      {activeSection === 'backup' && (
        <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '1rem' }}>Backup & Restore</h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ padding: '1rem', background: '#0f3460', borderRadius: 8 }}>
              <h4 style={{ color: '#fff', marginBottom: '0.5rem' }}>Backup</h4>
              <p style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '1rem' }}>Download all profiles, payloads, sequences, and settings as ZIP.</p>
              <button onClick={handleBackup} style={{ padding: '0.75rem 1.5rem', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '1rem' }}>
                Download Backup
              </button>
            </div>

            <div style={{ padding: '1rem', background: '#0f3460', borderRadius: 8 }}>
              <h4 style={{ color: '#fff', marginBottom: '0.5rem' }}>Restore</h4>
              <p style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '1rem' }}>Upload a backup ZIP file to restore all data.</p>
              <input type="file" accept=".zip" onChange={e => setRestoreFile(e.target.files[0])}
                style={{ marginBottom: '0.75rem', color: '#fff', fontSize: '0.85rem' }} />
              <button onClick={handleRestore} disabled={!restoreFile}
                style={{ padding: '0.75rem 1.5rem', background: restoreFile ? '#3498db' : '#555', color: '#fff', border: 'none', borderRadius: 6, cursor: restoreFile ? 'pointer' : 'not-allowed', fontSize: '1rem' }}>
                Restore Backup
              </button>
            </div>

            {backupStatus && (
              <div style={{ padding: '0.75rem', background: backupStatus.includes('failed') ? '#e74c3c' : '#27ae60', borderRadius: 6, color: '#fff', fontSize: '0.85rem' }}>
                {backupStatus}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

export default Settings;