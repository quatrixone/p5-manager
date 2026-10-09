import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import PayloadList from './components/PayloadList';
import Tools from './components/Tools';
import AutoloadBuilder from './components/AutoloadBuilder';
import PS5Control from './components/PS5Control';
import Settings from './components/Settings';
import FileOps from './components/FileOps';
import Library from './components/Library';
import BuiltinEditor from './components/BuiltinEditor';
import UpdateBanner from './components/UpdateBanner';
import { PlatformProvider, usePlatform } from './contexts/PlatformContext';
import { Ps5StatusProvider, usePs5Status } from './contexts/Ps5StatusContext';
import useVisiblePolling from './hooks/useVisiblePolling';
import { api, apiSafe } from './lib/api.js';
import './styles.css';

const tabs = [
  { id: 'payloads', label: 'Payloads', icon: '📦' },
  { id: 'autoload', label: 'Autoload', icon: '⚡' },
  { id: 'files', label: 'File Ops', icon: '📁' },
  { id: 'library', label: 'Library', icon: '🕹️' },
  { id: 'remote', label: 'P5 Control', icon: '🎮' },
  { id: 'tools', label: 'Tools', icon: '🧰' },
  { id: 'settings', label: 'Settings', icon: '⚙️' }
];

// Hidden route: the built-in editor lives at #builtin. It is intentionally
// absent from `tabs` so it doesn't show up in the sidebar / bottom nav.
// Settings → Config has a discreet "Edit built-ins" link to discover it.
const BUILTIN_HASH = '#builtin';
const readHashRoute = () => (typeof window !== 'undefined' && window.location.hash === BUILTIN_HASH);

