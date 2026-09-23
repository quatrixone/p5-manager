import { useState, useRef, useMemo, useEffect } from 'react';
import Modal from './UI/Modal';
import EmptyState from './UI/EmptyState';
import Badge from './UI/Badge';
import ProgressBar from './UI/ProgressBar';
import { usePlatform, platformMatches } from '../contexts/PlatformContext';
import { api } from '../lib/api.js';

// Filenames the app itself depends on by name, outside the auto-fetched
// ESSENTIAL_PAYLOADS list (those come from GET /payloads/defaults below).
// These three are vendored/self-built (p5managerclient), not GitHub
// releases, so they can't live in that download-oriented list - but
// removing/renaming them breaks a specific feature just the same:
//   rp-get-pin.elf  - Remote Play PIN auto-fetch (routes/remoteplay.js)
//   offact.elf      - offline PSN account activation (routes/remoteplay.js)
//   pkg-install.elf - PKG installer, auto-bound in Settings
const VENDORED_REQUIRED_FILENAMES = ['rp-get-pin.elf', 'offact.elf', 'pkg-install.elf'];

function PayloadList({ payloads, profiles, onFetchUrl, onSend, onDelete, onUpdate, onUpload, onRestoreDefaults, assetPicker, onConfirmAssetPicker, onCancelAssetPicker }) {
  const { mode } = usePlatform();
  const [githubUrl, setGitHubUrl] = useState('');
  const [selectedAssets, setSelectedAssets] = useState(new Set());

  // Default to "all checked" whenever a new picker list arrives, and clear
  // the selection once it closes - keeps stale checks from leaking into
  // the next repo's picker.
  useEffect(() => {
    if (assetPicker) {
      setSelectedAssets(new Set(assetPicker.assets.map(a => a.name)));
    } else {
      setSelectedAssets(new Set());
    }
  }, [assetPicker]);

  const toggleAsset = (name) => {
    setSelectedAssets(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const confirmAssetPicker = () => {
    if (!assetPicker) return;
    const chosen = assetPicker.assets.filter(a => selectedAssets.has(a.name));
    if (chosen.length === 0) return;
    onConfirmAssetPicker(chosen, assetPicker.version);
  };
  const [updateInfo, setUpdateInfo] = useState({});
  const [checkingId, setCheckingId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [showAddModal, setShowAddModal] = useState(false);
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'builtin'
  const [requiredFilenames, setRequiredFilenames] = useState(new Set(VENDORED_REQUIRED_FILENAMES));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.get('/payloads/defaults');
        if (cancelled || !Array.isArray(list)) return;
        // Only 'log' and 'template' entries are actual app dependencies
        // (Log viewer, the p2jb template). 'community' entries (kstuff,
        // ps5-backpork, micromount) are pre-curated convenience downloads -
        // nothing in the app breaks without them, so they belong in All,
        // not Built-in.
        const required = list.filter(p => p.tag === 'log' || p.tag === 'template');
        setRequiredFilenames(new Set([...VENDORED_REQUIRED_FILENAMES, ...required.map(p => p.filename)]));
      } catch (_) { /* keep the vendored-only fallback */ }
    })();
    return () => { cancelled = true; };
  }, []);
  // Ref-driven hidden file input. The previous label+display:none pattern
  // worked on desktop but iOS Safari (especially in standalone PWA mode)
  // refuses to honour the synthetic click on a `display: none` input —
  // the file picker simply never opens. Pushing the input off-screen
  // instead of hiding it via `display:none` keeps it in the layout
  // tree so the user-gesture chain reaches it, and the explicit `.click()`
  // call from the visible button bypasses the label-association entirely.
  const fileInputRef = useRef(null);

  // Check button: only contacts the GitHub releases API to compare
  // versions. NEVER touches the local payload file - downloading is
  // strictly the Update button's job (see handleUpdate). This split
  // lets the user inspect what's newer before committing to a write.
  const checkForUpdate = async (payload) => {
    if (!payload.source_url || !payload.source_url.includes('github.com')) return;
    setCheckingId(payload.id);
    try {
      const data = await api.get(`/payloads/${payload.id}/check-update`);
      setUpdateInfo(prev => ({
        ...prev,
        [payload.id]: {
          checked: true,
          currentVersion: data.currentVersion || payload.version,
          newVersion: data.newVersion || null,
          updateAvailable: data.updateAvailable || false,
          error: data.error || null,
        },
      }));
    } catch (err) {
      setUpdateInfo(prev => ({ ...prev, [payload.id]: { checked: true, error: err.message } }));
    }
    setCheckingId(null);
  };

  // Update button: actually downloads + writes the new release. We
  // deliberately do NOT gate this behind a prior Check - the backend's
  // PUT /update is idempotent (re-downloads the latest release every
  // time) so a user who just wants the freshest copy can hit Update
  // straight away without the two-click dance.
  const [updatingId, setUpdatingId] = useState(null);
  const handleUpdate = async (id) => {
    setUpdatingId(id);
    try {
      const data = await api.put(`/payloads/${id}/update`);
      if (data.success && data.newVersion) {
        setUpdateInfo(prev => ({
          ...prev,
          [id]: {
            ...(prev[id] || {}),
            checked: true,
            currentVersion: data.newVersion,
            newVersion: data.newVersion,
            updateAvailable: false,
          },
        }));
        onUpdate(id);
      }
    } catch (err) {
      console.error('Update failed:', err);
    }
    setUpdatingId(null);
  };

  const handleUrlFetch = () => {
    if (!githubUrl) return;
    onFetchUrl(githubUrl);
    setShowAddModal(false);
  };

  const handleUpload = (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) {
      onUpload(file);
      setShowAddModal(false);
    }
    // Reset so picking the same file twice in a row still fires onChange.
    // Without this, iOS / Chrome keep the file selected and the second
    // attempt is a silent no-op.
    if (e.target) e.target.value = '';
  };

  const openFilePicker = () => {
    const el = fileInputRef.current;
    if (!el) return;
    // Some mobile browsers reset the value on unmount; explicit clear
    // before .click() guarantees the change event will fire even when
    // re-selecting the previously picked file. Wrapped in a try to
    // tolerate the (rare) cases where the input is detached mid-click.
    try { el.value = ''; } catch (_) {}
    el.click();
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

  // Filter by active platform mode. Untagged payloads pass through every
  // filter so legacy uploads remain visible regardless of mode.
  const platformFiltered = useMemo(
    () => payloads.filter(p => platformMatches(mode, p.console_type)),
    [payloads, mode]
  );
  const builtinPayloads = useMemo(
    () => platformFiltered.filter(p => requiredFilenames.has(p.filename)),
    [platformFiltered, requiredFilenames]
  );
  // "All" means everything EXCEPT built-ins - those live only under the
  // Built-in tab, kept out of the main list so it doesn't get cluttered
  // with payloads the user never picks to Send by hand.
  const nonBuiltinPayloads = useMemo(
    () => platformFiltered.filter(p => !requiredFilenames.has(p.filename)),
    [platformFiltered, requiredFilenames]
  );
  const visiblePayloads = activeTab === 'builtin' ? builtinPayloads : nonBuiltinPayloads;
  const hiddenCount = payloads.length - platformFiltered.length;

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
          marginBottom: 6,
          transition: 'all 0.2s',
          transform: isSelected ? 'scale(0.98)' : 'scale(1)',
          borderLeft: hasUpdate ? '3px solid var(--accent)' : '3px solid transparent',
        }}
      >
        {/* Compact item row. Padding shrunk from var(--space-md) (16 px)
            to 8 / 12 px, icon from 2rem to 1.25rem, title to 0.88rem,
            subtitle to 0.72rem. Result: each row is ~58 % the vertical
            height of the original, so a long payload list fits a lot
            more entries on screen without scrolling. */}
        <div
          className="flex items-center gap-sm"
          onClick={() => {
            if (multiSelect) toggleSelect(payload.id);
            else toggleExpand(payload.id);
          }}
          style={{ cursor: 'pointer', padding: '6px 10px' }}
        >
          {multiSelect && (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleSelect(payload.id)}
              onClick={e => e.stopPropagation()}
              style={{ width: 18, height: 18, accentColor: 'var(--accent)', cursor: 'pointer' }}
            />
          )}
          <span style={{ fontSize: '1.25rem', lineHeight: 1 }}>📦</span>
          <div className="flex-1" style={{ minWidth: 0 }}>
            <div className="flex items-center gap-xs">
              <span className="truncate" style={{ fontWeight: 600, fontSize: '0.88rem' }}>{payload.name}</span>
              {payload.console_type && (
                <span className="console-type-badge" title={`Targets ${payload.console_type.toUpperCase()}`}>
                  {payload.console_type.toUpperCase()}
                </span>
              )}
              {hasUpdate && <Badge variant="info">Update</Badge>}
            </div>
            <div className="text-muted" style={{ fontSize: '0.72rem', lineHeight: 1.3 }}>
              {formatSize(payload.size)}
              {payload.version && <span> • v{payload.version}</span>}
            </div>
          </div>
          <span style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>{isExpanded ? '▲' : '▼'}</span>
        </div>

        {isExpanded && (
          <div
            className="comp-card-footer"
            style={{ flexWrap: 'wrap', gap: 6, padding: '6px 10px' }}
          >
            {/* Check + Update are two separate actions and both are
                ALWAYS visible (when the payload has a GitHub source):
                - Check: contacts GitHub, just compares versions
                - Update: downloads the latest release file
                Update is enabled either after a Check found an update,
                or unconditionally (re-download latest) when the user
                wants to refresh without checking first. */}
            {payload.source_url && (
              <>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => checkForUpdate(payload)}
                  disabled={checkingId === payload.id}
                  title="Compare local version with the latest GitHub release. Does not download."
                >
                  {checkingId === payload.id ? '⏳' : '🔍'} Check
                </button>
                <button
                  className={`btn btn-sm ${hasUpdate ? 'btn-success' : 'btn-secondary'}`}
                  onClick={() => handleUpdate(payload.id)}
                  disabled={updatingId === payload.id}
                  title={
                    hasUpdate
                      ? `Download ${info.newVersion || 'the latest release'}`
                      : 'Re-download the latest release from GitHub.'
                  }
                >
                  {updatingId === payload.id ? '⏳ Downloading…' : `⬆️ Update${hasUpdate && info?.newVersion ? ` → ${info.newVersion}` : ''}`}
                </button>
              </>
            )}
            <button className="btn btn-sm btn-primary" onClick={() => onSend(payload.id)}>
              📤 Send
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => onDelete(payload.id)}>
              🗑️ Delete
            </button>
            {/* Inline check result — sits at the end so it never elbows
                the action buttons out of the row. */}
            {info?.checked && payload.source_url && (
              <span
                className="text-xs text-muted"
                style={{ marginLeft: 'auto', alignSelf: 'center' }}
                title={info.error ? `Error: ${info.error}` : undefined}
              >
                {info.error
                  ? `⚠ ${info.error}`
                  : info.updateAvailable
                    ? `New release: ${info.newVersion}`
                    : '✓ Up to date'}
              </span>
            )}
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
      {/* Compact list header. h2 shrunk from 1.25rem to 1rem and the
          count subtitle to 0.72rem so the chrome above the list takes
          maybe ~30 % less vertical space, leaving more room for items. */}
      <div className="flex justify-between items-center mb-sm">
        <div>
          <h2 className="font-bold" style={{ fontSize: '1rem', margin: 0, lineHeight: 1.2 }}>Payloads</h2>
          <span className="text-muted" style={{ fontSize: '0.72rem' }}>
            {visiblePayloads.length} loaded
            {hiddenCount > 0 && (
              <> · <span title={`${hiddenCount} payload(s) hidden by the ${mode.toUpperCase()} platform filter`}>{hiddenCount} hidden</span></>
            )}
          </span>
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

      <div className="tabs mb-sm" style={{ fontSize: '0.8rem' }}>
        <button
          type="button"
          className={`tab-item ${activeTab === 'all' ? 'active' : ''}`}
          onClick={() => setActiveTab('all')}
        >
          All
        </button>
        <button
          type="button"
          className={`tab-item ${activeTab === 'builtin' ? 'active' : ''}`}
          onClick={() => setActiveTab('builtin')}
          title="Payloads the app itself depends on by name - required for the Log viewer, Remote Play PIN pairing, offline account activation, the p2jb template, and the PKG installer. Deleting one breaks that feature."
        >
          🧷 Built-in{builtinPayloads.length > 0 ? ` (${builtinPayloads.length})` : ''}
        </button>
      </div>

      {payloads.length === 0 ? (
        <EmptyState
          icon="📦"
          title="No payloads yet"
          text="Add payloads to send to your console"
          action={<button className="btn btn-primary" onClick={() => setShowAddModal(true)}>+ Add Payload</button>}
        />
      ) : activeTab === 'builtin' && builtinPayloads.length === 0 ? (
        <EmptyState
          icon="🧷"
          title="No built-in payloads present"
          text="None of the app-required payloads (log viewer, PIN pairing, offline activation, p2jb, PKG installer) are on disk yet. Hit ✨ Defaults to fetch the ones that come from GitHub, or upload the vendored ones (rp-get-pin.elf, offact.elf, pkg-install.elf) manually."
          action={onRestoreDefaults && <button className="btn btn-primary" onClick={() => onRestoreDefaults(false)}>✨ Defaults</button>}
        />
      ) : visiblePayloads.length === 0 ? (
        <EmptyState
          icon="🙈"
          title={`No ${mode.toUpperCase()} payloads`}
          text={`All ${payloads.length} loaded payload(s) target the other platform. Set the default profile's console type to "Auto-detect" in Settings to see them.`}
        />
      ) : (
        <div>
          {visiblePayloads.map(renderPayloadCard)}
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
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://github.com/.../file.lua"
              value={githubUrl}
              onChange={e => setGitHubUrl(e.target.value)}
              onKeyDown={(e) => {
                // Mobile soft-keyboards expose a "Go" key — submit on
                // Enter so users don't have to dismiss the keyboard
                // first just to reach the Fetch button.
                if (e.key === 'Enter' && githubUrl) handleUrlFetch();
              }}
            />
          </div>
          <button className="btn btn-primary btn-block" onClick={handleUrlFetch} disabled={!githubUrl}>
            📥 Fetch from GitHub
          </button>
          <div className="text-center text-muted text-sm">— or —</div>
          {/* Visible button drives the hidden input via ref. The input
              is positioned off-screen (NOT display:none) so iOS Safari
              & standalone PWAs honour the .click() user-gesture chain. */}
          <button
            type="button"
            className="btn btn-secondary btn-block"
            onClick={openFilePicker}
          >
            📁 Upload File
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".lua,.elf,.bin,.zip,application/zip"
            onChange={handleUpload}
            aria-hidden="true"
            tabIndex={-1}
            style={{
              position: 'absolute',
              left: '-9999px',
              width: 1, height: 1,
              opacity: 0,
              pointerEvents: 'none',
            }}
          />
          <div className="text-xs text-muted">
            Supported: <code>.lua</code> / <code>.elf</code> (PS5) ·{' '}
            <code>.bin</code> (PS4 GoldHEN) · <code>.zip</code> (auto-extracted, only
            supported payloads inside are kept). Platform is auto-detected from the
            filename and can be changed later from the payload card.
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={!!assetPicker}
        onClose={onCancelAssetPicker}
        title="Choose files to download"
        footer={
          <>
            <button className="btn btn-ghost" onClick={onCancelAssetPicker}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={confirmAssetPicker}
              disabled={selectedAssets.size === 0}
            >
              Download {selectedAssets.size > 0 ? `(${selectedAssets.size})` : ''}
            </button>
          </>
        }
      >
        {assetPicker && (
          <div className="flex-col gap-md">
            <div className="text-sm text-muted">
              The latest release ({assetPicker.version}) has multiple matching files — pick which one(s) to download.
            </div>
            <div className="flex-col gap-sm">
              {assetPicker.assets.map(asset => (
                <label
                  key={asset.name}
                  className="flex items-center gap-sm"
                  style={{ cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={selectedAssets.has(asset.name)}
                    onChange={() => toggleAsset(asset.name)}
                  />
                  <span style={{ flex: 1 }}>{asset.name}</span>
                  <span className="text-xs text-muted">{formatSize(asset.size)}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default PayloadList;