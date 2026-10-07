// The app's log as a file, for a user to send along when something does not
// work: <data dir>/logs/p5manager.log. It takes what log() records, requests
// that ended in an error, tasks that failed and a crash's stack. The Logs
// tab offers it as a download (GET /api/logs/file), together with
// console.log - everything the Windows launcher's window showed, the Remote
// Play service included.
//
// Kept small: at 1 MB the file becomes p5manager.1.log (replacing the one
// before it) and a new one starts, so the two never hold more than 2 MB -
// weeks of normal use. A line that repeats is written once with a count.
// The launcher's console.log is held to 2 x 2 MB the same way.
import fs from 'fs';
import path from 'path';
import { internalDataDir } from './paths.js';

const MAX_BYTES = 1024 * 1024;
export const logDir = path.join(internalDataDir, 'logs');
const current = path.join(logDir, 'p5manager.log');
const previous = path.join(logDir, 'p5manager.1.log');

// The version that is running (an in-app update makes it differ from the
// image's).
export const appVersion = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || ''; }
  catch (_) { return ''; }
})();

let ready = false;
let size = 0;
let lastKey = '';
let repeats = 0;

function write(line) {
  try {
    if (!ready) {
      fs.mkdirSync(logDir, { recursive: true });
      try { size = fs.statSync(current).size; } catch (_) { size = 0; }
      ready = true;
    }
    if (size + line.length > MAX_BYTES) {
      fs.rmSync(previous, { force: true });
      fs.renameSync(current, previous);
      size = 0;
    }
    fs.appendFileSync(current, line);
    size += Buffer.byteLength(line);
  } catch (_) { /* a log that cannot be written must not break the app */ }
}

export function fileLog(level, message) {
  const text = String(message ?? '').replace(/\r?\n/g, '\n    ');
  const key = `${level}|${text}`;
  if (key === lastKey) { repeats++; return; }
  if (repeats) write(`${new Date().toISOString()}       ... the line above ${repeats} more time(s)\n`);
  lastKey = key;
  repeats = 0;
  write(`${new Date().toISOString()} ${String(level).toUpperCase().padEnd(5)} ${text}\n`);
}

const tail = (file, bytes) => {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(bytes, st.size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return (st.size > len ? '[... earlier lines left out ...]\n' : '') + buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return ''; }
};

// What the download holds: the app log (the previous file first) and the
// end of the launcher's console log where there is one.
export function readFileLog() {
  if (repeats) { write(`${new Date().toISOString()}       ... the line above ${repeats} more time(s)\n`); repeats = 0; lastKey = ''; }
  const parts = [tail(previous, MAX_BYTES), tail(current, MAX_BYTES)].filter(Boolean);
  const consoleLog = tail(path.join(logDir, 'console.log'), 1024 * 1024);
  return parts.join('') + (consoleLog ? `\n===== console.log (launcher window, Remote Play service) =====\n${consoleLog}` : '');
}
