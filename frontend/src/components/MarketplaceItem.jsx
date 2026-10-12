// One card for everything the Marketplace lists - a curated item, a
// package from the FPKGi hub, an entry from a catalog the user added -
// and the actions that go with it. The New feed and the list both render
// these, so an item looks and behaves the same wherever it shows up.
import { useEffect, useState } from 'react';
import { api, apiSafe } from '../lib/api.js';
import { KIND_LABEL, KIND_ICON, actionFor, installedBadge, needsConsole, unverifiedWarning, sizeLabel } from '../lib/marketplaceView.js';

export function StoreIcon({ entry, size = 48 }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [entry.icon]);
  const style = { width: size, height: size, flexShrink: 0, borderRadius: 10, objectFit: 'contain', background: 'var(--bg-secondary)', display: 'grid', placeItems: 'center', fontSize: size / 2 };
  return entry.icon && !broken
    ? <img src={entry.icon} alt={`${entry.name} icon`} loading="lazy" referrerPolicy="no-referrer" style={style} onError={() => setBroken(true)} />
    : <span style={style} aria-hidden="true">{KIND_ICON[entry.kind] || '💿'}</span>;
}

export function ItemActions({ item, profiles = [], consoleOnline = null, onNotification, onDone }) {
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [pid, setPid] = useState('');
  const targets = profiles.filter((p) => !item.console_type || (p.console_type || 'ps5') === item.console_type);
  const wantsConsole = needsConsole(item);
  const action = actionFor(item, { consoleOnline, hasProfile: !!targets.length });
  const warning = unverifiedWarning(item);

  useEffect(() => { if (!pid && targets.length) setPid(String(targets[0].id)); }, [targets, pid]);
  useEffect(() => {
    if (job?.state !== 'running') return undefined;
    const timer = setInterval(async () => {
      const r = await apiSafe.get(`/store/jobs/${job.id}`);
      if (!r?.job) return;
      setJob(r.job);
      if (r.job.state === 'done') { onNotification?.(`${item.name} installed`, 'success'); onDone?.(); }
      if (r.job.state === 'failed') onNotification?.(r.job.error, 'error');
    }, 1000);
    return () => clearInterval(timer);
  }, [job, item, onDone, onNotification]);

  const run = async () => {
    if (action.action === 'link') { window.open(item.package_url, '_blank', 'noopener'); return; }
    // A package nobody can check is installed only on a clear yes.
    if (warning && !window.confirm(`${warning}\n\nInstall ${item.name} anyway?`)) return;
    if (item.installed && ['script', 'template'].includes(item.kind) && !item.update
      && !window.confirm(`Replace ${item.name} with the Marketplace version? Changes to the imported copy will be overwritten.`)) return;
    setBusy(true);
    try {
      const r = action.action === 'install-catalog'
        ? await api.post('/store/install-catalog', { origin: item.origin, id: item.id, profileId: pid, acknowledgeUnverified: !!warning })
        : await api.post('/store/install', { kind: item.kind, id: item.id, profileId: pid || undefined });
      if (r.job) setJob(r.job);
      else { onNotification?.(`${item.name} installed`, 'success'); onDone?.(); }
    } catch (e) { onNotification?.(e.message, 'error'); }
    setBusy(false);
  };

  const running = job?.state === 'running';
  return (
    <div onClick={(e) => e.stopPropagation()}>
      {wantsConsole && targets.length > 1 && (
        <select className="select mb-xs" aria-label="Console to install on" value={pid} onChange={(e) => setPid(e.target.value)} style={{ width: '100%', minHeight: 40 }}>
          {targets.map((p) => <option key={p.id} value={p.id}>Install on {p.name} ({p.ip_address})</option>)}
        </select>
      )}
      {job && (
        <div className="text-xs mb-xs" style={{ color: job.state === 'failed' ? 'var(--red)' : undefined }}>
          {running ? '⏳ ' : job.state === 'done' ? '✅ ' : '❌ '}{job.state === 'failed' ? job.error : job.step}
        </div>
      )}
      <button
        className={`btn ${action.action === 'link' ? 'btn-secondary' : 'btn-primary'}`}
        onClick={run}
        disabled={busy || running || action.disabled}
        title={action.reason || undefined}
        style={{ width: '100%', minHeight: 40 }}
      >
        {running ? 'Working…' : action.label}
      </button>
      {action.reason && <div className="text-xs text-muted mt-xs">{action.reason}</div>}
      {warning && !action.disabled && <div className="text-xs text-muted mt-xs">⚠ Unverified package</div>}
    </div>
  );
}

export function ItemCard({ item, profiles, consoleOnline, onOpen, onNotification, onDone }) {
  const badge = installedBadge(item);
  const meta = [
    item.kind === 'catalog' ? item.version && `v${item.version}` : `v${item.app_version || item.version}`,
    KIND_LABEL[item.kind] || item.category,
    item.console_type ? item.console_type.toUpperCase() : 'PS4 + PS5',
    item.author,
    item.size ? sizeLabel(item.size) : null,
    item.min_fw ? `FW ${item.min_fw}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className="comp-card" onClick={() => onOpen?.(item)} style={{ cursor: onOpen ? 'pointer' : 'default' }}>
      <div className="comp-card-body p-sm">
        <div className="flex items-center justify-between gap-xs">
          <div className="flex items-center gap-sm">
            <StoreIcon entry={item} />
            <span className="font-bold" style={{ wordBreak: 'break-word' }}>{item.name}</span>
          </div>
          {badge && <span className={`badge badge-${badge.tone}`} title={badge.title}>{badge.text}</span>}
        </div>
        <div className="text-xs text-muted mt-xs">{meta}</div>
        {item.description && (
          <div className="text-xs mt-xs" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.description}</div>
        )}
        <div className="mt-sm">
          <ItemActions item={item} profiles={profiles} consoleOnline={consoleOnline} onNotification={onNotification} onDone={onDone} />
        </div>
      </div>
    </div>
  );
}
