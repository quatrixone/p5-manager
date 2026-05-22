import { useState } from 'react';

function PayloadList({ payloads, profiles, onFetch, onSend, onDelete, onExportBackup, onImportBackup }) {
  const [repo, setRepo] = useState('cosmicflow2512/PS5-PayloadManager');
  const [filePath, setFilePath] = useState('');
  const [selectedProfile, setSelectedProfile] = useState('');

  const handleFetch = () => {
    if (!repo) return;
    onFetch(repo, filePath);
  };

  const handleImport = (e) => {
    const file = e.target.files[0];
    if (file) onImportBackup(file);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <section style={{ background: '#16213e', padding: '1.5rem', borderRadius: 12 }}>
        <h2 style={{ marginBottom: '1rem', fontSize: '1.25rem' }}>Fetch from GitHub</h2>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="owner/repo"
            value={repo}
            onChange={e => setRepo(e.target.value)}
            style={{ flex: 2, minWidth: 200, padding: '0.75rem', borderRadius: 6, border: '1px solid #0f3460', background: '#1a1a2e', color: '#fff' }}
          />
          <input
            type="text"
            placeholder="path (optional)"
            value={filePath}
            onChange={e => setFilePath(e.target.value)}
            style={{ flex: 1, minWidth: 150, padding: '0.75rem', borderRadius: 6, border: '1px solid #0f3460', background: '#1a1a2e', color: '#fff' }}
          />
          <button onClick={handleFetch} style={{ padding: '0.75rem 1.5rem', background: '#e94560', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500 }}>
            Fetch
          </button>
        </div>
      </section>

      <section style={{ background: '#16213e', padding: '1.5rem', borderRadius: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.25rem' }}>Local Payloads ({payloads.length})</h2>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <select
              value={selectedProfile}
              onChange={e => setSelectedProfile(e.target.value)}
              style={{ padding: '0.5rem', borderRadius: 6, background: '#1a1a2e', color: '#fff', border: '1px solid #0f3460' }}
            >
              <option value="">Select Profile</option>
              {profiles.map(p => (
                <option key={p.id} value={p.id}>{p.name} ({p.ip_address})</option>
              ))}
            </select>
            <button onClick={onExportBackup} style={{ padding: '0.5rem 1rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              Export Backup
            </button>
            <label style={{ padding: '0.5rem 1rem', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              Import Backup
              <input type="file" accept=".json" onChange={handleImport} style={{ display: 'none' }} />
            </label>
          </div>
        </div>

        {payloads.length === 0 ? (
          <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>No payloads loaded. Fetch from GitHub to get started.</p>
        ) : (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {payloads.map(payload => (
              <div key={payload.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', background: '#0f3460', borderRadius: 8 }}>
                <div>
                  <div style={{ fontWeight: 500 }}>{payload.name}</div>
                  <div style={{ fontSize: '0.85rem', color: '#aaa' }}>
                    {payload.size ? `${(payload.size / 1024).toFixed(1)} KB` : 'Unknown size'}
                    {payload.source_url && <span> • from GitHub</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    onClick={() => selectedProfile ? onSend(payload.id, parseInt(selectedProfile)) : alert('Select a profile first')}
                    style={{ padding: '0.5rem 1rem', background: '#e94560', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
                  >
                    Send
                  </button>
                  <button
                    onClick={() => onDelete(payload.id)}
                    style={{ padding: '0.5rem 1rem', background: '#c0392b', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
                  >
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

export default PayloadList;