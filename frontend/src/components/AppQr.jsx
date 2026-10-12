// The address of this P5 Manager as a QR code, for the Android app to read
// instead of the user typing an IP on a phone keyboard. The address is the
// one the browser is already on, which is by definition one that works from
// another device on the same network - unless it is localhost, and the card
// says so.
import { useMemo, useState } from 'react';
import { qrSvg } from '../lib/qr.js';

const LOCAL = /^(localhost|127\.|\[?::1\]?)/i;

export default function AppQr() {
  const [copied, setCopied] = useState(false);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const local = LOCAL.test(origin.replace(/^https?:\/\//, ''));
  const { path, size } = useMemo(() => qrSvg(origin || 'http://localhost'), [origin]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(origin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* No clipboard in this context; the address is on screen. */ }
  };

  return (
    <div className="comp-card">
      <div className="comp-card-body">
        <div className="font-bold mb-sm">📱 Open on a phone</div>
        <div className="text-xs text-muted mb-md">
          Scan this with the P5 Manager app for Android to point it at this server. Any browser on the
          same network can use the address too.
        </div>
        <div className="flex gap-md items-center flex-wrap">
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`QR code for ${origin}`} style={{ background: '#fff', borderRadius: 8, padding: 4 }}>
            <path d={path} fill="#000" />
          </svg>
          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
            <code className="text-sm" style={{ wordBreak: 'break-all' }}>{origin}</code>
            <div className="mt-sm flex gap-sm">
              <button className="btn btn-secondary btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy address'}</button>
            </div>
            {local && (
              <div className="text-xs mt-sm" style={{ color: 'var(--yellow, orange)' }}>
                This page is open on localhost, which means nothing to another device. Open P5 Manager by
                this machine's address on the network, then scan again.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
