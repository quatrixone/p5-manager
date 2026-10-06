import { useRef, useState } from 'react';
import useVisiblePolling from '../hooks/useVisiblePolling';
import { api, apiSafe } from '../lib/api.js';

// "A new version is out" bar under the top bar. The backend checks GitHub
// Releases and installs the new code itself (routes/update.js); where it
// cannot - the release needs a newer image - the bar says so and links to
// the release.
const DISMISS_KEY = 'update:dismissedVersion';

export default function UpdateBanner({ onNotification }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) || ''; } catch (_) { return ''; }
  });
  // Version this page was loaded with: once the server reports another one
  // the container has been swapped, so load the new frontend.
  const loadedVersion = useRef(null);
  const jobState = status?.job?.state;
  const updating = busy || jobState === 'downloading' || jobState === 'installing' || jobState === 'restarting';

  useVisiblePolling(async () => {
    const s = await apiSafe.get('/update/status');
    if (!s) return; // the app is restarting mid-update
    if (loadedVersion.current == null) loadedVersion.current = s.current;
    else if (s.current !== loadedVersion.current) { window.location.reload(); return; }
    if (busy && s.job?.state === 'failed') {
      setBusy(false);
      onNotification?.(`Update failed: ${s.job.error}`, 'error');
    } else if (busy && !s.job) {
      // Back up without the new version: the new code did not start and the
      // loader went back to the previous one.
      setBusy(false);
      if (s.last_result && !s.last_result.ok) onNotification?.(s.last_result.message, 'error');
    }
    setStatus(s);
  }, updating ? 4000 : 30 * 60 * 1000, [updating]);

  if (!status?.update_available) return null;
  const version = status.latest.version;
  if (!updating && dismissed === version) return null;

  const update = async () => {
    if (!window.confirm(`Update P5 Manager ${status.current} → ${version}?\n\nThe app downloads the new version and restarts; running transfers and Autoload sequences are interrupted.`)) return;
    setBusy(true);
    try {
      await api.post('/update/apply');
    } catch (e) {
      setBusy(false);
      onNotification?.(e.message, 'error');
    }
  };
  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, version); } catch (_) { /* ignore */ }
    setDismissed(version);
  };

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-text">
        {updating
          ? `⏳ ${jobState === 'downloading' ? 'Downloading' : jobState === 'installing' ? 'Installing' : 'Restarting with'} ${version} - the page reloads when it is ready…`
          : <>⬆ P5 Manager <b>{version}</b> is available <span className="text-muted">(you have {status.current})</span></>}
      </span>
      {!updating && status.blocked_reason && !status.can_apply && (
        <span className="text-xs text-muted" style={{ flex: '1 1 100%' }}>{status.blocked_reason}</span>
      )}
      {!updating && (
        <span className="flex gap-xs items-center">
          {status.can_apply && <button className="btn btn-primary btn-sm" onClick={update}>Update</button>}
          <a className="btn btn-secondary btn-sm" href={status.latest.url} target="_blank" rel="noreferrer">What's new</a>
          <button className="btn btn-ghost btn-sm" onClick={dismiss} aria-label="Hide until the next version">✕</button>
        </span>
      )}
    </div>
  );
}
