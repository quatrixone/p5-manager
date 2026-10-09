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
