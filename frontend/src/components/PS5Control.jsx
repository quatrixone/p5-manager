import { useState, useEffect } from 'react';

const API = '/api';

const KNOWN_GAMES = [
  { titleId: 'CUSA03474', name: 'Star Wars Racer Revenge (USA)' },
  { titleId: 'CUSA03492', name: 'Star Wars Racer Revenge (EU)' },
];

function PS5Control({ profiles }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedGame, setSelectedGame] = useState('');
  const [customTitleId, setCustomTitleId] = useState('');

  const defaultProfile = profiles.find(p => p.is_default) || profiles[0];

  const fetchStatus = async () => {
    if (!defaultProfile) return;
    try {
      const res = await fetch(`${API}/ps5/status/${defaultProfile.ip_address}`);
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setStatus({ status: 'unreachable', error: err.message });
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [defaultProfile]);

  const handleWake = async () => {
    if (!defaultProfile) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/ps5control/wake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: defaultProfile.ip_address })
      });
      const data = await res.json();
      if (data.success) {
        setTimeout(fetchStatus, 3000);
      }
    } catch (err) {
      console.error('Wake error:', err);
    }
    setLoading(false);
  };

  const handleLaunch = async () => {
    if (!defaultProfile) return;
    const titleId = customTitleId || selectedGame;
    if (!titleId) return;

    setLoading(true);
    try {
      const game = KNOWN_GAMES.find(g => g.titleId === titleId);
      await fetch(`${API}/ps5control/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: defaultProfile.ip_address,
          titleId,
          name: game?.name || titleId
        })
      });
    } catch (err) {
      console.error('Launch error:', err);
    }
    setLoading(false);
  };

  const handleInput = async (button) => {
    if (!defaultProfile) return;
    try {
      await fetch(`${API}/ps5control/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: defaultProfile.ip_address, button })
      });
    } catch (err) {
      console.error('Input error:', err);
    }
  };

  if (!defaultProfile) {
    return (
      <div style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <p style={{ color: '#888' }}>No profile found. Please create a profile first.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <div style={{ marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 500 }}>PS5 Remote Control</h2>
          <div style={{ color: '#aaa', fontSize: '0.85rem' }}>
            Using: <span style={{ color: '#27ae60' }}>{defaultProfile.name}</span> ({defaultProfile.ip_address})
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          <div style={{
            padding: '0.5rem 1rem',
            borderRadius: 6,
            background: status?.status === 'running' ? '#27ae60' : status?.status === 'standby' ? '#f39c12' : '#c0392b',
            color: '#fff',
            fontWeight: 500,
            fontSize: '0.9rem'
          }}>
            {status?.status === 'running' ? 'Running' : status?.status === 'standby' ? 'Standby' : 'Off/Unreachable'}
          </div>
          <button
            onClick={handleWake}
            disabled={loading}
            style={{ padding: '0.75rem 1.5rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500, fontSize: '1rem', minHeight: 44 }}
          >
            Wake / Zapnúť
          </button>
        </div>
      </section>

      <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '1rem' }}>Launch Application</h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <select
            value={selectedGame}
            onChange={e => { setSelectedGame(e.target.value); setCustomTitleId(''); }}
            style={{ padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '1rem' }}
          >
            <option value="">Select known game...</option>
            {KNOWN_GAMES.map(g => (
              <option key={g.titleId} value={g.titleId}>{g.name}</option>
            ))}
          </select>

          <div style={{ color: '#888', fontSize: '0.85rem', textAlign: 'center' }}>alebo</div>

          <input
            type="text"
            placeholder="Custom titleId (e.g. CUSAXXXXX)"
            value={customTitleId}
            onChange={e => { setCustomTitleId(e.target.value); setSelectedGame(''); }}
            style={{ padding: '0.75rem', borderRadius: 6, border: '1px solid #0f3460', background: '#1a1a2e', color: '#fff', fontSize: '1rem' }}
          />

          <button
            onClick={handleLaunch}
            disabled={loading || (!selectedGame && !customTitleId)}
            style={{ padding: '0.75rem', background: (!selectedGame && !customTitleId) ? '#555' : '#27ae60', color: '#fff', border: 'none', borderRadius: 6, cursor: (!selectedGame && !customTitleId) ? 'not-allowed' : 'pointer', fontWeight: 500, fontSize: '1rem', minHeight: 44 }}
          >
            Launch / Spustiť
          </button>
        </div>
      </section>

      <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '1rem' }}>Controller Input</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
          {['up', 'down', 'left', 'right', 'x', 'circle', 'square', 'triangle', 'ps', 'options', 'touchpad'].map(btn => (
            <button
              key={btn}
              onClick={() => handleInput(btn)}
              style={{ padding: '0.75rem', background: '#0f3460', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', minHeight: 44, textTransform: 'uppercase' }}
            >
              {btn}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export default PS5Control;