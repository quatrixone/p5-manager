import express from 'express';
import net from 'net';
import { getDatabase, saveDatabase, log } from '../db/sqlite.js';

const router = express.Router();

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
  // New wake endpoint sends both DDP WAKEUP and DDP LAUNCH (using the stored
  // PSN account_id), so the PS5 wakes *and* logs the user in - bypassing the
  // "Press PS button" prompt that otherwise blocks Remote Play after a cold
  // boot from rest mode.
  await apiFetch('POST', '/remoteplay/wake', {
    profile_id: ctx.profile.id,
  });

  // Optional: keep the PS5 awake for the rest of the sequence by holding an
  // RP session open. Without this, PS5 returns to rest mode mid-FTP-upload
  // because the FTP server payload doesn't count as user activity for the
  // console's power-saving timer. A live Remote Play session does.
  if (step.keep_session) {
    try {
      // Give DDP LAUNCH a moment to finish logging in before RP knocks.
      await sleep(step.keep_session_delay_ms || 3000);
      const r = await apiFetch('POST', '/remoteplay/quick-start', {
        ip: ctx.profile.ip_address,
      });
      if (r?.session_id) {
        ctx.openedSessions.push({ ip: ctx.profile.ip_address, session_id: r.session_id });
        runLog(ctx.run, `  · opened keep-awake RP session ${r.session_id.slice(0, 8)} for ${ctx.profile.ip_address}`);
      }
    } catch (e) {
      // Don't fail the whole sequence just because we couldn't keep PS5
      // awake - DDP wake alone is often enough for short runs.
      runLog(ctx.run, `  · keep_session failed: ${e.message} (sequence will continue without RP session)`);
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
  await apiFetch('POST', '/micromount/extract/queue/resume').catch(() => {});
  const r = await apiFetch('POST', '/micromount/extract/queue', body);
  const itemId = r.item.id;
  await pollUntilTerminal(async () => {
    const list = await apiFetch('GET', '/micromount/extract/queue');
    const item = (list.items || []).find(i => i.id === itemId);
    if (!item) return { status: 'failed', error: 'item disappeared' };
    return { status: item.status, error: item.error };
  });
}

async function execFtpUpload(step, ctx) {
  const ip = step.ip || ctx.profile?.ip_address;
  if (!ip) throw new Error('ftp_upload needs ip or profile');
  if (!step.local_path) throw new Error('ftp_upload needs local_path');
  await apiFetch('POST', '/micromount/ftp/upload', {
    ip,
    local_path: step.local_path,
    dest_path: step.dest_path,
  });
}

async function execConvert(step) {
  if (!step.source_path) throw new Error('convert needs source_path');
  await apiFetch('POST', '/micromount/convert/queue/resume').catch(() => {});
  const r = await apiFetch('POST', '/micromount/convert/queue', {
    mode: step.mode || 'pack-file',
    source_path: step.source_path,
    output_name: step.output_name,
    compress: step.compress !== false,
    verify: step.verify !== false,
  });
  const itemId = r.item.id;
  await pollUntilTerminal(async () => {
    const list = await apiFetch('GET', '/micromount/convert/queue');
    const item = (list.items || []).find(i => i.id === itemId);
    if (!item) return { status: 'failed', error: 'item disappeared' };
    return { status: item.status, error: item.error };
  });
}

async function execInputScript(step, ctx) {
  if (!ctx.profile) throw new Error('input_script step needs a profile');
  // Step may carry either a script_id (referencing input_scripts table) or
  // the literal script content (set when the step was added via the UI).
  const body = {
    ip: ctx.profile.ip_address,
    profile_id: ctx.profile.id,
    keep_session: true,
  };
  if (step.script) body.script = step.script;
  else if (step.scriptId) body.script_id = step.scriptId;
  else throw new Error('input_script step needs a script or scriptId');
  const r = await apiFetch('POST', '/remoteplay/run-script', body);
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
    await apiFetch('POST', '/remoteplay/quick-start', { ip: ctx.profile.ip_address, profile_id: ctx.profile.id });
  } else if (action === 'stop') {
    await apiFetch('POST', '/remoteplay/quick-stop', { ip: ctx.profile.ip_address });
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

const DEFAULT_TEMPLATES = [
  {
    id: 'tpl-wake-and-send',
    name: 'Wake & send payload',
    description: 'Wake the PS5, wait for it, then send the default payload.',
    steps: [
      { type: 'wol', name: 'Wake on LAN' },
      { type: 'wait', duration: 8000, name: 'Wait 8 seconds' },
      { type: 'check_port', port: 9021, retryFromStep: 1, retryToStep: 2, name: 'Check port 9021 (retry 1-2 on fail)' },
    ],
    requiresProfile: true,
  },
  {
    id: 'tpl-download-extract-upload',
    name: 'Download → extract → upload to PS5',
    description: 'Download a file, extract it locally, then upload result to PS5 via FTP. Wakes PS5 and holds a Remote Play session so it stays awake through the upload.',
    steps: [
      { type: 'wol', keep_session: true, name: 'Wake PS5 (keep awake)' },
      { type: 'wait', duration: 6000, name: 'Wait 6 seconds' },
      { type: 'download', url: 'https://example.com/archive.zip', dest_kind: 'local', dest_path: '/data/mkpfs', name: 'Download archive.zip' },
      { type: 'extract', source: 'local-fs', local_path: '/data/mkpfs/archive.zip', dest_kind: 'local-fs', dest_local_path: '/data/mkpfs', name: 'Extract archive.zip' },
      { type: 'ftp_upload', local_path: '/data/mkpfs/file.ffpfsc', dest_path: '/data/homebrew', name: 'Upload to PS5 FTP' },
    ],
    requiresProfile: true,
  },
  {
    id: 'tpl-full-pipeline',
    name: 'Full game pipeline',
    description: 'Wake PS5 (holding an RP session so it stays awake), download, extract, convert to .ffpfsc, upload via FTP.',
    steps: [
      { type: 'wol', keep_session: true, name: 'Wake PS5 (keep awake)' },
      { type: 'wait', duration: 6000, name: 'Wait 6 seconds' },
      { type: 'download', url: 'https://example.com/game.rar', dest_kind: 'local', dest_path: '/data/mkpfs', name: 'Download game.rar' },
      { type: 'extract', source: 'local-fs', local_path: '/data/mkpfs/game.rar', dest_kind: 'local-fs', dest_local_path: '/data/mkpfs', name: 'Extract game.rar' },
      { type: 'convert', mode: 'pack-file', source_path: '/data/mkpfs/game.exfat', name: 'Convert to .ffpfsc' },
      { type: 'ftp_upload', local_path: '/data/mkpfs/game.ffpfsc', dest_path: '/data/homebrew', name: 'Upload .ffpfsc to PS5' },
    ],
    requiresProfile: true,
  },
  {
    id: 'tpl-full-game',
    name: 'Full game (RP session → launch script → verify ELF)',
    description: 'Start a Remote Play session, run an input script that launches the game, wait for it to boot, then succeed when the ELF port (9021) is open.',
    steps: [
      { type: 'rp_session', action: 'start', name: 'Start Remote Play session' },
      { type: 'input_script', scriptId: null, scriptName: '(pick after loading template)', script: '// edit this step to pick your launch script', name: 'Run input: launch game' },
      { type: 'wait', duration: 20000, name: 'Wait 20 seconds for game to boot' },
      { type: 'check_port', port: 9021, retryFromStep: 3, retryToStep: 3, name: 'Verify ELF port 9021 (success)' },
      { type: 'rp_session', action: 'stop', name: 'Stop Remote Play session' },
    ],
    requiresProfile: true,
  },
  {
    id: 'tpl-p2jb-jailbreak',
    name: 'p2jb jailbreak (wake → lua → wait 55min → verify ELF)',
    description: 'Wake PS5, wait 15s, send p2jb.lua once the Lua port (9026) is up, wait 55 minutes, then succeed if the ELF port (9021) is reachable.',
    steps: [
      { type: 'wol', name: 'Wake on LAN' },
      { type: 'wait', duration: 15000, name: 'Wait 15 seconds' },
      // Block until Lua port 9026 is available; on failure, retry the wake + wait pair.
      { type: 'check_port', port: 9026, retryFromStep: 1, retryToStep: 2, name: 'Check Lua port 9026 (retry wake on fail)' },
      { type: 'payload', payloadName: 'p2jb.lua', name: 'Send p2jb.lua' },
      { type: 'wait', duration: 55 * 60 * 1000, name: 'Wait 55 minutes' },
      // Final verification: ELF port 9021 must be open. No retry → fails the sequence if unreachable.
      { type: 'check_port', port: 9021, retryFromStep: 6, retryToStep: 6, name: 'Verify ELF port 9021 (success)' },
    ],
    requiresProfile: true,
  },
];

router.get('/templates/list', (req, res) => {
  res.json(DEFAULT_TEMPLATES);
});

export default router;
