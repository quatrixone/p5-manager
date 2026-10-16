export function portRetry(step, index) {
  if (step.retryFromStep == null && step.retryToStep == null) return null;
  const from = Number(step.retryFromStep);
  const to = Number(step.retryToStep ?? from);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > index + 1) {
    throw new Error(`Step ${index + 1}: retry range must reference earlier steps or this check`);
  }
  const maxRetries = step.maxRetries == null ? 3 : Number(step.maxRetries);
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error('maxRetries must be 0 to 5');
  return { from: from - 1, to: to - 1, maxRetries };
}

export function validateSequenceSteps(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 100) throw new Error('steps must contain 1 to 100 steps');
  const supported = new Set(['wait','wol','check_port','payload','download','extract','ftp_upload','convert','input_script','rp_session','klog_read','lua_log_read']);
  steps.forEach((step,index) => {
    if (!step || typeof step !== 'object' || !supported.has(step.type)) throw new Error(`Step ${index+1}: unknown step type`);
    if (step.type === 'check_port') {
      const port = Number(step.port || 9021);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Step ${index+1}: invalid port`);
      const seconds = Number(step.waitSeconds || 0);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) throw new Error(`Step ${index+1}: waitSeconds must be 0 to 3600`);
      portRetry(step,index);
    }
    if (step.type === 'wait' && (!Number.isInteger(Number(step.duration)) || Number(step.duration) < 0 || Number(step.duration) > 3600000)) throw new Error(`Step ${index+1}: invalid wait duration`);
  });
  return steps;
}

// Whether a loader_down watcher may take over its console on this tick.
//
// The watcher steers a real controller through Remote Play, so every rule here is a
// reason not to: something is already running, something else recently ran on this
// console, the console is off, its loader answers, or someone is on the controller.
// Only a console that has been on with the loader closed for the configured time,
// with nothing else going on, is taken over.
//
// A fact may be a value or a function returning one, so the console and Remote Play
// are asked only when the cheap facts have not already settled it. The returned
// downSince is the state to keep: a holding reason resets it, so the port has to
// stay closed for the full time again once the reason is gone.
export async function shouldAutoTrigger(state, cfg, now, facts) {
  const fact = async (value) => (typeof value === 'function' ? await value() : value);
  const hold = (reason) => ({ run: false, downSince: 0, reason });

  if (await fact(facts.busy)) return hold('a sequence is already running');

  // The cooldown counts any run on this console, not only the watcher's own: a
  // manual or external run that just failed leaves exactly the state that would
  // trigger this watcher, and it must not pick up where a person left off.
  const quiet = Math.max(Number(state?.lastRunAt) || 0, Number(await fact(facts.lastRunEndedAt)) || 0);
  if (quiet && now - quiet < cfg.cooldownMin * 60_000) {
    return hold('a run on this console finished less than the cooldown ago');
  }

  if (!(await fact(facts.consoleOn))) return hold('the console is not on');
  if (await fact(facts.portOpen)) return hold('the watched port answers');
  if (await fact(facts.remotePlayBusy)) return hold('Remote Play is in use on this console');

  const downSince = Number(state?.downSince) || now;
  if (now - downSince < cfg.closedForS * 1000) {
    return { run: false, downSince, reason: 'the port has not been closed for long enough' };
  }
  return { run: true, downSince: 0, reason: 'the console is on and the watched port is closed' };
}
