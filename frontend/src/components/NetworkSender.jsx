import { useState } from 'react';

function NetworkSender({ profiles, payloads, onSend, onCheckStatus }) {
  const [selectedProfile, setSelectedProfile] = useState('');
  const [selectedPayload, setSelectedPayload] = useState('');
  const [statusResult, setStatusResult] = useState(null);

  const handleCheckStatus = async () => {
    const profile = profiles.find(p => p.id === parseInt(selectedProfile));
    if (!profile) return;
    const reachable = await onCheckStatus(profile.ip_address, profile.port);
    setStatusResult(reachable);
  };

  const handleSend = () => {
    if (!selectedProfile || !selectedPayload) return;
    onSend(parseInt(selectedPayload), parseInt(selectedProfile));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <section style={{ background: '#16213e', padding: '1.5rem', borderRadius: 12 }}>
        <h2 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>Send Payload</h2>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', color: '#aaa' }}>Profile</label>
            <select
              value={selectedProfile}
              onChange={e => setSelectedProfile(e.target.value)}
              style={{ padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', minWidth: 180 }}
            >
              <option value="">Select...</option>
              {profiles.map(p => (
                <option key={p.id} value={p.id}>{p.name} ({p.ip_address})</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', color: '#aaa' }}>Payload</label>
            <select
              value={selectedPayload}
              onChange={e => setSelectedPayload(e.target.value)}
              style={{ padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', minWidth: 200 }}
            >
              <option value="">Select...</option>
              {payloads.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <button
            onClick={handleSend}
            disabled={!selectedProfile || !selectedPayload}
            style={{ padding: '0.75rem 2rem', background: (!selectedProfile || !selectedPayload) ? '#555' : '#e94560', color: '#fff', border: 'none', borderRadius: 6, cursor: (!selectedProfile || !selectedPayload) ? 'not-allowed' : 'pointer', fontWeight: 500 }}
          >
            Send
          </button>
        </div>
      </section>

      <section style={{ background: '#16213e', padding: '1.5rem', borderRadius: 12 }}>
        <h2 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>PS5 Status Check</h2>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', color: '#aaa' }}>Profile</label>
            <select
              value={selectedProfile}
              onChange={e => setSelectedProfile(e.target.value)}
              style={{ padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', minWidth: 180 }}
            >
              <option value="">Select...</option>
              {profiles.map(p => (
                <option key={p.id} value={p.id}>{p.name} ({p.ip_address})</option>
              ))}
            </select>
          </div>
          <button onClick={handleCheckStatus} style={{ padding: '0.75rem 1.5rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500 }}>
            Check Status
          </button>
        </div>
        {statusResult !== null && (
          <div style={{ marginTop: '1rem', padding: '1rem', borderRadius: 8, background: statusResult ? '#27ae60' : '#c0392b', color: '#fff' }}>
            {statusResult ? 'PS5 is reachable and ready' : 'PS5 not reachable'}
          </div>
        )}
      </section>
    </div>
  );
}

export default NetworkSender;