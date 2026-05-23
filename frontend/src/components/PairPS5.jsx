import { useState, useEffect } from 'react';

const API = '/api';

function PairPS5({ ip, onPaired }) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [isPaired, setIsPaired] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [pin, setPin] = useState('');

  useEffect(() => {
    checkPairing();
  }, [ip]);

  const checkPairing = async () => {
    try {
      const res = await fetch(`${API}/ps5control/pairstatus?ip=${ip}`);
      const data = await res.json();
      setIsPaired(data.paired || false);
    } catch {
      setIsPaired(false);
    }
  };

  const startPairing = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/ps5control/pair/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip })
      });
      const data = await res.json();
      if (data.success) {
        setSessionId(data.sessionId || '');
        setStep(2);
      } else {
        setError(data.error || 'Failed to connect to PS5');
      }
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const confirmPin = async () => {
    if (!pin || pin.length !== 4) {
      setError('Please enter 4-digit PIN from PS5');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/ps5control/pair/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, pin, sessionId })
      });
      const data = await res.json();
      if (data.success) {
        setSuccess(true);
        setIsPaired(true);
        if (onPaired) onPaired();
      } else {
        setError(data.error || 'Invalid PIN. Try again.');
      }
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  if (isPaired || success) {
    return (
      <div style={{ background: '#16213e', padding: '1.5rem', borderRadius: 12, textAlign: 'center' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✓</div>
        <h3 style={{ color: '#27ae60', marginBottom: '0.5rem' }}>PS5 Paired Successfully</h3>
        <p style={{ color: '#888', fontSize: '0.85rem' }}>
          Your PS5 at {ip} is now paired and ready for remote control.
        </p>
      </div>
    );
  }

  return (
    <div style={{ background: '#16213e', padding: '1.5rem', borderRadius: 12 }}>
      <h3 style={{ fontSize: '1rem', fontWeight: 500, marginBottom: '1rem', color: '#27ae60' }}>
        PS5 Pairing (Pure Python - No VNC)
      </h3>

      {/* Step 1: Connect to PS5 */}
      <div style={{
        padding: '1rem',
        background: step >= 1 ? '#0f3460' : '#1a1a2e',
        borderRadius: 8,
        marginBottom: '1rem',
        opacity: step < 1 ? 0.5 : 1
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: step > 1 ? '#27ae60' : '#e94560',
            color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', fontWeight: 600
          }}>
            1
          </div>
          <span style={{ fontWeight: 500 }}>Connect to PS5</span>
        </div>

        {step === 1 && (
          <div>
            <p style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '1rem', lineHeight: 1.6 }}>
              1. On your PS5, go to <strong>Settings → Accessories → Remote Play → Add Device</strong><br/>
              2. A <strong>4-digit PIN</strong> will be displayed on your TV<br/>
              3. Click "Connect" below, then enter the PIN
            </p>
            <button
              onClick={startPairing}
              disabled={loading}
              style={{
                padding: '0.75rem 1.5rem',
                background: loading ? '#555' : '#e94560',
                color: '#fff', border: 'none', borderRadius: 6,
                cursor: loading ? 'not-allowed' : 'pointer',
                fontSize: '1rem', minHeight: 44
              }}
            >
              {loading ? 'Connecting...' : 'Connect to PS5'}
            </button>
          </div>
        )}
      </div>

      {/* Step 2: Enter PIN */}
      <div style={{
        padding: '1rem',
        background: step >= 2 ? '#0f3460' : '#1a1a2e',
        borderRadius: 8,
        marginBottom: '1rem',
        opacity: step < 2 ? 0.5 : 1
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: step > 2 ? '#27ae60' : '#e94560',
            color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', fontWeight: 600
          }}>
            2
          </div>
          <span style={{ fontWeight: 500 }}>Enter PS5 PIN</span>
        </div>

        {step === 2 && (
          <div>
            <p style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '1rem' }}>
              Enter the 4-digit PIN shown on your PS5 screen:
            </p>
            <input
              type="text"
              placeholder="0000"
              maxLength={4}
              value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
              style={{
                width: '100%',
                maxWidth: 150,
                padding: '0.75rem',
                borderRadius: 6,
                background: '#1a1a2e',
                color: '#fff',
                border: '1px solid #0f3460',
                fontSize: '1.5rem',
                textAlign: 'center',
                letterSpacing: '0.5rem'
              }}
            />
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={confirmPin}
                disabled={loading || pin.length !== 4}
                style={{
                  padding: '0.75rem 1.5rem',
                  background: loading || pin.length !== 4 ? '#555' : '#27ae60',
                  color: '#fff', border: 'none', borderRadius: 6,
                  cursor: loading || pin.length !== 4 ? 'not-allowed' : 'pointer',
                  fontSize: '1rem', minHeight: 44
                }}
              >
                {loading ? 'Pairing...' : 'Confirm PIN'}
              </button>
              <button
                onClick={() => setStep(1)}
                style={{
                  padding: '0.75rem 1rem',
                  background: '#666',
                  color: '#fff', border: 'none', borderRadius: 6,
                  cursor: 'pointer', fontSize: '0.9rem'
                }}
              >
                Back
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Info Box */}
      <div style={{
        padding: '1rem',
        background: '#1a1a2e',
        borderRadius: 8,
        border: '1px solid #333'
      }}>
        <h4 style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '0.5rem' }}>How pairing works:</h4>
        <p style={{ color: '#666', fontSize: '0.75rem', lineHeight: 1.5 }}>
          We use a pure Python implementation of the Chiaki protocol to pair with PS5.
          No VNC or GUI required - the process runs entirely in the backend.
        </p>
      </div>

      {/* Error display */}
      {error && (
        <div style={{
          marginTop: '1rem',
          padding: '0.75rem',
          background: '#e74c3c',
          borderRadius: 6,
          color: '#fff',
          fontSize: '0.85rem'
        }}>
          {error}
        </div>
      )}
    </div>
  );
}

export default PairPS5;