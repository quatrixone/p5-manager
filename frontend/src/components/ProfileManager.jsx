import { useState } from 'react';

function ProfileManager({ profiles, onCreate, onUpdate, onDelete, onSetDefault }) {
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [mac, setMac] = useState('');
  const [editingId, setEditingId] = useState(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (editingId) {
      onUpdate(editingId, name, ip, mac);
      setEditingId(null);
    } else {
      onCreate(name, ip, mac);
    }
    setName('');
    setIp('');
    setMac('');
  };

  const startEdit = (profile) => {
    setEditingId(profile.id);
    setName(profile.name);
    setIp(profile.ip_address);
    setMac(profile.mac_address || '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setName('');
    setIp('');
    setMac('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <section style={{ background: 'var(--bg-elev)', padding: '1rem', borderRadius: 12 }}>
        <h2 style={{ marginBottom: '1rem', fontSize: '1rem', fontWeight: 500 }}>
          {editingId ? 'Edit Profile' : 'Add New Profile'}
        </h2>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', color: '#aaa' }}>Name</label>
            <input
              type="text"
              placeholder="My PS5"
              value={name}
              onChange={e => setName(e.target.value)}
              required
              style={{ padding: '0.75rem', borderRadius: 6, border: '1px solid var(--bg-elev-2)', background: 'var(--bg)', color: '#fff', fontSize: '1rem' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', color: '#aaa' }}>IP Address</label>
            <input
              type="text"
              placeholder="192.168.1.x"
              value={ip}
              onChange={e => setIp(e.target.value)}
              required
              style={{ padding: '0.75rem', borderRadius: 6, border: '1px solid var(--bg-elev-2)', background: 'var(--bg)', color: '#fff', fontSize: '1rem' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', color: '#aaa' }}>MAC Address (for Wake-on-LAN)</label>
            <input
              type="text"
              placeholder="AA:BB:CC:DD:EE:FF"
              value={mac}
              onChange={e => setMac(e.target.value)}
              style={{ padding: '0.75rem', borderRadius: 6, border: '1px solid var(--bg-elev-2)', background: 'var(--bg)', color: '#fff', fontSize: '1rem' }}
            />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="submit" style={{ padding: '0.75rem', background: editingId ? 'var(--amber)' : 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500, fontSize: '1rem', flex: 1, minHeight: 44 }}>
              {editingId ? 'Update' : 'Add'}
            </button>
            {editingId && (
              <button type="button" onClick={cancelEdit} style={{ padding: '0.75rem', background: '#666', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', minHeight: 44 }}>
                Cancel
              </button>
            )}
          </div>
        </form>
      </section>

      <section style={{ background: 'var(--bg-elev)', padding: '1rem', borderRadius: 12 }}>
        <h2 style={{ marginBottom: '1rem', fontSize: '1rem', fontWeight: 500 }}>Saved Profiles ({profiles.length})</h2>
        {profiles.length === 0 ? (
          <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>No profiles saved. Add one above.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {profiles.map(profile => (
              <div key={profile.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem', background: profile.is_default ? '#1a5276' : 'var(--bg-elev-2)', borderRadius: 8, border: profile.is_default ? '2px solid var(--accent)' : 'none' }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {profile.name}
                    {profile.is_default && <span style={{ fontSize: '0.7rem', background: 'var(--accent)', padding: '0.1rem 0.5rem', borderRadius: 4 }}>Default</span>}
                  </div>
                  <div style={{ fontSize: '0.85rem', color: '#aaa' }}>
                    {profile.ip_address}
                    {profile.mac_address && <span style={{ color: 'var(--accent)' }}> • {profile.mac_address}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {!profile.is_default && (
                    <button onClick={() => onSetDefault(profile.id)} style={{ padding: '0.5rem 0.75rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', minHeight: 36 }}>
                      Set Default
                    </button>
                  )}
                  <button onClick={() => startEdit(profile)} style={{ padding: '0.5rem 0.75rem', background: 'var(--blue)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', minHeight: 36 }}>
                    Edit
                  </button>
                  <button onClick={() => onDelete(profile.id)} style={{ padding: '0.5rem 0.75rem', background: 'var(--red)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', minHeight: 36 }}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default ProfileManager;