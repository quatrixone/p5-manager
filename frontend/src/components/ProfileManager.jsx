import { useState } from 'react';

function ProfileManager({ profiles, onCreate, onUpdate, onDelete }) {
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('9021');
  const [editingId, setEditingId] = useState(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (editingId) {
      onUpdate(editingId, name, ip, parseInt(port));
      setEditingId(null);
    } else {
      onCreate(name, ip, parseInt(port));
    }
    setName('');
    setIp('');
    setPort('9021');
  };

  const startEdit = (profile) => {
    setEditingId(profile.id);
    setName(profile.name);
    setIp(profile.ip_address);
    setPort(profile.port?.toString() || '9021');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setName('');
    setIp('');
    setPort('9021');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <section style={{ background: '#16213e', padding: '1.5rem', borderRadius: 12 }}>
        <h2 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>
          {editingId ? 'Edit Profile' : 'Add New Profile'}
        </h2>
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', color: '#aaa' }}>Name</label>
            <input
              type="text"
              placeholder="My PS5"
              value={name}
              onChange={e => setName(e.target.value)}
              required
              style={{ padding: '0.75rem', borderRadius: 6, border: '1px solid #0f3460', background: '#1a1a2e', color: '#fff', width: 150 }}
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
              style={{ padding: '0.75rem', borderRadius: 6, border: '1px solid #0f3460', background: '#1a1a2e', color: '#fff', width: 150 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', color: '#aaa' }}>Port</label>
            <input
              type="number"
              value={port}
              onChange={e => setPort(e.target.value)}
              style={{ padding: '0.75rem', borderRadius: 6, border: '1px solid #0f3460', background: '#1a1a2e', color: '#fff', width: 100 }}
            />
          </div>
          <button type="submit" style={{ padding: '0.75rem 1.5rem', background: editingId ? '#f39c12' : '#e94560', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500 }}>
            {editingId ? 'Update' : 'Add'}
          </button>
          {editingId && (
            <button type="button" onClick={cancelEdit} style={{ padding: '0.75rem 1rem', background: '#666', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              Cancel
            </button>
          )}
        </form>
      </section>

      <section style={{ background: '#16213e', padding: '1.5rem', borderRadius: 12 }}>
        <h2 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>Saved Profiles ({profiles.length})</h2>
        {profiles.length === 0 ? (
          <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>No profiles saved. Add one above.</p>
        ) : (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {profiles.map(profile => (
              <div key={profile.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', background: '#0f3460', borderRadius: 8 }}>
                <div>
                  <div style={{ fontWeight: 500 }}>{profile.name}</div>
                  <div style={{ fontSize: '0.85rem', color: '#aaa' }}>
                    {profile.ip_address}:{profile.port || 9021}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button onClick={() => startEdit(profile)} style={{ padding: '0.5rem 1rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                    Edit
                  </button>
                  <button onClick={() => onDelete(profile.id)} style={{ padding: '0.5rem 1rem', background: '#c0392b', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
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