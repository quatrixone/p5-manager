import { useEffect, useState } from 'react';
import LogViewer from './LogViewer';
import Marketplace from './Marketplace';

const TOOLS = [
  { id: 'logs', label: '📋 Logs' },
  { id: 'store', label: '🛒 Marketplace' },
];

function readTool() {
  try {
    const t = localStorage.getItem('toolsTab');
    return TOOLS.some((x) => x.id === t) ? t : 'logs';
  } catch (_) {
    return 'logs';
  }
}

// The Tools tab: things that are not part of the daily flow - the logs and
// the marketplace.
export default function Tools({ logs, onRefreshLogs, profiles, onNotification }) {
  const [tool, setTool] = useState(readTool);
  useEffect(() => {
    try { localStorage.setItem('toolsTab', tool); } catch (_) { /* private mode */ }
  }, [tool]);

  return (
    <div>
      <div className="tabs mb-md">
        {TOOLS.map((t) => (
          <button key={t.id} className={`tab-item ${tool === t.id ? 'active' : ''}`} onClick={() => setTool(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tool === 'logs' && <LogViewer logs={logs} onRefresh={onRefreshLogs} profiles={profiles} />}
      {tool === 'store' && <Marketplace profiles={profiles} onNotification={onNotification} />}
    </div>
  );
}
