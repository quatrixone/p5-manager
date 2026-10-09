import net from 'node:net';
import { Writable } from 'node:stream';
import { Client } from 'basic-ftp';
import { ps4PayloadLock } from './ps4PayloadLock.js';

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
  const lock = ps4PayloadLock(ip);
  const previous = lock.acquire(operation);
  if (previous) {
    const probe = new Client(8000);
    try {
      await probe.access({ host: ip, port: ftpPort, user: 'anonymous', password: '', secure: false });
      const previousLog = `/data/.p5manager-${previous.operation === 'get-pin' ? 'rp-get-pin' : 'offact'}-ps4.log`;
      const output = await readLog(probe, previousLog);
      if (/^Done\s*$/m.test(output)) {
        lock.release();
        return runPs4RemotePlay({ ip, ftpPort, data, operation, prepare });
      }
      if (operation === 'get-pin' && previous.operation === operation && previous.result?.expires_at > Date.now())
        return { ...previous.result, reused: true };
    } finally { probe.close(); }
    throw new Error('A PS4 payload is still running. Wait for the current PIN session to finish.');
  }
  let sent = false;
  let monitoring = false;
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
      const output = await readLog(ftp, remote);
      result = parsePs4RemotePlay(output);
      if (operation === 'get-pin' && result.pin && result.account_id && !/^Done\s*$/m.test(output)) {
        const response = { ...result, success: true, expires_at: Date.now() + 120000 };
        lock.save(response);
        monitoring = true;
        monitor(ftp, remote, lock).catch(() => {});
        return response;
      }
      if (/^Done\s*$/m.test(output)) {
        lock.release();
        const success = operation === 'offact' && !!result.account_id && ['yes', 'already'].includes(result.activated);
        return { ...result, success, ...(!success ? { message: result.error || 'PS4 payload did not produce a PIN or activate the account.' } : {}) };
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { ...result, success: false, message: 'Timed out waiting for PS4 payload output.' };
  } finally {
    if (!monitoring) ftp.close();
    if (!sent) lock.release();
  }
}

async function readLog(ftp, remote) {
  let output = '';
  try {
    await ftp.downloadTo(new Writable({ write(chunk, encoding, next) { output += chunk.toString(); next(); } }), remote);
  } catch (e) { if (e.code !== 550) throw e; }
  return output;
}

async function monitor(ftp, remote, lock) {
  try {
    const until = lock.read()?.until || Date.now();
    while (Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (/^Done\s*$/m.test(await readLog(ftp, remote))) { lock.release(); return; }
    }
    lock.release();
  } finally { ftp.close(); }
}
