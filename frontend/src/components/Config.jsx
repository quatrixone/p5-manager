import { useState, useEffect } from 'react';

const API = '/api';

const DEFAULT_PAYLOADS = [
  { name: 'Kernel Logger (klogsrv)', url: 'https://github.com/ps5-payload-dev/klogsrv/releases/download/v0.8/klogsrv-ps5.elf' },
  { name: 'BD-JB', url: 'https://github.com/ps5-payload-sdk/BD-JB/releases/latest/download/BD-JB.elf' },
  { name: 'Enable UART', url: 'https://github.com/ps5-payload-sdk/uart-enable/releases/latest/download/uart-enable.elf' },
];

function Config() {
  const [defaultSubnet, setDefaultSubnet] = useState('10.0.2.0/24');
  const [payloadUrls, setPayloadUrls] = useState([]);
  const [newUrl, setNewUrl] = useState('');
  const [newName, setNewName] = useState('');
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
      if (data.default_payloads) {
        setPayloadUrls(JSON.parse(data.default_payloads));
      } else {
        setPayloadUrls(DEFAULT_PAYLOADS);
      }
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    }
  };

  const saveSettings = async () => {
    setLoading(true);
    setMessage('');
    try {
      await fetch(`${API}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'default_subnet', value: defaultSubnet })
      });
      await fetch(`${API}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'default_payloads', value: JSON.stringify(payloadUrls) })
      });
      setMessage('Settings saved!');
    } catch (err) {
      setMessage('Failed to save: ' + err.message);
    }
    setLoading(false);
    setTimeout(() => setMessage(''), 3000);
  };

  const addPayloadUrl = () => {
    if (!newUrl || !newName) return;
    setPayloadUrls([...payloadUrls, { name: newName, url: newUrl }]);
    setNewUrl('');
    setNewName('');
  };

  const removePayloadUrl = (index) => {
    setPayloadUrls(payloadUrls.filter((_, i) => i !== index));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '1rem' }}>Network</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.85rem', color: '#aaa', marginBottom: '0.25rem' }}>Default Subnet</label>
            <input
              type="text"
              value={defaultSubnet}
              onChange={e => setDefaultSubnet(e.target.value)}
              placeholder="10.0.2.0/24"
              style={{ padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '1rem', width: '100%', maxWidth: 200 }}
            />
          </div>
        </div>
      </section>

      <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '1rem' }}>Default Payloads</h2>
        <p style={{ fontSize: '0.85rem', color: '#888', marginBottom: '1rem' }}>These URLs will be used when adding payloads from GitHub.</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
          {payloadUrls.map((p, idx) => (
            <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', background: '#0f3460', borderRadius: 6 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{p.name}</div>
                <div style={{ fontSize: '0.75rem', color: '#888', wordBreak: 'breakAll' }}>{p.url}</div>
              </div>
              <button onClick={() => removePayloadUrl(idx)} style={{ padding: '0.4rem 0.75rem', background: '#c0392b', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.8rem', marginLeft: '0.5rem' }}>
                Remove
              </button>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            style={{ padding: '0.5rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '0.85rem', width: 120 }}
          />
          <input
            type="text"
            placeholder="GitHub URL"
            value={newUrl}
            onChange={e => setNewUrl(e.target.value)}
            style={{ padding: '0.5rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '0.85rem', flex: 1, minWidth: 200 }}
          />
          <button onClick={addPayloadUrl} style={{ padding: '0.5rem 1rem', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem' }}>
            Add
          </button>
        </div>
      </section>

      <button onClick={saveSettings} disabled={loading} style={{ padding: '1rem', background: loading ? '#555' : '#3498db', color: '#fff', border: 'none', borderRadius: 6, cursor: loading ? 'not-allowed' : 'pointer', fontSize: '1rem', fontWeight: 500 }}>
        {loading ? 'Saving...' : 'Save Settings'}
      </button>

      {message && (
        <div style={{ padding: '0.75rem', background: message.includes('Failed') ? '#e74c3c' : '#27ae60', borderRadius: 6, color: '#fff', fontSize: '0.85rem' }}>
          {message}
        </div>
      )}
    </div>
  );
}

export default Config;