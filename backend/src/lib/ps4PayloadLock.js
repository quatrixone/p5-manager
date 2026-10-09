import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { internalDataDir } from './paths.js';

// Stored in the data volume: a backend restart does not stop the console payload.
export function ps4PayloadLock(ip, directory = path.join(internalDataDir, 'ps4-payload-locks')) {
  const file = path.join(directory, `${createHash('sha256').update(ip).digest('hex')}.json`);
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  const release = () => { fs.rmSync(file, { force: true }); };
  return {
    read,
    release,
    acquire(operation, now = Date.now()) {
      const previous = read();
      if (previous && previous.until > now) return previous;
      fs.mkdirSync(directory, { recursive: true });
      if (previous) release();
      const state = { operation, until: now + 200000 };
      try { fs.writeFileSync(file, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); }
      catch (e) { if (e.code === 'EEXIST') return read(); throw e; }
      return null;
    },
    save(result) {
      const state = read();
      if (state) fs.writeFileSync(file, JSON.stringify({ ...state, result }), { mode: 0o600 });
    },
  };
}
