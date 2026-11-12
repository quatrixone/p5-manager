// Exports a PS4 save decrypted, without anyone touching the console.
//
// save-mounter-ps4.bin is sent to GoldHEN's BinLoader and reads one command
// line from /data/.p5manager-save-ps4 on the console:
//
//   MOUNT <user id hex> <title id> <save name>   mounts, then prints
//                                                "Mount point: <path>"
//   UMOUNT                                       prints "Unmounted"
//
// It copies the save image to its own file first, unseals the key through
// /dev/pfsmgr and mounts that copy, so the console's own save is never
// touched. The mounted files are plain, which is what the PS5's save
// mounter wants - the same thing Apollo Save Tool's "export decrypted save
// files" produces, without the manual run.
//
// Everything the payload says comes back through the log file over FTP;
// GoldHEN closes the BinLoader socket without saying anything.
import { Writable, Readable } from 'node:stream';
import { sendPs4Payload } from './ps4RemotePlay.js';

export const PS4_EXPORT_PAYLOAD = 'save-mounter-ps4.bin';
const CMD_FILE = '/data/.p5manager-save-ps4';
const LOG_FILE = '/data/.p5manager-save-ps4.log';
const POLL_MS = 500;

export function validPs4User(v) { return /^[0-9a-f]{1,8}$/i.test(String(v || '')); }

// What the payload printed, as the lines it prints.
export function parsePs4SaveLog(output) {
  return {
    mountPoint: output.match(/^Mount point: (.+?)\s*$/m)?.[1] || null,
    source: output.match(/^Source: (.+?)\s*$/m)?.[1] || null,
    unmounted: /^Unmounted\s*$/m.test(output),
    error: output.match(/^Error: (.+?)\s*$/m)?.[1] || null,
    log: output.split(/\r?\n/).filter(Boolean),
  };
}

async function readLog(ftp) {
  let output = '';
  try {
    await ftp.downloadTo(new Writable({ write(chunk, _enc, next) { output += chunk.toString(); next(); } }), LOG_FILE);
  } catch (e) {
    if (e.code !== 550) throw e; // not written yet
  }
  return output;
}

// Puts one command in front of the payload and waits for its answer. `ftp`
// is an open client for the same console.
async function run(ftp, ip, payload, command, timeoutMs) {
  try { await ftp.remove(LOG_FILE); } catch (e) { if (e.code !== 550) throw e; }
  // No trailing newline: the payload holds "UMOUNT" as one exact string, and
  // the mount line is read with sscanf, which does not care either way.
  // shortcut: guessed from the payload's strings, its source is lost; if a
  // command is ever refused with "invalid mount command", read the binary again.
  await ftp.uploadFrom(Readable.from([command]), CMD_FILE);
  await sendPs4Payload(ip, payload);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const answer = parsePs4SaveLog(await readLog(ftp));
    if (answer.error) throw Object.assign(new Error(answer.error), { status: 502, log: answer.log });
    if (answer.mountPoint || answer.unmounted) return answer;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw Object.assign(new Error('the PS4 save payload did not answer in time'), { status: 504 });
}

export function mountPs4Save(ftp, ip, payload, { user, title, dir }, timeoutMs = 120_000) {
  return run(ftp, ip, payload, `MOUNT ${String(user).toLowerCase()} ${title} ${dir}`, timeoutMs);
}

export function unmountPs4Save(ftp, ip, payload, timeoutMs = 60_000) {
  return run(ftp, ip, payload, 'UMOUNT', timeoutMs);
}

// The saves a PS4 holds, straight off its drive: /user/home/<user>/savedata/
// <title>/ keeps `sdimg_<name>` (the save) beside `<name>.bin` (its sealed
// key). Both are encrypted - only their names are read here, which is all
// the list needs; the payload above does the decrypting.
export async function listPs4Saves(ftp) {
  const out = [];
  let users;
  try { users = await ftp.list('/user/home'); } catch (e) { if (e.code === 550) return out; throw e; }
  for (const u of users) {
    if (!u.isDirectory || !validPs4User(u.name)) continue;
    let titles;
    try { titles = await ftp.list(`/user/home/${u.name}/savedata`); } catch (e) { if (e.code === 550) continue; throw e; }
    for (const t of titles) {
      if (!t.isDirectory || !/^[A-Z]{4}\d{5}$/i.test(t.name)) continue;
      let files;
      try { files = await ftp.list(`/user/home/${u.name}/savedata/${t.name}`); } catch (e) { if (e.code === 550) continue; throw e; }
      for (const f of files) {
        const name = /^sdimg_(.+)$/.exec(f.name)?.[1];
        if (!name) continue;
        out.push({
          user: u.name.toLowerCase(),
          title: t.name.toUpperCase(),
          dir: name,
          size: f.size || 0,
          modified: f.modifiedAt ? new Date(f.modifiedAt).toISOString() : null,
        });
      }
    }
  }
  return out;
}
