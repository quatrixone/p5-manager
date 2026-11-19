// Client for the LZ4 Compression payload (the engine) on the console.
import {FileSystem, Http} from '@ps5-react/core';

export const ENGINE = 'http://127.0.0.1:5920';
const PAYLOAD_MANAGER = 'http://127.0.0.1:8084';
// Where Payload Manager keeps the engine: 0.6 puts uploads under local/,
// older versions in their own folder.
const ENGINE_ELFS = [
  '/data/pldmgr/payloads/local/lz4-compression/lz4-compression.elf',
  '/data/pldmgr/payloads/lz4-compression/lz4-compression.elf',
];

export function engineElf() {
  try {
    return ENGINE_ELFS.find(path => FileSystem.exists(path)) || null;
  } catch (err) {
    return null;
  }
}

// An abort signal that fires after ms (the transport retries a refused
// connection for minutes, which is too long while an engine restarts).
function timeoutSignal(ms) {
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener: (type, fn) => { if (type === 'abort') listeners.add(fn); },
    removeEventListener: (type, fn) => listeners.delete(fn),
  };
  const id = setTimeout(() => {
    signal.aborted = true;
    for (const fn of [...listeners]) fn();
  }, ms);
  return {signal, clear: () => clearTimeout(id)};
}

async function call(path, options = {}) {
  const timer = options.timeoutMs ? timeoutSignal(options.timeoutMs) : null;
  let response;
  try {
    response = await Http.request(ENGINE + path, {
      method: options.method || 'GET',
      maxBytes: options.maxBytes || 4 * 1024 * 1024,
      ...(timer ? {signal: timer.signal} : {}),
    });
  } catch (err) {
    if (timer && timer.signal.aborted) throw new Error(`no answer from the engine within ${options.timeoutMs / 1000} s`);
    throw err;
  } finally {
    if (timer) timer.clear();
  }
  let data = {};
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.data = data;
    throw error;
  }
  return data;
}

const post = path => call(path, {method: 'POST'});

export function gameQuery(game) {
  let query = 'titleId=' + encodeURIComponent(game.titleId || '');
  if (game.sourcePath) query += '&sourcePath=' + encodeURIComponent(game.sourcePath);
  return query;
}

export function iconUrl(game, full) {
  if (!game || !game.hasIcon) return '';
  const version = `${game.iconSize || 0}-${game.iconMtime || 0}`;
  return `${ENGINE}/api/lzc/icon?titleId=${encodeURIComponent(game.titleId)}` +
    (full ? '' : '&size=thumb') + `&v=${encodeURIComponent(version)}`;
}

