// Client of save-mounter.elf (p5managerclient/save-mounter, from
// n0llptr/Playstation-5-Save-Mounter): a PS5 payload that mounts save data -
// the PS5's own and PS4 saves of backwards-compatible games - read/write
// under /mnt/pfs/, where FTP can reach the files, and creates new saves.
//
// It listens on TCP 9090 and speaks lines: a command, then "OK [value]" or
// "ERR <reason>", for some commands followed by a counted list of lines or
// by raw bytes. One connection per console is kept and commands take turns
// on it. The payload is sent through the ELF loader when nothing answers
// on 9090.
import net from 'net';

export const MOUNTER_PORT = 9090;
const CONNECT_TIMEOUT_MS = 4_000;
const COMMAND_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 15_000;

class MounterConnection {
  constructor(ip) {
    this.ip = ip;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiters = []; // { kind: 'line' | 'bytes', n, resolve, reject }
    this.chain = Promise.resolve();
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.ip, port: MOUNTER_PORT });
      const t = setTimeout(() => { s.destroy(); reject(new Error('the save mounter did not answer')); }, CONNECT_TIMEOUT_MS);
      s.once('connect', () => {
        clearTimeout(t);
        s.setKeepAlive(true, 10_000);
        this.socket = s;
        resolve();
      });
      s.on('data', (d) => { this.buffer = Buffer.concat([this.buffer, d]); this.pump(); });
      const fail = (err) => {
        clearTimeout(t);
        this.closed = true;
        for (const w of this.waiters.splice(0)) w.reject(err || new Error('the save mounter closed the connection'));
        reject(err);
      };
      s.on('error', fail);
      s.on('close', () => fail(new Error('the save mounter closed the connection')));
    });
  }

  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (w.kind === 'line') {
        const nl = this.buffer.indexOf(0x0a);
        if (nl < 0) return;
        const line = this.buffer.subarray(0, nl).toString('utf8').replace(/\r$/, '');
        this.buffer = this.buffer.subarray(nl + 1);
        this.waiters.shift();
        w.resolve(line);
      } else {
        if (this.buffer.length < w.n) return;
        const out = this.buffer.subarray(0, w.n);
        this.buffer = this.buffer.subarray(w.n);
        this.waiters.shift();
        w.resolve(Buffer.from(out));
      }
    }
  }

  read(kind, n = 0) {
    if (this.closed) return Promise.reject(new Error('the save mounter closed the connection'));
    return new Promise((resolve, reject) => {
      this.waiters.push({ kind, n, resolve, reject });
      this.pump();
    });
  }

  // Runs `fn` with exclusive use of the connection.
  exclusive(fn) {
    const run = this.chain.then(() => withTimeout(fn(), COMMAND_TIMEOUT_MS, () => this.destroy()));
    this.chain = run.catch(() => {});
    return run;
  }

  async ok(command) {
    // Each command is answered before the next is sent, so nothing should
    // be waiting here. When something is, it is the tail of an answer we
    // mis-counted - a save whose title or subtitle holds a newline makes
    // the payload send more lines than it announced - and reading it as
    // this command's answer would break every command after it.
    if (this.buffer.length) {
      this.buffer = Buffer.alloc(0);
    }
    this.socket.write(`${command}\n`);
    const line = await this.read('line');
    if (line.startsWith('ERR ')) throw new Error(line.slice(4));
    if (line === 'OK') return '';
    if (line.startsWith('OK ')) return line.slice(3);
    throw new Error(`unexpected answer from the save mounter: ${line}`);
  }

  // A save listing is one record a line - unless the game put a newline in
  // the text it shows with the save, and then the record goes on over the
  // next lines. Reading those as records of their own turns the rest of
  // the answer into nonsense, so they are joined back on.
  async records(command, fields) {
    const count = parseInt(await this.ok(command), 10) || 0;
    const out = [];
    // Not just `count` records: the last one may still be waiting for the
    // rest of its fields, and leaving those unread would make them the
    // answer to the next command.
    const whole = () => out.length >= count && (!count || out[out.length - 1].split('\t').length >= fields);
    while (!whole()) out.push(...addLine(out, await this.read('line'), fields));
    return out;
  }

  async lines(command) {
    const count = parseInt(await this.ok(command), 10) || 0;
    const out = [];
    for (let i = 0; i < count; i++) out.push(await this.read('line'));
    return out;
  }

  destroy() {
    this.closed = true;
    try { this.socket?.destroy(); } catch (_) {}
  }
}

