// Generic job queue with a single in-flight worker.
//
// Replaces the four hand-rolled FIFO workers inside routes/convert.js (convert,
// extract, ftpUpload, install) which were 99% identical scaffolding (array +
// paused flag + workerRunning flag + tick fn + watchdog + status mirror)
// glued to per-domain validate/build/execute callbacks. We extract that
// scaffolding here once; each domain only supplies its hooks.
//
// HTTP wire format is preserved bit-for-bit so the frontend keeps working:
// `mountQueueRoutes()` produces the exact same response shapes as the old
// inline routes did.

export class JobQueue {
  /**
   * @param {Object} opts
   * @param {string} opts.name                Short identifier (also used in logs)
   * @param {Function} opts.log               Logger fn (level, msg)
   * @param {Function} [opts.scheduleSave]    Debounced persistence flusher
   * @param {number} [opts.tickIntervalMs]    Setinterval cadence (default 2000)
   * @param {number} [opts.pickIntervalMs]    Delay before re-tick after a finish (default 100)
   * @param {number} [opts.failIntervalMs]    Delay before re-tick after a sync failure (default 50)
   * @param {string[]} [opts.liveStatuses]    Statuses that count as "currently working"
   * @param {string[]} [opts.terminalStatuses] Statuses allowed for clean removal
   * @param {string[]} [opts.finishedStatuses] Subset of terminal that qualifies as "finished"
   * @param {string[]} [opts.retryStatuses]   Statuses that can be re-queued via retry()
   * @param {string} [opts.runningStatus]     Status set when worker picks the item (default 'running')
   * @param {string} [opts.startingStatus]    Optional pre-running status (e.g. 'starting')
   * @param {Object} [opts.watchdog]          Stuck-flag watchdog config
   * @param {Function} [opts.shouldBlockRun]  (queue) => bool — return true to skip this tick
   * @param {Function} [opts.validate]        (params) => validated | { error }
   * @param {Function} [opts.buildJob]        (params, validated) => job  (optional; pattern A)
   * @param {Map} [opts.jobsMap]              External jobs map (optional; pattern A)
   * @param {Function} opts.execute           (item|job) => Promise<void> — required
   * @param {Function} [opts.finalize]        (item, job) => void — pattern A mirror-back
   * @param {Function} [opts.itemPublic]      (item) => publicShape — for snapshot()
   * @param {Function} [opts.retryReset]      (item) => void — wipe progress on retry
   * @param {Function} [opts.cancelHook]      (item) => void — tear down on live-DELETE
   */
  constructor(opts) {
    this.name = opts.name;
    this.log = opts.log || ((lvl, msg) => (console[lvl] || console.log)(msg));
    this.scheduleSave = opts.scheduleSave || (() => {});
    this.tickIntervalMs = opts.tickIntervalMs ?? 2000;
    this.pickIntervalMs = opts.pickIntervalMs ?? 100;
    this.failIntervalMs = opts.failIntervalMs ?? 50;
    this.liveStatuses = new Set(opts.liveStatuses || ['running']);
    this.terminalStatuses = new Set(opts.terminalStatuses || ['queued', 'completed', 'failed', 'cancelled']);
    this.finishedStatuses = new Set(opts.finishedStatuses || ['completed', 'failed', 'cancelled']);
    this.retryStatuses = new Set(opts.retryStatuses || ['failed', 'cancelled']);
    this.runningStatus = opts.runningStatus || 'running';
    this.startingStatus = opts.startingStatus || null;
    this.watchdog = opts.watchdog || null;
    this.shouldBlockRun = opts.shouldBlockRun || (() => false);
    this.validate = opts.validate || (() => ({}));
    this.buildJob = opts.buildJob || null;
    this.jobsMap = opts.jobsMap || null;
    this.execute = opts.execute;
    this.finalize = opts.finalize || null;
    this.itemPublic = opts.itemPublic || ((item) => {
      const { _job, _proc, params, ...rest } = item;
      return rest;
    });
    this.retryReset = opts.retryReset || ((item) => {
      item.error = null;
      item.progress = 0;
      item.started_at = null;
      item.finished_at = null;
    });
    this.cancelHook = opts.cancelHook || null;

    this.items = [];
    this.paused = true;
    this._workerRunning = false;
    this._workerStartedAt = 0;
    this._interval = null;
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this.tick(), this.tickIntervalMs);
    if (typeof this._interval.unref === 'function') this._interval.unref();
  }

  stop() {
    if (!this._interval) return;
    clearInterval(this._interval);
    this._interval = null;
  }

  // Re-arms the per-queue setInterval ticker; same scheduling shape as the old
  // setTimeout(..., 50) chain — `setImmediate`-flavored pickups are still
  // delivered by `setTimeout` so the worker fires from a microtask-clean
  // stack.
  _scheduleTick(delay) {
    setTimeout(() => this.tick(), delay);
  }

  _runWatchdog() {
    if (!this.watchdog) return;
    if (!this._workerRunning) return;
    if (this._workerStartedAt <= 0) return;
    const ageMs = Date.now() - this._workerStartedAt;
    if (ageMs <= (this.watchdog.ageMs || 60_000)) return;

    const itemStatuses = this.watchdog.liveItemStatuses
      ? new Set(this.watchdog.liveItemStatuses)
      : this.liveStatuses;
    const liveItem = this.items.some(it => itemStatuses.has(it.status));
    let liveJob = false;
    if (this.watchdog.jobsMap && this.watchdog.liveJobStatuses) {
      const set = new Set(this.watchdog.liveJobStatuses);
      liveJob = Array.from(this.watchdog.jobsMap.values()).some(j => set.has(j.status));
    }
    if (!liveItem && !liveJob) {
      this.log('warn', `[${this.name}-queue] watchdog: workerRunning stuck for ${Math.round(ageMs / 1000)}s with no live job; clearing`);
      this._workerRunning = false;
      this._workerStartedAt = 0;
    }
  }

  tick() {
    this._runWatchdog();
    if (this._workerRunning) return;
    if (this.paused) return;
    if (this.items.length === 0) return;
    if (this.shouldBlockRun(this)) return;

    const next = this.items.find(q => q.status === 'queued');
    if (!next) return;

    this._workerRunning = true;
    this._workerStartedAt = Date.now();
    if (this.startingStatus) next.status = this.startingStatus;

    let prep;
    try {
      prep = this.validate(next.params || next);
    } catch (err) {
      next.status = 'failed';
      next.error = err.message;
      next.finished_at = new Date().toISOString();
      this._endTick(this.failIntervalMs);
      return;
    }
    if (prep && prep.error) {
      next.status = 'failed';
      next.error = prep.error;
      next.finished_at = new Date().toISOString();
      this._endTick(this.failIntervalMs);
      return;
    }

    let job = null;
    try {
      if (this.buildJob) {
        job = this.buildJob(next.params || next, prep || {});
        if (this.jobsMap) this.jobsMap.set(job.id, job);
        next.status = this.runningStatus;
        next.job_id = job.id;
        next.started_at = job.started_at;
        next._job = job;
      } else {
        next.status = this.runningStatus;
        next.started_at = new Date().toISOString();
      }
    } catch (err) {
      next.status = 'failed';
      next.error = err.message;
      next.finished_at = new Date().toISOString();
      this._endTick(this.failIntervalMs);
      return;
    }

    const target = job || next;
    let p;
    try {
      p = this.execute(target);
    } catch (err) {
      next.status = 'failed';
      next.error = err.message;
      next.finished_at = new Date().toISOString();
      this._endTick(this.failIntervalMs);
      return;
    }
    Promise.resolve(p)
      .then(() => {
        if (job && this.finalize) this.finalize(next, job);
      })
      .catch(err => {
        next.status = 'failed';
        next.error = err.message;
        next.finished_at = new Date().toISOString();
      })
      .finally(() => {
        this._endTick(this.pickIntervalMs);
      });
  }

  _endTick(delay) {
    this._workerRunning = false;
    this._workerStartedAt = 0;
    this.scheduleSave();
    this._scheduleTick(delay);
  }

  add(item) {
    this.items.push(item);
    this._scheduleTick(50);
    this.scheduleSave();
    return item;
  }

  pause() {
    this.paused = true;
    this.log('info', `${this.name} queue paused`);
    this.scheduleSave();
    return { success: true, paused: true };
  }

  resume() {
    this.paused = false;
    this.log('info', `${this.name} queue resumed`);
    this._scheduleTick(50);
    this.scheduleSave();
    return { success: true, paused: false };
  }

  remove(id) {
    const idx = this.items.findIndex(q => q.id === id);
    if (idx < 0) return { status: 404, body: { error: 'Item not found' } };
    const item = this.items[idx];
    if (this.liveStatuses.has(item.status)) {
      if (this.cancelHook) {
        try { this.cancelHook(item); } catch (_) {}
      }
      item.status = 'cancelled';
      item.finished_at = new Date().toISOString();
      this.items.splice(idx, 1);
      this.scheduleSave();
      return { status: 200, body: { success: true, cancelled: true } };
    }
    if (this.terminalStatuses.has(item.status)) {
      this.items.splice(idx, 1);
      this.scheduleSave();
      return { status: 200, body: { success: true } };
    }
    return { status: 400, body: { error: `Cannot remove item in status ${item.status}` } };
  }

  clear() {
    const before = this.items.length;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].status === 'queued') this.items.splice(i, 1);
    }
    const removed = before - this.items.length;
    if (removed) this.scheduleSave();
    return { success: true, removed };
  }

  clearFinished() {
    const before = this.items.length;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.finishedStatuses.has(this.items[i].status)) this.items.splice(i, 1);
    }
    const removed = before - this.items.length;
    if (removed) this.scheduleSave();
    return { success: true, removed };
  }

  move(id, direction) {
    const idx = this.items.findIndex(q => q.id === id);
    if (idx < 0) return { status: 404, body: { error: 'Item not found' } };
    if (this.items[idx].status !== 'queued') {
      return { status: 400, body: { error: 'Only queued items can be moved' } };
    }
    if (direction === 'up' && idx > 0 && this.items[idx - 1].status === 'queued') {
      [this.items[idx - 1], this.items[idx]] = [this.items[idx], this.items[idx - 1]];
    } else if (direction === 'down' && idx < this.items.length - 1 && this.items[idx + 1].status === 'queued') {
      [this.items[idx], this.items[idx + 1]] = [this.items[idx + 1], this.items[idx]];
    } else if (direction === 'top') {
      const [item] = this.items.splice(idx, 1);
      const firstQueued = this.items.findIndex(q => q.status === 'queued');
      const insertAt = firstQueued < 0 ? this.items.length : firstQueued;
      this.items.splice(insertAt, 0, item);
    }
    this.scheduleSave();
    return { status: 200, body: { success: true } };
  }

  retry(id) {
    const item = this.items.find(q => q.id === id);
    if (!item) return { status: 404, body: { error: 'Item not found' } };
    if (!this.retryStatuses.has(item.status)) {
      return { status: 400, body: { error: `Cannot retry item in status ${item.status}` } };
    }
    item.status = 'queued';
    this.retryReset(item);
    this._scheduleTick(50);
    this.scheduleSave();
    return { status: 200, body: { success: true } };
  }

  snapshot() {
    return {
      paused: this.paused,
      items: this.items.map(it => this.itemPublic(it)),
    };
  }
}

// Wire the standard CRUD endpoints for a JobQueue onto an Express router.
// The POST `/queue` (add) endpoint is intentionally left to the caller
// because each domain's payload validation differs wildly.
export function mountQueueRoutes(router, prefix, queue) {
  router.get(prefix, (_req, res) => res.json(queue.snapshot()));

  router.delete(`${prefix}/:id`, (req, res) => {
    const r = queue.remove(req.params.id);
    res.status(r.status).json(r.body);
  });

  router.post(`${prefix}/clear`, (_req, res) => res.json(queue.clear()));
  router.post(`${prefix}/clear-finished`, (_req, res) => res.json(queue.clearFinished()));
  router.post(`${prefix}/pause`, (_req, res) => res.json(queue.pause()));
  router.post(`${prefix}/resume`, (_req, res) => res.json(queue.resume()));

  router.post(`${prefix}/:id/move`, (req, res) => {
    const r = queue.move(req.params.id, req.body?.direction);
    res.status(r.status).json(r.body);
  });

  router.post(`${prefix}/:id/retry`, (req, res) => {
    const r = queue.retry(req.params.id);
    res.status(r.status).json(r.body);
  });
}