function App() {
  const [activeTab, setActiveTab] = useState(() => {
    const saved = localStorage.getItem('activeTab');
    // Dashboard and standalone remoteplay tabs were removed - migrate.
    if (!saved || saved === 'dashboard') return 'payloads';
    if (saved === 'remoteplay') return 'remote';
    // Logs moved into Tools.
    if (saved === 'logs') return 'tools';
    return saved;
  });
  const [showBuiltinEditor, setShowBuiltinEditor] = useState(readHashRoute);

  // Sync state with hash changes (browser back/forward, manual edits).
  useEffect(() => {
    const onHash = () => setShowBuiltinEditor(readHashRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const closeBuiltinEditor = () => {
    if (window.location.hash === BUILTIN_HASH) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    setShowBuiltinEditor(false);
  };
  const [payloads, setPayloads] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [logs, setLogs] = useState([]);
  const [notification, setNotification] = useState(null);
  // Set when /fetch-url resolves a bare repo URL to a release with more
  // than one matching asset - PayloadList renders a picker modal off this
  // instead of the backend silently downloading everything.
  const [assetPicker, setAssetPicker] = useState(null);

  const showNotification = (message, type = 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  const fetchPayloads = useCallback(async () => {
    const data = await apiSafe.get('/payloads');
    if (Array.isArray(data)) setPayloads(data);
  }, []);

  const fetchProfiles = useCallback(async () => {
    const data = await apiSafe.get('/profiles');
    if (Array.isArray(data)) setProfiles(data);
  }, []);

  const fetchLogs = useCallback(async () => {
    const data = await apiSafe.get('/logs?limit=50');
    if (Array.isArray(data)) setLogs(data);
  }, []);

  // One-shot loads on first mount (payloads + profiles); logs use the
  // visibility-aware poller below so the request stops while the tab is
  // hidden. fetchPayloads/Profiles don't need polling at all — they're
  // refreshed explicitly whenever the user mutates them.
  useEffect(() => {
    fetchPayloads();
    fetchProfiles();
  }, [fetchPayloads, fetchProfiles]);

  // 5 s while the app is foregrounded. The server-side log buffer is
  // append-only so a slightly slower cadence costs nothing user-visible,
  // and the visibility gate means a backgrounded browser tab stops
  // making the call entirely.
  useVisiblePolling(fetchLogs, 5000);

  useEffect(() => {
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);

  const fetchFromGitHub = async (repo, filePath) => {
    try {
      const data = await api.post('/payloads/fetch', { repo, path: filePath });
      if (data.success) {
        showNotification(`Downloaded ${data.downloaded.length} payload(s)`, 'success');
        fetchPayloads();
        fetchLogs();
      } else {
        showNotification(data.error, 'error');
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const activeConsoleType = () => {
    const profile = profiles.find(p => p.is_default) || profiles[0];
    const type = String(profile?.console_type || '').toLowerCase();
    return type === 'ps4' || type === 'ps5' ? type : undefined;
  };

  const fetchFromGitHubUrl = async (url, consoleType = activeConsoleType()) => {
    try {
      const data = await api.post('/payloads/fetch-url', { url, console_type: consoleType });
      if (data.needsSelection) {
        setAssetPicker({ assets: data.assets, version: data.version, console_type: consoleType });
        return;
      }
      if (data.success) {
        showNotification(`Downloaded ${data.downloaded.length} payload(s)`, 'success');
        fetchPayloads();
        fetchLogs();
      } else {
        showNotification(data.error, 'error');
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  // Confirms the user's choice from the asset picker opened above.
  // `assets` is the subset of { name, size, download_url } the user
  // checked; the backend downloads exactly those and nothing else.
  const fetchSelectedAssets = async (assets, version, consoleType = activeConsoleType()) => {
    try {
      const data = await api.post('/payloads/fetch-assets', { assets, version, console_type: consoleType });
      if (data.success) {
        showNotification(`Downloaded ${data.downloaded.length} payload(s)`, 'success');
        fetchPayloads();
        fetchLogs();
      } else {
        showNotification(data.error, 'error');
      }
    } catch (err) {
      showNotification(err.message, 'error');
    } finally {
      setAssetPicker(null);
    }
  };

  const sendPayload = async (payloadId) => {
    // Always honour the user-chosen default profile; profiles[0] would send
    // to whichever PS5 happens to be first in the list (often a PS4 in mixed
    // households).
    const profile = profiles.find(p => p.is_default) || profiles[0];
    if (!profile) {
      showNotification('Add a console in Settings before continuing.', 'error');
      return;
    }
    try {
      const data = await api.post(`/payloads/send/${payloadId}`, { ip: profile.ip_address, port: profile.port });
      if (data.success) {
        showNotification(`Payload sent to ${profile.name}`, 'success');
      } else {
        showNotification(data.error, 'error');
      }
      fetchLogs();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const deletePayload = async (id) => {
    try {
      await api.del(`/payloads/${id}`);
      showNotification('Payload deleted', 'success');
      fetchPayloads();
      fetchLogs();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  // Returns the backend's answer so PayloadList can show the new version
  // without issuing a second PUT of its own (it used to: every Update
  // downloaded the release twice).
  const updatePayload = async (id) => {
    try {
      const data = await api.put(`/payloads/${id}/update`);
      if (data.success) {
        showNotification(data.name ? `Updated to ${data.name}` : 'Payload updated', 'success');
        fetchPayloads();
        fetchLogs();
      } else {
        showNotification(data.error || 'Update failed', 'warning');
      }
      return data;
    } catch (error) {
      showNotification(error.message || 'Update failed', 'error');
      return null;
    }
  };

  const restoreDefaultPayloads = async (force = false) => {
    try {
      const data = await api.post(`/payloads/defaults/restore${force ? '?force=1' : ''}`);
      if (data.success) {
        const a = data.added?.length || 0;
        const s = data.skipped?.length || 0;
        const f = data.failed?.length || 0;
        showNotification(`Built-in payloads restored: ${a} added, ${s} already present${f ? `, ${f} failed` : ''}`, f ? 'warning' : 'success');
        fetchPayloads();
        fetchLogs();
      } else {
        showNotification(data.error || 'Restore failed', 'error');
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const uploadPayload = async (file, consoleType = activeConsoleType()) => {
    try {
      // FileReader's native base64 encoding, not a byte-by-byte
      // String.fromCharCode reduce() — that approach blocks the main
      // thread for seconds on multi-MB payloads (SpectrumLibrary is
      // ~5 MB) and on some browsers looks like the upload silently did
      // nothing at all.
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1] || '');
        reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });

      const data = await api.post('/payloads/upload', { name: file.name, data: base64, console_type: consoleType });
      if (data.success) {
        // ZIP uploads return { zip: true, extracted: [...], skipped: [...] }
        // so the user immediately sees how many payloads landed and how
        // many were dropped (e.g. README.md, source files, etc.).
        if (data.zip) {
          const n = data.extracted?.length || 0;
          const s = data.skipped?.length || 0;
          showNotification(
            `Extracted ${n} payload${n === 1 ? '' : 's'} from ZIP${s ? ` · skipped ${s} unsupported file${s === 1 ? '' : 's'}` : ''}`,
            n > 0 ? 'success' : 'warning'
          );
        } else {
          showNotification('Payload uploaded', 'success');
        }
        fetchPayloads();
        fetchLogs();
      } else {
        showNotification(data.error, 'error');
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const createProfile = async (name, ip, mac, consoleType, ftpPort) => {
    try {
      // consoleType may be 'ps4' | 'ps5' | null/undefined. Backend
      // normalises invalid values back to NULL = auto-detect.
      await api.post('/profiles', {
        name,
        ip_address: ip,
        mac_address: mac,
        console_type: consoleType ?? null,
        // '' = no own port, follow the console type.
        ftp_port: ftpPort ?? '',
      });
      showNotification('Profile created', 'success');
      fetchProfiles();
      fetchLogs();
      if (profiles.length === 0) {
        const allProfiles = await apiSafe.get('/profiles');
        if (Array.isArray(allProfiles) && allProfiles.length === 1) {
          await apiSafe.post(`/profiles/${allProfiles[0].id}/set-default`);
          fetchProfiles();
        }
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const updateProfile = async (id, name, ip, mac, consoleType, ftpPort) => {
    try {
      // Skip console_type entirely when caller didn't supply one so the
      // backend leaves the column untouched (legacy callers).
      await api.put(`/profiles/${id}`, {
        name,
        ip_address: ip,
        mac_address: mac,
        ...(consoleType !== undefined ? { console_type: consoleType } : {}),
        ...(ftpPort !== undefined ? { ftp_port: ftpPort } : {}),
      });
      showNotification('Profile updated', 'success');
      fetchProfiles();
      fetchLogs();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const setDefaultProfile = async (id) => {
    try {
      await api.post(`/profiles/${id}/set-default`);
      showNotification('Default console updated', 'success');
      fetchProfiles();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const deleteProfile = async (id) => {
    try {
      await api.del(`/profiles/${id}`);
      showNotification('Console removed', 'success');
      fetchProfiles();
      fetchLogs();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const checkPs5Status = async (ip, port) => {
    try {
      const data = await api.get(`/ps5/status/${ip}?port=${port || 9021}`);
      const consoleName = profiles.find(profile => profile.ip_address === ip)?.name || 'Console';
      showNotification(data.reachable ? `${consoleName} is reachable` : `${consoleName} is not reachable`, data.reachable ? 'success' : 'warning');
      fetchLogs();
      return data.reachable;
    } catch (err) {
      showNotification(err.message, 'error');
      return false;
    }
  };

  const exportBackup = async () => {
    try {
      const data = await api.get('/backup');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ps5-backup-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showNotification('Backup exported', 'success');
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const importBackup = async (file) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await api.post('/backup', { data });
      showNotification('Backup imported', 'success');
      fetchProfiles();
      fetchPayloads();
      fetchLogs();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const defaultProfile = profiles.find(p => p.is_default) || profiles[0];

  const sidebar = (
    <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
  );

  const mobileNav = (
    <MobileNav activeTab={activeTab} setActiveTab={setActiveTab} />
  );

  return (
    <PlatformProvider activeProfile={defaultProfile}>
    <Ps5StatusProvider key={defaultProfile?.id || 'none'} profile={defaultProfile}>
    <>
      <header className="app-topbar">
        <PlatformAwareBrand />
        {defaultProfile && (
          <TopbarPs5Status
            profile={defaultProfile}
            profiles={profiles}
            onSwitch={setDefaultProfile}
            onManage={() => setActiveTab('settings')}
          />
        )}
      </header>

      {notification && (
        <div className={`app-toast ${notification.type || 'info'}`}>
          {notification.message}
        </div>
      )}

      {/* First-run onboarding: empty DB → nudge the user into Settings to
          add their first profile. The platform mode then follows the new
          profile's console_type automatically. */}
      <FirstRunOnboarding
        profiles={profiles}
        onStart={() => setActiveTab('settings')}
      />

      <div className="app-shell">
        {sidebar}

        <main className="app-main">
          <UpdateBanner onNotification={showNotification} />
          {showBuiltinEditor && (
            <BuiltinEditor onClose={closeBuiltinEditor} onNotification={showNotification} />
          )}
          {!showBuiltinEditor && activeTab === 'payloads' && (
            <PayloadList
              payloads={payloads}
              profiles={profiles}
              onFetchUrl={fetchFromGitHubUrl}
              onSend={sendPayload}
              onDelete={deletePayload}
              onUpdate={updatePayload}
              onUpload={uploadPayload}
              onRestoreDefaults={restoreDefaultPayloads}
              assetPicker={assetPicker}
              onConfirmAssetPicker={fetchSelectedAssets}
              onCancelAssetPicker={() => setAssetPicker(null)}
            />
          )}
          {!showBuiltinEditor && activeTab === 'autoload' && (
            <AutoloadBuilder profiles={profiles} payloads={payloads} onNotification={showNotification} />
          )}
          {!showBuiltinEditor && activeTab === 'remote' && (
            <PS5Control profiles={profiles} onNotification={showNotification} onProfilesChanged={fetchProfiles} />
          )}
          {!showBuiltinEditor && activeTab === 'files' && (
            <FileOps profiles={profiles} onNotification={showNotification} />
          )}
          {!showBuiltinEditor && activeTab === 'library' && (
            <Library profiles={profiles} onNotification={showNotification} />
          )}
          {!showBuiltinEditor && activeTab === 'settings' && (
            <Settings
              profiles={profiles}
              onProfileCreate={createProfile}
              onProfileUpdate={updateProfile}
              onProfileDelete={deleteProfile}
              onProfileSetDefault={setDefaultProfile}
            />
          )}
          {!showBuiltinEditor && activeTab === 'tools' && (
            <Tools logs={logs} onRefreshLogs={fetchLogs} profiles={profiles} onNotification={showNotification} />
          )}
        </main>
      </div>

      {mobileNav}
    </>
    </Ps5StatusProvider>
    </PlatformProvider>
  );
}

// Brand + mode-aware subtitle. "PS4 mode" / "PS5 mode" / "PS4 / PS5" so
// the user always sees which content the rest of the UI is filtered to.
// Reads the shared Ps5StatusContext instead of polling on its own - see
// Ps5StatusContext.jsx for why this used to be a second, conflicting
// poller (a TCP payload-port check independent of PS5 Control's DDP
// check, which made the dot flash red right when "Wake PS5" was clicked
// even though the console really was waking up).
// The pill is also the console switcher: a click lists the profiles and
// picking one makes it the default, which is the console the whole UI works
// with.
function TopbarPs5Status({ profile, profiles = [], onSwitch, onManage }) {
  const { state, portStatus } = usePs5Status();
  const [open, setOpen] = useState(false);
  const label = {
    online: portStatus?.reachable ? 'Payload host up' : 'Console online',
    waking: 'Waking…',
    standby: 'In rest mode',
    offline: 'Unreachable',
  }[state];
  const pick = (id) => {
    setOpen(false);
    if (id !== profile.id) onSwitch?.(id);
  };
  return (
    <div className="app-status-wrap">
      <button
        type="button"
        className="app-status"
        title={`${profile.name} — ${label}. Select to switch consoles.`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className={`dot ${state}`} />
        <span className="truncate">{profile.name}</span>
        <ConsoleTypeBadge consoleType={portStatus?.console_type || profile.console_type} />
        <span className="ip">{profile.ip_address}</span>
        <span className="app-status-caret" aria-hidden="true">▾</span>
      </button>
      {/* In a portal: the top bar's backdrop-filter would otherwise confine
          the fixed backdrop to the bar itself. */}
      {open && createPortal(
        <>
          <div className="app-status-backdrop" onClick={() => setOpen(false)} />
          <div className="app-status-menu" role="menu">
            <div className="app-status-menu-title">Console</div>
            {profiles.map(p => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={p.id === profile.id}
                className={`app-status-menu-item ${p.id === profile.id ? 'active' : ''}`}
                onClick={() => pick(p.id)}
              >
                <span className="app-status-menu-check">{p.id === profile.id ? '✓' : ''}</span>
                <span className="truncate" style={{ flex: 1, minWidth: 0 }}>{p.name}</span>
                <ConsoleTypeBadge consoleType={p.console_type} />
                <span className="ip">{p.ip_address}</span>
              </button>
            ))}
            <button type="button" className="app-status-menu-item app-status-menu-manage" onClick={() => { setOpen(false); onManage?.(); }}>
              ⚙ Add or edit consoles…
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

function PlatformAwareBrand() {
  const { mode } = usePlatform();
  const subtitle = mode === 'ps4' ? 'PS4 mode'
    : mode === 'ps5' ? 'PS5 mode'
    : 'PS4 / PS5';
  return (
    <div className="app-brand">
      <span className="app-brand-mark">P5</span>
      <span>Manager</span>
      <span className="app-brand-subtitle" title={`Platform filter: ${subtitle}`}>{subtitle}</span>
    </div>
  );
}

// Tab label resolver — the "Console / PS5 Control / PS4 Control" label
// is the only tab that needs to flex with the platform mode. Everything
// else keeps its static label.
function effectiveTabLabel(tabId, mode) {
  if (tabId !== 'remote') return null;
  if (mode === 'ps4') return 'PS4 Control';
  if (mode === 'ps5') return 'PS5 Control';
  return 'Console';
}

function Sidebar({ activeTab, setActiveTab }) {
  const { mode } = usePlatform();
  return (
    <aside className="app-sidebar">
      <h6>Workspace</h6>
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={`nav-item ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => setActiveTab(tab.id)}
        >
          <span className="nav-item-icon">{tab.icon}</span>
          <span>{effectiveTabLabel(tab.id, mode) || tab.label}</span>
        </button>
      ))}
    </aside>
  );
}

function MobileNav({ activeTab, setActiveTab }) {
  const { mode } = usePlatform();
  const [moreOpen, setMoreOpen] = useState(false);
  const primaryIds = ['files', 'library', 'remote', 'payloads'];
  const primaryTabs = tabs.filter(tab => primaryIds.includes(tab.id));
  const moreTabs = tabs.filter(tab => !primaryIds.includes(tab.id));
  const selectTab = (id) => {
    setActiveTab(id);
    setMoreOpen(false);
  };
  useEffect(() => {
    if (!moreOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => { if (event.key === 'Escape') setMoreOpen(false); };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [moreOpen]);
  return (
    <>
      <nav className="bottom-nav" aria-label="Main navigation">
        <div className="bottom-nav-inner">
          {primaryTabs.map(tab => (
            <button
              key={tab.id}
              className={`bottom-nav-item ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => selectTab(tab.id)}
              aria-current={activeTab === tab.id ? 'page' : undefined}
            >
              <span className="bottom-nav-icon" aria-hidden="true">{tab.icon}</span>
              <span>{effectiveTabLabel(tab.id, mode) || tab.label}</span>
            </button>
          ))}
          <button
            className={`bottom-nav-item bottom-nav-more ${moreOpen || moreTabs.some(tab => tab.id === activeTab) ? 'active' : ''}`}
            onClick={() => setMoreOpen(open => !open)}
            aria-expanded={moreOpen}
            aria-haspopup="dialog"
          >
            <span className="bottom-nav-icon" aria-hidden="true">···</span>
            <span>More</span>
          </button>
        </div>
      </nav>
      {moreOpen && createPortal(
        <>
          <button className="mobile-more-backdrop" aria-label="Close more navigation" onClick={() => setMoreOpen(false)} />
          <section className="mobile-more-sheet" role="dialog" aria-modal="true" aria-label="More sections">
            <div className="mobile-more-sheet-head">
              <div>
                <strong>More</strong>
                <div className="text-xs text-muted">Tools and settings</div>
              </div>
              <button className="btn btn-icon btn-ghost" onClick={() => setMoreOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="mobile-more-grid">
              {moreTabs.map(tab => (
                <button
                  key={tab.id}
                  className={`mobile-more-item ${activeTab === tab.id ? 'active' : ''}`}
                  onClick={() => selectTab(tab.id)}
                  aria-current={activeTab === tab.id ? 'page' : undefined}
                >
                  <span className="mobile-more-icon" aria-hidden="true">{tab.icon}</span>
                  <span>{effectiveTabLabel(tab.id, mode) || tab.label}</span>
                  {activeTab === tab.id && <span className="mobile-more-check" aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          </section>
        </>,
        document.body,
      )}
    </>
  );
}

// First-run onboarding. Renders nothing once the user has at least one
// profile OR has explicitly dismissed the welcome card. Sends the user
// straight into Settings to add their first profile — at which point
// they pick the console type in the form and the rest of the UI follows
// it automatically (no separate platform switch).
function FirstRunOnboarding({ profiles, onStart }) {
  const STORAGE_KEY = 'p5-manager-onboarded';
  const [dismissed, setDismissed] = useState(() => {
    try { return !!localStorage.getItem(STORAGE_KEY); } catch (_) { return false; }
  });

  if (dismissed) return null;
  if (!Array.isArray(profiles) || profiles.length > 0) return null;

  const finish = () => {
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch (_) {}
    setDismissed(true);
    onStart?.();
  };

  return (
    <div className="onboarding-overlay" role="dialog" aria-labelledby="onboarding-title">
      <div className="onboarding-card">
        <h2 id="onboarding-title" className="onboarding-title">Welcome to P5 Manager</h2>
        <p className="onboarding-body">
          Add your PS4 or PS5 from the next screen. The app will show the tools and payloads
          for that console automatically. You can find it on your network or add it yourself.
        </p>
        <div className="onboarding-actions">
          <button className="btn btn-primary" onClick={finish}>
            ➕ Add my first console
          </button>
          <button className="btn btn-ghost onboarding-skip" onClick={finish}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}

// Small platform badge shown next to the profile name in the status pill.
// Reads the live host_type returned by /api/ps5/status (preferred) or
// falls back to the persisted profile.console_type.
function ConsoleTypeBadge({ consoleType }) {
  if (!consoleType) return null;
  const label = consoleType === 'ps4' ? 'PS4' : (consoleType === 'ps5' ? 'PS5' : null);
  if (!label) return null;
  return <span className="console-type-badge" aria-label={`Detected ${label}`}>{label}</span>;
}

export default App;
