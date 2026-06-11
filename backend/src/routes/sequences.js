import express from 'express';
import net from 'net';
import { getDatabase, saveDatabase, log } from '../db/sqlite.js';
import { loadBuiltin } from '../lib/builtinLoader.js';

const router = express.Router();

// Built-in templates live in /frontend/builtin/templates.js so the user
// only edits one place to change what shows up in the Autoload "Templates"
// menu. loadBuiltin() caches by mtime so file edits via the built-in
// editor are picked up on the very next request without a restart.
async function getBuiltinTemplates() {
  try {
    const mod = await loadBuiltin('templates.js');
    return Array.isArray(mod.DEFAULT_TEMPLATES) ? mod.DEFAULT_TEMPLATES : [];
  } catch (err) {
    log('error', `Failed to load built-in templates: ${err.message}`);
    return [];
  }
}

// Local API base used by sequence step execution. Keeps sequences decoupled
// from internal module structures and re-uses validated/HTTP-tested code paths.
const PORT = process.env.PORT || 3001;
const API = `http://127.0.0.1:${PORT}/api`;

async function apiFetch(method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

router.get('/', (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT s.*, p.name as profile_name, p.ip_address
      FROM autoload_sequences s
      LEFT JOIN profiles p ON s.profile_id = p.id
      ORDER BY s.created_at DESC
    `);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    res.json(results);
  } catch (error) {
    log('error', `Failed to get sequences: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare('SELECT * FROM autoload_sequences WHERE id = ?');
    stmt.bind([parseInt(req.params.id)]);
    let sequence = null;
    if (stmt.step()) {
      sequence = stmt.getAsObject();
    }
    stmt.free();
    if (!sequence) {
      return res.status(404).json({ error: 'Sequence not found' });
    }
    res.json(sequence);
  } catch (error) {
    log('error', `Failed to get sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { profileId, name, steps, scheduleCron, scheduleEnabled } = req.body;
    if (!name || !steps) {
      return res.status(400).json({ error: 'name and steps required' });
    }

    const db = getDatabase();
    db.run(
      'INSERT INTO autoload_sequences (profile_id, name, steps, schedule_cron, schedule_enabled) VALUES (?, ?, ?, ?, ?)',
      [profileId ? parseInt(profileId) : null, name, JSON.stringify(steps), scheduleCron || null, scheduleEnabled ? 1 : 0]
    );
    const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    saveDatabase();

    log('info', `Created sequence: ${name}`);
    res.json({ success: true, id: lastId });
  } catch (error) {
    log('error', `Failed to create sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { name, steps, scheduleCron, scheduleEnabled, profileId } = req.body;
    const db = getDatabase();

    const existing = db.prepare('SELECT id FROM autoload_sequences WHERE id = ?');
    existing.bind([parseInt(req.params.id)]);
    if (!existing.step()) {
      existing.free();
      return res.status(404).json({ error: 'Sequence not found' });
    }
    existing.free();

    db.run(
      'UPDATE autoload_sequences SET name = ?, steps = ?, profile_id = ?, schedule_cron = ?, schedule_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [name, JSON.stringify(steps), profileId ? parseInt(profileId) : null, scheduleCron || null, scheduleEnabled ? 1 : 0, parseInt(req.params.id)]
    );
    saveDatabase();

    log('info', `Updated sequence: ${name}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to update sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const db = getDatabase();
    db.run('DELETE FROM autoload_sequences WHERE id = ?', [parseInt(req.params.id)]);
    saveDatabase();

    log('info', `Deleted sequence ${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    log('error', `Failed to delete sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ---- Step executors ----------------------------------------------------------

async function execWait(step) {
  const ms = parseInt(step.duration) || 0;
  if (ms > 0) await sleep(ms);
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
  const ok = await checkPortOpen(ctx.profile.ip_address, port);
  if (!ok) {
    const from = Math.max(1, parseInt(step.retryFromStep) || 1);
    const to = Math.max(from, parseInt(step.retryToStep) || from);
    // Signal the outer runner to retry a step range. We throw with a marker so
    // the orchestrator can pick it up.
    const err = new Error(`Port ${port} not open on ${ctx.profile.ip_address}`);
    err.retry = { from: from - 1, to: to - 1 };
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
    });
    if (r?.already_live) {
      runLog(ctx.run, `  · PS5 ${ctx.profile.ip_address} already had a live session - reusing`);
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
      await apiFetch('POST', '/remoteplay/wake', { profile_id: ctx.profile.id });
    } catch (e2) {
      throw new Error(`wake failed: ${e2.message}`);
    }
  }

  if (step.keep_session) {
    try {
      await sleep(step.keep_session_delay_ms || 1000);
      const r = await apiFetch('POST', '/remoteplay/quick-start', {
        ip: ctx.profile.ip_address,
      });
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
  const db = getDatabase();
  // Try exact name first, then filename, then case-insensitive match.
  const queries = [
    'SELECT id FROM payloads WHERE name = ? LIMIT 1',
    'SELECT id FROM payloads WHERE filename = ? LIMIT 1',
    'SELECT id FROM payloads WHERE LOWER(name) = LOWER(?) LIMIT 1',
    'SELECT id FROM payloads WHERE LOWER(filename) = LOWER(?) LIMIT 1',
  ];
  for (const q of queries) {
    const stmt = db.prepare(q);
    stmt.bind([name]);
    let id = null;
    if (stmt.step()) id = stmt.getAsObject().id;
    stmt.free();
    if (id) return id;
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
  });
}

async function pollUntilTerminal(getStatus, { timeoutMs = 6 * 60 * 60 * 1000, intervalMs = 1500 } = {}) {
  const start = Date.now();
  while (true) {
    const s = await getStatus();
    if (s.status === 'completed') return s;
    if (s.status === 'failed' || s.status === 'cancelled') {
      throw new Error(`${s.status}: ${s.error || ''}`);
    }
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await sleep(intervalMs);
  }
}

async function execDownload(step) {
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
  await apiFetch('POST', '/downloader/queue/resume').catch(() => {});
  const r = await apiFetch('POST', '/downloader/start', body);
  const jobId = r.job_id;
  await pollUntilTerminal(async () => {
    const j = await apiFetch('GET', `/downloader/${jobId}`);
    return { status: j.status, error: j.error };
  });
}

async function execExtract(step) {
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
  await apiFetch('POST', '/convert/extract/queue/resume').catch(() => {});
  const r = await apiFetch('POST', '/convert/extract/queue', body);
  const itemId = r.item.id;
  await pollUntilTerminal(async () => {
    const list = await apiFetch('GET', '/convert/extract/queue');
    const item = (list.items || []).find(i => i.id === itemId);
    if (!item) return { status: 'failed', error: 'item disappeared' };
    return { status: item.status, error: item.error };
  });
}

async function execFtpUpload(step, ctx) {
  const ip = step.ip || ctx.profile?.ip_address;
  if (!ip) throw new Error('ftp_upload needs ip or profile');
  if (!step.local_path) throw new Error('ftp_upload needs local_path');
  await apiFetch('POST', '/convert/ftp/upload', {
    ip,
    local_path: step.local_path,
    dest_path: step.dest_path,
  });
}

async function execConvert(step) {
  if (!step.source_path) throw new Error('convert needs source_path');
  await apiFetch('POST', '/convert/convert/queue/resume').catch(() => {});
  const r = await apiFetch('POST', '/convert/convert/queue', {
    mode: step.mode || 'pack-file',
    source_path: step.source_path,
    output_name: step.output_name,
    compress: step.compress !== false,
    verify: step.verify !== false,
  });
  const itemId = r.item.id;
  await pollUntilTerminal(async () => {
    const list = await apiFetch('GET', '/convert/convert/queue');
    const item = (list.items || []).find(i => i.id === itemId);
    if (!item) return { status: 'failed', error: 'item disappeared' };
    return { status: item.status, error: item.error };
  });
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
    status = await apiFetch('GET', `/remoteplay/quick-status?ip=${encodeURIComponent(ip)}`);
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
    const ddp = await apiFetch('GET', `/remoteplay/discover?ip=${encodeURIComponent(ip)}`);
    if (!ddp?.success) {
      throw new Error(`PS5 ${ip} is offline / unreachable (DDP failed)`);
    }
    runLog(ctx.run, `  · ${label}: cold start (PS5 state=${ddp.status || 'unknown'})`);
  } catch (e) {
    // DDP failure is fatal here - bubble up so the sequence stops instead
    // of looping through stale step retries.
    throw new Error(`PS5 ${ip} not reachable: ${e.message}`);
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
  else if (step.scriptId) body.script_id = step.scriptId;
  else throw new Error('input_script step needs a script or scriptId');

  await ensureSessionForStep(ctx, 'input_script');

  const r = await apiFetch('POST', '/remoteplay/run-script', body);
  if (r?.session_id) {
    runLog(ctx.run, `  · session ${r.session_id.slice(0, 8)} executed ${(r.events || []).length} input event(s)`);
  }
  const failed = (r.events || []).filter((e) => e.type === 'error');
  if (failed.length) {
    throw new Error(`${failed.length} input(s) failed: ${failed.slice(0, 3).map((f) => f.msg || f.button).join(', ')}`);
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
    const r = await apiFetch('POST', '/remoteplay/quick-start', { ip: ctx.profile.ip_address, profile_id: ctx.profile.id });
    if (r?.session_id) {
      runLog(ctx.run, `  · RP session ${r.session_id.slice(0, 8)} ready (${r.resumed ? 'warm-resumed' : r.reused ? 'reused' : 'fresh'})`);
    }
  } else if (action === 'stop') {
    // Soft stop: sidecar parks the session in the warm cache so it can be
    // resumed cheaply by anything that runs after this step (next sequence
    // iteration, scheduled rerun, the user clicking Start in the UI...).
    await apiFetch('POST', '/remoteplay/quick-stop', { ip: ctx.profile.ip_address });
    runLog(ctx.run, '  · soft-stopped RP session (parked in warm cache for next start)');
  } else if (action === 'standby') {
    // Hard "go to sleep" — sends the PS5 standby command through the RP
    // session (the same path the P5 Control "Standby" button uses).
    // Requires the profile to be PSN-linked + RP-paired; /remoteplay/standby
    // surfaces a 400 with a readable message when either is missing.
    // We also drop the warm cache first so the next sequence start doesn't
    // try to resume into a now-asleep console.
    try { await apiFetch('POST', '/remoteplay/quick-stop', { ip: ctx.profile.ip_address }); } catch (_) {}
    await apiFetch('POST', '/remoteplay/standby', { ip: ctx.profile.ip_address, profile_id: ctx.profile.id });
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
    openedSessions: [], // [{ ip, session_id }] - closed in the finally block
  };

  const maxRetriesPerCheck = 3;
  const retryCount = new Map();
  let i = 0;
  try {
    while (i < steps.length) {
      if (run.cancelled) {
        run.status = 'cancelled';
        runLog(run, `Cancelled at step ${i + 1}`);
        break;
      }
      const step = steps[i];
      run.current_step = i;
      runLog(run, `Step ${i + 1}/${steps.length}: ${step.name || step.type}`);

      const exec = STEP_EXEC[step.type];
      if (!exec) {
        runLog(run, `  ! unknown step type: ${step.type} (skipping)`);
        i++;
        continue;
      }
      try {
        await exec(step, ctx);
        runLog(run, `  ✓ ok`);
        i++;
      } catch (e) {
        if (e.retry && typeof e.retry.from === 'number') {
          const rc = (retryCount.get(i) || 0) + 1;
          retryCount.set(i, rc);
          if (rc > maxRetriesPerCheck) {
            runLog(run, `  ✗ failed after ${rc - 1} retries: ${e.message}`);
            run.status = 'failed';
            run.error = e.message;
            break;
          }
          runLog(run, `  ↻ check failed (${e.message}); rerunning steps ${e.retry.from + 1}-${e.retry.to + 1} (attempt ${rc})`);
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

router.post('/:id/run', async (req, res) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT s.*, p.name as profile_name, p.ip_address, p.port, p.mac_address
      FROM autoload_sequences s
      LEFT JOIN profiles p ON s.profile_id = p.id
      WHERE s.id = ?
    `);
    stmt.bind([parseInt(req.params.id)]);
    let sequence = null;
    if (stmt.step()) sequence = stmt.getAsObject();
    stmt.free();

    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
    const steps = JSON.parse(sequence.steps || '[]');
    if (steps.length === 0) return res.status(400).json({ error: 'Sequence has no steps' });

    const profile = sequence.profile_id ? {
      id: sequence.profile_id,
      name: sequence.profile_name,
      ip_address: sequence.ip_address,
      port: sequence.port,
      mac_address: sequence.mac_address,
    } : null;

    const runId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const run = {
      id: runId,
      sequence_id: sequence.id,
      sequence_name: sequence.name,
      status: 'queued',
      total: steps.length,
      current_step: 0,
      started_at: null,
      finished_at: null,
      error: null,
      log: '',
      cancelled: false,
    };
    recordRun(run);

    log('info', `Running sequence "${sequence.name}" (${steps.length} steps)`);
    executeSequence(run, sequence, profile, steps).catch(e => {
      run.status = 'failed';
      run.error = e.message;
      run.finished_at = new Date().toISOString();
      runLog(run, `Fatal: ${e.message}`);
    });

    res.json({ success: true, run_id: runId, message: `Sequence "${sequence.name}" started with ${steps.length} steps` });
  } catch (error) {
    log('error', `Failed to run sequence: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

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
  res.json({ success: true });
});

// ---- Built-in templates: always available, no DB rows needed -----------------
//
// Source of truth: /frontend/builtin/templates.js (see top of this file).

router.get('/templates/list', async (req, res) => {
  try {
    const templates = await getBuiltinTemplates();
    res.json(templates);
  } catch (err) {
    log('error', `templates/list failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
