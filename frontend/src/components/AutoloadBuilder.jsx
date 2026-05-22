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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <h2 style={{ marginBottom: '1rem', fontSize: '1rem', fontWeight: 500 }}>Autoload Builder</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', color: '#aaa' }}>Sequence Name</label>
            <input
              type="text"
              placeholder="My Autoload"
              value={sequenceName}
              onChange={e => setSequenceName(e.target.value)}
              style={{ padding: '0.75rem', borderRadius: 6, border: '1px solid #0f3460', background: '#1a1a2e', color: '#fff', fontSize: '1rem' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <label style={{ fontSize: '0.85rem', color: '#aaa' }}>Target Profile</label>
            <select
              value={selectedProfile}
              onChange={e => setSelectedProfile(e.target.value)}
              style={{ padding: '0.75rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460', fontSize: '1rem' }}
            >
              <option value="">Select...</option>
              {profiles.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: '0.5rem' }}>
          <label style={{ fontSize: '0.85rem', color: '#aaa', display: 'block', marginBottom: '0.5rem' }}>Add Payload</label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {payloads.map(p => (
              <button
                key={p.id}
                onClick={() => addStep(p.id)}
                style={{ padding: '0.5rem 0.75rem', background: '#0f3460', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', minHeight: 36 }}
              >
                + {p.name}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <h2 style={{ fontSize: '1rem' }}>Sequence ({steps.length})</h2>
          <button
            onClick={runSequence}
            disabled={!selectedProfile || steps.length === 0}
            style={{
              padding: '0.5rem 1rem',
              background: (!selectedProfile || steps.length === 0) ? '#555' : '#27ae60',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: (!selectedProfile || steps.length === 0) ? 'not-allowed' : 'pointer',
              fontWeight: 500,
              fontSize: '0.9rem',
              minHeight: 36
            }}
          >
            Run Sequence
          </button>
        </div>

        {steps.length === 0 ? (
          <p style={{ color: '#888', textAlign: 'center', padding: '1.5rem' }}>Add payloads to build sequence</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {steps.map((step, index) => (
              <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem', background: '#0f3460', borderRadius: 6 }}>
                <span style={{ width: 24, height: 24, background: '#16213e', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: '0.8rem', flexShrink: 0 }}>
                  {index + 1}
                </span>
                <span style={{ flex: 1, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step.name}</span>
                <button onClick={() => moveStep(index, -1)} disabled={index === 0} style={{ padding: '0.25rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 4, cursor: index === 0 ? 'not-allowed' : 'pointer', opacity: index === 0 ? 0.5 : 1, minWidth: 28, minHeight: 28 }}>
                  ↑
                </button>
                <button onClick={() => moveStep(index, 1)} disabled={index === steps.length - 1} style={{ padding: '0.25rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 4, cursor: index === steps.length - 1 ? 'not-allowed' : 'pointer', opacity: index === steps.length - 1 ? 0.5 : 1, minWidth: 28, minHeight: 28 }}>
                  ↓
                </button>
                <button onClick={() => removeStep(index)} style={{ padding: '0.25rem', background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', minWidth: 28, minHeight: 28 }}>
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