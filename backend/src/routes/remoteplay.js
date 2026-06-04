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

function loadProfileByIp(ip) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT id, ip_address, rp_user_profile FROM profiles WHERE ip_address = ? LIMIT 1');
  stmt.bind([ip]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function loadProfileById(id) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT id, ip_address, rp_user_profile FROM profiles WHERE id = ? LIMIT 1');
  stmt.bind([parseInt(id)]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

async function ensureSessionForIp(ip) {
  const cached = ipToSession.get(ip);
  if (cached && (Date.now() - cached.started) < SESSION_REUSE_MS) {
    try {
      const s = await sidecar('GET', `/sessions/${encodeURIComponent(cached.sid)}`, undefined, { timeout: 4000 });
      if (s.state === 'connected') return cached.sid;
    } catch (_) { /* fall through to recreate */ }
    ipToSession.delete(ip);
  }
  const profile = loadProfileByIp(ip);
  if (!profile?.rp_user_profile) {
    throw new Error('No Remote Play credentials for this PS5 - pair first in the Remote Play tab');
  }
  let userProfile;
  try { userProfile = JSON.parse(profile.rp_user_profile); }
  catch (_) { throw new Error('Stored Remote Play profile is corrupt - re-pair the PS5'); }

  const data = await sidecar('POST', '/sessions/start', { ip, user_profile: userProfile }, { timeout: 30000 });
  ipToSession.set(ip, { sid: data.session_id, started: Date.now() });
  log('info', `Started Remote Play session ${data.session_id} for ${ip}`);
  return data.session_id;
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

function parseScriptLine(line) {
  const t = (line || '').trim();
  if (!t || t.startsWith('//') || t.startsWith('#')) return null;
  const parts = t.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  if (cmd === 'wait' || cmd === 'sleep') {
    const ms = parseInt(parts[1], 10);
    return { type: 'wait', ms: Number.isFinite(ms) && ms >= 0 ? ms : 1000 };
  }
  const btn = BUTTON_ALIASES[cmd];
  if (btn) {
    const dur = parts[1] ? parseInt(parts[1], 10) : 80;
    return { type: 'button', button: btn, duration: Number.isFinite(dur) ? dur : 80 };
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

router.post('/sessions/start', async (req, res) => {
  try {
    const { ip, profile_id } = req.body || {};
    if (!ip) return res.status(400).json({ success: false, error: 'ip required' });

    let userProfile = req.body?.user_profile;
    if (!userProfile && profile_id) {
      const db = getDatabase();
      const stmt = db.prepare('SELECT rp_user_profile FROM profiles WHERE id = ?');
      stmt.bind([parseInt(profile_id)]);
      if (stmt.step()) {
        const raw = stmt.getAsObject().rp_user_profile;
        if (raw) { try { userProfile = JSON.parse(raw); } catch (_) {} }
      }
      stmt.free();
    }
    if (!userProfile) return res.status(400).json({ success: false, error: 'No Remote Play profile - pair first' });

    const data = await sidecar('POST', '/sessions/start', { ip, user_profile: userProfile }, { timeout: 30000 });
    ipToSession.set(ip, { sid: data.session_id, started: Date.now() });
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
    const data = await sidecar('POST', `/sessions/${encodeURIComponent(req.params.sid)}/stop`, {}, { timeout: 10000 });
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
router.post('/quick-start', async (req, res) => {
  try {
    const { ip: rawIp, profile_id } = req.body || {};
    let ip = rawIp;
    if (!ip && profile_id) ip = loadProfileById(profile_id)?.ip_address;
    if (!ip) return res.status(400).json({ success: false, error: 'ip or profile_id required' });
    const sid = await ensureSessionForIp(ip);
    res.json({ success: true, session_id: sid, ip, cached: true });
  } catch (err) {
    res.status(err.status || 502).json({ success: false, error: err.message });
  }
});

// Tear down a cached session for an IP, freeing the PS5-side state. Quiet
// no-op if no session was cached.
router.post('/quick-stop', async (req, res) => {
  try {
    const { ip: rawIp, profile_id } = req.body || {};
    let ip = rawIp;
    if (!ip && profile_id) ip = loadProfileById(profile_id)?.ip_address;
    if (!ip) return res.status(400).json({ success: false, error: 'ip or profile_id required' });
    const cached = ipToSession.get(ip);
    if (!cached) return res.json({ success: true, stopped: false, ip });
    try { await sidecar('POST', `/sessions/${encodeURIComponent(cached.sid)}/stop`, {}, { timeout: 8000 }); } catch (_) {}
    ipToSession.delete(ip);
    res.json({ success: true, stopped: true, ip, session_id: cached.sid });
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
      const s = await sidecar('GET', `/sessions/${encodeURIComponent(cached.sid)}`, undefined, { timeout: 4000 });
      return res.json({ success: true, active: s.state === 'connected', ip, session_id: cached.sid, state: s.state });
    } catch (_) {
      ipToSession.delete(ip);
      return res.json({ success: true, active: false, ip });
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

    const sid = await ensureSessionForIp(ip);
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
    try { sid = await ensureSessionForIp(ip); }
    catch (e) { return res.status(400).json({ success: false, error: e.message }); }

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
            sid = await ensureSessionForIp(ip);
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
      if (parsed.type === 'button') {
        const err = await sendButton(parsed.button, parsed.duration);
        events.push({
          line: i + 1, type: 'button', button: parsed.button,
          ...(err && err !== 'recovered' ? { error: err } : {}),
          ...(err === 'recovered' ? { recovered: true } : {}),
        });
        await new Promise((r) => setTimeout(r, 60));
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
      try { await sidecar('POST', `/sessions/${encodeURIComponent(sid)}/stop`, {}, { timeout: 5000 }); } catch (_) {}
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
