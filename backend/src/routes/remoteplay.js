import express from 'express';
import { getDatabase, saveDatabase, log } from '../db/sqlite.js';

const router = express.Router();

const SIDECAR_URL = process.env.CHIAKI_SIDECAR_URL || 'http://127.0.0.1:9555';

// Per-IP session cache so script runs can transparently reuse a single
// Remote Play session across many quick-input calls. The session is verified
// on each ensure-call against the sidecar before being trusted.
const ipToSession = new Map(); // ip -> { sid, started }
const SESSION_REUSE_MS = 5 * 60 * 1000;

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
  const db = getDatabase();
  const stmt = db.prepare(`SELECT ${PROFILE_COLS} FROM profiles WHERE ip_address = ? LIMIT 1`);
  stmt.bind([ip]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function loadProfileById(id) {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT ${PROFILE_COLS} FROM profiles WHERE id = ? LIMIT 1`);
  stmt.bind([parseInt(id)]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

// Single shared entry-point for "give me a working Remote Play session for
// this PS5". Used by every caller that needs one: ScriptRunner's manual
// Start, Autoload's rp_session step, RemotePlay.jsx's Start button, and the
// implicit auto-open inside quick-input / run-script. Keeping the logic in
// one place means caching, credential lookup, error reporting, and the
// wakeup-before-connect handshake all behave identically everywhere.
async function ensureSessionForIp(ip, opts = {}) {
  const { userProfile: explicitProfile = null, forceNew = false } = opts;

  if (!forceNew) {
    const cached = ipToSession.get(ip);
    if (cached && (Date.now() - cached.started) < SESSION_REUSE_MS) {
      try {
        const s = await sidecar('GET', `/sessions/${encodeURIComponent(cached.sid)}`, undefined, { timeout: 5000 });
        if (s.state === 'connected') return { session_id: cached.sid, ip, cached: true };
      } catch (e) {
        // Treat sidecar timeouts as transient - keep the cached entry. Only
        // evict on a definitive "session gone" response.
        if (!/timeout|ECONN/i.test(e.message || '')) ipToSession.delete(ip);
        else return { session_id: cached.sid, ip, cached: true, transient: true };
      }
      if (forceNew) ipToSession.delete(ip);
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
      throw new Error('No Remote Play credentials for this PS5 - pair first in the Remote Play tab');
    }
    try { userProfile = JSON.parse(profile.rp_user_profile); }
    catch (_) { throw new Error('Stored Remote Play profile is corrupt - re-pair the PS5'); }
    accountId = profile.psn_account_id || null;
  }

  // The sidecar uses account_id (decimal) to compute the DDP LAUNCH
  // credential, which it fires after wakeup to dismiss the PS5 "Press PS
  // button" account-picker that appears after waking from rest mode.
  //
  // Timeout budget (must match sidecar /sessions/start worst case):
  //   pre-wait for PS5 session lock release : up to 60 s
  //   gentle quiet retries (2 × 45 s)       : up to 90 s
  //   actual connect + auth                 : up to 15 s
  //   safety margin                         :    15 s
  //   ──────────────────────────────────────────────────
  //   total                                 :   180 s
  const data = await sidecar('POST', '/sessions/start',
    { ip, user_profile: userProfile, account_id: accountId },
    { timeout: 180000 });
  ipToSession.set(ip, { sid: data.session_id, started: Date.now() });
  // `resumed:true` means the sidecar handed us a warm-cached session that
  // was never actually disconnected on the PS5 side - reconnect was O(ms).
  log('info', `${data.resumed ? 'Resumed' : 'Started'} Remote Play session ${data.session_id} for ${ip}`);
  return { session_id: data.session_id, ip, cached: false, state: data.state, resumed: !!data.resumed };
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
      const db = getDatabase();
      db.run(
        'UPDATE profiles SET psn_account_id = ?, psn_online_id = ? WHERE id = ?',
        [data.account_id, data.online_id || null, parseInt(profile_id)]
      );
      saveDatabase();
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
    const data = await sidecar('POST', '/wake', {
      ip,
      account_id: profile.psn_account_id,
      online_id: profile.psn_online_id || null,
      user_profile: userProfile,
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
    if ((!acctId || !onlineId) && pidInt) {
      const db = getDatabase();
      const stmt = db.prepare('SELECT psn_account_id, psn_online_id FROM profiles WHERE id = ?');
      stmt.bind([pidInt]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        if (!acctId) acctId = row.psn_account_id;
        if (!onlineId) onlineId = row.psn_online_id;
      }
      stmt.free();
    }
    if (!acctId) return res.status(400).json({ success: false, error: 'PSN account_id required (run OAuth first)' });

    const data = await sidecar('POST', '/register', { ip, account_id: acctId, pin, online_id: onlineId || null }, { timeout: 60000 });

    if (pidInt && data.profile) {
      const db = getDatabase();
      db.run(
        'UPDATE profiles SET rp_user_profile = ? WHERE id = ?',
        [JSON.stringify(data.profile), pidInt]
      );
      saveDatabase();
      log('info', `Stored Remote Play credentials for profile ${pidInt}`);
    }

    res.json({ success: true, profile: data.profile });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
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
    // a user_profile inline for diagnostics / tests.
    const data = await ensureSessionForIp(ip, {
      userProfile: req.body?.user_profile || null,
      forceNew: !!req.body?.force_new,
    });
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
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
      try { await sidecar('POST', `/sessions/${encodeURIComponent(cached.sid)}/stop`, {}, { timeout: 20000 }); } catch (_) {}
      ipToSession.delete(ip);
      cachedStopped = true;
    }

    // If `all` was requested OR we had nothing cached, also ask the sidecar to
    // tear down anything it knows about for this IP. Recovers from caches
    // drifting after a sidecar restart.
    let sidecarStopped = [];
    if (all || !cachedStopped) {
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

// Report whether a cached RP session exists for an IP and its current state.
router.get('/quick-status', async (req, res) => {
  try {
    const { ip } = req.query || {};
    if (!ip) return res.status(400).json({ success: false, error: 'ip required' });
    const cached = ipToSession.get(ip);
    if (!cached) return res.json({ success: true, active: false, ip });
    try {
      const s = await sidecar('GET', `/sessions/${encodeURIComponent(cached.sid)}`, undefined, { timeout: 10000 });
      return res.json({ success: true, active: s.state === 'connected', ip, session_id: cached.sid, state: s.state });
    } catch (e) {
      // A timeout (sidecar busy with sessions/start retry loop) is NOT the
      // same as "session lost". Only evict the cache if the sidecar
      // explicitly reports the session is gone (4xx). Treat other errors as
      // transient and keep the cached session.
      const transient = /timeout|ECONN/i.test(e.message || '');
      if (!transient) ipToSession.delete(ip);
      return res.json({ success: true, active: !transient ? false : true, ip, session_id: cached.sid, transient });
    }
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
      const db = getDatabase();
      const stmt = db.prepare('SELECT script FROM input_scripts WHERE id = ?');
      stmt.bind([parseInt(script_id)]);
      if (stmt.step()) actualScript = stmt.getAsObject().script;
      stmt.free();
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
    const db = getDatabase();
    db.run('UPDATE profiles SET rp_user_profile = NULL WHERE id = ?', [parseInt(profile_id)]);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
