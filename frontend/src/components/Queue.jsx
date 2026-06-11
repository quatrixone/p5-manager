import { useState, useEffect, useMemo, useRef } from 'react';

const API = '/api';

const TYPE_META = {
  download: { icon: '⬇️', label: 'Download' },
  extract: { icon: '📦', label: 'Extract' },
  convert: { icon: '🔄', label: 'Convert' },
  upload: { icon: '⬆️', label: 'Upload' },
  install: { icon: '📥', label: 'Install' },
};

// Map a queue item to the per-job REST endpoint that returns its `.log`.
// Returns null when the underlying job hasn't been created yet (item still
// sitting in the queue), so the dropdown can render an explanatory placeholder
// instead of hammering a 404.
function logUrlForItem(item) {
  if (item.type === 'download') return `${API}/downloader/${item.id}`;
  if (item.type === 'upload') return `${API}/convert/ftp/upload/${item.id}`;
  if (item.type === 'install') return `${API}/convert/install/${item.id}`;
  // convert + extract use a separate jobs map keyed by job_id, which only
  // exists once the queue worker has picked the item up.
  if (!item.job_id) return null;
  if (item.type === 'convert') return `${API}/convert/convert/${item.job_id}`;
  if (item.type === 'extract') return `${API}/convert/extract/${item.job_id}`;
  return null;
}

function fmtBytes(b) {
  if (b == null || isNaN(b)) return '';
  const n = Number(b);
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : mb >= 10 ? 1 : 2)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

const STATUS_META = {
  queued: { color: 'var(--magenta)', label: 'Queued' },
  starting: { color: 'var(--blue)', label: 'Starting' },
  staging: { color: 'var(--blue)', label: 'Staging' },
  running: { color: 'var(--blue)', label: 'Running' },
  pushing: { color: 'var(--blue)', label: 'Pushing' },
  sending: { color: 'var(--blue)', label: 'Sending' },
  installing: { color: 'var(--blue)', label: 'Installing' },
  unpacking: { color: 'var(--blue)', label: 'Unpacking' },
  completed: { color: 'var(--green)', label: 'Completed' },
  failed: { color: 'var(--red)', label: 'Failed' },
  push_failed: { color: 'var(--amber, #ffb86b)', label: 'Push failed' },
  cancelled: { color: '#7f8c8d', label: 'Cancelled' },
};

function fmtMB(b) {
  if (!b && b !== 0) return '';
  return fmtBytes(b);
}

function itemTitle(item) {
  return (
    item.source_name ||
    item.archive ||
    item.pkg_name ||
    item.file_name ||
    item.filename ||
    item.url ||
    item.id
  );
}

function itemSubtitle(item) {
  if (item.type === 'download') {
    if (item.bytes_total) {
      return `${fmtMB(item.bytes_downloaded || 0)} / ${fmtMB(item.bytes_total)}`;
    }
    return item.dest_path || '';
  }
  if (item.type === 'convert') return `${item.mode || ''}${item.output_name ? ` → ${item.output_name}` : ''}`;
  if (item.type === 'extract') return `${item.archive_type || ''}${item.dest ? ` → ${item.dest}` : ''}`;
  if (item.type === 'upload') return `${item.ip || ''}${item.dest_path ? ` → ${item.dest_path}` : ''}`;
  if (item.type === 'install') {
    // For install items the title slot already shows the pkg name, so the
    // subtitle gives the target PS5 + the live install_status hint when the
    // payload has streamed one (`playable`, `transferring`, etc.).
    const parts = [];
    if (item.ip) parts.push(item.ip);
    if (item.install_status) parts.push(`status: ${item.install_status}`);
    if (item.staged_path) parts.push(item.staged_path);
    return parts.join(' · ');
  }
  return '';
}

