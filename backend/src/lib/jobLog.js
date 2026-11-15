// Long console jobs the browser watches by polling.
//
// A job runs on its own, keeps the step it is on and the lines it said, and
// is forgotten an hour after it ends. The routes that use it expose a
// `jobs/:id` of their own; what they hand the browser is `publicJob`,
// without the function the job writes with.
import crypto from 'node:crypto';

const KEEP_MS = 60 * 60 * 1000;

export const publicJob = ({ say, ...rest }) => rest;

export function createJobs(onFailure) {
  const jobs = new Map();
  return {
    get: (id) => jobs.get(id),
    start(kind, run) {
      const job = {
        id: crypto.randomBytes(6).toString('hex'), kind, state: 'running', step: '',
        log: [], files: 0, bytes: 0, error: null, result: null, started: Date.now(),
      };
      const say = (step) => { job.step = step; job.log.push(step); if (job.log.length > 200) job.log.shift(); };
      job.say = say;
      jobs.set(job.id, job);
      (async () => {
        try {
          job.result = await run(job, say);
          job.state = 'done';
          say('Done');
        } catch (e) {
          job.state = 'failed';
          job.error = e.message;
          say(`Failed: ${e.message}`);
          onFailure?.(kind, e);
        }
        setTimeout(() => jobs.delete(job.id), KEEP_MS).unref?.();
      })();
      return job;
    },
  };
}
