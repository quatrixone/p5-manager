import { useState, useEffect, useMemo } from 'react';

const API = '/api';

const TYPE_META = {
  download: { icon: '⬇️', label: 'Download' },
  extract: { icon: '📦', label: 'Extract' },
  convert: { icon: '🔄', label: 'Convert' },
  upload: { icon: '⬆️', label: 'Upload' },
};

const STATUS_META = {
  queued: { color: '#8e44ad', label: 'Queued' },
  starting: { color: 'var(--blue)', label: 'Starting' },
  running: { color: 'var(--blue)', label: 'Running' },
  pushing: { color: 'var(--blue)', label: 'Pushing' },
  completed: { color: 'var(--green)', label: 'Completed' },
  failed: { color: 'var(--red)', label: 'Failed' },
  cancelled: { color: '#7f8c8d', label: 'Cancelled' },
};

function fmtMB(b) {
  if (!b && b !== 0) return '';
  const mb = b / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb >= 100 ? 0 : mb >= 10 ? 1 : 2)} MB`;
}

function itemTitle(item) {
  return (
    item.source_name ||
    item.archive ||
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
  return '';
}

function QueueItem({ item, onRemove, onRetry, onMove, onStart }) {
  const meta = TYPE_META[item.type] || { icon: '📋', label: item.type };
  const statusMeta = STATUS_META[item.status] || { color: 'var(--muted)', label: item.status };
  const progress = Math.max(0, Math.min(100, Number(item.progress || 0)));
  const isActive = ['running', 'starting', 'pushing'].includes(item.status);
  const isDone = ['completed', 'failed', 'cancelled'].includes(item.status);
  const canRemove = item.status !== 'completed' || true; // allow remove anytime
  const canMove = item.status === 'queued';
  const canRetry = item.status === 'failed' || item.status === 'cancelled';
  const canStartNow = item.type === 'download' && item.status === 'queued';

  return (
    <div className="queue-item" style={{
      background: 'var(--panel2)',
      borderRadius: 10,
      padding: 'var(--space-sm) var(--space-md)',
      marginBottom: 'var(--space-xs)',
      borderLeft: `3px solid ${statusMeta.color}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
        <span style={{ fontSize: '1.25rem' }} title={meta.label}>{meta.icon}</span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="text-sm truncate" style={{ fontWeight: 500 }} title={itemTitle(item)}>
            {itemTitle(item)}
          </div>
          <div className="text-xs text-muted truncate">
            <span style={{ color: statusMeta.color, fontWeight: 500 }}>{statusMeta.label}</span>
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
          {canStartNow && (
            <button className="btn btn-primary btn-sm" onClick={() => onStart(item.type, item.id)} title="Start this download now">▶</button>
          )}
          {canRetry && (
            <button className="btn btn-secondary btn-sm" onClick={() => onRetry(item.type, item.id)} title="Retry">↻</button>
          )}
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

      {/* progress bar shown for ALL tasks */}
      <div style={{ marginTop: 6 }}>
        <div style={{
          height: 6,
          background: 'var(--panel)',
          borderRadius: 3,
          overflow: 'hidden',
          position: 'relative',
        }}>
          <div style={{
            width: isDone && progress === 0 ? '100%' : `${progress}%`,
            height: '100%',
            background: isDone && item.status !== 'completed' ? 'var(--red)' : statusMeta.color,
            transition: 'width 0.3s ease',
          }} />
        </div>
        <div className="text-xs text-muted" style={{ marginTop: 2, display: 'flex', justifyContent: 'space-between' }}>
          <span>{progress}%</span>
          {item.added_at && <span>added {new Date(item.added_at).toLocaleTimeString()}</span>}
        </div>
      </div>
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
        fetch(`${API}/micromount/queue/all`),
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

  // The Queue tab exposes a single global Start/Pause so we treat all queues uniformly.
  // If *any* of them is paused, the global state is "paused" (need a Start press).
  const anyPaused = useMemo(() => {
    const p = data?.paused || {};
    return downloaderPaused || p.extract || p.convert || p.upload;
  }, [data, downloaderPaused]);

  const handleStartAll = async () => {
    await Promise.all([
      fetch(`${API}/downloader/queue/resume`, { method: 'POST' }),
      fetch(`${API}/micromount/queue/resume-all`, { method: 'POST' }),
    ]);
    fetchQueue();
  };

  const handlePauseAll = async () => {
    await Promise.all([
      fetch(`${API}/downloader/queue/pause`, { method: 'POST' }),
      fetch(`${API}/micromount/queue/pause-all`, { method: 'POST' }),
    ]);
    fetchQueue();
  };

  const handleClearFinished = async () => {
    await Promise.all([
      fetch(`${API}/micromount/queue/clear-finished`, { method: 'POST' }),
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
      await fetch(`${API}/micromount/${type}/queue/${id}`, { method: 'DELETE' });
    }
    fetchQueue();
  };

  const handleRetry = async (type, id) => {
    if (type !== 'download') {
      await fetch(`${API}/micromount/${type}/queue/${id}/retry`, { method: 'POST' });
    }
    fetchQueue();
  };

  const handleMove = async (type, id, direction) => {
    if (type !== 'download') {
      await fetch(`${API}/micromount/${type}/queue/${id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
    }
    fetchQueue();
  };

  const handleStartItem = async (type, id) => {
    if (type === 'download') {
      // unpausing the downloader queue starts the queued items in order
      await fetch(`${API}/downloader/queue/resume`, { method: 'POST' });
    }
    fetchQueue();
  };

  if (loading) return <div className="comp-card"><div className="comp-card-body">Loading...</div></div>;

  const allItems = [
    ...extractItems,
    ...convertItems,
    ...uploadItems,
    ...downloads,
  ].sort((a, b) => {
    const statusOrder = { running: 0, starting: 0, pushing: 0, queued: 1, completed: 2, failed: 3, cancelled: 4 };
    const aOrder = statusOrder[a.status] ?? 5;
    const bOrder = statusOrder[b.status] ?? 5;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return new Date(b.added_at || b.started_at || 0) - new Date(a.added_at || a.started_at || 0);
  });

  const activeCount = (arr) => arr.filter(i => ['queued', 'running', 'starting', 'pushing'].includes(i.status)).length;

  const counts = {
    all: allItems.length,
    download: activeCount(downloads),
    extract: activeCount(extractItems),
    convert: activeCount(convertItems),
    upload: activeCount(uploadItems),
  };

  const totalActive = counts.download + counts.extract + counts.convert + counts.upload;

  const filtered = filter === 'all' ? allItems
    : filter === 'download' ? downloads
    : filter === 'extract' ? extractItems
    : filter === 'convert' ? convertItems
    : uploadItems;

  return (
    <div className="comp-card">
      <div className="comp-card-header" style={{ flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
          <span className="comp-card-title">📋 Queue</span>
          {totalActive > 0 && (
            <span className="badge" style={{ background: anyPaused ? '#7f8c8d' : 'var(--blue)' }}>
              {anyPaused ? '⏸ paused' : '▶ running'} · {totalActive} active
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
          {anyPaused ? (
            <button
              className="btn btn-success"
              onClick={handleStartAll}
              disabled={totalActive === 0}
              title={totalActive === 0 ? 'Nothing queued' : 'Start all queues'}
            >
              ▶ Start
            </button>
          ) : (
            <button className="btn btn-secondary" onClick={handlePauseAll}>
              ⏸ Pause
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={handleClearFinished}>🗑 Clear done</button>
        </div>
      </div>

      <div className="comp-card-body">
        <div className="text-xs text-muted mb-md">
          Items added from Upload / Convert / Download / Extract are paused until you press <strong>Start</strong>.
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-xs)', marginBottom: 'var(--space-md)', flexWrap: 'wrap' }}>
          {[
            { key: 'all', label: `All (${counts.all})` },
            { key: 'download', label: `⬇️ Download (${counts.download})` },
            { key: 'extract', label: `📦 Extract (${counts.extract})` },
            { key: 'convert', label: `🔄 Convert (${counts.convert})` },
            { key: 'upload', label: `⬆️ Upload (${counts.upload})` },
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
            <div className="empty-state-title">Queue is empty</div>
            <div className="empty-state-text">
              Add tasks from the Files, Convert or Download tabs and start them here.
            </div>
          </div>
        ) : (
          filtered.map(item => (
            <QueueItem
              key={`${item.type}-${item.id}`}
              item={item}
              onRemove={handleRemove}
              onRetry={handleRetry}
              onMove={handleMove}
              onStart={handleStartItem}
            />
          ))
        )}
      </div>
    </div>
  );
}