function QueueItem({ item, queuePaused, onRemove, onRetry, onMove, onStart, onPause, onResume }) {
  const meta = TYPE_META[item.type] || { icon: '📋', label: item.type };
  const statusMeta = STATUS_META[item.status] || { color: 'var(--muted)', label: item.status };
  const progress = Math.max(0, Math.min(100, Number(item.progress || 0)));
  const isActive = ['running', 'starting', 'staging', 'pushing', 'sending', 'installing', 'unpacking'].includes(item.status);
  const isDone = ['completed', 'failed', 'cancelled', 'push_failed'].includes(item.status);
  const isQueued = item.status === 'queued';
  const canMove = isQueued;
  // Retry is offered on EVERY terminal status (failed / cancelled /
  // push_failed / completed), not just failures. The user asked for
  // "moznost retry pri kazdom jobe" — completed gets it too so they can
  // re-run a finished conversion or re-upload an artefact without
  // re-queuing from scratch (executeConvertJob overwrites the existing
  // output, uploadFileResilient overwrites the destination file).
  const canRetry = ['failed', 'cancelled', 'push_failed', 'completed'].includes(item.status);

  // ── Log dropdown state ─────────────────────────────────────────────────
  // The log lives on a separate per-job endpoint (`logUrlForItem`). We only
  // poll while the dropdown is expanded so we don't pull tens of KB per
  // second on the queue list view that's already polling /queue/all.
  const [logOpen, setLogOpen] = useState(false);
  const [logText, setLogText] = useState('');
  const [logErr, setLogErr] = useState(null);
  const logRef = useRef(null);
  const logUrl = logUrlForItem(item);
  const hasLogEndpoint = !!logUrl;

  useEffect(() => {
    if (!logOpen) return;
    let cancelled = false;
    const tick = async () => {
      if (!logUrl) { setLogText(''); setLogErr('Log will appear once this task starts running.'); return; }
      try {
        const r = await fetch(logUrl);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (cancelled) return;
        setLogText(j.log || '');
        setLogErr(null);
      } catch (e) {
        if (!cancelled) setLogErr(e.message);
      }
    };
    tick();
    // While the job is active we want a snappy refresh; once it's done the
    // log is final so we can back off (still poll once a few seconds in case
    // mkpfs flushed a tail line after completion).
    const intervalMs = isActive ? 1500 : 5000;
    const h = setInterval(tick, intervalMs);
    return () => { cancelled = true; clearInterval(h); };
  }, [logOpen, logUrl, isActive]);

  // Auto-scroll the log pane to the bottom whenever new content arrives so
  // the most recent line is always visible without manual scrolling.
  useEffect(() => {
    if (logOpen && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logText, logOpen]);

  // We expose Start / Pause / Resume per-task even though the actual work
  // happens in a per-type worker. From the user's point of view:
  //   - Start (queued item): kick the worker so this one begins.
  //   - Pause (running or queued): freeze processing of this queue type.
  //   - Resume (queue type paused): unfreeze.
  //   - Stop: cancel-and-remove this item.
  const showStart = isQueued && queuePaused;
  const showResume = queuePaused && (isActive || isQueued);
  const showPause = !queuePaused && (isActive || isQueued);

  // Effective per-task label: a queued item under a paused queue is also "paused".
  const effectiveLabel = (isQueued || isActive) && queuePaused ? 'Paused' : statusMeta.label;
  const effectiveColor = (isQueued || isActive) && queuePaused ? '#7f8c8d' : statusMeta.color;

  // For silent jobs (notably mkpfs unpack) the % is synthesised from io
  // counters by the backend. We surface the live byte counts next to the
  // progress label so the user gets a real "is this thing alive?" signal
  // even when the percentage moves slowly.
  //
  // Convert/unpack jobs can be in one of these phases:
  //   - smb-staging: smbclient downloading source → show bytes_written / bytes_total
  //   - scanning:    mkpfs reading the .ffpfsc    → show bytes_read    / bytes_total
  //   - extracting:  mkpfs writing files          → show bytes_written / bytes_total
  // The frontend treats them uniformly: pick the most-relevant byte counter
  // for the current phase and surface phase as a coloured tag.
  const isUnpack = item.type === 'convert' && item.mode === 'unpack';
  const phase = item.phase || item.unpack_phase || null;
  const liveBytes = (
    phase === 'smb-staging' && item.bytes_written != null ? item.bytes_written
    : isUnpack && phase === 'scanning' && item.bytes_read != null ? item.bytes_read
    : item.bytes_written != null && item.bytes_written > 0 ? item.bytes_written
    : isUnpack && item.bytes_read != null ? item.bytes_read
    : item.bytes_downloaded != null ? item.bytes_downloaded
    : item.bytes_sent != null ? item.bytes_sent
    : null
  );
  const liveBytesTotal = (
    item.bytes_total != null && item.bytes_total > 0 ? item.bytes_total
    : item.size != null ? item.size
    : null
  );
  const phaseLabel =
      phase === 'smb-staging' ? 'smb staging'
    : phase === 'scanning'    ? 'scanning'
    : phase === 'extracting'  ? 'extracting'
    : null;
  const bytesLabel = (liveBytes != null && liveBytes > 0)
    ? (liveBytesTotal
        ? `${fmtBytes(liveBytes)} / ${fmtBytes(liveBytesTotal)}`
        : fmtBytes(liveBytes))
    : '';

  // Show an indeterminate animation when the task is clearly active but
  // we don't yet have a useful percentage (first few seconds before the
  // poller has a sample).
  const indeterminate = isActive && progress < 1 && liveBytes != null && liveBytes > 0;

  return (
    <div className="queue-item" style={{
      background: 'var(--panel2)',
      borderRadius: 10,
      padding: 'var(--space-sm) var(--space-md)',
      marginBottom: 'var(--space-xs)',
      borderLeft: `3px solid ${effectiveColor}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
        <span style={{ fontSize: '1.25rem' }} title={meta.label}>{meta.icon}</span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="text-sm truncate" style={{ fontWeight: 500 }} title={itemTitle(item)}>
            {itemTitle(item)}
          </div>
          <div className="text-xs text-muted truncate">
            <span style={{ color: effectiveColor, fontWeight: 500 }}>{effectiveLabel}</span>
            {itemSubtitle(item) && <> · {itemSubtitle(item)}</>}
            {item.error && <span style={{ color: 'var(--red)' }}> · {item.error}</span>}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
          {canMove && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => onMove(item.type, item.id, 'up')} title="Move up">↑</button>
              <button className="btn btn-ghost btn-sm" onClick={() => onMove(item.type, item.id, 'down')} title="Move down">↓</button>
            </>
          )}
          {showStart && (
            <button className="btn btn-success btn-sm" onClick={() => onStart(item.type, item.id)} title="Start this task">▶</button>
          )}
          {showResume && !showStart && (
            <button className="btn btn-success btn-sm" onClick={() => onResume(item.type)} title={`Resume ${meta.label.toLowerCase()} queue`}>▶</button>
          )}
          {showPause && (
            <button className="btn btn-secondary btn-sm" onClick={() => onPause(item.type)} title={`Pause ${meta.label.toLowerCase()} queue`}>⏸</button>
          )}
          {canRetry && (
            <button className="btn btn-secondary btn-sm" onClick={() => onRetry(item.type, item.id)} title="Retry">↻</button>
          )}
          <button
            className={`btn btn-sm ${logOpen ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setLogOpen(v => !v)}
            title={logOpen ? 'Hide log' : 'Show log'}
            aria-expanded={logOpen}
          >
            📜
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => onRemove(item.type, item.id, isActive)}
            title={isActive ? 'Cancel & remove' : 'Remove'}
            style={{ color: isActive ? 'var(--red)' : undefined }}
          >
            ✕
          </button>
        </div>
      </div>

      <div style={{ marginTop: 6 }}>
        <div style={{
          height: 6,
          background: 'var(--panel)',
          borderRadius: 3,
          overflow: 'hidden',
          position: 'relative',
        }}>
          {indeterminate ? (
            <div className="queue-bar-indeterminate" style={{
              height: '100%',
              background: effectiveColor,
              borderRadius: 3,
            }} />
          ) : (
            <div style={{
              width: isDone && progress === 0 ? '100%' : `${progress}%`,
              height: '100%',
              background: isDone && item.status === 'failed' ? 'var(--red)'
                : isDone && item.status === 'cancelled' ? '#7f8c8d'
                : effectiveColor,
              transition: 'width 0.3s ease',
            }} />
          )}
        </div>
        <div className="text-xs text-muted" style={{ marginTop: 2, display: 'flex', justifyContent: 'space-between', gap: 'var(--space-sm)' }}>
          <span>
            {indeterminate ? 'working…' : `${progress}%`}
            {phaseLabel && <> · <span style={{ color: 'var(--blue)' }}>{phaseLabel}</span></>}
            {bytesLabel && ` · ${bytesLabel}`}
          </span>
          {item.added_at && <span>added {new Date(item.added_at).toLocaleTimeString()}</span>}
        </div>
      </div>

      {logOpen && (
        <div style={{ marginTop: 'var(--space-xs)' }}>
          <pre
            ref={logRef}
            className="queue-log"
            style={{
              maxHeight: 260,
              overflow: 'auto',
              margin: 0,
              padding: 'var(--space-xs) var(--space-sm)',
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: '0.72rem',
              lineHeight: 1.35,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-muted)',
            }}
          >
            {logErr && !logText
              ? <span style={{ color: 'var(--muted)' }}>{logErr}</span>
              : (logText || (hasLogEndpoint ? 'Waiting for output…' : 'Log will appear once this task starts running.'))}
          </pre>
        </div>
      )}
    </div>
  );
}

export default function Queue() {
  const [data, setData] = useState(null);
  const [downloads, setDownloads] = useState([]);
  const [downloaderPaused, setDownloaderPaused] = useState(true);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  const fetchQueue = async () => {
    try {
      const [queueRes, downloadRes, dlState] = await Promise.all([
        fetch(`${API}/convert/queue/all`),
        fetch(`${API}/downloader`),
        fetch(`${API}/downloader/queue`),
      ]);
      const queueData = await queueRes.json();
      const downloadData = await downloadRes.json();
      const dlQueue = await dlState.json();

      const downloadItems = Array.isArray(downloadData)
        ? downloadData.map(job => ({
            ...job,
            type: 'download',
            id: job.id,
            file_name: job.filename,
            source_name: job.filename || job.url,
          }))
        : [];

      setData(queueData);
      setDownloads(downloadItems);
      setDownloaderPaused(!!dlQueue.paused);
    } catch (err) {
      console.error('Failed to fetch queue:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, 1500);
    return () => clearInterval(interval);
  }, []);

  const extractItems = (data?.extract?.items || []).map(i => ({ ...i, type: 'extract' }));
  const convertItems = (data?.convert?.items || []).map(i => ({ ...i, type: 'convert' }));
  const uploadItems = (data?.upload?.items || []).map(i => ({ ...i, type: 'upload' }));
  const installItems = (data?.install?.items || []).map(i => ({ ...i, type: 'install' }));

  // Pause state per queue type. The UI uses these to render the correct per-task
  // start/pause/resume button on each item. There is no global pause anymore.
  //
  // Backend shape (see /api/convert/queue/all):
  //   { extract: { paused, items }, convert: { paused, items }, upload: { paused, items }, all: [...] }
  // The previous code read `data.paused.<type>` — `data.paused` doesn't
  // exist, so every queue evaluated to `paused: false` even when the
  // backend was paused. That hid the Resume buttons and left Pause as the
  // only visible action — clicking it pinged /pause on an already-paused
  // queue, leaving the user no escape. Reading from the right path
  // restores the per-queue Start/Pause/Resume rotation.
  const pausedByType = useMemo(() => ({
    download: !!downloaderPaused,
    extract: !!data?.extract?.paused,
    convert: !!data?.convert?.paused,
    upload: !!data?.upload?.paused,
    install: !!data?.install?.paused,
  }), [data, downloaderPaused]);

  // The upload queue is mounted under /ftp/upload/... not /upload/..., so
  // map types to their actual REST path. Everything else uses the type id
  // directly.
  const apiPathForType = (type) => (type === 'upload' ? 'ftp/upload' : type);

  const handlePauseType = async (type) => {
    if (type === 'download') {
      await fetch(`${API}/downloader/queue/pause`, { method: 'POST' });
    } else {
      await fetch(`${API}/convert/${apiPathForType(type)}/queue/pause`, { method: 'POST' });
    }
    fetchQueue();
  };

  const handleResumeType = async (type) => {
    if (type === 'download') {
      await fetch(`${API}/downloader/queue/resume`, { method: 'POST' });
    } else {
      await fetch(`${API}/convert/${apiPathForType(type)}/queue/resume`, { method: 'POST' });
    }
    fetchQueue();
  };

  const handleClearFinished = async () => {
    await Promise.all([
      fetch(`${API}/convert/queue/clear-finished`, { method: 'POST' }),
      fetch(`${API}/downloader/queue/clear-finished`, { method: 'POST' }),
    ]);
    fetchQueue();
  };

  const handleRemove = async (type, id, isActive) => {
    if (isActive) {
      if (!window.confirm('Cancel this running task?')) return;
    }
    if (type === 'download') {
      await fetch(`${API}/downloader/${id}`, { method: 'DELETE' });
    } else {
      await fetch(`${API}/convert/${apiPathForType(type)}/queue/${id}`, { method: 'DELETE' });
    }
    fetchQueue();
  };

  const handleRetry = async (type, id) => {
    if (type !== 'download') {
      await fetch(`${API}/convert/${apiPathForType(type)}/queue/${id}/retry`, { method: 'POST' });
    }
    fetchQueue();
  };

  const handleMove = async (type, id, direction) => {
    if (type !== 'download') {
      await fetch(`${API}/convert/${apiPathForType(type)}/queue/${id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
    }
    fetchQueue();
  };

  // Start a single queued task = move it to the head and unpause its queue
  // type. The worker then picks it first.
  const handleStartItem = async (type, id) => {
    if (type !== 'download') {
      try {
        await fetch(`${API}/convert/${apiPathForType(type)}/queue/${id}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction: 'top' }),
        });
      } catch (_) { /* best-effort move; resume below is the actual trigger */ }
    }
    await handleResumeType(type);
  };

  if (loading) return <div className="comp-card"><div className="comp-card-body">Loading...</div></div>;

  const allItems = [
    ...extractItems,
    ...convertItems,
    ...uploadItems,
    ...installItems,
    ...downloads,
  ].sort((a, b) => {
    const statusOrder = { running: 0, starting: 0, staging: 0, pushing: 0, sending: 0, installing: 0, unpacking: 0, queued: 1, completed: 2, failed: 3, push_failed: 3, cancelled: 4 };
    const aOrder = statusOrder[a.status] ?? 5;
    const bOrder = statusOrder[b.status] ?? 5;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return new Date(b.added_at || b.started_at || 0) - new Date(a.added_at || a.started_at || 0);
  });

  const activeCount = (arr) => arr.filter(i => ['queued', 'running', 'starting', 'staging', 'pushing', 'sending', 'installing', 'unpacking'].includes(i.status)).length;

  const counts = {
    all: allItems.length,
    download: activeCount(downloads),
    extract: activeCount(extractItems),
    convert: activeCount(convertItems),
    upload: activeCount(uploadItems),
    install: activeCount(installItems),
  };

  const totalActive = counts.download + counts.extract + counts.convert + counts.upload + counts.install;

  const filtered = filter === 'all' ? allItems
    : filter === 'download' ? downloads
    : filter === 'extract' ? extractItems
    : filter === 'convert' ? convertItems
    : filter === 'install' ? installItems
    : uploadItems;

  const anyPaused = pausedByType.download || pausedByType.extract || pausedByType.convert || pausedByType.upload || pausedByType.install;

  return (
    <div className="comp-card">
      <div className="comp-card-header" style={{ flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <span className="comp-card-title">📋 Tasks</span>
          {totalActive > 0 && (
            <span className="badge" style={{ background: anyPaused ? '#7f8c8d' : 'var(--blue)' }}>
              {totalActive} active
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
          <button className="btn btn-ghost btn-sm" onClick={handleClearFinished}>🗑 Clear done</button>
        </div>
      </div>

      <div className="comp-card-body">
        <div className="text-xs text-muted mb-md">
          Each task has its own ▶ Start / ⏸ Pause / ▶ Resume / ✕ Stop controls. Items added from Upload / Convert / Download / Extract sit idle until you press ▶ on them.
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-xs)', marginBottom: 'var(--space-md)', flexWrap: 'wrap' }}>
          {[
            { key: 'all', label: `All (${counts.all})` },
            { key: 'download', label: `⬇️ Download (${counts.download})` },
            { key: 'extract', label: `📦 Extract (${counts.extract})` },
            { key: 'convert', label: `🔄 Convert (${counts.convert})` },
            { key: 'upload', label: `⬆️ Upload (${counts.upload})` },
            { key: 'install', label: `📥 Install (${counts.install})` },
          ].map(f => (
            <button
              key={f.key}
              className={`btn btn-sm ${filter === f.key ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <div className="empty-state-title">No active tasks</div>
            <div className="empty-state-text">
              Add tasks from the Files, Convert or Download tabs and start them here.
            </div>
          </div>
        ) : (
          filtered.map(item => (
            <QueueItem
              key={`${item.type}-${item.id}`}
              item={item}
              queuePaused={pausedByType[item.type]}
              onRemove={handleRemove}
              onRetry={handleRetry}
              onMove={handleMove}
              onStart={handleStartItem}
              onPause={handlePauseType}
              onResume={handleResumeType}
            />
          ))
        )}
      </div>
    </div>
  );
}
