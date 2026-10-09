import express from 'express';
import { portRetry, validateSequenceSteps } from '../lib/sequenceChecks.js';
import net from 'net';
import { getRepo, log } from '../db/sqlite.js';
import { readBuiltinList } from '../lib/builtinLoader.js';
import { readBuiltinInputScripts } from './inputScripts.js';
import { installedTemplates } from './store.js';

const router = express.Router();

// Built-in templates live in /frontend/builtin/templates.json so the user
// only edits one place to change what shows up in the Autoload "Templates"
// menu. readBuiltinList() rereads the file when it changes, so edits via
// the built-in editor show on the very next request without a restart.
async function getBuiltinTemplates() {
  try {
    return readBuiltinList('templates.json');
  } catch (err) {
    log('error', `Failed to load built-in templates: ${err.message}`);
    return [];
  }
}

// Local API base used by sequence step execution. Keeps sequences decoupled
// from internal module structures and re-uses validated/HTTP-tested code paths.
const PORT = process.env.PORT || 3001;
const API = `http://127.0.0.1:${PORT}/api`;

// signal: the run's abort signal. A step's request is dropped the moment the
// run is cancelled; the route on the other end sees its client go away.
async function apiFetch(method, urlPath, body, signal) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    signal,
    ...(body !== undefined ? {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch (_) { data = {}; }
  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    const err = new Error(`${method} ${urlPath}: ${msg}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

const cancelError = () => Object.assign(new Error('cancelled'), { cancelled: true });
// A wait that ends at once, with an error, when the run is cancelled.
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(cancelError());
  const onAbort = () => { clearTimeout(timer); reject(cancelError()); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

// In-memory live state for currently running / recently completed sequence runs.
// (Not persisted; the sequence definition itself lives in SQLite.)
const sequenceRuns = new Map();
const MAX_RUNS = 30;
const runOrder = [];

function recordRun(run) {
  sequenceRuns.set(run.id, run);
  runOrder.push(run.id);
  while (runOrder.length > MAX_RUNS) {
    const old = runOrder.shift();
    sequenceRuns.delete(old);
  }
}

function runLog(run, line) {
  const stamp = new Date().toISOString().split('T')[1].replace('Z', '');
  run.log += `[${stamp}] ${line}\n`;
  if (run.log.length > 200_000) run.log = run.log.slice(-200_000);
}

// The only automatic trigger so far; anything else is stored as "none".
const AUTO_TRIGGER_LOADER_DOWN = 'loader_down';
const normalizeAutoTrigger = (v) => (v === AUTO_TRIGGER_LOADER_DOWN ? v : null);

// Settings of the trigger, with the defaults used when a field is missing.
//   intervalS   how often the console is checked
//   port        port to watch; null = the profile's payload port
//   closedForS  how long the port has to stay closed before the run starts
//   cooldownMin pause after a run before the trigger may fire again
const AUTO_TRIGGER_DEFAULTS = { intervalS: 30, port: null, closedForS: 30, cooldownMin: 10 };
function parseAutoTriggerConfig(raw) {
  let cfg = raw;
  if (typeof raw === 'string') { try { cfg = JSON.parse(raw); } catch (_) { cfg = null; } }
  cfg = cfg && typeof cfg === 'object' ? cfg : {};
  const num = (v, min, max, fallback) => {
    const n = parseInt(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    intervalS: num(cfg.intervalS, 10, 3600, AUTO_TRIGGER_DEFAULTS.intervalS),
    port: num(cfg.port, 1, 65535, AUTO_TRIGGER_DEFAULTS.port),
    closedForS: num(cfg.closedForS, 0, 3600, AUTO_TRIGGER_DEFAULTS.closedForS),
    cooldownMin: num(cfg.cooldownMin, 0, 1440, AUTO_TRIGGER_DEFAULTS.cooldownMin),
  };
}
const serializeAutoTriggerConfig = (trigger, raw) => (normalizeAutoTrigger(trigger) ? JSON.stringify(parseAutoTriggerConfig(raw)) : null);

router.get('/', (req, res) => {
  try {
    res.json(getRepo().queryAll(`
      SELECT s.*, p.name as profile_name, p.ip_address
      FROM autoload_sequences s
      LEFT JOIN profiles p ON s.profile_id = p.id
      ORDER BY s.created_at DESC
    `));
  } catch (error) {
    log('error', `Failed to get sequences: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const sequence = getRepo().queryOne('SELECT * FROM autoload_sequences WHERE id = ?', [parseInt(req.params.id)]);
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
    res.json(sequence);
  } catch (error) {
    log('error', `Failed to get sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { profileId, name, steps, scheduleCron, scheduleEnabled, autoTrigger, autoTriggerConfig } = req.body;
    if (!name || !steps) return res.status(400).json({ error: 'name and steps required' });
    try { validateSequenceSteps(steps); } catch (e) { return res.status(400).json({ error: e.message }); }
    const lastId = getRepo().runAndSave(
      'INSERT INTO autoload_sequences (profile_id, name, steps, schedule_cron, schedule_enabled, auto_trigger, auto_trigger_config) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [profileId ? parseInt(profileId) : null, name, JSON.stringify(steps), scheduleCron || null, scheduleEnabled ? 1 : 0, normalizeAutoTrigger(autoTrigger), serializeAutoTriggerConfig(autoTrigger, autoTriggerConfig)],
    );
    log('info', `Created sequence: ${name}`);
    res.json({ success: true, id: lastId });
  } catch (error) {
    log('error', `Failed to create sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { name, steps, scheduleCron, scheduleEnabled, profileId, autoTrigger, autoTriggerConfig } = req.body;
    try { validateSequenceSteps(steps); } catch (e) { return res.status(400).json({ error: e.message }); }
    const repo = getRepo();
    if (!repo.queryOne('SELECT id FROM autoload_sequences WHERE id = ?', [parseInt(req.params.id)])) {
      return res.status(404).json({ error: 'Sequence not found' });
    }
    repo.runAndSave(
      'UPDATE autoload_sequences SET name = ?, steps = ?, profile_id = ?, schedule_cron = ?, schedule_enabled = ?, auto_trigger = ?, auto_trigger_config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, JSON.stringify(steps), profileId ? parseInt(profileId) : null, scheduleCron || null, scheduleEnabled ? 1 : 0, normalizeAutoTrigger(autoTrigger), serializeAutoTriggerConfig(autoTrigger, autoTriggerConfig), parseInt(req.params.id)],
    );
    log('info', `Updated sequence: ${name}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to update sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    getRepo().runAndSave('DELETE FROM autoload_sequences WHERE id = ?', [parseInt(req.params.id)]);
    log('info', `Deleted sequence ${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to delete sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ---- Step executors ----------------------------------------------------------

async function execWait(step, ctx) {
  const ms = parseInt(step.duration) || 0;
  if (ms > 0) await sleep(ms, ctx.signal);
}

function checkPortOpen(ip, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, ip);
  });
}

async function execCheckPort(step, ctx) {
  if (!ctx.profile) throw new Error('check_port needs a profile');
  const port = parseInt(step.port) || 9021;
  // waitSeconds: keep probing that long before calling it a failure, for a
  // port that opens some time after the previous step (a jailbreak that is
  // still running).
  const deadline = Date.now() + (parseInt(step.waitSeconds) || 0) * 1000;
  let ok = await checkPortOpen(ctx.profile.ip_address, port);
  while (!ok && Date.now() < deadline && !ctx.run.cancelled) {
    await sleep(3000, ctx.signal);
    ok = await checkPortOpen(ctx.profile.ip_address, port);
  }
  if (!ok) {
    const err = new Error(`Port ${port} not open on ${ctx.profile.ip_address}`);
    const retry = portRetry(step, ctx.run.current_step);
    if (retry) err.retry = retry;
    throw err;
  }
}

async function execWol(step, ctx) {
  if (!ctx.profile) throw new Error('wol needs a profile');
  // /prewarm establishes a full Remote Play handshake (which wakes the
  // console from rest mode, logs the user in *and* dismisses the "Press
  // PS button" account picker) and then parks the session in the sidecar's
  // PAUSED_SESSIONS warm cache. From there:
  //   - subsequent input_script / rp_session steps resume from warm cache
  //     in O(ms) instead of redoing the 5-10 s handshake,
  //   - the warm cache holds the PS5 awake just like a live session would,
  //     so long FTP uploads / extracts don't let the PS5 fall back to rest,
  //   - if no further RP step runs in this sequence the warm cache simply
  //     ages out (180 s TTL) and the PS5 returns to standby naturally.
  //
  // The legacy `keep_session` flag predates /prewarm - back then we had to
  // open a full live session to keep PS5 awake. The warm cache fills the
  // same role now, so the flag becomes a no-op for new sequences. We keep
  // honouring it for backwards compatibility with saved sequences that
  // expect an explicit live session: in that case we promote the warm
  // cache to a live session via /quick-start (which resumes from the warm
  // entry created by /prewarm above - still O(ms), no second handshake).
  try {
    const r = await apiFetch('POST', '/remoteplay/prewarm', {
      profile_id: ctx.profile.id,
    }, ctx.signal);
    if (r?.already_live) {
      runLog(ctx.run, `  · Console ${ctx.profile.ip_address} already had a live session - reusing`);
    } else if (r?.warm_cached) {
      runLog(ctx.run, `  · pre-warmed RP session for ${ctx.profile.ip_address} (warm cache TTL ${r.warm_cache_ttl_s || 180}s)`);
    } else if (r?.resumed) {
      runLog(ctx.run, `  · resumed warm-cached RP session for ${ctx.profile.ip_address}`);
    }
  } catch (e) {
    // Fall back to the bare DDP WAKEUP+LAUNCH path so callers without a
    // paired Remote Play profile (or with a corrupted one) still get the
    // PS5 woken up. The error is logged but doesn't fail the step - if
    // the next step actually needs a session it'll raise on its own.
    runLog(ctx.run, `  · prewarm failed: ${e.message} - falling back to DDP wake`);
    try {
      await apiFetch('POST', '/remoteplay/wake', { profile_id: ctx.profile.id }, ctx.signal);
    } catch (e2) {
      throw new Error(`wake failed: ${e2.message}`);
    }
  }

  if (step.keep_session) {
    try {
      await sleep(step.keep_session_delay_ms || 1000, ctx.signal);
      const r = await apiFetch('POST', '/remoteplay/quick-start', {
        ip: ctx.profile.ip_address,
      }, ctx.signal);
      if (r?.session_id) {
        ctx.openedSessions.push({ ip: ctx.profile.ip_address, session_id: r.session_id });
        runLog(ctx.run, `  · promoted warm cache to live keep-awake session ${r.session_id.slice(0, 8)}`);
      }
    } catch (e) {
      runLog(ctx.run, `  · keep_session promote failed: ${e.message} (warm cache still holds PS5 awake)`);
    }
  }
}

function findPayloadIdByName(name) {
  const repo = getRepo();
  // Try exact name first, then filename, then case-insensitive match.
  const queries = [
    'SELECT id FROM payloads WHERE name = ? LIMIT 1',
    'SELECT id FROM payloads WHERE filename = ? LIMIT 1',
    'SELECT id FROM payloads WHERE LOWER(name) = LOWER(?) LIMIT 1',
    'SELECT id FROM payloads WHERE LOWER(filename) = LOWER(?) LIMIT 1',
  ];
  for (const q of queries) {
    const row = repo.queryOne(q, [name]);
    if (row?.id) return row.id;
  }
  return null;
}

async function execPayload(step, ctx) {
  if (!ctx.profile) throw new Error('payload step needs a profile');
  let payloadId = step.payloadId;
  if (!payloadId && step.payloadName) {
    payloadId = findPayloadIdByName(step.payloadName);
    if (!payloadId) throw new Error(`Payload "${step.payloadName}" not found - install it first`);
  }
  if (!payloadId) throw new Error('payloadId or payloadName required');
  await apiFetch('POST', `/payloads/send/${payloadId}`, {
    ip: ctx.profile.ip_address,
    port: ctx.profile.port || 9021,
  }, ctx.signal);
}

async function pollUntilTerminal(getStatus, { timeoutMs = 6 * 60 * 60 * 1000, intervalMs = 1500, signal } = {}) {
  const start = Date.now();
  while (true) {
    const s = await getStatus();
    if (s.status === 'completed') return s;
    if (s.status === 'failed' || s.status === 'cancelled') {
      throw new Error(`${s.status}: ${s.error || ''}`);
    }
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await sleep(intervalMs, signal);
  }
}

async function execDownload(step, ctx) {
  const body = {
    url: step.url,
    filename: step.filename || undefined,
    dest_kind: step.dest_kind || 'local',
    dest_path: step.dest_path,
    smb_source_id: step.smb_source_id,
    smb_subdir: step.smb_subdir,
    overwrite: true,
  };
  // Make sure the queue is not paused so the worker starts our job.
  await apiFetch('POST', '/downloader/queue/resume', undefined, ctx.signal).catch(() => {});
  const r = await apiFetch('POST', '/downloader/start', body, ctx.signal);
  const jobId = r.job_id;
  await pollUntilTerminal(async () => {
    const j = await apiFetch('GET', `/downloader/${jobId}`, undefined, ctx.signal);
    return { status: j.status, error: j.error };
  }, { signal: ctx.signal });
}

async function execExtract(step, ctx) {
  const body = {
    source: step.source || 'local-fs',
    local_path: step.local_path,
    dest_kind: step.dest_kind || 'local-fs',
    dest_local_path: step.dest_local_path || undefined,
    password: step.password || '',
    delete_archive_after: !!step.delete_archive_after,
    source_id: step.source_id,
    smb_path: step.smb_path,
    filename: step.filename,
  };
  await apiFetch('POST', '/convert/extract/queue/resume', undefined, ctx.signal).catch(() => {});
  const r = await apiFetch('POST', '/convert/extract/queue', body, ctx.signal);
  const itemId = r.item.id;
  await pollUntilTerminal(async () => {
    const list = await apiFetch('GET', '/convert/extract/queue', undefined, ctx.signal);
    const item = (list.items || []).find(i => i.id === itemId);
    if (!item) return { status: 'failed', error: 'item disappeared' };
    return { status: item.status, error: item.error };
  }, { signal: ctx.signal });
}

async function execFtpUpload(step, ctx) {
  const ip = step.ip || ctx.profile?.ip_address;
  if (!ip) throw new Error('ftp_upload needs ip or profile');
  if (!step.local_path) throw new Error('ftp_upload needs local_path');
  await apiFetch('POST', '/convert/ftp/upload', {
    ip,
    local_path: step.local_path,
    dest_path: step.dest_path,
  }, ctx.signal);
}

async function execConvert(step, ctx) {
  if (!step.source_path) throw new Error('convert needs source_path');
  await apiFetch('POST', '/convert/convert/queue/resume', undefined, ctx.signal).catch(() => {});
  const r = await apiFetch('POST', '/convert/convert/queue', {
    mode: step.mode || 'pack-file',
    source_path: step.source_path,
    output_name: step.output_name,
    compress: step.compress !== false,
    verify: step.verify !== false,
  }, ctx.signal);
  const itemId = r.item.id;
  await pollUntilTerminal(async () => {
    const list = await apiFetch('GET', '/convert/convert/queue', undefined, ctx.signal);
    const item = (list.items || []).find(i => i.id === itemId);
    if (!item) return { status: 'failed', error: 'item disappeared' };
    return { status: item.status, error: item.error };
  }, { signal: ctx.signal });
}

// Probe Remote Play session state for the profile, log a one-line summary
// and (on miss) make sure we have an active session before running buttons.
//
// `run-script` already calls ensureSessionForIp() internally as a safety
// net, but doing the probe here gives us:
//   - a clear log entry so users can see WHY a script step was instant
//     (resumed from warm) vs slow (cold start),
//   - a chance to surface "PS5 offline" *before* the input handshake spends
//     60-90 s discovering the same thing the hard way.
async function ensureSessionForStep(ctx, label) {
  const ip = ctx.profile.ip_address;
  let status = null;
  try {
    status = await apiFetch('GET', `/remoteplay/quick-status?ip=${encodeURIComponent(ip)}`, undefined, ctx.signal);
  } catch (_) { /* sidecar may be transient - the actual call will retry */ }

  if (status?.active) {
    runLog(ctx.run, `  · ${label}: reusing live RP session ${(status.session_id || '').slice(0, 8)}`);
    return 'live';
  }
  if (status?.warm) {
    const age = Math.round(status.warm_age_s || 0);
    runLog(ctx.run, `  · ${label}: resuming from warm cache (age ${age}s, TTL ${Math.round(status.warm_ttl_remaining_s || 0)}s)`);
    return 'warm';
  }

  // Cold path: fail fast if PS5 is unreachable so we don't burn the full
  // 60 s post-disconnect lock waiting on a console that's truly offline.
  try {
    const ddp = await apiFetch('GET', `/remoteplay/discover?ip=${encodeURIComponent(ip)}`, undefined, ctx.signal);
    if (!ddp?.success) {
      throw new Error(`Console ${ip} is offline / unreachable (DDP failed)`);
    }
    runLog(ctx.run, `  · ${label}: cold start (console state=${ddp.status || 'unknown'})`);
  } catch (e) {
    // DDP failure is fatal here - bubble up so the sequence stops instead
    // of looping through stale step retries.
    throw new Error(`Console ${ip} not reachable: ${e.message}`);
  }
  return 'cold';
}

async function execInputScript(step, ctx) {
  if (!ctx.profile) throw new Error('input_script step needs a profile');
  // Step may carry either a script_id (referencing input_scripts table) or
  // the literal script content (set when the step was added via the UI).
  const body = {
    ip: ctx.profile.ip_address,
    profile_id: ctx.profile.id,
    keep_session: true, // leave session in warm cache for the next step
  };
  if (step.script) body.script = step.script;
  else if (typeof step.scriptId === 'string' && step.scriptId.startsWith('builtin:')) {
    // Built-in scripts are not in the input_scripts table; take the current
    // text so an edit of the built-in applies to the next run.
    const builtin = readBuiltinInputScripts().find(s => s.id === step.scriptId);
    if (!builtin?.script) throw new Error(`Built-in script "${step.scriptId}" not found`);
    if (builtin.console_type && builtin.console_type !== ctx.profile.console_type) throw new Error(`${builtin.name} requires ${builtin.console_type.toUpperCase()}`);
    body.script = builtin.script;
  } else if (step.scriptId) body.script_id = step.scriptId;
  else throw new Error('input_script step needs a script or scriptId');

  await ensureSessionForStep(ctx, 'input_script');

  const r = await apiFetch('POST', '/remoteplay/run-script', body, ctx.signal);
  if (r?.session_id) {
    runLog(ctx.run, `  · session ${r.session_id.slice(0, 8)} executed ${(r.events || []).length} input event(s)`);
  }
  if (r.success === false) throw new Error(r.error || 'Input script failed');
  const failed = (r.events || []).filter((e) => e.type === 'error' || e.error);
  if (failed.length) {
    throw new Error(`${failed.length} input(s) failed: ${failed.slice(0, 3).map((f) => f.error || f.msg || f.button).join(', ')}`);
  }
}

async function execRpSession(step, ctx) {
  if (!ctx.profile) throw new Error('rp_session step needs a profile');
  const action = step.action || 'start';
  if (action === 'start') {
    // /quick-start ensures (and caches) a Remote Play session for this IP
    // using stored pair credentials. Subsequent input_script steps reuse it.
    // Logs the path it took (live/warm/cold) so timing is debuggable.
    const path = await ensureSessionForStep(ctx, 'rp_session start');
    if (path === 'cold') {
      // Surface DDP state up front and let the caller see what the first
      // handshake will be fighting against.
      runLog(ctx.run, '  · opening fresh RP session (first start after standby can take 60-120s)');
    }
    const r = await apiFetch('POST', '/remoteplay/quick-start', { ip: ctx.profile.ip_address, profile_id: ctx.profile.id }, ctx.signal);
    if (r?.session_id) {
      runLog(ctx.run, `  · RP session ${r.session_id.slice(0, 8)} ready (${r.resumed ? 'warm-resumed' : r.reused ? 'reused' : 'fresh'})`);
    }
  } else if (action === 'stop') {
    // Soft stop: sidecar parks the session in the warm cache so it can be
    // resumed cheaply by anything that runs after this step (next sequence
    // iteration, scheduled rerun, the user clicking Start in the UI...).
    await apiFetch('POST', '/remoteplay/quick-stop', { ip: ctx.profile.ip_address }, ctx.signal);
    runLog(ctx.run, '  · soft-stopped RP session (parked in warm cache for next start)');
  } else if (action === 'standby') {
    // Hard "go to sleep" — sends the PS5 standby command through the RP
    // session (the same path the P5 Control "Standby" button uses).
    // Requires the profile to be PSN-linked + RP-paired; /remoteplay/standby
    // surfaces a 400 with a readable message when either is missing.
    // We also drop the warm cache first so the next sequence start doesn't
    // try to resume into a now-asleep console.
    try { await apiFetch('POST', '/remoteplay/quick-stop', { ip: ctx.profile.ip_address }, ctx.signal); } catch (_) {}
    await apiFetch('POST', '/remoteplay/standby', { ip: ctx.profile.ip_address, profile_id: ctx.profile.id }, ctx.signal);
    runLog(ctx.run, '  · console rest mode command sent');
  } else {
    throw new Error(`rp_session: unknown action "${action}"`);
  }
}

const STEP_EXEC = {
  wait: execWait,
  wol: execWol,
  check_port: execCheckPort,
  payload: execPayload,
  download: execDownload,
  extract: execExtract,
  ftp_upload: execFtpUpload,
  convert: execConvert,
  input_script: execInputScript,
  rp_session: execRpSession,
  // Stubs for older types kept for backwards compatibility (no-op for now)
  klog_read: async () => {},
  lua_log_read: async () => {},
};

async function executeSequence(run, sequence, profile, steps) {
  run.status = 'running';
  run.started_at = new Date().toISOString();
  run.total = steps.length;
  runLog(run, `Sequence "${sequence.name}" starting (${steps.length} steps)`);

  // Per-run context shared across step executors. We use it to remember
  // background resources (e.g. RP sessions opened by wol/keep_session) so
  // we can clean them up after the run regardless of success/failure.
  const ctx = {
    profile,
    run,
    signal: run.abort.signal,
    openedSessions: [], // [{ ip, session_id }] - closed in the finally block
  };
  // Cancel has to take effect now, not when the step in progress is done: a
  // step can be a wait of minutes or a conversion of hours. The waits and
  // requests of a step end with the signal; this promise covers whatever
  // does not.
  const cancelled = new Promise((_, reject) => {
    ctx.signal.addEventListener('abort', () => reject(cancelError()), { once: true });
  });
  cancelled.catch(() => {});

  const retryCount = new Map();
  let i = 0;
  let retryResume = null;
  try {
    while (i < steps.length) {
      if (run.cancelled) {
        run.status = 'cancelled';
        runLog(run, `Cancelled at step ${i + 1}`);
        break;
      }
      const step = steps[i];
      run.current_step = i;
      run.current_step_name = step.name || step.type;
      runLog(run, `Step ${i + 1}/${steps.length}: ${step.name || step.type}`);

      const exec = STEP_EXEC[step.type];
      if (!exec) {
        runLog(run, `  ! unknown step type: ${step.type} (skipping)`);
        i++;
        continue;
      }
      try {
        const running = exec(step, ctx);
        running.catch(() => {}); // it may still fail after the run has moved on
        await Promise.race([running, cancelled]);
        runLog(run, `  ✓ ok`);
        if (retryResume && i === retryResume.end) { i = retryResume.check; retryResume = null; }
        else i++;
      } catch (e) {
        if (run.cancelled) {
          run.status = 'cancelled';
          runLog(run, `Cancelled during step ${i + 1}`);
          break;
        }
        if (e.retry && typeof e.retry.from === 'number') {
          const rc = (retryCount.get(i) || 0) + 1;
          retryCount.set(i, rc);
          if (rc > e.retry.maxRetries) {
            runLog(run, `  ✗ failed after ${rc - 1} retries: ${e.message}`);
            run.status = 'failed';
            run.error = e.message;
            break;
          }
          runLog(run, `  ↻ check failed (${e.message}); rerunning steps ${e.retry.from + 1}-${e.retry.to + 1} (attempt ${rc})`);
          retryResume = e.retry.to < i ? { end: e.retry.to, check: i } : null;
          i = Math.max(0, e.retry.from);
          continue;
        }
        runLog(run, `  ✗ failed: ${e.message}`);
        run.status = 'failed';
        run.error = e.message;
        break;
      }
    }
  } finally {
    // Close any RP sessions we opened to keep PS5 awake. Errors here are
    // swallowed: cleanup must not mask the main outcome.
    for (const s of ctx.openedSessions) {
      try {
        await apiFetch('POST', '/remoteplay/quick-stop', { ip: s.ip });
        runLog(run, `  · closed keep-awake RP session for ${s.ip}`);
      } catch (e) {
        runLog(run, `  · failed to close keep-awake session for ${s.ip}: ${e.message}`);
      }
    }
  }

  if (run.status === 'running') run.status = 'completed';
  run.finished_at = new Date().toISOString();
  runLog(run, `Sequence ended with status: ${run.status}`);
  log('info', `sequence ${sequence.id} (${sequence.name}) ${run.status}`);
}

// Start a run of a saved sequence in the background. Returns the run, or
// throws an Error with .status for the route to report.
function startSequenceRun(sequenceId, startedBy) {
  const sequence = getRepo().queryOne(`
    SELECT s.*, p.name as profile_name, p.ip_address, p.port, p.mac_address, p.console_type
    FROM autoload_sequences s
    LEFT JOIN profiles p ON s.profile_id = p.id
    WHERE s.id = ?
  `, [sequenceId]);

  if (!sequence) throw Object.assign(new Error('Sequence not found'), { status: 404 });
  const steps = JSON.parse(sequence.steps || '[]');
  try { validateSequenceSteps(steps); } catch (e) { throw Object.assign(e, { status: 400 }); }

  const profile = sequence.profile_id ? {
    id: sequence.profile_id,
    name: sequence.profile_name,
    ip_address: sequence.ip_address,
    port: sequence.port,
    mac_address: sequence.mac_address,
    console_type: sequence.console_type,
  } : null;

  const runId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const run = {
    id: runId,
    sequence_id: sequence.id,
    sequence_name: sequence.name,
    profile_id: sequence.profile_id || null,
    status: 'queued',
    total: steps.length,
    current_step: 0,
    started_at: null,
    finished_at: null,
    error: null,
    log: '',
    cancelled: false,
  };
  // Not enumerable: the run is sent to the browser as it is.
  Object.defineProperty(run, 'abort', { value: new AbortController() });
  recordRun(run);
  if (startedBy) runLog(run, startedBy);

  log('info', `Running sequence "${sequence.name}" (${steps.length} steps)`);
  executeSequence(run, sequence, profile, steps).catch(e => {
    run.status = 'failed';
    run.error = e.message;
    run.finished_at = new Date().toISOString();
    runLog(run, `Fatal: ${e.message}`);
  });
  return run;
}

router.post('/:id/run', async (req, res) => {
  try {
    const run = startSequenceRun(parseInt(req.params.id));
    res.json({ success: true, run_id: run.id, message: `Sequence "${run.sequence_name}" started with ${run.total} steps` });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    log('error', `Failed to run sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ---- Automatic trigger: console on, payload loader down ----------------------
//
// A sequence saved with auto_trigger = 'loader_down' runs by itself when its
// console answers as switched on (not rest mode) while the watched port is
// closed - i.e. the console was restarted and is not jailbroken any more.
// The sequence takes over the controller through Remote Play, so the watcher
// is deliberately slow to fire: the port has to stay closed for a while, no
// other sequence may be running, and after a run it waits out a cooldown
// before trying again, so a jailbreak that keeps failing does not keep
// steering the console. How often, which port, how long and the cooldown are
// per sequence - see AUTO_TRIGGER_DEFAULTS.
const AUTO_TRIGGER_TICK_MS = 5 * 1000;
const autoTriggerState = new Map(); // sequence id -> { nextCheckAt, downSince, lastRunAt }

async function isConsoleOn(ip) {
  try {
    const ddp = await apiFetch('GET', `/remoteplay/discover?ip=${encodeURIComponent(ip)}`);
    return String(ddp?.status || '').toLowerCase() === 'ok';
  } catch (_) {
    return false;
  }
}

async function autoTriggerTick() {
  const sequences = getRepo().queryAll(`
    SELECT s.id, s.name, s.auto_trigger_config, p.ip_address, p.port
    FROM autoload_sequences s
    JOIN profiles p ON s.profile_id = p.id
    WHERE s.auto_trigger = ?
  `, [AUTO_TRIGGER_LOADER_DOWN]);
  if (sequences.length === 0) return;
  const busy = Array.from(sequenceRuns.values()).some(r => r.status === 'queued' || r.status === 'running');

  for (const seq of sequences) {
    const cfg = parseAutoTriggerConfig(seq.auto_trigger_config);
    let state = autoTriggerState.get(seq.id);
    if (!state) { state = { nextCheckAt: 0, downSince: 0, lastRunAt: 0 }; autoTriggerState.set(seq.id, state); }
    if (Date.now() < state.nextCheckAt) continue;
    state.nextCheckAt = Date.now() + cfg.intervalS * 1000;

    const port = cfg.port || seq.port || 9021;
    const cooledDown = !state.lastRunAt || Date.now() - state.lastRunAt >= cfg.cooldownMin * 60 * 1000;
    const down = !busy && cooledDown
      && await isConsoleOn(seq.ip_address)
      && !(await checkPortOpen(seq.ip_address, port));
    if (!down) { state.downSince = 0; continue; }
    if (!state.downSince) state.downSince = Date.now();
    if (Date.now() - state.downSince < cfg.closedForS * 1000) continue;

    state.downSince = 0;
    state.lastRunAt = Date.now();
    log('info', `Auto-trigger: ${seq.ip_address} is on but port ${port} is closed - running "${seq.name}"`);
    try {
      startSequenceRun(seq.id, `Started automatically: console is on, port ${port} is closed`);
    } catch (e) {
      log('error', `Auto-trigger for "${seq.name}" failed: ${e.message}`);
    }
    return; // one console-steering run at a time
  }
}

export function startAutoTriggerWatcher() {
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try { await autoTriggerTick(); } catch (e) { log('error', `Auto-trigger check failed: ${e.message}`); }
    ticking = false;
  }, AUTO_TRIGGER_TICK_MS);
  timer.unref?.();
}

router.get('/runs/recent', (req, res) => {
  const list = runOrder.slice().reverse().map(id => {
    const r = sequenceRuns.get(id);
    if (!r) return null;
    const { cancelled, ...pub } = r;
    return pub;
  }).filter(Boolean);
  res.json(list);
});

router.get('/runs/:runId', (req, res) => {
  const r = sequenceRuns.get(req.params.runId);
  if (!r) return res.status(404).json({ error: 'Run not found' });
  const { cancelled, ...pub } = r;
  res.json(pub);
});

router.post('/runs/:runId/cancel', (req, res) => {
  const r = sequenceRuns.get(req.params.runId);
  if (!r) return res.status(404).json({ error: 'Run not found' });
  r.cancelled = true;
  r.abort?.abort();
  res.json({ success: true });
});

// ---- Built-in templates: always available, no DB rows needed -----------------
//
// Source of truth: /frontend/builtin/templates.json (see top of this file).

router.get('/templates/list', async (req, res) => {
  try {
    // The built-in ones, then those installed from the marketplace.
    res.json([...(await getBuiltinTemplates()), ...installedTemplates()]);
  } catch (err) {
    log('error', `templates/list failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
