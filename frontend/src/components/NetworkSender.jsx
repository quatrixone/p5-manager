import { useState } from 'react';

function NetworkSender({ profiles, payloads, onSend, onCheckStatus }) {
  const [selectedPayload, setSelectedPayload] = useState('');
  const [statusResult, setStatusResult] = useState(null);

  const defaultProfile = profiles.find(p => p.is_default) || profiles[0];

  const handleCheckStatus = async () => {
    if (!defaultProfile) return;

    const [luaReachable, elfReachable] = await Promise.all([
      onCheckStatus(defaultProfile.ip_address, 9026),
      onCheckStatus(defaultProfile.ip_address, 9021)
    ]);

    // PS5 is reachable if LUA port (9026) is OK
    setStatusResult({ lua: luaReachable, elf: elfReachable, reachable: luaReachable });
  };

  const handleSend = () => {
    if (!defaultProfile || !selectedPayload) return;
    onSend(parseInt(selectedPayload));
  };

  if (!defaultProfile) {
    return (
      <div style={{ background: '#16213e', padding: '1.5rem', borderRadius: 12 }}>
        <p style={{ color: '#888' }}>No profile found. Please create a profile first.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <div style={{ marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1rem', marginBottom: '0.25rem' }}>Send Payload</h2>
          <div style={{ color: '#aaa', fontSize: '0.85rem' }}>
            Using: <span style={{ color: '#27ae60' }}>{defaultProfile.name}</span> ({defaultProfile.ip_address})
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <select
            value={selectedPayload}
            onChange={e => setSelectedPayload(e.target.value)}
            style={{ padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '1rem' }}
          >
            <option value="">Select payload...</option>
            {payloads.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            onClick={handleSend}
            disabled={!selectedPayload}
            style={{ padding: '0.75rem', background: !selectedPayload ? '#555' : '#e94560', color: '#fff', border: 'none', borderRadius: 6, cursor: !selectedPayload ? 'not-allowed' : 'pointer', fontWeight: 500, fontSize: '1rem', minHeight: 44 }}
          >
            Send
          </button>
        </div>
      </section>

      <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <div style={{ marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1rem', marginBottom: '0.25rem' }}>
            PS5 Status
            {statusResult && (
              <span style={{ marginLeft: '0.5rem', color: statusResult.reachable ? '#27ae60' : '#c0392b', fontSize: '0.9rem' }}>
                {statusResult.reachable ? '✓ Reachable' : '✗ Not reachable'}
              </span>
            )}
          </h2>
          <div style={{ color: '#aaa', fontSize: '0.85rem' }}>
            {defaultProfile.ip_address}
          </div>
        </div>
        <button onClick={handleCheckStatus} style={{ padding: '0.75rem 1rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500, fontSize: '1rem', minHeight: 44, width: '100%' }}>
          Check Status
        </button>
        {statusResult !== null && (
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
            <div style={{ padding: '0.75rem', borderRadius: 8, background: statusResult.lua ? '#27ae60' : '#c0392b', color: '#fff', flex: 1, textAlign: 'center', fontSize: '0.9rem' }}>
              LUA: {statusResult.lua ? 'OK' : 'NO'}
            </div>
            <div style={{ padding: '0.75rem', borderRadius: 8, background: statusResult.elf ? '#27ae60' : '#c0392b', color: '#fff', flex: 1, textAlign: 'center', fontSize: '0.9rem' }}>
              ELF: {statusResult.elf ? 'OK' : 'NO'}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default NetworkSender;