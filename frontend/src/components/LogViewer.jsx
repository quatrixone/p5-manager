function LogViewer({ logs, onRefresh }) {
  const getLevelColor = (level) => {
    switch (level) {
      case 'error': return '#e74c3c';
      case 'warning': return '#f39c12';
      case 'success': return '#27ae60';
      default: return '#3498db';
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '1.25rem' }}>System Logs ({logs.length})</h2>
        <button onClick={onRefresh} style={{ padding: '0.5rem 1rem', background: '#3498db', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
          Refresh
        </button>
      </div>

      <section style={{ background: '#16213e', padding: '1.5rem', borderRadius: 12 }}>
        {logs.length === 0 ? (
          <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>No logs yet</p>
        ) : (
          <div style={{ fontFamily: 'monospace', fontSize: '0.85rem', maxHeight: 500, overflow: 'auto' }}>
            {logs.map(log => (
              <div key={log.id} style={{
                padding: '0.5rem',
                borderBottom: '1px solid #0f3460',
                display: 'flex',
                gap: '1rem'
              }}>
                <span style={{ color: '#666', whiteSpace: 'nowrap' }}>
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span style={{ color: getLevelColor(log.level), fontWeight: 500, textTransform: 'uppercase', minWidth: 60 }}>
                  {log.level}
                </span>
                <span style={{ color: '#eee' }}>{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default LogViewer;