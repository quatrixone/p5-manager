import { useState } from 'react';

function PayloadList({ payloads, profiles, onFetch, onFetchUrl, onSend, onDelete, onUpdate, onUpload, onExportBackup, onImportBackup }) {
  const [githubUrl, setGitHubUrl] = useState('');

  const handleUrlFetch = () => {
    if (!githubUrl) return;
    onFetchUrl(githubUrl);
  };

  const handleUpload = (e) => {
    const file = e.target.files[0];
    if (file) onUpload(file);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <div style={{ marginBottom: '0.75rem', fontSize: '1rem', fontWeight: 500 }}>Fetch from GitHub</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <input
            type="text"
            placeholder="https://github.com/owner/repo/blob/main/file.lua"
            value={githubUrl}
            onChange={e => setGitHubUrl(e.target.value)}
            style={{ padding: '0.75rem', borderRadius: 6, border: '1px solid #0f3460', background: '#1a1a2e', color: '#fff', fontSize: '1rem' }}
          />
          <button onClick={handleUrlFetch} style={{ padding: '0.75rem', background: '#e94560', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500, fontSize: '1rem', minHeight: 44 }}>
            Fetch
          </button>
        </div>
        <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#888' }}>
          Supports direct file URLs (ends in .lua, .elf) and release URLs.
        </p>
      </section>

      <section style={{ background: '#16213e', padding: '1rem', borderRadius: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <h2 style={{ fontSize: '1rem' }}>Payloads ({payloads.length})</h2>
          <label style={{ padding: '0.5rem 1rem', background: '#27ae60', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 500, fontSize: '0.9rem', minHeight: 36 }}>
            Upload File
            <input type="file" accept=".lua,.elf" onChange={handleUpload} style={{ display: 'none' }} />
          </label>
        </div>

        {payloads.length === 0 ? (
          <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>No payloads loaded. Fetch from GitHub to get started.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {payloads.map(payload => (
              <div key={payload.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem', background: '#0f3460', borderRadius: 8 }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: '0.95rem' }}>{payload.name}</div>
                  <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
                    {payload.size ? `${(payload.size / 1024).toFixed(1)} KB` : 'Unknown size'}
                    {payload.version && <span> • v{payload.version}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {payload.source_url && (
                    <button
                      onClick={() => onUpdate(payload.id)}
                      style={{ padding: '0.5rem 0.75rem', background: '#f39c12', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', minHeight: 36 }}
                    >
                      Update
                    </button>
                  )}
                  <button
                    onClick={() => onSend(payload.id)}
                    style={{ padding: '0.5rem 0.75rem', background: '#e94560', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', minHeight: 36 }}
                  >
                    Send
                  </button>
                  <button
                    onClick={() => onDelete(payload.id)}
                    style={{ padding: '0.5rem 0.75rem', background: '#c0392b', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem', minHeight: 36 }}
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