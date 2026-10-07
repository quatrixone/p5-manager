import { useState } from 'react';

export default function RemotePlayPairing({ consoleLabel, menuPath, paired, liveSession, disabled,
  busy, progress, result, pairTab, setPairTab, pin, setPin, onOneClickPair, onFetchPin,
  onActivate, onPair, onForgetPair, account, pinResult, activationResult }) {
  const [method, setMethod] = useState('automatic');
  const automatic = method === 'automatic';
  const offline = pairTab === 'unactivated';
  const canAct = !busy && !disabled && !liveSession;
  const details = result?.log || pinResult?.log || activationResult?.log;
  const error = result?.error || pinResult?.error || pinResult?.message || activationResult?.error || activationResult?.message;
  const tab = (value, label) => (
    <button type="button" role="tab" aria-selected={pairTab === value}
      className={`btn ${pairTab === value ? 'btn-primary' : 'btn-ghost'}`}
      disabled={busy} onClick={() => setPairTab(value)} style={{ flex: '1 1 180px' }}>{label}</button>
  );
  return (
    <section className="card flex-col gap-md" aria-label={`Pair ${consoleLabel}`}>
      <div className="flex gap-sm flex-wrap items-center justify-between">
        <h3 style={{ margin: 0 }}>Pair {consoleLabel}</h3>
        <span className="text-sm" style={{ color: paired ? 'var(--green)' : 'var(--muted)' }}>
          {paired ? '✓ Paired for Remote Play' : 'Not paired yet'}
        </span>
      </div>
      <div className="flex gap-xs flex-wrap" role="tablist" aria-label="Account activation">
        {tab('activated', 'PSN Activated')}
        {tab('unactivated', 'Not Activated / Offline')}
      </div>
      <p className="text-sm text-muted" style={{ margin: 0 }}>
        {offline ? 'Activate the account for offline use, then pair for Remote Play.'
          : 'Your console account is already activated. Pair it for Remote Play.'}
      </p>
      <div className="flex gap-sm flex-wrap" role="group" aria-label="Pairing method">
        <button type="button" className={`btn btn-sm ${automatic ? 'btn-secondary' : 'btn-ghost'}`}
          aria-pressed={automatic} disabled={busy} onClick={() => setMethod('automatic')}>Jailbreak ON · Automatic</button>
        <button type="button" className={`btn btn-sm ${!automatic ? 'btn-secondary' : 'btn-ghost'}`}
          aria-pressed={!automatic} disabled={busy} onClick={() => setMethod('manual')}>Jailbreak OFF · Manual</button>
      </div>
      {liveSession && <div className="text-sm" role="status" style={{ color: 'var(--yellow)' }}>
        Stop the live Remote Play session before pairing.
      </div>}
      {automatic ? (<>
        <p className="text-sm text-muted" style={{ margin: 0 }}>
          {offline ? 'One click activates the account, gets a PIN and pairs the console. Enable the payload loader and FTP first.'
            : 'One click reads the console account, gets a PIN and pairs it. Enable the payload loader and FTP first.'}
          {' '}If the console has no account ID yet, link your PSN account below first.
        </p>
        <button type="button" className="btn btn-success" disabled={!canAct}
          onClick={() => onOneClickPair(offline)}>
          {busy ? progress || 'Working…' : offline ? 'Activate & pair in one click' : paired ? 'Re-pair in one click' : 'Pair in one click'}
        </button>
        <details>
          <summary className="text-sm text-muted" style={{ cursor: 'pointer' }}>Individual steps</summary>
          <div className="flex gap-sm flex-wrap" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!canAct} onClick={onActivate}>Read / activate account</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!canAct} onClick={onFetchPin}>Auto-fetch PIN</button>
          </div>
          {activationResult?.success && <p className="text-sm" style={{ color: 'var(--green)' }}>
            ✓ {activationResult.user || 'Account'}: {activationResult.activated === 'already' ? 'Already activated' : 'Activated'}
          </p>}
          {pinResult?.pin && <p className="text-sm">PIN: <b>{pinResult.pin}</b></p>}
          <ManualPin pin={pin} setPin={setPin} disabled={!canAct || !account.linked} onPair={onPair} />
        </details>
      </>) : (<>
        {offline && <p className="text-sm" style={{ color: 'var(--yellow)', margin: 0 }}>
          Offline activation requires jailbreak. For an account already activated on the console, choose PSN Activated and use its PIN.
        </p>}
        <p className="text-sm text-muted" style={{ margin: 0 }}>{menuPath}. Enter the eight-digit PIN shown on the console.</p>
        {!account.linked && <p className="text-sm" style={{ margin: 0 }}>Link your PSN account below before pairing manually.</p>}
        <ManualPin pin={pin} setPin={setPin} disabled={!canAct || !account.linked || offline} onPair={onPair} />
      </>)}
      {progress && <div className="text-sm" role="status" aria-live="polite" style={{ color: result?.success ? 'var(--green)' : 'var(--text)' }}>{progress}</div>}
      {error && <div className="text-sm" role="alert" style={{ color: 'var(--red)' }}>{error}</div>}
      {details?.length > 0 && <details>
        <summary className="text-sm text-muted" style={{ cursor: 'pointer' }}>Diagnostic output</summary>
        <pre style={{ maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>{details.join('\n')}</pre>
      </details>}
      <details open={!account.linked && (!automatic || !!error)}>
        <summary className="text-sm" style={{ cursor: 'pointer' }}>
          {account.linked ? `✓ Account: ${account.name}` : 'Link PSN account · Sony login or account ID'}
        </summary>
        <div className="flex-col gap-sm" style={{ marginTop: 8 }}>
          <p className="text-sm text-muted" style={{ margin: 0 }}>
            {automatic ? 'The automatic flow reads an existing account from the console. Link one here if none is available or you want to use a different account.'
              : 'Use the same PSN account as the console. Sign in with Sony, then paste the complete redirect URL here.'}
          </p>
          <div className="flex gap-sm flex-wrap">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || account.busy || disabled} onClick={account.onLogin}>Open Sony login</button>
            {account.linked && <button type="button" className="btn btn-ghost btn-sm" disabled={busy || account.busy} onClick={account.onForget}>Forget account</button>}
          </div>
          {account.loginUrl && <a href={account.loginUrl} target="_blank" rel="noopener noreferrer">Continue Sony sign-in</a>}
          <label className="text-sm">Redirect URL after sign-in</label>
          <textarea className="input" rows={2} value={account.redirectUrl} disabled={busy || account.busy}
            onChange={e => account.setRedirectUrl(e.target.value)} placeholder="Paste the full URL after Sony sign-in" />
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || account.busy || !account.redirectUrl.trim() || disabled} onClick={account.onExchange}>Link account</button>
          <div className="flex gap-sm flex-wrap">
            <input className="input" aria-label="PSN account ID" placeholder="Account ID (decimal or base64)" value={account.manualId}
              disabled={busy || account.busy} onChange={e => account.setManualId(e.target.value)} style={{ flex: '2 1 200px' }} />
            <input className="input" aria-label="PSN name" placeholder="PSN name (optional)" value={account.manualName}
              disabled={busy || account.busy} onChange={e => account.setManualName(e.target.value)} style={{ flex: '1 1 160px' }} />
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || account.busy || !account.manualId.trim() || disabled} onClick={account.onSave}>Use account ID</button>
          </div>
        </div>
      </details>
      {paired && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onForgetPair}>Forget pairing</button>}
    </section>
  );
}

function ManualPin({ pin, setPin, disabled, onPair }) {
  return <div className="flex gap-sm flex-wrap" style={{ marginTop: 8 }}>
    <input className="input" aria-label="Pairing PIN" inputMode="numeric" maxLength={9} placeholder="1234 5678"
      value={pin} onChange={e => setPin(e.target.value)} disabled={disabled}
      style={{ flex: '1 1 160px', fontSize: '1.25rem', letterSpacing: 3 }} />
    <button type="button" className="btn btn-success" disabled={disabled || !/^\d{8}$/.test(pin.replace(/\s/g, ''))} onClick={onPair}>Pair with PIN</button>
  </div>;
}
