import { useEffect, useRef } from 'react';

// Module-level counter so two Modals mounted at once (e.g. a confirmation
// dialog stacking on top of a FolderPicker) both increment on open and
// both decrement on close. The previous version was a per-component
// effect that just overwrote `document.body.style.overflow` - so opening
// Modal A then Modal B then closing A would restore the scrollbar even
// though B was still visible underneath, letting the user scroll the
// dimmed page out from under the modal.
let _openCount = 0;
function lockScroll() {
  _openCount += 1;
  if (_openCount === 1) {
    const prev = document.body.style.overflow;
    document.body.dataset._modalPrevOverflow = prev;
    document.body.style.overflow = 'hidden';
  }
}
function unlockScroll() {
  _openCount = Math.max(0, _openCount - 1);
  if (_openCount === 0) {
    document.body.style.overflow = document.body.dataset._modalPrevOverflow || '';
    delete document.body.dataset._modalPrevOverflow;
  }
}

export default function Modal({ isOpen, onClose, title, children, footer }) {
  const overlayRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    lockScroll();
    return () => { unlockScroll(); };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current) onClose();
  };

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal-content">
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}