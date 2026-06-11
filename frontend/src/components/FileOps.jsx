import { useState, useEffect, useCallback } from 'react';
import Convert from './Convert';
import Downloader from './Downloader';
import Queue from './Queue';
import FileBrowser from './FileBrowser';
import useVisiblePolling from '../hooks/useVisiblePolling';

const API = '/api';
const STORAGE_TAB = 'fileops.tab';

// Counts of "in flight" items per queue type. Polled centrally here so each
// tab badge stays in sync and we only hit the queue endpoints once per cycle.
function useQueueCounts() {
  const [counts, setCounts] = useState({
    download: 0,
    extract: 0,
    convert: 0,
    upload: 0,
    total: 0,
  });

  const refresh = useCallback(async () => {
    try {
      const [qRes, dlRes] = await Promise.all([
        fetch(`${API}/convert/queue/all`),
        fetch(`${API}/downloader`),
      ]);
      const q = qRes.ok ? await qRes.json() : {};
      const dl = dlRes.ok ? await dlRes.json() : [];
      const isActive = (s) => ['queued', 'running', 'starting', 'staging', 'pushing', 'unpacking'].includes(s);
      const c = {
        extract: (q?.extract?.items || []).filter(i => isActive(i.status)).length,
        convert: (q?.convert?.items || []).filter(i => isActive(i.status)).length,
        upload: (q?.upload?.items || []).filter(i => isActive(i.status)).length,
        download: (Array.isArray(dl) ? dl : []).filter(j => isActive(j.status)).length,
      };
      c.total = c.extract + c.convert + c.upload + c.download;
      setCounts(c);
    } catch (_) { /* keep last good value */ }
  }, []);

  // 4 s while the File Ops shell is visible. The tab badges only need to
  // surface "is there anything cooking right now" — the actual queue page
  // does its own 2 s refresh. Bumped from 2.5 s and visibility-gated so a
  // background tab doesn't keep hammering /api/convert/queue/all.
  useVisiblePolling(refresh, 4000);

  return counts;
}

const TABS = [
  { key: 'files',    label: 'Browse',   icon: '📁', countKeys: ['upload', 'extract'] },
  { key: 'convert',  label: 'Convert',  icon: '🔄', countKeys: ['convert'] },
  { key: 'download', label: 'Download', icon: '⬇️', countKeys: ['download'] },
  // 'queue' key kept stable for localStorage migration; the label is now
  // "Tasks" everywhere users see it.
  { key: 'queue',    label: 'Tasks',    icon: '📋', countKeys: ['download', 'extract', 'convert', 'upload'] },
];

export default function FileOps({ profiles, onNotification }) {
  const [subTab, setSubTab] = useState(() => {
    try { return localStorage.getItem(STORAGE_TAB) || 'files'; } catch (_) { return 'files'; }
  });
  // When a file is "Convert now"-d from a different sub-tab, we stash it and
  // bounce to the Convert tab which picks it up via `initialPick`.
  const [pendingConvertPick, setPendingConvertPick] = useState(null);

  const counts = useQueueCounts();

  const switchTab = useCallback((next) => {
    setSubTab(next);
    try { localStorage.setItem(STORAGE_TAB, next); } catch (_) {}
  }, []);

  const openQueue = useCallback(() => switchTab('queue'), [switchTab]);
  const sendToConvert = useCallback((pick) => {
    setPendingConvertPick(pick);
    switchTab('convert');
  }, [switchTab]);

  return (
    <div className="fileops">
      <header className="fileops-header">
        <div className="fileops-title">
          <span className="fileops-title-icon" aria-hidden>📂</span>
          <div className="fileops-title-text">
            <div className="fileops-title-h">Files &amp; Operations</div>
            <div className="fileops-title-sub">
              Browse local, SMB and PS5 FTP · Upload / Download / Convert / Extract — all from one ⋮ menu
            </div>
          </div>
        </div>
        {/* The "N active jobs" / "Idle" status pill used to live here, but
            it duplicated the badge that the Tasks tab already shows in the
            nav below — the user only needs one activity indicator. */}
      </header>

      <nav className="fileops-tabs" role="tablist">
        {TABS.map(t => {
          const n = (t.countKeys || []).reduce((acc, k) => acc + (counts[k] || 0), 0);
          const active = subTab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              className={`fileops-tab ${active ? 'is-active' : ''}`}
              onClick={() => switchTab(t.key)}
            >
              <span className="fileops-tab-icon" aria-hidden>{t.icon}</span>
              <span className="fileops-tab-label">{t.label}</span>
              {n > 0 && <span className="fileops-tab-badge">{n}</span>}
            </button>
          );
        })}
      </nav>

      <div className="fileops-body">
        {subTab === 'files' && (
          <FileBrowser
            profiles={profiles}
            onNotification={onNotification}
            enableFtp enableExtract enableDelete enableFtpUpload
            onOpenQueue={openQueue}
            onPickConvert={sendToConvert}
          />
        )}
        {subTab === 'convert' && (
          <Convert
            profiles={profiles}
            onNotification={onNotification}
            onOpenQueue={openQueue}
            initialPick={pendingConvertPick}
            onPickConsumed={() => setPendingConvertPick(null)}
          />
        )}
        {subTab === 'download' && (
          <Downloader
            profiles={profiles}
            onNotification={onNotification}
            onOpenQueue={openQueue}
          />
        )}
        {subTab === 'queue' && <Queue />}
      </div>
    </div>
  );
}
