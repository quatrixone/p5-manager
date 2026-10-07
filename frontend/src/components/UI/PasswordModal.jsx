import { useEffect, useState } from 'react';
import Modal from './Modal';

// Asks for the password of a protected archive. Closing it (×) is not a
// refusal to extract: the caller decides what that means - the file browser
// queues the task anyway, and the password can still be given in Tasks.
export default function PasswordModal({ isOpen, name, hint, onSubmit, onClose }) {
  const [password, setPassword] = useState('');
  useEffect(() => { if (isOpen) setPassword(''); }, [isOpen, name]);

  const submit = () => { if (password) onSubmit(password); };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="🔑 Archive password"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Not now</button>
          <button className="btn btn-primary" onClick={submit} disabled={!password}>Extract</button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex-col gap-sm">
        <div className="text-xs text-muted truncate" title={name}>
          <span style={{ color: 'var(--text)' }}>{name}</span> is protected by a password.
        </div>
        <input
          className="input"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="off"
          spellCheck={false}
        />
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </form>
    </Modal>
  );
}
