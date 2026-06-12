import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client as FtpClient } from 'basic-ftp';
import { getRepo, log } from '../db/sqlite.js';
import { pushKernelLogEntry } from './kernelLogServer.js';
import { payloadsDir } from '../lib/paths.js';

const router = express.Router();

// Default trigger file path used by offact.elf to pick up a PSN
// account_id supplied by the manager when no on-console PSN account is
// linked yet. Matches TRIGGER_PATH in p5managerclient/offact/main.c.
const OFFACT_TRIGGER_DEFAULT = '/data/.p5manager-offact';

// Anonymous PS5 ftpsrv on GoldHEN listens on 2121 by default. We keep
// the trigger upload self-contained instead of going through convert.js'
// withFtp helper because /activate-account is a small one-shot path.
async function writeOffactTrigger(ip, triggerPath, accountIdB64, onlineId) {
  const tmp = path.join(os.tmpdir(), `offact-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const body =
    `# P5 Manager - host-supplied PSN account_id for offact.elf\n` +
    `${accountIdB64}\n` +
    (onlineId ? `${onlineId}\n` : '');
  fs.writeFileSync(tmp, body);
  try {
    const client = new FtpClient(10_000);
    client.ftp.verbose = false;
    try {
      await client.access({ host: ip, port: 2121, user: 'anonymous', password: '', secure: false });
      const remoteDir = path.posix.dirname(triggerPath);
      const remoteName = path.posix.basename(triggerPath);
      if (remoteDir && remoteDir !== '/' && remoteDir !== '.') {
        await client.ensureDir(remoteDir);
      } else {
        await client.cd('/');
      }
      await client.uploadFrom(tmp, remoteName);
    } finally {
      try { client.close(); } catch (_) {}
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// Best-effort cleanup of the trigger so a stale file from a previous
// run can't accidentally re-link the wrong PSN account on the next
// invocation. Failure is non-fatal — offact treats a missing file as
// "no trigger" which is the correct behaviour after a successful run.
async function deleteOffactTrigger(ip, triggerPath) {
  try {
    const client = new FtpClient(8_000);
    client.ftp.verbose = false;
    try {
      await client.access({ host: ip, port: 2121, user: 'anonymous', password: '', secure: false });
      await client.remove(triggerPath);
    } finally {
      try { client.close(); } catch (_) {}
    }
  } catch (_) { /* ignored — see comment above */ }
}

const SIDECAR_URL = process.env.PYREMOTEPLAY_SIDECAR_URL
  || process.env.CHIAKI_SIDECAR_URL  // legacy env name, kept for older compose files
  || 'http://127.0.0.1:9555';

// Per-IP session cache so script runs can transparently reuse a single
// Remote Play session across many quick-input calls. The session is verified
// on each ensure-call against the sidecar before being trusted.
//
// We also track whether the cached session has video enabled - the sidecar
// only attaches a video receiver when `enable_video=true` is passed at start,
// so reusing a no-video session when the caller wants video gives them a
// session whose /video.mjpeg endpoint returns 400. Tracking the bit lets us
// force a fresh start in that case.
const ipToSession = new Map(); // ip -> { sid, started, video }
const SESSION_REUSE_MS = 5 * 60 * 1000;
// Per-IP in-flight Start promise so two near-simultaneous callers
// (UI double-click, autoload step + script runner, ...) collapse onto
// the same sidecar request instead of racing. Mirrors the asyncio.Lock
// on the sidecar side; defends against the case where both reach the
// sidecar before its lock is acquired.
const inFlightStarts = new Map(); // ip -> Promise<{session_id, ip, ...}>

async function sidecar(method, urlPath, body, { timeout = 30000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${SIDECAR_URL}${urlPath}`, {
      method,
      signal: controller.signal,
      ...(body !== undefined ? {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      } : {}),
    });
    let data;
    try { data = await res.json(); } catch (_) { data = {}; }
    if (!res.ok) {
      const e = new Error(data?.detail || data?.error || `sidecar ${res.status}`);
      e.status = res.status;
      e.body = data;
      throw e;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`sidecar timeout (${timeout}ms)`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const PROFILE_COLS = 'id, ip_address, rp_user_profile, psn_account_id, psn_online_id';

function loadProfileByIp(ip) {
  return getRepo().queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE ip_address = ? LIMIT 1`, [ip]);
}

function loadProfileById(id) {
  return getRepo().queryOne(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ? LIMIT 1`, [parseInt(id)]);
}

// Single shared entry-point for "give me a working Remote Play session for
// this PS5". Used by every caller that needs one: ScriptRunner's manual
// Start, Autoload's rp_session step, RemotePlay.jsx's Start button, and the
// implicit auto-open inside quick-input / run-script. Keeping the logic in
// one place means caching, credential lookup, error reporting, and the
// wakeup-before-connect handshake all behave identically everywhere.
// PS5 Remote Play stream knobs. Mirrors the whitelists on the sidecar;
// we re-validate here so a bad request body doesn't make it all the way
// to pyremoteplay before being rejected. We expose only 360p / 540p /
// 720p — 1080p was removed because the MJPEG re-encode is too slow on a
// Pi-class CPU. FPS is no longer user-configurable; the sidecar always
// runs at its default (30 fps).
const RP_RESOLUTIONS = new Set(['360p', '540p', '720p']);
const RP_DEFAULT_RESOLUTION = '720p';

function normalizeStreamParams({ resolution } = {}) {
  const res = RP_RESOLUTIONS.has(resolution) ? resolution : RP_DEFAULT_RESOLUTION;
  return { resolution: res };
}

async function ensureSessionForIp(ip, opts = {}) {
  const {
    userProfile: explicitProfile = null,
    forceNew = false,
    enableVideo = false,
    resolution: rawResolution,
  } = opts;
  const { resolution } = normalizeStreamParams({ resolution: rawResolution });

  // Coalesce concurrent callers onto the same in-flight Start. forceNew
  // bypasses the cache (above) but it does NOT bypass dedupe - if a Start
  // is already running we still want to wait for it instead of opening a
  // second handshake.
  //
  // Reuse rule: an in-flight Start can satisfy any later caller whose
  // media flag is a *subset* of the in-flight one. So an in-flight start
  // with video=true serves an input-only call (extra decoder is harmless);
  // the reverse forces a new handshake.
  const inflight = inFlightStarts.get(ip);
  if (inflight && (inflight._enableVideo || !enableVideo)) {
    return inflight;
  }

  const work = (async () => {
  if (!forceNew) {
    const cached = ipToSession.get(ip);
    const cacheMatches = cached && (cached.video || !enableVideo);
    if (cacheMatches && (Date.now() - cached.started) < SESSION_REUSE_MS) {
      try {
        const s = await sidecar('GET', `/sessions/${encodeURIComponent(cached.sid)}`, undefined, { timeout: 5000 });
        if (s.state === 'connected') {
          return {
            session_id: cached.sid, ip, cached: true,
            video: !!cached.video,
            resolution: s.resolution || cached.resolution,
          };
        }
      } catch (e) {
        // Treat sidecar timeouts as transient - keep the cached entry. Only
        // evict on a definitive "session gone" response.
        if (!/timeout|ECONN/i.test(e.message || '')) ipToSession.delete(ip);
        else return {
          session_id: cached.sid, ip, cached: true, transient: true,
          video: !!cached.video,
          resolution: cached.resolution,
        };
      }
    } else if (cached) {
      ipToSession.delete(ip);
    }
  }

  // Need a fresh session - resolve the paired credentials.
  let userProfile = explicitProfile;
  let accountId = null;
  if (!userProfile) {
    const profile = loadProfileByIp(ip);
    if (!profile?.rp_user_profile) {
      throw new Error('No Remote Play credentials for this console - pair first in the Console tab');
    }
    try { userProfile = JSON.parse(profile.rp_user_profile); }
    catch (_) { throw new Error('Stored Remote Play profile is corrupt - re-pair the console'); }
    accountId = profile.psn_account_id || null;
  }

  // Profile-aware DDP host_type: when the user (or auto-detect) labelled
  // the profile as PS4 we explicitly forward "PS4" to the sidecar so the
  // LAUNCH packet uses the PS4 service ID. Leaving null preserves the
  // legacy auto-detect path on the sidecar.
  const hostTypeProfile = loadProfileByIp(ip);
  const hostTypeOverride = hostTypeProfile?.console_type === 'ps4' ? 'PS4'
    : hostTypeProfile?.console_type === 'ps5' ? 'PS5'
    : null;

  // The sidecar uses account_id (decimal) to compute the DDP LAUNCH
  // credential, which it fires after wakeup to dismiss the "Press PS
  // button" account-picker that appears after waking from rest mode.
  //
  // Timeout budget (must match sidecar /sessions/start worst case):
  //   pre-wait for session lock release     : up to 60 s
  //   gentle quiet retries (2 × 45 s)       : up to 90 s
  //   actual connect + auth                 : up to 15 s
  //   safety margin                         :    15 s
  //   ──────────────────────────────────────────────────
  //   total                                 :   180 s
  const data = await sidecar('POST', '/sessions/start',
    {
      ip,
      user_profile: userProfile,
      account_id: accountId,
      enable_video: enableVideo,
      resolution,
      ...(hostTypeOverride ? { host_type: hostTypeOverride } : {}),
    },
    { timeout: 180000 });
  ipToSession.set(ip, {
    sid: data.session_id,
    started: Date.now(),
    video: !!data.video,
    resolution: data.resolution || resolution,
  });
  // `resumed:true` means the sidecar handed us a warm-cached session that
  // was never actually disconnected on the PS5 side - reconnect was O(ms).
  // `reused:true` means a sibling caller's Start completed first and we
  // got handed its session_id back without firing a second handshake.
  const mediaBits = data.video ? 'video' : '';
  const streamTag = data.resolution ? ` @ ${data.resolution}` : '';
  log('info', `${data.resumed ? 'Resumed' : data.reused ? 'Reused' : 'Started'} Remote Play session ${data.session_id} for ${ip}${mediaBits ? ` (with ${mediaBits})` : ''}${streamTag}`);
  return { session_id: data.session_id, ip, cached: false, state: data.state,
           resumed: !!data.resumed, reused: !!data.reused,
           video: !!data.video,
           resolution: data.resolution || resolution };
  })();

  // Tag the in-flight promise with its media mode so a concurrent caller
  // asking for a superset skips the dedupe.
  work._enableVideo = enableVideo;
  inFlightStarts.set(ip, work);
  try {
    return await work;
  } finally {
    inFlightStarts.delete(ip);
  }
}

// Map ScriptRunner.jsx commands → sidecar (pyremoteplay) button names.
const BUTTON_ALIASES = {
  cross: 'cross', x: 'cross',
  circle: 'circle', o: 'circle',
  square: 'square',
  triangle: 'triangle',
  up: 'up', down: 'down', left: 'left', right: 'right',
  l1: 'l1', r1: 'r1', l2: 'l2', r2: 'r2', l3: 'l3', r3: 'r3',
  ps: 'ps', options: 'options', share: 'share', create: 'share',
  touchpad: 'touchpad',
};

// ─── PS5 on-screen keyboard emulation ────────────────────────────────────────
//
// PS5 native software keyboard ("OSK") layout we emulate. pyremoteplay has no
// public API for the keyboard protocol so we type by walking the d-pad over
// the visible keys. Layout matches the default QWERTY view; rows are anchored
// to the same left column so deltas work cleanly.
//
//   row 0: q w e r t y u i o p
//   row 1: a s d f g h j k l
//   row 2: z x c v b n m
//   row 3: <space bar - we pick col 3 as a safe centre target>
//
// Coordinates are (col, row). The lower-case letters are listed; uppercase is
// folded to lower-case (PS5 search is case-insensitive).
const OSK_KEY_COORDS = (() => {
  const map = {};
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) map[row[c]] = [c, r];
  });
  map[' '] = [3, 3]; // space bar
  return map;
})();

function buildOskInputs(text) {
  // Returns an array of low-level events (button taps + delays) so the runner
  // can emit them one at a time and stay responsive to stopRequested.
  const events = [];
  let curCol = 0;
  let curRow = 0;
  // Snap-to-home: pretend the user already navigated to "q" by walking
  // out of any text field and into the keyboard's top-left.
  for (let i = 0; i < 4; i++) events.push({ button: 'up' });
  for (let i = 0; i < 10; i++) events.push({ button: 'left' });
  // Walk to first letter row (Q row). The reset above lands on the top-left
  // (q) directly when the keyboard has no numbers row visible; otherwise
  // it lands on the numbers row and one extra "down" gets us to Q.
  events.push({ button: 'down', soft: true }); // safe nudge into Q row
  // After the nudge we treat (0,0) as Q.
  for (const ch0 of String(text)) {
    const ch = ch0.toLowerCase();
    const coords = OSK_KEY_COORDS[ch];
    if (!coords) {
      // Unsupported char (digit / punctuation / accented). Skip but record.
      events.push({ note: `skip:${ch0}` });
      continue;
    }
    const [tc, tr] = coords;
    const dr = tr - curRow;
    const dc = tc - curCol;
    if (dr > 0) for (let i = 0; i < dr; i++) events.push({ button: 'down' });
    else if (dr < 0) for (let i = 0; i < -dr; i++) events.push({ button: 'up' });
    if (dc > 0) for (let i = 0; i < dc; i++) events.push({ button: 'right' });
    else if (dc < 0) for (let i = 0; i < -dc; i++) events.push({ button: 'left' });
    events.push({ button: 'cross', commit: true });
    curCol = tc;
    curRow = tr;
  }
  return events;
}

// Recognise a "10x" / "x10" / "*10" repeat token and return the count.
function parseRepeatToken(tok) {
  if (!tok) return null;
  const m = /^(?:x(\d+)|(\d+)x|\*(\d+))$/i.exec(tok);
  if (!m) return null;
  const n = parseInt(m[1] || m[2] || m[3], 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : null;
}

function parseScriptLine(line) {
  const t = (line || '').trim();
  if (!t || t.startsWith('//') || t.startsWith('#')) return null;
  const parts = t.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  if (cmd === 'wait' || cmd === 'sleep') {
    const ms = parseInt(parts[1], 10);
    return { type: 'wait', ms: Number.isFinite(ms) && ms >= 0 ? ms : 1000 };
  }
  // text <free-form string> — types the string on the PS5 on-screen keyboard
  // by emulating d-pad navigation + cross taps. Everything after the first
  // whitespace is the literal payload (so quotes are NOT required).
  if (cmd === 'text' || cmd === 'type') {
    const text = t.replace(/^\S+\s+/, '');
    return { type: 'text', text };
  }
  const btn = BUTTON_ALIASES[cmd];
  if (btn) {
    // Accept the remaining args in any order:
    //   left              -> 1x, 80ms
    //   left 120          -> 1x, 120ms
    //   left 10x          -> 10x, 80ms
    //   left 10x 120      -> 10x, 120ms
    //   left 120 10x      -> 10x, 120ms
    let count = 1;
    let dur = 80;
    for (let i = 1; i < parts.length; i++) {
      const rep = parseRepeatToken(parts[i]);
      if (rep != null) { count = rep; continue; }
      const n = parseInt(parts[i], 10);
      if (Number.isFinite(n)) dur = n;
    }
    return { type: 'button', button: btn, duration: dur, count };
  }
  // stick: e.g. "lstick 0.5 -0.3 200" (x, y, duration ms)
  if (cmd === 'lstick' || cmd === 'rstick') {
    const x = parseFloat(parts[1]) || 0;
    const y = parseFloat(parts[2]) || 0;
    const ms = parts[3] ? parseInt(parts[3], 10) : 250;
    return { type: 'stick', side: cmd === 'lstick' ? 'left' : 'right', x, y, ms };
  }
  return { type: 'unknown', raw: t };
}

// ─── Sidecar health -----------------------------------------------------------

router.get('/health', async (req, res) => {
  try {
    const data = await sidecar('GET', '/health', undefined, { timeout: 5000 });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// ─── PSN OAuth wizard ---------------------------------------------------------

router.get('/oauth/login-url', async (req, res) => {
  try {
    const data = await sidecar('GET', '/oauth/login_url', undefined, { timeout: 8000 });
    res.json({ success: true, url: data.url });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/oauth/exchange', async (req, res) => {
  try {
    const { redirect_url, profile_id } = req.body || {};
    if (!redirect_url) return res.status(400).json({ success: false, error: 'redirect_url required' });
    const data = await sidecar('POST', '/oauth/exchange', { redirect_url }, { timeout: 20000 });
    if (profile_id && data.account_id) {
      getRepo().runAndSave(
        'UPDATE profiles SET psn_account_id = ?, psn_online_id = ? WHERE id = ?',
        [data.account_id, data.online_id || null, parseInt(profile_id)],
      );
      log('info', `Linked PSN account ${data.online_id || data.account_id} to profile ${profile_id}`);
    }
    res.json({ success: true, account_id: data.account_id, online_id: data.online_id });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ─── Discovery / Status -------------------------------------------------------

router.get('/discover', async (req, res) => {
  try {
    const ip = req.query.ip;
    if (!ip) return res.status(400).json({ success: false, error: 'ip required' });
    const data = await sidecar('GET', `/discover?ip=${encodeURIComponent(ip)}`, undefined, { timeout: 8000 });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// ─── Wake (no session) --------------------------------------------------------
//
// Send wakeup UDP packets to the PS5 without trying to open a session. Helps
// recover the RP slot when something else kicked the previous session (e.g.
// a physical DualSense booted our Remote Play stream off the console).
router.post('/wake', async (req, res) => {
  try {
    const { ip: rawIp, profile_id } = req.body || {};
    let ip = rawIp;
    let profile = null;
    if (profile_id) profile = loadProfileById(profile_id);
    if (!ip && profile) ip = profile.ip_address;
    if (!ip) return res.status(400).json({ success: false, error: 'ip or profile_id required' });
    if (!profile) profile = loadProfileByIp(ip);
    if (!profile?.psn_account_id) return res.status(400).json({ success: false, error: 'PS5 must be PSN-linked first (Remote Play tab)' });

    let userProfile = null;
    if (profile.rp_user_profile) {
      try { userProfile = JSON.parse(profile.rp_user_profile); } catch (_) {}
    }
    // /wake is intentionally fast: it sends UDP wakeup + DDP LAUNCH packets
    // synchronously and then kicks off a background "warm cache an RP
    // session" task on the sidecar (returns `warming: true` when active).
    // The sync part stays well under 5 s; we keep a 20 s ceiling so a deep-
    // standby PS5 with packet loss still has time to respond.
    const wakeHostType = profile.console_type === 'ps4' ? 'PS4'
      : profile.console_type === 'ps5' ? 'PS5'
      : null;
    const data = await sidecar('POST', '/wake', {
      ip,
      account_id: profile.psn_account_id,
      online_id: profile.psn_online_id || null,
      user_profile: userProfile,
      ...(wakeHostType ? { host_type: wakeHostType } : {}),
    }, { timeout: 20000 });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// Put the PS5 into rest mode via Remote Play. Uses an existing live session if
// the sidecar still has one for the target IP, otherwise spins up a temporary
// session, sends the standby packet, and tears it down.
router.post('/standby', async (req, res) => {
  try {
    const { ip: rawIp, profile_id } = req.body || {};
    let ip = rawIp;
    let profile = null;
    if (profile_id) profile = loadProfileById(profile_id);
    if (!ip && profile) ip = profile.ip_address;
    if (!ip) return res.status(400).json({ success: false, error: 'ip or profile_id required' });
    if (!profile) profile = loadProfileByIp(ip);
    if (!profile?.psn_account_id) return res.status(400).json({ success: false, error: 'PS5 must be PSN-linked first' });
    if (!profile?.rp_user_profile) return res.status(400).json({ success: false, error: 'PS5 must be paired (Remote Play tab) first' });

    let userProfile = null;
    try { userProfile = JSON.parse(profile.rp_user_profile); } catch (_) {}

    const data = await sidecar('POST', '/standby', {
      ip,
      account_id: profile.psn_account_id,
      online_id: profile.psn_online_id || null,
      user_profile: userProfile,
    }, { timeout: 45000 });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// ─── Register (pair with PIN) -------------------------------------------------

router.post('/register', async (req, res) => {
  try {
    const { ip, pin, profile_id, account_id, online_id } = req.body || {};
    if (!ip || !pin) return res.status(400).json({ success: false, error: 'ip and pin required' });

    let acctId = account_id;
    let onlineId = online_id;
    let pidInt = profile_id ? parseInt(profile_id) : null;
    // Look up console_type alongside account info so we can hand pyremoteplay
    // an explicit host_type during pair. Falls back to auto-detect when null.
    let storedConsoleType = null;
    if (pidInt) {
      const row = getRepo().queryOne('SELECT psn_account_id, psn_online_id, console_type FROM profiles WHERE id = ?', [pidInt]);
      if (row) {
        if (!acctId) acctId = row.psn_account_id;
        if (!onlineId) onlineId = row.psn_online_id;
        storedConsoleType = row.console_type || null;
      }
    }
    if (!acctId) return res.status(400).json({ success: false, error: 'PSN account_id required (run OAuth first)' });

    const pairHostType = storedConsoleType === 'ps4' ? 'PS4'
      : storedConsoleType === 'ps5' ? 'PS5'
      : null;
    const data = await sidecar('POST', '/register', {
      ip,
      account_id: acctId,
      pin,
      online_id: onlineId || null,
      ...(pairHostType ? { host_type: pairHostType } : {}),
    }, { timeout: 60000 });

    if (pidInt && data.profile) {
      getRepo().runAndSave(
        'UPDATE profiles SET rp_user_profile = ? WHERE id = ?',
        [JSON.stringify(data.profile), pidInt],
      );
      log('info', `Stored Remote Play credentials for profile ${pidInt}`);
    }

    res.json({ success: true, profile: data.profile });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ─── Remote Play PIN auto-fetch ─────────────────────────────────────────────
//
// Sends rp-get-pin.elf (vendored under ../../p5managerclient/rp-get-pin/,
// built into data/payloads/) to the console's elfldr (port 9021) and harvests the
// PIN + PSN online_id (display name) + base64 Account ID from stdout.
// The payload prints exactly:
//
//   Pin code: NNNN NNNN
//   Account ID: <base64>
//   Timeout: 120 seconds
//
// — within ~1-3 s of injection (the swallow-loop patched build can take a
// few hundred ms longer when kstuff/shadowmount are concurrently running).
// We keep the socket open longer than the regular send route's 60 s cap
// since the payload's pairing loop holds it for up to 120 s; we don't
// need to wait that long — once the parser sees both lines we return.
//
// Side effects:
//   * stdout is tee'd into the kernel-log buffer with the [rp-get-pin.elf]
//     tag exactly like the regular /api/payloads/send/:id route does, so
//     the user can still inspect raw payload output from the Logs tab.
//   * The payload kills any previously-running instance on the PS5 via
//     SIGTERM (see main.c `find_pid` loop). If found, it prints
//     "Send again to get a new pin code" and exits. We surface that as a
//     409 so the UI can prompt the user to click again after a second.
router.post('/get-pin', async (req, res) => {
  try {
    const { ip: rawIp, profile_id } = req.body || {};
    let ip = rawIp;
    if (!ip && profile_id) {
      ip = getRepo().queryScalar('SELECT ip_address FROM profiles WHERE id = ?', [parseInt(profile_id)]) || null;
    }
    if (!ip) return res.status(400).json({ success: false, error: 'ip or profile_id required' });

    // Locate the payload on disk. We accept any filename that matches
    // `rp-get-pin*.elf` so a user can drop a hand-built variant into
    // data/payloads/ without renaming. Prefer the canonical name first.
    const candidates = ['rp-get-pin.elf'];
    try {
      const extras = fs.readdirSync(payloadsDir)
        .filter(n => /^rp-get-pin.*\.elf$/i.test(n) && n !== 'rp-get-pin.elf');
      candidates.push(...extras);
    } catch (_) { /* dir may not exist yet */ }

    let payloadPath = null;
    for (const c of candidates) {
      const p = path.join(payloadsDir, c);
      if (fs.existsSync(p)) { payloadPath = p; break; }
    }
    if (!payloadPath) {
      return res.status(404).json({
        success: false,
        error:
          'rp-get-pin.elf not found in data/payloads/. Build it from the vendored source at p5managerclient/rp-get-pin/ (make + copy) or upload via the Payloads tab.',
      });
    }

    const fileData = fs.readFileSync(payloadPath);
    log('info', `[get-pin] sending ${path.basename(payloadPath)} (${fileData.length} B) to ${ip}:9021`);

    const net = await import('net');
    const client = new net.Socket();
    const TAG = 'rp-get-pin.elf';

    // Parser state. The payload prints the two lines we care about
    // separated by a newline; we collect data, split on newlines, parse
    // each complete line. `leftover` holds the trailing partial line
    // between chunk callbacks (TCP doesn't respect line boundaries).
    let leftover = '';
    let pin = null;          // formatted "XXXX XXXX"
    let accountId = null;    // base64 from the ELF
    let onlineId = null;     // PSN display name (e.g. "MyHandle")
    let oldInstanceMessage = null;
    let totalBytes = 0;
    let resolved = false;
    // Buffer of all lines we received so the UI can surface them when
    // capture fails (the user gets a debug log instead of just a vague
    // "PIN not captured" message).
    const capturedLines = [];

    const finish = (extra = {}) => {
      if (resolved) return;
      resolved = true;
      try { client.destroy(); } catch (_) {}

      // When PSN is signed in on the console, rp-get-pin.elf prints the
      // real PSN account_id (read straight from regmgr) + online_id.
      // Persist them onto the profile so the rest of the pairing flow
      // (and the "Not Activated" tab's offact path) sees the link without
      // requiring the user to also run Sony OAuth. We only persist when
      // a profile_id was supplied AND we actually captured an id, so we
      // never wipe an existing OAuth-derived id on a soft failure.
      if (profile_id && accountId) {
        try {
          getRepo().run(
            'UPDATE profiles SET psn_account_id = ?, psn_online_id = COALESCE(?, psn_online_id) WHERE id = ?',
            [accountId, onlineId, parseInt(profile_id)],
          );
          log('info', `[get-pin] persisted account_id=${accountId} user=${onlineId || '?'} on profile ${profile_id}`);
        } catch (e) {
          log('warn', `[get-pin] persist failed: ${e.message}`);
        }
      }

      const payload = {
        success: true,
        pin,
        account_id: accountId,
        online_id: onlineId,
        log: capturedLines,
        ...extra,
      };
      if (!pin || !accountId) {
        // Best-effort: surface partial state. Lets the UI decide whether to
        // ask the user to look at the PS5 screen or retry. We also surface
        // a smarter diagnostic for the common "ptrace contention" case
        // (kstuff / shadowmount holding SceShellUI) so the user knows
        // exactly which fix to try (disable kstuff temporarily).
        payload.success = !!(pin && accountId);
        if (!payload.error && !payload.message) {
          const log = capturedLines.join('\n');
          if (/timed out|too many spurious|gave up waiting|Failed to allocate pincode/i.test(log)) {
            payload.message =
              'rp-get-pin.elf could not acquire SceShellUI (probably kstuff/shadowmount is holding ptrace). ' +
              'Soft-reboot the PS5 and run rp-get-pin.elf before any other payload, or disable kstuff temporarily.';
          } else if (oldInstanceMessage) {
            payload.message = oldInstanceMessage;
          } else if (capturedLines.length === 0) {
            payload.message =
              'No output from rp-get-pin.elf - the ELF may not have started (elfldr issue) or SceShellUI is stuck. Try sending the payload manually from the Payloads tab to debug.';
          } else {
            payload.message =
              'Payload ran but PIN line was not captured. See "log" field for details. The PIN may still be showing on your PS5 screen as a notification.';
          }
        }
      }
      res.json(payload);
    };

    client.on('data', (chunk) => {
      totalBytes += chunk.length;
      const text = leftover + chunk.toString('utf8');
      const lines = text.split(/\r?\n/);
      leftover = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        pushKernelLogEntry(line, ip, TAG);
        capturedLines.push(line);

        // "Pin code: 1234 5678"
        const mPin = /Pin code:\s*(\d{4})\s+(\d{4})/i.exec(line);
        if (mPin) pin = `${mPin[1]} ${mPin[2]}`;

        // "User: <psn-online-id>"  (may be "(unknown)" if SDK call fails)
        const mUser = /^User:\s*(.+?)\s*$/.exec(line);
        if (mUser && mUser[1] !== '(unknown)') onlineId = mUser[1];

        // "Account ID: <base64>"
        const mAcc = /Account ID:\s*([A-Za-z0-9+/=]{8,})/.exec(line);
        if (mAcc) accountId = mAcc[1];

        // Old-instance bail: payload prints this and exits if a previous
        // copy was still running (it sent SIGTERM to it). The OLD copy
        // is still happily generating a PIN and showing notifications on
        // the PS5 screen — we surface that to the UI so the user clicks
        // again in 2 s, by which time the old copy has shut down cleanly.
        if (/Send again to get a new pin code/i.test(line)) {
          oldInstanceMessage = 'Old payload instance was running; it was just terminated. Try again in 2 s.';
        }
      }

      if (pin && accountId) {
        log('info', `[get-pin] captured PIN ${pin} + user=${onlineId || '?'} + Account ID ${accountId}`);
        finish();
      }
    });

    client.on('close', () => {
      if (leftover.trim()) pushKernelLogEntry(leftover, ip, TAG);
      log('info', `[get-pin] socket closed, ${totalBytes} B received`);
      finish();
    });

    client.on('error', (err) => {
      if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return;
      log('warn', `[get-pin] socket error: ${err.message}`);
      if (!resolved) {
        resolved = true;
        try { client.destroy(); } catch (_) {}
        res.status(502).json({ success: false, error: `socket error: ${err.message}` });
      }
    });

    // Cap how long we wait for the parser. Best case: ~3 s when there's
    // no old instance to clean up. Worst case: ~25 s when we have to
    // SIGKILL an old instance, wait 6 s for SceShellUI to respawn, then
    // burn another ~15 s polling 0x80FC0004 from sceRemoteplayGeneratePinCode
    // until the Remote Play service is ready. 45 s gives ample headroom.
    client.setTimeout(45_000, () => {
      log('warn', `[get-pin] read timeout (${totalBytes} B captured)`);
      if (!resolved) finish();
      else { try { client.destroy(); } catch (_) {} }
    });

    let writeOk = false;
    await new Promise((resolve, reject) => {
      client.connect(9021, ip, () => {
        client.write(fileData, (err) => {
          if (err) return reject(err);
          writeOk = true;
          // Half-close write side — elfldr reads until EOF before executing.
          client.end();
          resolve();
        });
      });
      const earlyError = (err) => { if (!writeOk) reject(err); };
      client.once('error', earlyError);
    });
  } catch (err) {
    log('error', `[get-pin] failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Offline PSN activation (offact.elf) ────────────────────────────────────
//
// Sends offact.elf (vendored under ../../p5managerclient/offact/, built into
// data/payloads/) to the console's elfldr (port 9021). The payload picks
// up the currently signed-in user, derives a deterministic account_id
// from the display name, writes it + type "np" + flags 0x1002 to the
// user's registry slot, and prints structured stdout:
//
//   User: <display name>
//   Account ID: <base64 of raw 8 bytes>
//   Account ID (hex): 0x<16 hex>
//   Slot: <1..16>
//   Activated: yes|already|failed
//
// We forward the captured account_id back to the caller and, if a
// profile_id was supplied, also persist it into profiles.psn_account_id /
// psn_online_id so the rest of the pairing flow ("Auto-fetch PIN" +
// "Pair") works without the OAuth step. This is the offline-activation
// counterpart to /oauth/exchange.
router.post('/activate-account', async (req, res) => {
  try {
    const {
      ip: rawIp,
      profile_id,
      force,
      // Optional override: caller can supply a base64 account_id + online_id
      // directly (e.g. right after running PSN OAuth in the UI). When
      // omitted we fall back to the profile's stored psn_account_id.
      account_id: bodyAccountId,
      online_id: bodyOnlineId,
      // Optional custom trigger path - matches the build-time TRIGGER_PATH
      // in offact.elf. Defaults to /data/.p5manager-offact.
      trigger_path: bodyTriggerPath,
    } = req.body || {};

    let ip = rawIp;
    let psnAccountId = bodyAccountId || null;
    let psnOnlineId = bodyOnlineId || null;
    if ((!ip || !psnAccountId) && profile_id) {
      const row = getRepo().queryOne('SELECT ip_address, psn_account_id, psn_online_id FROM profiles WHERE id = ?', [parseInt(profile_id)]);
      if (row) {
        if (!ip) ip = row.ip_address;
        if (!psnAccountId) psnAccountId = row.psn_account_id || null;
        if (!psnOnlineId) psnOnlineId = row.psn_online_id || null;
      }
    }
    if (!ip) return res.status(400).json({ success: false, error: 'ip or profile_id required' });

    const triggerPath = bodyTriggerPath || OFFACT_TRIGGER_DEFAULT;

    // If we have a host-side PSN account_id (either passed inline or
    // pulled off the profile), drop it into the trigger file on the
    // PS5 BEFORE we send the ELF. offact.elf reads the file when the
    // console's own registry slot is empty (no PSN linked yet) and
    // adopts that account_id - this is the "manager linked PSN
    // remotely via OAuth, mirror it onto the console" path.
    let triggerWritten = false;
    if (psnAccountId) {
      try {
        await writeOffactTrigger(ip, triggerPath, psnAccountId, psnOnlineId || null);
        triggerWritten = true;
        log('info', `[offact] trigger file written to ${ip}:${triggerPath} (account=${psnOnlineId || psnAccountId})`);
      } catch (e) {
        // Non-fatal: offact still works against an on-console PSN
        // account if one exists. We just won't be able to adopt the
        // host-supplied id.
        log('warn', `[offact] trigger upload failed (${e.message}); falling back to on-console registry`);
      }
    } else {
      log('info', `[offact] no host PSN account_id available (profile not OAuth-linked); offact will rely on the on-console registry`);
    }

    const candidates = ['offact.elf'];
    try {
      const extras = fs.readdirSync(payloadsDir)
        .filter(n => /^offact.*\.elf$/i.test(n) && n !== 'offact.elf');
      candidates.push(...extras);
    } catch (_) { /* dir may not exist */ }

    let payloadPath = null;
    for (const c of candidates) {
      const p = path.join(payloadsDir, c);
      if (fs.existsSync(p)) { payloadPath = p; break; }
    }
    if (!payloadPath) {
      return res.status(404).json({
        success: false,
        error:
          'offact.elf not found in data/payloads/. Build it from the vendored source at p5managerclient/offact/ (make + copy) or upload via the Payloads tab.',
      });
    }

    const fileData = fs.readFileSync(payloadPath);
    log('info', `[offact] sending ${path.basename(payloadPath)} (${fileData.length} B) to ${ip}:9021${force ? ' (--force)' : ''}`);

    const net = await import('net');
    const client = new net.Socket();
    const TAG = 'offact.elf';

    let leftover = '';
    let user = null;
    let accountIdB64 = null;
    let accountIdHex = null;
    let slot = null;
    let activated = null; // 'yes' | 'already' | 'failed'
    let resolved = false;
    let totalBytes = 0;
    const capturedLines = [];

    const finish = (extra = {}) => {
      if (resolved) return;
      resolved = true;
      try { client.destroy(); } catch (_) {}

      // Persist the derived/captured account_id onto the profile so the
      // rest of the pairing flow lights up. Only do this when we got
      // something usable AND the user passed a profile_id - we never
      // mutate profiles on a pure success-less probe.
      let persisted = false;
      if (profile_id && accountIdB64 && (activated === 'yes' || activated === 'already')) {
        try {
          getRepo().runAndSave(
            'UPDATE profiles SET psn_account_id = ?, psn_online_id = ? WHERE id = ?',
            [accountIdB64, user || null, parseInt(profile_id)],
          );
          persisted = true;
          log('info', `[offact] persisted account_id=${accountIdB64} user=${user || '?'} on profile ${profile_id}`);
        } catch (e) {
          log('warn', `[offact] failed to persist profile: ${e.message}`);
        }
      }

      const payload = {
        success: activated === 'yes' || activated === 'already',
        activated,                          // 'yes' | 'already' | 'failed' | null
        user,
        account_id: accountIdB64,
        account_id_hex: accountIdHex,
        slot,
        persisted,
        trigger_written: triggerWritten,
        log: capturedLines,
        ...extra,
      };

      // Once offact has reported a terminal outcome, remove the trigger
      // file so a later run doesn't accidentally re-adopt a stale id.
      // Fire-and-forget — we already have the payload, no need to block
      // the response on FTP cleanup.
      if (triggerWritten) {
        deleteOffactTrigger(ip, triggerPath).catch(() => {});
      }
      if (!payload.success && !payload.error && !payload.message) {
        if (capturedLines.length === 0) {
          payload.message = 'No output from offact.elf - the ELF may not have started (elfldr issue) or the PS5 is not reachable.';
        } else if (activated === 'failed') {
          payload.message = 'offact.elf ran but registry writes returned an error. See "log" for diagnostics (sceRegMgrSetBin / sceRegMgrSetStr return codes).';
        } else {
          payload.message = 'offact.elf ran but no "Activated:" line was captured. See "log" for details.';
        }
      }
      res.json(payload);
    };

    client.on('data', (chunk) => {
      totalBytes += chunk.length;
      const text = leftover + chunk.toString('utf8');
      const lines = text.split(/\r?\n/);
      leftover = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        pushKernelLogEntry(line, ip, TAG);
        capturedLines.push(line);

        const mUser = /^User:\s*(.+?)\s*$/.exec(line);
        if (mUser) user = mUser[1];

        const mAcc = /^Account ID:\s*([A-Za-z0-9+/=]{8,})\s*$/.exec(line);
        if (mAcc) accountIdB64 = mAcc[1];

        const mHex = /^Account ID \(hex\):\s*(0x[0-9a-fA-F]+)\s*$/.exec(line);
        if (mHex) accountIdHex = mHex[1];

        const mSlot = /^Slot:\s*(\d+)\s*$/.exec(line);
        if (mSlot) slot = parseInt(mSlot[1], 10);

        const mAct = /^Activated:\s*(yes|already|failed)\s*$/i.exec(line);
        if (mAct) activated = mAct[1].toLowerCase();
      }

      // offact is fast (no ptrace, no SceShellUI involvement); resolve
      // as soon as we see the terminal "Activated:" line.
      if (activated) {
        log('info', `[offact] result: activated=${activated} user=${user || '?'} slot=${slot} id=${accountIdB64 || '?'}`);
        finish();
      }
    });

    client.on('close', () => {
      if (leftover.trim()) pushKernelLogEntry(leftover, ip, TAG);
      log('info', `[offact] socket closed, ${totalBytes} B received`);
      finish();
    });

    client.on('error', (err) => {
      if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return;
      log('warn', `[offact] socket error: ${err.message}`);
      if (!resolved) {
        resolved = true;
        try { client.destroy(); } catch (_) {}
        res.status(502).json({ success: false, error: `socket error: ${err.message}` });
      }
    });

    // offact only does a handful of regmgr syscalls - 5 s is generous.
    client.setTimeout(8_000, () => {
      log('warn', `[offact] read timeout (${totalBytes} B captured)`);
      if (!resolved) finish();
      else { try { client.destroy(); } catch (_) {} }
    });

    // Forward the --force flag through to the ELF when caller requested
    // it. elfldr concats argv after a NUL-terminated cmdline header so
    // we just append " --force" to the bytes before send. (The simpler
    // path: a tiny stub that reads argv. offact.elf does that already.)
    //
    // NOTE: elfldr on PS5 expects raw ELF only - we don't add argv here
    // because the protocol doesn't support it. The `--force` flag is
    // exposed via the OFFACT_FORCE=1 env path inside the ELF instead,
    // but elfldr doesn't pass env either. For now `force` is a no-op on
    // wire; we keep the parameter so the UI can pass it once we ship
    // a force-variant ELF or extend elfldr.
    let writeOk = false;
    await new Promise((resolve, reject) => {
      client.connect(9021, ip, () => {
        client.write(fileData, (err) => {
          if (err) return reject(err);
          writeOk = true;
          client.end();
          resolve();
        });
      });
      const earlyError = (err) => { if (!writeOk) reject(err); };
      client.once('error', earlyError);
    });
  } catch (err) {
    log('error', `[offact] failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Session lifecycle --------------------------------------------------------

// Public Start endpoint. Used by RemotePlay.jsx's "Start session" button.
// Delegates to the shared ensureSessionForIp() so behaviour is identical to
// ScriptRunner's Start and the Autoload rp_session start step.
router.post('/sessions/start', async (req, res) => {
  try {
    const { ip: rawIp, profile_id } = req.body || {};
    let ip = rawIp;
    if (!ip && profile_id) ip = loadProfileById(profile_id)?.ip_address;
    if (!ip) return res.status(400).json({ success: false, error: 'ip or profile_id required' });

    // Caller may force a brand-new session (e.g. after Force-reset) or supply
    // a user_profile inline for diagnostics / tests. `enable_video` opts in
    // to the MJPEG live-preview receiver on the sidecar.
    const data = await ensureSessionForIp(ip, {
      userProfile: req.body?.user_profile || null,
      forceNew: !!req.body?.force_new,
      enableVideo: !!req.body?.enable_video,
      resolution: req.body?.resolution,
    });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// Proxy the MJPEG video preview from the sidecar to the browser. Plain
// pass-through: we don't decode or re-encode anything, just pipe the
// multipart/x-mixed-replace stream byte-for-byte. The browser renders it
// with a vanilla <img src="..."> tag.
//
// We deliberately use Node's native `fetch` here (instead of the `sidecar()`
// helper) because that helper buffers the full body before returning, which
// would defeat streaming entirely.
router.get('/sessions/:sid/video.mjpeg', async (req, res) => {
  const sid = req.params.sid;
  const fps = req.query.fps || '12';
  const upstreamUrl = `${SIDECAR_URL}/sessions/${encodeURIComponent(sid)}/video.mjpeg?fps=${encodeURIComponent(fps)}`;

  // Tie the upstream fetch lifecycle to the client connection - if the
  // browser closes the <img> (page nav, toggle off), we abort the sidecar
  // request so its generator gets GeneratorExit and stops encoding JPEGs.
  const controller = new AbortController();
  let aborted = false;
  const onClose = () => {
    if (!aborted) { aborted = true; controller.abort(); }
  };
  req.on('close', onClose);

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, { signal: controller.signal });
  } catch (err) {
    req.off('close', onClose);
    if (err.name === 'AbortError') return; // client gone before headers
    return res.status(502).json({ success: false, error: `sidecar unreachable: ${err.message}` });
  }

  if (!upstream.ok) {
    req.off('close', onClose);
    let detail = '';
    try { detail = (await upstream.json())?.detail || ''; } catch (_) {}
    return res.status(upstream.status).json({ success: false, error: detail || `sidecar ${upstream.status}` });
  }

  // Mirror the multipart content-type (including boundary) and disable any
  // proxy buffering so frames hit the browser as soon as they arrive.
  res.status(200);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=rpframe');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const reader = upstream.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        // Back-pressure: pause until the socket drains, otherwise we leak
        // memory when the client is slower than the PS5 frame rate.
        await new Promise((r) => res.once('drain', r));
      }
    }
  } catch (err) {
    // Upstream aborted (session stopped, sidecar dropped) or client closed.
    // Either way just end the response.
  } finally {
    req.off('close', onClose);
    try { res.end(); } catch (_) {}
  }
});

router.post('/sessions/:sid/input', async (req, res) => {
  try {
    const data = await sidecar('POST', `/sessions/${encodeURIComponent(req.params.sid)}/input`, req.body || {}, { timeout: 5000 });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// Fullscreen "Shake" gesture — proxies to the sidecar's Controller.shake()
// motion-burst patch. The sidecar fires the animation on a daemon thread
// and returns immediately, so a short timeout is fine even though the
// PS5-side effect lasts the full duration_ms.
router.post('/sessions/:sid/shake', async (req, res) => {
  try {
    const body = req.body || {};
    const payload = {};
    if (body.duration_ms !== undefined && body.duration_ms !== null) {
      payload.duration_ms = Math.max(50, Math.min(5000, Number(body.duration_ms) || 700));
    }
    if (body.intensity !== undefined && body.intensity !== null) {
      payload.intensity = Math.max(0, Math.min(1, Number(body.intensity) || 0.85));
    }
    const data = await sidecar('POST', `/sessions/${encodeURIComponent(req.params.sid)}/shake`, payload, { timeout: 6500 });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

router.get('/sessions/:sid', async (req, res) => {
  try {
    const data = await sidecar('GET', `/sessions/${encodeURIComponent(req.params.sid)}`, undefined, { timeout: 5000 });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

router.post('/sessions/:sid/stop', async (req, res) => {
  try {
    // Sidecar waits up to ~12 s for the PS5 to ack the disconnect, so give
    // the HTTP call enough headroom to deliver the result.
    const data = await sidecar('POST', `/sessions/${encodeURIComponent(req.params.sid)}/stop`, {}, { timeout: 20000 });
    // Evict the cache so the next quick-input/script call starts fresh.
    for (const [ip, v] of ipToSession.entries()) {
      if (v.sid === req.params.sid) ipToSession.delete(ip);
    }
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// ─── Direct session control (used by ScriptRunner + autoload rp_session step)

// Open (or reuse) the cached Remote Play session for an IP. Returns the
// session id and current cached state without requiring the caller to know
// anything about pyremoteplay.
// Pre-warm: open a full Remote Play session, then immediately park it in
// the sidecar's warm cache. Used by the "Wake PS5" buttons everywhere - the
// user gets a console that is genuinely ready (RP auth handshake done, slot
// claimed), and the *next* Start session resumes from warm cache in O(ms)
// instead of fighting the PS5 post-disconnect lock.
//
// Resolves credentials the same way ensureSessionForIp() does, so the
// caller only needs ip or profile_id.
router.post('/prewarm', async (req, res) => {
  try {
    const { ip: rawIp, profile_id } = req.body || {};
    let ip = rawIp;
    let profile = null;
    if (profile_id) profile = loadProfileById(profile_id);
    if (!ip && profile) ip = profile.ip_address;
    if (!ip) return res.status(400).json({ success: false, error: 'ip or profile_id required' });
    if (!profile) profile = loadProfileByIp(ip);
    if (!profile?.rp_user_profile) {
      return res.status(400).json({ success: false, error: 'No Remote Play credentials for this PS5 - pair first in the Remote Play tab' });
    }
    let userProfile;
    try { userProfile = JSON.parse(profile.rp_user_profile); }
    catch (_) { return res.status(400).json({ success: false, error: 'Stored Remote Play profile is corrupt - re-pair the PS5' }); }

    const prewarmStream = normalizeStreamParams({
      resolution: req.body?.resolution,
    });
    const data = await sidecar('POST', '/sessions/prewarm', {
      ip,
      user_profile: userProfile,
      account_id: profile.psn_account_id || null,
      enable_video: !!req.body?.enable_video,
      resolution: prewarmStream.resolution,
    }, { timeout: 180000 });

    // Drop the local cache - the session is now in the sidecar's warm
    // cache, not the live SESSIONS pool, so a subsequent quick-input or
    // /sessions/start needs to go through ensureSessionForIp() again
    // (which will resume from warm cache for free).
    ipToSession.delete(ip);
    log('info', `Pre-warmed Remote Play session ${data.session_id} for ${ip}`
      + (data.warm_cached ? ` (warm-cached ${data.warm_cache_ttl_s}s)` : ' (already live)'));
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// Alias of /sessions/start kept for backwards compatibility with ScriptRunner
// and Autoload's rp_session step. Goes through the same ensureSessionForIp()
// helper so callers can't accidentally diverge.
router.post('/quick-start', async (req, res) => {
  try {
    const { ip: rawIp, profile_id } = req.body || {};
    let ip = rawIp;
    if (!ip && profile_id) ip = loadProfileById(profile_id)?.ip_address;
    if (!ip) return res.status(400).json({ success: false, error: 'ip or profile_id required' });
    const data = await ensureSessionForIp(ip, { forceNew: !!req.body?.force_new });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// Tear down a cached session for an IP, freeing the PS5-side state. Quiet
// no-op if no session was cached.
router.post('/quick-stop', async (req, res) => {
  try {
    const { ip: rawIp, profile_id, all } = req.body || {};
    let ip = rawIp;
    if (!ip && profile_id) ip = loadProfileById(profile_id)?.ip_address;
    if (!ip) return res.status(400).json({ success: false, error: 'ip or profile_id required' });

    let cachedStopped = false;
    const cached = ipToSession.get(ip);
    if (cached) {
      // Soft stop (no force=true) - the sidecar parks the session in its
      // PAUSED_SESSIONS warm cache so the next Start resumes instantly
      // instead of fighting the PS5 post-disconnect session lock.
      try { await sidecar('POST', `/sessions/${encodeURIComponent(cached.sid)}/stop`, {}, { timeout: 20000 }); } catch (_) {}
      ipToSession.delete(ip);
      cachedStopped = true;
    }

    // /sessions/stop-all is a HARD reset: it tears down BOTH the live
    // SESSIONS pool and the PAUSED_SESSIONS warm cache, and stamps
    // RECENT_DISCONNECTS so the next Start sleeps out the 60s PS5 lock.
    // That is exactly what we want for `force reset`, but it's the wrong
    // thing to do on a normal Stop - it would wipe the warm cache we just
    // populated via /sessions/:sid/stop a few lines up.
    //
    // So: only call stop-all when the caller explicitly asks for it via
    // `all:true`. The previous "also call it when we had nothing cached"
    // fallback turned out to be hostile to warm-cache reuse: a fresh
    // /quick-stop call right after /sessions/:sid/stop (the Node cache
    // gets cleared there too) would still trigger stop-all.
    let sidecarStopped = [];
    if (all) {
      try {
        const r = await sidecar('POST', `/sessions/stop-all?ip=${encodeURIComponent(ip)}`, {}, { timeout: 8000 });
        sidecarStopped = r?.stopped || [];
      } catch (_) {}
    }

    res.json({
      success: true,
      ip,
      stopped: cachedStopped,
      cleared_sidecar_sessions: sidecarStopped,
    });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// Report the state of any Remote Play session resources we have for an IP.
// The response covers three cases:
//   - active live session  → { active: true, session_id, video }
//   - warm-cached session  → { active: false, warm: true, warm_ttl_s, video }
//   - nothing              → { active: false, warm: false }
//
// We always consult the sidecar (it's the source of truth, especially after
// a Node restart that loses ipToSession). Local cache is only used as a
// hint for the session_id when the sidecar confirms it's still alive.
router.get('/quick-status', async (req, res) => {
  try {
    const { ip } = req.query || {};
    if (!ip) return res.status(400).json({ success: false, error: 'ip required' });

    const cached = ipToSession.get(ip);

    // First check: if we have a local cached session_id, verify it against
    // the sidecar directly. This is the cheap fast path.
    if (cached) {
      try {
        const s = await sidecar('GET', `/sessions/${encodeURIComponent(cached.sid)}`, undefined, { timeout: 10000 });
        if (s.state === 'connected') {
          return res.json({
            success: true,
            active: true,
            warm: false,
            ip,
            session_id: cached.sid,
            state: s.state,
            video: !!s.video,
            resolution: s.resolution || cached.resolution || null,
          });
        }
        // Session exists but isn't connected - drop the stale local cache
        // and fall through to the sidecar-wide warm-status lookup below.
        ipToSession.delete(ip);
      } catch (e) {
        // Treat sidecar timeouts as transient - keep the cached entry and
        // tell the UI "we don't know yet, assume still active". Only evict
        // on a definitive 4xx ("session not found").
        const transient = /timeout|ECONN/i.test(e.message || '');
        if (transient) {
          return res.json({
            success: true,
            active: true,
            warm: false,
            ip,
            session_id: cached.sid,
            transient: true,
            video: !!cached.video,
            resolution: cached.resolution || null,
          });
        }
        ipToSession.delete(ip);
      }
    }

    // No local session_id (or it was stale) - ask the sidecar what it knows
    // about this IP. Covers warm cache (pre-warmed by Wake button) and
    // sessions opened by other clients between Node restarts.
    try {
      const w = await sidecar('GET', `/warm-status?ip=${encodeURIComponent(ip)}`, undefined, { timeout: 5000 });
      if (w.live) {
        // Re-populate Node's cache so subsequent calls hit the fast path.
        ipToSession.set(ip, {
          sid: w.session_id,
          started: Date.now(),
          video: !!w.video,
          resolution: w.resolution || null,
        });
        return res.json({
          success: true,
          active: true,
          warm: false,
          ip,
          session_id: w.session_id,
          video: !!w.video,
          resolution: w.resolution || null,
        });
      }
      if (w.warm) {
        return res.json({
          success: true,
          active: false,
          warm: true,
          ip,
          warm_session_id: w.session_id,
          warm_age_s: w.age_s,
          warm_ttl_remaining_s: w.ttl_remaining_s,
          video: !!w.video,
          resolution: w.resolution || null,
        });
      }
    } catch (_) { /* sidecar transient - report as "nothing" */ }

    return res.json({ success: true, active: false, warm: false, ip });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// ─── Script runner ------------------------------------------------------------

// Send one or more button/stick events as a quick-tap. Automatically starts a
// Remote Play session for the target IP (using stored pair credentials) and
// reuses it across calls.
router.post('/quick-input', async (req, res) => {
  try {
    const { ip: rawIp, profile_id, button, action = 'tap', duration_ms = 80, stick, x, y } = req.body || {};
    let ip = rawIp;
    if (!ip && profile_id) ip = loadProfileById(profile_id)?.ip_address;
    if (!ip) return res.status(400).json({ success: false, error: 'ip or profile_id required' });
    if (!button && !stick) return res.status(400).json({ success: false, error: 'button or stick required' });

    const { session_id: sid } = await ensureSessionForIp(ip);
    const payload = button
      ? { button: BUTTON_ALIASES[button.toLowerCase()] || button.toLowerCase(), action, duration_ms }
      : { stick, x, y };
    await sidecar('POST', `/sessions/${encodeURIComponent(sid)}/input`, payload, { timeout: 5000 });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// Run a saved or inline input script through a Remote Play session.
// Body: { profile_id?|ip?, script?, script_id?, keep_session? }
// Response: { success, session_id, events: [{line, type, ...}] }
router.post('/run-script', async (req, res) => {
  try {
    const { script: rawScript, ip: rawIp, profile_id, script_id, keep_session = true } = req.body || {};

    let actualScript = rawScript;
    if (!actualScript && script_id) {
      actualScript = getRepo().queryScalar('SELECT script FROM input_scripts WHERE id = ?', [parseInt(script_id)]) || null;
    }
    if (!actualScript) return res.status(400).json({ success: false, error: 'script or script_id required' });

    let ip = rawIp;
    if (!ip && profile_id) ip = loadProfileById(profile_id)?.ip_address;
    if (!ip) return res.status(400).json({ success: false, error: 'ip or profile_id required' });

    const lines = String(actualScript).split('\n');
    let sid;
    try {
      const r = await ensureSessionForIp(ip);
      sid = r.session_id;
    } catch (e) { return res.status(400).json({ success: false, error: e.message }); }

    const events = [];
    const sendButton = async (button, duration) => {
      try {
        await sidecar('POST', `/sessions/${encodeURIComponent(sid)}/input`, {
          button, action: 'tap', duration_ms: duration,
        }, { timeout: 5000 });
        return null;
      } catch (e) {
        // Session may have died (PS5 entered rest mode mid-script). Try once
        // to recreate it and replay the button.
        if (e.status === 404 || /session/i.test(e.message)) {
          ipToSession.delete(ip);
          try {
            const r = await ensureSessionForIp(ip);
            sid = r.session_id;
            await sidecar('POST', `/sessions/${encodeURIComponent(sid)}/input`, {
              button, action: 'tap', duration_ms: duration,
            }, { timeout: 5000 });
            return 'recovered';
          } catch (e2) { return e2.message; }
        }
        return e.message;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const parsed = parseScriptLine(lines[i]);
      if (!parsed) continue;
      if (parsed.type === 'wait') {
        events.push({ line: i + 1, type: 'wait', ms: parsed.ms });
        await new Promise((r) => setTimeout(r, parsed.ms));
        continue;
      }
      if (parsed.type === 'unknown') {
        events.push({ line: i + 1, type: 'error', msg: `unknown command: ${parsed.raw}` });
        continue;
      }
      if (parsed.type === 'text') {
        const inputs = buildOskInputs(parsed.text || '');
        let typed = 0;
        let errLast = null;
        for (const ev of inputs) {
          if (ev.note) continue;
          const dur = ev.commit ? 100 : 60;
          const err = await sendButton(ev.button, dur);
          if (err && err !== 'recovered') errLast = err;
          // Spacing between key navigations (small) and after a commit (a bit
          // longer so PS5 can render the inserted character).
          await new Promise((r) => setTimeout(r, ev.commit ? 140 : 90));
          if (ev.commit) typed++;
        }
        events.push({
          line: i + 1, type: 'text', text: parsed.text, typed,
          ...(errLast ? { error: errLast } : {}),
        });
        continue;
      }
      if (parsed.type === 'button') {
        const reps = Math.max(1, parsed.count || 1);
        let lastErr = null;
        let recoveredAny = false;
        for (let r = 0; r < reps; r++) {
          const err = await sendButton(parsed.button, parsed.duration);
          if (err === 'recovered') recoveredAny = true;
          else if (err) lastErr = err;
          // Spacing between repeats so PS5 menus register each press as a
          // discrete event instead of a long hold.
          await new Promise((rs) => setTimeout(rs, 60));
        }
        events.push({
          line: i + 1, type: 'button', button: parsed.button, count: reps,
          ...(lastErr ? { error: lastErr } : {}),
          ...(recoveredAny ? { recovered: true } : {}),
        });
        continue;
      }
      if (parsed.type === 'stick') {
        try {
          await sidecar('POST', `/sessions/${encodeURIComponent(sid)}/input`, {
            stick: parsed.side, x: parsed.x, y: parsed.y,
          }, { timeout: 5000 });
          await new Promise((r) => setTimeout(r, parsed.ms));
          // Re-center
          await sidecar('POST', `/sessions/${encodeURIComponent(sid)}/input`, {
            stick: parsed.side, x: 0, y: 0,
          }, { timeout: 5000 });
          events.push({ line: i + 1, type: 'stick', side: parsed.side, x: parsed.x, y: parsed.y, ms: parsed.ms });
        } catch (e) {
          events.push({ line: i + 1, type: 'error', msg: `stick failed: ${e.message}` });
        }
      }
    }

    if (!keep_session) {
      try { await sidecar('POST', `/sessions/${encodeURIComponent(sid)}/stop`, {}, { timeout: 20000 }); } catch (_) {}
      ipToSession.delete(ip);
    }

    res.json({ success: true, session_id: sid, events });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// Convenience: forget the saved RP credentials on a profile.
router.post('/forget', (req, res) => {
  try {
    const { profile_id } = req.body || {};
    if (!profile_id) return res.status(400).json({ success: false, error: 'profile_id required' });
    getRepo().runAndSave('UPDATE profiles SET rp_user_profile = NULL WHERE id = ?', [parseInt(profile_id)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Counterpart of /oauth/exchange + /activate-account: drops the PSN
// account binding from the profile. We deliberately do NOT touch
// rp_user_profile here - the pairing credential is independent and
// users may want to re-link a different PSN account onto the same
// pairing (e.g. to fix an account_id mismatch from upstream OAuth).
router.post('/forget-account', (req, res) => {
  try {
    const { profile_id } = req.body || {};
    if (!profile_id) return res.status(400).json({ success: false, error: 'profile_id required' });
    getRepo().runAndSave(
      'UPDATE profiles SET psn_account_id = NULL, psn_online_id = NULL WHERE id = ?',
      [parseInt(profile_id)],
    );
    log('info', `Forgotten PSN account on profile ${profile_id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
