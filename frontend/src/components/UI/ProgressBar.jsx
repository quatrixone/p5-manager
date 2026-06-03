export default function ProgressBar({ value = 0, max = 100, label, showPercent = true }) {
  const percent = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div style={{ width: '100%' }}>
      {(label || showPercent) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-xs)', fontSize: '0.8rem' }}>
          {label && <span className="text-muted">{label}</span>}
          {showPercent && <span style={{ fontWeight: 600 }}>{Math.round(percent)}%</span>}
        </div>
      )}
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}