import { useState, useRef } from 'react';
import Modal from './UI/Modal';
import EmptyState from './UI/EmptyState';
import Badge from './UI/Badge';
import ProgressBar from './UI/ProgressBar';

function PayloadList({ payloads, profiles, onFetchUrl, onSend, onDelete, onUpdate, onUpload, onRestoreDefaults }) {
  const [githubUrl, setGitHubUrl] = useState('');
  const [updateInfo, setUpdateInfo] = useState({});
  const [checkingId, setCheckingId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [showAddModal, setShowAddModal] = useState(false);

  const checkForUpdate = async (payload) => {
    if (!payload.source_url || !payload.source_url.includes('github.com')) return;
    setCheckingId(payload.id);
    try {
      const res = await fetch(`/api/payloads/${payload.id}/check-update`);
      const data = await res.json();
      setUpdateInfo(prev => ({
        ...prev,
        [payload.id]: {
          currentVersion: data.currentVersion || payload.version,
          newVersion: data.newVersion || null,
          updateAvailable: data.updateAvailable || false,
          error: data.error || null
        }
      }));
    } catch (err) {
      setUpdateInfo(prev => ({ ...prev, [payload.id]: { error: err.message } }));
    }
    setCheckingId(null);
  };

  const handleUpdate = async (id) => {
    const info = updateInfo[id];
    if (!info?.updateAvailable) return;
    try {
      const res = await fetch(`/api/payloads/${id}/update`, { method: 'PUT' });
      const data = await res.json();
      if (data.success && data.newVersion) {
        setUpdateInfo(prev => ({ ...prev, [id]: { ...prev[id], currentVersion: data.newVersion, updateAvailable: false } }));
        onUpdate(id);
      }
    } catch (err) {
      console.error('Update failed:', err);
    }
  };

  const handleUrlFetch = () => {
    if (!githubUrl) return;
    onFetchUrl(githubUrl);
    setShowAddModal(false);
  };

  const handleUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      onUpload(file);
      setShowAddModal(false);
    }
  };

  const toggleExpand = (id) => setExpandedId(expandedId === id ? null : id);

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const clearSelection = () => {
    setMultiSelect(false);
    setSelected(new Set());
  };

  const formatSize = (bytes) => {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const renderPayloadCard = (payload) => {
    const info = updateInfo[payload.id];
    const isExpanded = expandedId === payload.id;
    const isSelected = selected.has(payload.id);
    const hasUpdate = info?.updateAvailable;

    return (
      <div
        key={payload.id}
        className="comp-card"
        style={{
          marginBottom: 'var(--space-sm)',
          transition: 'all 0.2s',
          transform: isSelected ? 'scale(0.98)' : 'scale(1)',
          borderLeft: hasUpdate ? '3px solid var(--accent)' : '3px solid transparent',
        }}
      >
        <div
          className="flex items-center gap-md p-md"
          onClick={() => {
            if (multiSelect) toggleSelect(payload.id);
            else toggleExpand(payload.id);
          }}
          style={{ cursor: 'pointer' }}
        >
          {multiSelect && (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleSelect(payload.id)}
              onClick={e => e.stopPropagation()}
              style={{ width: 24, height: 24, accentColor: 'var(--accent)', cursor: 'pointer' }}
            />
          )}
          <span style={{ fontSize: '2rem' }}>📦</span>
          <div className="flex-1" style={{ minWidth: 0 }}>
            <div className="flex items-center gap-sm">
              <span className="truncate" style={{ fontWeight: 600 }}>{payload.name}</span>
              {hasUpdate && <Badge variant="info">Update</Badge>}
            </div>
            <div className="text-muted text-sm">
              {formatSize(payload.size)}
              {payload.version && <span> • v{payload.version}</span>}
            </div>
          </div>
          <span style={{ color: 'var(--muted)', fontSize: '1.2rem' }}>{isExpanded ? '▲' : '▼'}</span>
        </div>

        {isExpanded && (
          <div className="comp-card-footer" style={{ flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => checkForUpdate(payload)}
              disabled={checkingId === payload.id || !payload.source_url}
            >
              {checkingId === payload.id ? '⏳' : '🔍'} Check
            </button>
            {hasUpdate ? (
              <button className="btn btn-sm btn-success" onClick={() => handleUpdate(payload.id)}>
                ⬆️ Update
              </button>
            ) : (
              <button className="btn btn-sm btn-secondary" disabled>
                ✓ Up to date
              </button>
            )}
            <button className="btn btn-sm btn-primary" onClick={() => onSend(payload.id)}>
              📤 Send
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => onDelete(payload.id)}>
              🗑️ Delete
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderMultiSelectBar = () => {
    if (!multiSelect || selected.size === 0) return null;
    return (
      <div className="action-bar">
        <span className="text-sm">{selected.size} selected</span>
        <button className="btn btn-sm btn-danger" onClick={() => {
          selected.forEach(id => onDelete(id));
          clearSelection();
        }}>
          🗑️ Delete
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => {
          selected.forEach(id => onSend(id));
          clearSelection();
        }}>
          📤 Send
        </button>
        <button className="btn btn-sm btn-ghost" onClick={clearSelection}>✕</button>
      </div>
    );
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-md">
        <div>
          <h2 className="font-bold" style={{ fontSize: '1.25rem' }}>Payloads</h2>
          <span className="text-muted text-sm">{payloads.length} loaded</span>
        </div>
        <div className="flex gap-sm">
          {onRestoreDefaults && (
            <button
              className="btn btn-sm btn-ghost"
              title="Re-download the built-in payloads (log + templates)"
              onClick={() => onRestoreDefaults(false)}
            >
              ✨ Defaults
            </button>
          )}
          <button className="btn btn-sm btn-secondary" onClick={() => setMultiSelect(!multiSelect)}>
            {multiSelect ? '✓ Done' : '☐ Select'}
          </button>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            + Add
          </button>
        </div>
      </div>

      {payloads.length === 0 ? (
        <EmptyState
          icon="📦"
          title="No payloads yet"
          text="Add payloads to send to your PS5"
          action={<button className="btn btn-primary" onClick={() => setShowAddModal(true)}>+ Add Payload</button>}
        />
      ) : (
        <div>
          {payloads.map(renderPayloadCard)}
        </div>
      )}

      {renderMultiSelectBar()}

      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add Payload"
        footer={
          <button className="btn btn-ghost" onClick={() => setShowAddModal(false)}>Cancel</button>
        }
      >
        <div className="flex-col gap-md">
          <div>
            <label className="text-sm text-muted mb-sm" style={{ display: 'block' }}>GitHub URL</label>
            <input
              className="input"
              type="text"
              placeholder="https://github.com/.../file.lua"
              value={githubUrl}
              onChange={e => setGitHubUrl(e.target.value)}
            />
          </div>
          <button className="btn btn-primary btn-block" onClick={handleUrlFetch} disabled={!githubUrl}>
            📥 Fetch from GitHub
          </button>
          <div className="text-center text-muted text-sm">— or —</div>
          <label className="btn btn-secondary btn-block" style={{ cursor: 'pointer' }}>
            📁 Upload File
            <input type="file" accept=".lua,.elf" onChange={handleUpload} style={{ display: 'none' }} />
          </label>
        </div>
      </Modal>
    </div>
  );
}

export default PayloadList;