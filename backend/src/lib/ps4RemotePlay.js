import net from 'node:net';
import { Writable } from 'node:stream';
import { Client } from 'basic-ftp';

const active = new Map();
export function parsePs4RemotePlay(output) {
  const account_id = output.match(/^Account ID: ([A-Za-z0-9+/]{11}=)\s*$/m)?.[1] || null;
  const pin = output.match(/^Pin code: (\d{4})\s*(\d{4})\s*$/m);
  const activated = output.match(/^Activated: (yes|already|failed)$/m)?.[1] || null;
  const error = output.match(/^Error: (.+)$/m)?.[1];
  return { account_id, pin: pin ? `${pin[1]} ${pin[2]}` : null, activated,
    user: output.match(/^User: (.+)$/m)?.[1] || null,
    slot: Number(output.match(/^Slot: (\d+)$/m)?.[1]) || null,
    account_id_hex: output.match(/^Account ID hex: ([a-f0-9]+)$/m)?.[1] || null,
    log: output.split(/\r?\n/).filter(Boolean), ...(error ? { error } : {}) };
}

function send(ip, port, data) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port });
    socket.setTimeout(8000, () => socket.destroy(new Error('BinLoader connection timed out')));
    socket.once('error', reject);
    socket.once('connect', () => socket.end(data, () => { socket.destroy(); resolve(); }));
  });
}

// GoldHEN closes the upload socket; payload output is retrieved through FTP.
export async function runPs4RemotePlay({ ip, ftpPort, data, operation, prepare }) {
  if ((active.get(ip) || 0) > Date.now()) throw new Error('A PS4 payload is still running. Wait for the current PIN session to finish.');
  active.set(ip, Date.now() + 140000);
  let sent = false;
  const remote = `/data/.p5manager-${operation === 'get-pin' ? 'rp-get-pin' : 'offact'}-ps4.log`;
  const ftp = new Client(8000);
  try {
    if (prepare) await prepare();
    await ftp.access({ host: ip, port: ftpPort, user: 'anonymous', password: '', secure: false });
    try { await ftp.remove(remote); } catch (e) { if (e.code !== 550) throw e; }
    try { await send(ip, 9090, data); }
    catch (e) { if (e.code !== 'ECONNREFUSED') throw e; await send(ip, 9020, data); }
    sent = true;
    let result = { log: [] };
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      let output = '';
      try {
        await ftp.downloadTo(new Writable({ write(chunk, encoding, next) { output += chunk.toString(); next(); } }), remote);
      } catch (e) { if (e.code !== 550) throw e; }
      result = parsePs4RemotePlay(output);
      if (operation === 'get-pin' && result.pin && result.account_id) return { ...result, success: true };
      if (/^Done\s*$/m.test(output)) {
        active.delete(ip);
        const success = operation === 'offact' && !!result.account_id && ['yes', 'already'].includes(result.activated);
        return { ...result, success, ...(!success ? { message: result.error || 'PS4 payload did not produce a PIN or activate the account.' } : {}) };
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { ...result, success: false, message: 'Timed out waiting for PS4 payload output.' };
  } finally {
    ftp.close();
    if (!sent) active.delete(ip);
  }
}