export const api = {
  status: () => call('/api/status'),
  games: () => call('/api/lzc/games'),
  history: () => call('/api/lzc/history'),
  job: () => call('/api/lzc/job'),
  usb: () => call('/api/lzc/usb'),
  lz4Profile: game => call('/api/lzc/lz4/profile?titleId=' + encodeURIComponent(game.titleId)),
  // TOML profiles found on USB drives and in the import folder, matches first.
  lz4Configs: game => call('/api/lzc/lz4/configs?titleId=' + encodeURIComponent(game.titleId) +
    '&name=' + encodeURIComponent(game.name || '')),
  importConfig: (game, path) => post('/api/lzc/lz4/profile?titleId=' + encodeURIComponent(game.titleId) +
    '&action=import&path=' + encodeURIComponent(path)),
  removeProfile: game => post('/api/lzc/lz4/profile?titleId=' + encodeURIComponent(game.titleId) + '&action=delete'),
  uncompressPlan: game => call('/api/lzc/uncompress-plan?' + gameQuery(game)),
  cancelJob: () => post('/api/lzc/job/cancel'),
  cancelQueued: id => post('/api/lzc/queue/cancel?id=' + encodeURIComponent(id)),
  shutdown: () => post('/api/control/shutdown'),
  // Simple actions that start straight away.
  run(action, game) {
    const routes = {
      'validate-only': 'validate-only', 'validate-repair': 'validate-repair',
      'lz4-verify': 'lz4-verify', 'verify-game': 'lz4-verify', 'build-ampr-index': 'build-ampr-index',
      'set-read-only': 'set-read-only', 'extract-image': 'extract-image',
      'refresh-mount': 'refresh-mount', 'read-speed-test': 'read-speed-test',
      'restore-ampr-original': 'restore-ampr-original',
    };
    return post(`/api/lzc/${routes[action]}?` + gameQuery(game));
  },
  updateAmpr: game => post('/api/lzc/update-ampr?' + gameQuery(game) +
    '&version=' + encodeURIComponent(game.amprLatestVersion || '') +
    '&sha256=' + encodeURIComponent(game.amprLatestSha256 || '') + '&intent=latest'),
  compress(game, {action, format, destination, deletePolicy, usbId, confirmStream}) {
    let url = (action === 'make-image' ? '/api/lzc/make-image?' : '/api/lzc/compress?') +
      gameQuery(game) + '&format=' + encodeURIComponent(format);
    if (deletePolicy) url += '&deletePolicy=' + encodeURIComponent(deletePolicy);
    if (destination && destination !== 'keep') url += '&destination=' + encodeURIComponent(destination);
    if (usbId) url += '&usbId=' + encodeURIComponent(usbId);
    if (confirmStream) url += '&confirmStream=1';
    return post(url);
  },
  lz4(game, {mode, level, profile, destination, deletePolicy, usbId}) {
    let url = (mode === 'unpack' ? '/api/lzc/lz4-unpack?' : '/api/lzc/lz4-pack?') + gameQuery(game) +
      '&destination=' + encodeURIComponent(destination) + '&deletePolicy=' + encodeURIComponent(deletePolicy);
    if (mode !== 'unpack') url += '&level=' + encodeURIComponent(level) + '&profile=' + encodeURIComponent(profile);
    if (destination === 'usb' && usbId) url += '&usbId=' + encodeURIComponent(usbId);
    return post(url);
  },
  uncompress(game, {mode, destination, deletePolicy, usbId}) {
    let url = '/api/lzc/uncompress?' + gameQuery(game) + '&mode=' + encodeURIComponent(mode) +
      '&destination=' + encodeURIComponent(destination) + '&deletePolicy=' + encodeURIComponent(deletePolicy);
    if (usbId) url += '&usbId=' + encodeURIComponent(usbId);
    return post(url);
  },
  move(game, {copy, target, usbId}) {
    const verb = copy ? 'copy' : 'move';
    if (target === 'internal') return post(`/api/lzc/${verb}-to-internal?` + gameQuery(game));
    return post(`/api/lzc/${verb}-to-usb?` + gameQuery(game) + '&usbId=' + encodeURIComponent(usbId));
  },
  deleteGame: game => post('/api/lzc/delete-game-data?' + gameQuery(game) + '&confirm=delete'),
};

// Asks Payload Manager to load the engine when it isn't running yet.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// After an update: load the new engine through Payload Manager while the old
// one still runs; it stops the old one and takes over (the engine's handoff).
// Waits until a different engine process answers and returns its version.
export async function restartEngine() {
  let before = null;
  try {
    before = await call('/api/status', {timeoutMs: 3000});
  } catch (err) {
    // Not running: loading it just starts it.
  }
  if (!(await startEngine())) throw new Error('Payload Manager refused to load the new engine');
  let last = 'no answer';
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const now = await call('/api/status', {timeoutMs: 2000});
      if (!before || now.pid !== before.pid) return now.version || '';
      last = `the old engine (${before.version || 'pid ' + before.pid}) is still running`;
    } catch (err) {
      last = err.message;
    }
  }
  throw new Error(`the new engine didn't take over: ${last}`);
}

// Ask the engine to open the app again once it has closed.
export async function relaunchAfterClose(titleId) {
  try {
    await call('/api/control/relaunch?titleId=' + encodeURIComponent(titleId), {method: 'POST', timeoutMs: 3000});
    return true;
  } catch (err) {
    return false;
  }
}

// Payload Manager 0.6 only loads on a POST with its request marker (and no
// foreign Origin); older versions take a GET.
export async function startEngine() {
  const elf = engineElf();
  if (!elf) return false;
  const url = `${PAYLOAD_MANAGER}/loadpayload:${elf}`;
  let response = await Http.request(url, {method: 'POST', headers: {'X-PLDMGR-Request': '1'}, body: '', maxBytes: 65536});
  if (response.status === 404 || response.status === 405) response = await Http.request(url, {method: 'GET', maxBytes: 65536});
  return response.ok && (await response.text()).trim() !== 'Invalid payload name';
}
