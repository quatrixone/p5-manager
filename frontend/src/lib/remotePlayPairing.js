// One shared sequence for PS4 and PS5. The backend chooses the console payload.
export async function pairRemotePlay({ post, profile, offline = false, activationAccount = null, onProgress = () => {}, onAccount = () => {}, onPin = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const target = { ip: profile.ip_address, profile_id: profile.id };
  const checked = async (route, body) => {
    const result = await post(`/remoteplay/${route}`, body);
    if (!result?.success) {
      const error = new Error(result?.message || result?.error || 'Pairing could not complete.');
      error.log = result?.log;
      throw error;
    }
    return result;
  };
  if (offline) {
    onProgress('Activating account…');
    const activation = await checked('activate-account', { ...target, ...(activationAccount ? { account_id: activationAccount } : {}) });
    onAccount(activation);
  }
  onProgress('Getting PIN…');
  const pinResult = await checked('get-pin', target);
  const pin = String(pinResult.pin || '').replace(/\s/g, '');
  if (!/^\d{8}$/.test(pin) || !pinResult.account_id) {
    const error = new Error('The console did not return a valid PIN and account.');
    error.log = pinResult.log;
    throw error;
  }
  onAccount(pinResult);
  onPin(pinResult);
  onProgress('Pairing…');
  // PIN generation completes before the console's registration listener is ready.
  await wait(1000);
  const registration = { ...target, pin, account_id: pinResult.account_id,
    ...(pinResult.online_id ? { online_id: pinResult.online_id } : {}) };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      onProgress('Pairing…');
      const result = await checked('register', registration);
      onProgress('Paired');
      return result;
    } catch (error) {
      // Retry only service discovery while keeping the same still-valid PIN.
      if (attempt === 2 || !/Regist search failed/i.test(error.message)) throw error;
      onProgress('Waiting for console…');
      await wait(1500 * (attempt + 1));
    }
  }
}

// Compare decimal and little-endian base64 IDs without losing 64-bit precision.
export function sameAccountId(a, b) {
  const normalize = value => {
    try {
      const text = String(value || '').trim();
      if (/^\d{1,20}$/.test(text)) return BigInt(text).toString();
      if (!/^[A-Za-z0-9+/]{11}=$/.test(text)) return null;
      const bytes = atob(text);
      let id = 0n;
      for (let i = 7; i >= 0; i--) id = (id << 8n) | BigInt(bytes.charCodeAt(i));
      return id.toString();
    } catch { return null; }
  };
  const id = normalize(a);
  return id !== null && id === normalize(b);
}
