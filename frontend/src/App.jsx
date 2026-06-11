import { useState, useEffect, useCallback } from 'react';
import PayloadList from './components/PayloadList';
import LogViewer from './components/LogViewer';
import AutoloadBuilder from './components/AutoloadBuilder';
import PS5Control from './components/PS5Control';
import Settings from './components/Settings';
import FileOps from './components/FileOps';
import BuiltinEditor from './components/BuiltinEditor';
import { PlatformProvider, usePlatform } from './contexts/PlatformContext';
import './styles.css';

const API = '/api';

const tabs = [
  { id: 'payloads', label: 'Payloads', icon: '📦' },
  { id: 'autoload', label: 'Autoload', icon: '⚡' },
  { id: 'files', label: 'File Ops', icon: '📁' },
  { id: 'remote', label: 'P5 Control', icon: '🎮' },
  { id: 'logs', label: 'Logs', icon: '📋' },
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

  const showNotification = (message, type = 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  const fetchPayloads = useCallback(async () => {
    try {
      const res = await fetch(`${API}/payloads`);
      const data = await res.json();
      setPayloads(data);
    } catch (err) {
      console.error('Failed to fetch payloads:', err);
    }
  }, []);

  const fetchProfiles = useCallback(async () => {
    try {
      const res = await fetch(`${API}/profiles`);
      const data = await res.json();
      setProfiles(data);
    } catch (err) {
      console.error('Failed to fetch profiles:', err);
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`${API}/logs?limit=50`);
      const data = await res.json();
      setLogs(data);
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    }
  }, []);

  useEffect(() => {
    fetchPayloads();
    fetchProfiles();
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [fetchPayloads, fetchProfiles, fetchLogs]);

  useEffect(() => {
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);

  const fetchFromGitHub = async (repo, filePath) => {
    try {
      const res = await fetch(`${API}/payloads/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, path: filePath })
      });
      const data = await res.json();
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

  const fetchFromGitHubUrl = async (url) => {
    try {
      const res = await fetch(`${API}/payloads/fetch-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
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

  const sendPayload = async (payloadId) => {
    // Always honour the user-chosen default profile; profiles[0] would send
    // to whichever PS5 happens to be first in the list (often a PS4 in mixed
    // households).
    const profile = profiles.find(p => p.is_default) || profiles[0];
    if (!profile) {
      showNotification('Please create a profile first', 'error');
      return;
    }
    try {
      const res = await fetch(`${API}/payloads/send/${payloadId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: profile.ip_address, port: profile.port })
      });
      const data = await res.json();
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
      await fetch(`${API}/payloads/${id}`, { method: 'DELETE' });
      showNotification('Payload deleted', 'success');
      fetchPayloads();
      fetchLogs();
          } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const updatePayload = async (id) => {
    try {
      const res = await fetch(`${API}/payloads/${id}/update`, { method: 'PUT' });
      const data = await res.json();
      if (data.success) {
        showNotification('Payload updated', 'success');
        fetchPayloads();
        fetchLogs();
              } else {
        showNotification(data.error || 'Update failed', 'warning');
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const restoreDefaultPayloads = async (force = false) => {
    try {
      const res = await fetch(`${API}/payloads/defaults/restore${force ? '?force=1' : ''}`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const a = data.added?.length || 0;
        const s = data.skipped?.length || 0;
        const f = data.failed?.length || 0;
        showNotification(`Defaults: +${a} added, ${s} kept${f ? `, ${f} failed` : ''}`, f ? 'warning' : 'success');
        fetchPayloads();
        fetchLogs();
      } else {
        showNotification(data.error || 'Restore failed', 'error');
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const uploadPayload = async (file) => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));

      const res = await fetch(`${API}/payloads/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, data: base64 })
      });
      const data = await res.json();
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

  const createProfile = async (name, ip, mac, consoleType) => {
    try {
      await fetch(`${API}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          ip_address: ip,
          mac_address: mac,
          // consoleType may be 'ps4' | 'ps5' | null/undefined. Backend
          // normalises invalid values back to NULL = auto-detect, so we
          // can pass it through verbatim.
          console_type: consoleType ?? null,
        })
      });
      showNotification('Profile created', 'success');
      fetchProfiles();
      fetchLogs();
      // If this is the first profile, set it as default
      if (profiles.length === 0) {
        const res = await fetch(`${API}/profiles`);
        const allProfiles = await res.json();
        if (allProfiles.length === 1) {
          await fetch(`${API}/profiles/${allProfiles[0].id}/set-default`, { method: 'POST' });
          fetchProfiles();
        }
      }
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const updateProfile = async (id, name, ip, mac, consoleType) => {
    try {
      await fetch(`${API}/profiles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          ip_address: ip,
          mac_address: mac,
          // Pass undefined when caller didn't supply one (legacy callers)
          // so the backend leaves the column untouched.
          ...(consoleType !== undefined ? { console_type: consoleType } : {}),
        })
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
      await fetch(`${API}/profiles/${id}/set-default`, { method: 'POST' });
      showNotification('Default profile set', 'success');
      fetchProfiles();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const deleteProfile = async (id) => {
    try {
      await fetch(`${API}/profiles/${id}`, { method: 'DELETE' });
      showNotification('Profile deleted', 'success');
      fetchProfiles();
      fetchLogs();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const checkPs5Status = async (ip, port) => {
    try {
      const res = await fetch(`${API}/ps5/status/${ip}?port=${port || 9021}`);
      const data = await res.json();
      showNotification(data.reachable ? 'PS5 is reachable' : 'PS5 not reachable', data.reachable ? 'success' : 'warning');
      fetchLogs();
      return data.reachable;
    } catch (err) {
      showNotification(err.message, 'error');
      return false;
    }
  };

  const exportBackup = async () => {
    try {
      const res = await fetch(`${API}/backup`);
      const data = await res.json();
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
      await fetch(`${API}/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data })
      });
      showNotification('Backup imported', 'success');
      fetchProfiles();
      fetchPayloads();
      fetchLogs();
    } catch (err) {
      showNotification(err.message, 'error');
    }
  };

  const defaultProfile = profiles.find(p => p.is_default) || profiles[0];
  const [defaultStatus, setDefaultStatus] = useState(null); // { reachable, openPort }

  // Lightweight status poll for the topbar status pill. Mirrors PS5Control's
  // own poll so the indicator always reflects the default console, no matter
  // which tab the user is on.
  useEffect(() => {
    if (!defaultProfile) {
      setDefaultStatus(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`${API}/ps5/status/${defaultProfile.ip_address}?port=${defaultProfile.port || 9021}`);
        const data = await res.json();
        if (!cancelled) setDefaultStatus(data);
      } catch (_) {
        if (!cancelled) setDefaultStatus({ reachable: false });
      }
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, [defaultProfile?.ip_address, defaultProfile?.port]);

  const statusDot = (() => {
    if (!defaultProfile) return 'offline';
    if (!defaultStatus) return 'offline';
    if (!defaultStatus.reachable) return 'offline';
    // Any open payload listener (ELF 9021, Lua 9026, PS4 GoldHEN 9020,
    // PS4 web exploit 8080, etaHEN 6970) means the console is awake and
    // running a payload host - never report "standby" in that case.
    // Anything else came from the DDP discover fallback (UDP-visible
    // but no TCP listener), which is what "standby" actually represents.
    const PAYLOAD_PORTS = new Set([9021, 9026, 9020, 8080, 6970]);
    if (PAYLOAD_PORTS.has(defaultStatus.openPort)) return 'online';
    return 'standby';
  })();

  const sidebar = (
    <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
  );

  const mobileNav = (
    <MobileNav activeTab={activeTab} setActiveTab={setActiveTab} />
  );

  return (
    <PlatformProvider activeProfile={defaultProfile}>
    <>
      <header className="app-topbar">
        <PlatformAwareBrand />

        {defaultProfile && (
          <div className="app-status" title={defaultProfile.name}>
            <span className={`dot ${statusDot}`} />
            <span className="truncate">{defaultProfile.name}</span>
            <ConsoleTypeBadge consoleType={defaultStatus?.console_type || defaultProfile.console_type} />
            <span className="ip">{defaultProfile.ip_address}</span>
          </div>
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
          {!showBuiltinEditor && activeTab === 'settings' && (
            <Settings
              profiles={profiles}
              onProfileCreate={createProfile}
              onProfileUpdate={updateProfile}
              onProfileDelete={deleteProfile}
              onProfileSetDefault={setDefaultProfile}
            />
          )}
          {!showBuiltinEditor && activeTab === 'logs' && (
            <LogViewer logs={logs} onRefresh={fetchLogs} profiles={profiles} />
          )}
        </main>
      </div>

      {mobileNav}
    </>
    </PlatformProvider>
  );
}

// Brand + mode-aware subtitle. "PS4 mode" / "PS5 mode" / "PS4 / PS5" so
// the user always sees which content the rest of the UI is filtered to.
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
  return (
    <nav className="bottom-nav">
      <div className="bottom-nav-inner">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`bottom-nav-item ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="bottom-nav-icon">{tab.icon}</span>
            <span>{effectiveTabLabel(tab.id, mode) || tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
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
          Let's add your first console. Pick PS4 or PS5 in the profile form on the next screen —
          the rest of the UI then adapts to that platform automatically (payloads, autoload
          templates, Convert tools). Auto-detect via Remote Play discovery works too.
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