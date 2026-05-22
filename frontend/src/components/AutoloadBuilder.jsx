import { useState } from 'react';

function AutoloadBuilder({ profiles, payloads }) {
  const [selectedProfile, setSelectedProfile] = useState('');
  const [sequenceName, setSequenceName] = useState('');
  const [steps, setSteps] = useState([]);

  const addStep = (payloadId) => {
    const payload = payloads.find(p => p.id === payloadId);
    if (!payload) return;
    setSteps([...steps, { payloadId, name: payload.name }]);
  };

  const removeStep = (index) => {
    setSteps(steps.filter((_, i) => i !== index));
  };

  const moveStep = (index, direction) => {
    const newSteps = [...steps];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= newSteps.length) return;
    [newSteps[index], newSteps[targetIndex]] = [newSteps[targetIndex], newSteps[index]];
    setSteps(newSteps);
  };

  const runSequence = async () => {
    if (!selectedProfile || steps.length === 0) return;
    const profile = profiles.find(p => p.id === parseInt(selectedProfile));
    if (!profile) return;

    alert(`Starting autoload sequence "${sequenceName || 'Unnamed'}" on ${profile.name} with ${steps.length} steps`);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <section style={{ background: '#16213e', padding: '1.5rem', borderRadius: 12 }}>
        <h2 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>Autoload Builder</h2>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', color: '#aaa' }}>Sequence Name</label>
            <input
              type="text"
              placeholder="My Autoload"
              value={sequenceName}
              onChange={e => setSequenceName(e.target.value)}
              style={{ padding: '0.75rem', borderRadius: 6, border: '1px solid #0f3460', background: '#1a1a2e', color: '#fff', width: 180 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', color: '#aaa' }}>Target Profile</label>
            <select
              value={selectedProfile}
              onChange={e => setSelectedProfile(e.target.value)}
              style={{ padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', minWidth: 180 }}
            >
              <option value="">Select...</option>
              {profiles.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ fontSize: '0.85rem', color: '#aaa', display: 'block', marginBottom: '0.5rem' }}>Add Payload</label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {payloads.map(p => (
              <button
                key={p.id}
                onClick={() => addStep(p.id)}
                style={{ padding: '0.5rem 1rem', background: '#0f3460', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
              >
                + {p.name}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section style={{ background: '#16213e', padding: '1.5rem', borderRadius: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.25rem' }}>Sequence ({steps.length} steps)</h2>
          <button
            onClick={runSequence}
            disabled={!selectedProfile || steps.length === 0}
            style={{
              padding: '0.75rem 1.5rem',
              background: (!selectedProfile || steps.length === 0) ? '#555' : '#27ae60',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: (!selectedProfile || steps.length === 0) ? 'not-allowed' : 'pointer',
              fontWeight: 500
            }}
          >
            Run Sequence
          </button>
        </div>

        {steps.length === 0 ? (
          <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>Add payloads to build sequence</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {steps.map((step, index) => (
              <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem', background: '#0f3460', borderRadius: 6 }}>
                <span style={{ width: 30, height: 30, background: '#16213e', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600 }}>
                  {index + 1}
                </span>
                <span style={{ flex: 1 }}>{step.name}</span>
                <button onClick={() => moveStep(index, -1)} disabled={index === 0} style={{ padding: '0.25rem 0.5rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 4, cursor: index === 0 ? 'not-allowed' : 'pointer', opacity: index === 0 ? 0.5 : 1 }}>
                  ↑
                </button>
                <button onClick={() => moveStep(index, 1)} disabled={index === steps.length - 1} style={{ padding: '0.25rem 0.5rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 4, cursor: index === steps.length - 1 ? 'not-allowed' : 'pointer', opacity: index === steps.length - 1 ? 0.5 : 1 }}>
                  ↓
                </button>
                <button onClick={() => removeStep(index)} style={{ padding: '0.25rem 0.5rem', background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default AutoloadBuilder;