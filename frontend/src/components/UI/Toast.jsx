import { useState, useEffect } from 'react';

export default function Toast({ message, type = 'info', duration = 3000, onClose }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onClose, 300);
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const bgColor = {
    success: 'var(--green)',
    error: 'var(--red)',
    warning: '#f39c12',
    info: 'var(--blue)',
  }[type] || 'var(--blue)';

  return (
    <div style={{
      position: 'fixed',
      top: 80,
      left: '50%',
      transform: visible ? 'translateX(-50%)' : 'translateX(-50%) translateY(-20px)',
      opacity: visible ? 1 : 0,
      padding: 'var(--space-sm) var(--space-lg)',
      background: bgColor,
      color: 'var(--text)',
      borderRadius: 8,
      fontSize: '0.9rem',
      fontWeight: 500,
      zIndex: 3000,
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      transition: 'all 0.3s ease',
      maxWidth: '90vw',
      textAlign: 'center',
    }}>
      {message}
    </div>
  );
}

export function ToastContainer({ toasts, onRemove }) {
  return (
    <div style={{ position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)', zIndex: 3000, display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      {toasts.map(toast => (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          duration={toast.duration || 3000}
          onClose={() => onRemove(toast.id)}
        />
      ))}
    </div>
  );
}

export function useToast() {
  const [toasts, setToasts] = useState([]);

  const addToast = (message, type = 'info', duration = 3000) => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type, duration }]);
  };

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  return { toasts, addToast, removeToast };
}