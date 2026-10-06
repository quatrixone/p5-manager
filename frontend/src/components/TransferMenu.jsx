import { createPortal } from 'react-dom';

// Small menu shown where a drag & drop between two panes was released:
// Copy / Move / Cancel, or - when the destination already holds items with
// the same names - the list of collisions and an Overwrite choice.
// Portalled to <body>: an ancestor's page-in transform would otherwise make
// `position: fixed` relative to that ancestor instead of the viewport.
export default function TransferMenu({ pending, destLabel, onChoose, onOverwrite, onCancel }) {
  if (!pending) return null;
  const { items, point, conflicts, busy, op } = pending;
  const left = Math.max(8, Math.min((point?.x ?? 100) - 20, window.innerWidth - 288));
  const top = Math.max(8, Math.min((point?.y ?? 100) - 10, window.innerHeight - 220));
  const what = items.length === 1 ? items[0].name : `${items.length} items`;
  return createPortal(
    <>
      <div className="transfer-menu-backdrop" onClick={busy ? undefined : onCancel} />
      <div className="transfer-menu" style={{ left, top }} role="dialog" aria-label="Transfer">
        <div className="text-sm font-medium truncate" title={what}>{what}</div>
        <div className="text-xs text-muted truncate" title={destLabel}>→ {destLabel}</div>
        {conflicts ? (
          <>
            <div className="text-xs" style={{ color: 'var(--red)' }}>
              Already there: {conflicts.slice(0, 5).join(', ')}{conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : ''}
            </div>
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={onOverwrite}>
              {busy ? '⏳ Working…' : `Overwrite and ${op}`}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-success btn-sm" disabled={busy} onClick={() => onChoose('copy')}>📋 Copy</button>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onChoose('move')}>✂ Move</button>
          </>
        )}
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </>,
    document.body,
  );
}