// Appends `line` to the records read so far: its own record, or the rest
// of the last one when that is still short of its fields. Returns what to
// push - empty when the line went onto the previous record.
export function addLine(records, line, fields) {
  const last = records[records.length - 1];
  if (last !== undefined && last.split('\t').length < fields) {
    records[records.length - 1] = `${last}\n${line}`;
    return [];
  }
  return [line];
}

function withTimeout(promise, ms, onTimeout) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => { onTimeout?.(); reject(new Error('the save mounter did not answer in time')); }, ms);
    }),
  ]);
}

const connections = new Map(); // ip -> MounterConnection

// The connection to the console's save mounter, starting the payload when
// it is not running: `start(ip)` sends it (through the ELF loader).
export async function mounterFor(ip, { start, portOpen }) {
  const have = connections.get(ip);
  if (have && !have.closed) return have;
  connections.delete(ip);
  if (!(await portOpen(ip, MOUNTER_PORT, 1500))) {
    await start(ip);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!(await portOpen(ip, MOUNTER_PORT, 1000))) {
      if (Date.now() > deadline) throw new Error(`sent the save mounter, but it did not start listening on port ${MOUNTER_PORT}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const conn = new MounterConnection(ip);
  await conn.connect();
  connections.set(ip, conn);
  return conn;
}

export function dropMounter(ip) {
  connections.get(ip)?.destroy();
  connections.delete(ip);
}

// ── commands ────────────────────────────────────────────────────────────

export const firmware = (c) => c.exclusive(() => c.ok('GET_FW'));

export const users = (c) => c.exclusive(async () => (await c.lines('GET_USERS')).map((line) => {
  const sp = line.indexOf(' ');
  return { id: parseInt(line.slice(0, sp), 16), hex: line.slice(0, sp), name: line.slice(sp + 1) };
}).filter((u) => Number.isFinite(u.id)));

// Title ids with saves for a user (CUSA… PS4, PPSA… PS5, and the classics).
export const titles = (c, userHex) => c.exclusive(async () => (await c.lines(`LIST_SAVES ${userHex}`)).sort());

export const saves = (c, userHex, titleId) => c.exclusive(async () => (await c.records(`SEARCH ${userHex} ${titleId}`, 5)).map((line) => {
  const [dir = '', title = '', subtitle = '', detail = '', time = ''] = line.split('\t');
  const t = parseInt(time, 10);
  return { dir, title, subtitle, detail, modified: t > 0 ? new Date(t * 1000).toISOString() : null };
}));

// Mounts a save read/write; returns its mount point (/mnt/pfs/...). One save
// is mounted at a time - the payload copies it back when it is unmounted.
export const mount = (c, userHex, titleId, dir) => c.exclusive(() => c.ok(`MOUNT ${userHex} ${titleId} ${dir}`));

export const unmount = (c) => c.exclusive(() => c.ok('UMOUNT'));

// A new, empty save, left mounted; `blocks` of 32 KiB.
export const create = (c, userHex, titleId, dir, blocks) => c.exclusive(() => c.ok(`CREATE ${userHex} ${titleId} ${dir} ${blocks}`));

export const readFile = (c, file, maxBytes = 16 * 1024 * 1024) => c.exclusive(async () => {
  const size = parseInt(await c.ok(`READ_FILE ${file}`), 10);
  if (!(size >= 0)) throw new Error('the save mounter gave no size');
  if (size > maxBytes) {
    c.destroy();
    throw new Error(`${file} is too large (${size} bytes)`);
  }
  return c.read('bytes', size);
});

// Ends the payload (it exits on EXIT).
export async function stopMounter(ip) {
  const c = connections.get(ip);
  if (!c || c.closed) return false;
  try { await c.exclusive(() => c.ok('EXIT')); } catch (_) {}
  dropMounter(ip);
  return true;
}

// Is `name` usable as a save directory name? The payload builds paths from it.
export function validSaveDir(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]{1,31}$/.test(name) && !name.startsWith('.');
}

export function validTitleId(id) {
  return typeof id === 'string' && /^[A-Z]{4}\d{5}$/.test(id);
}
