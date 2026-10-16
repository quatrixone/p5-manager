import test from 'node:test';
import assert from 'node:assert/strict';
import { portRetry, shouldAutoTrigger, validateSequenceSteps } from './sequenceChecks.js';

const CFG = { closedForS: 30, cooldownMin: 10 };
const NOW = 1_700_000_000_000;
const minutes = (n) => n * 60_000;

// Everything the watcher would find on a console that it should take over: on,
// loader closed long enough, nothing else running, nothing on the controller.
const ready = (over = {}) => ({
  busy: false,
  lastRunEndedAt: 0,
  consoleOn: true,
  portOpen: false,
  remotePlayBusy: false,
  ...over,
});

test('a console that is on with the loader closed long enough is taken over', async () => {
  const decision = await shouldAutoTrigger({ downSince: NOW - 31_000 }, CFG, NOW, ready());
  assert.equal(decision.run, true);
});

test('the wait for a closed port starts at the first tick that sees it closed', async () => {
  const first = await shouldAutoTrigger({ downSince: 0 }, CFG, NOW, ready());
  assert.equal(first.run, false);
  assert.equal(first.downSince, NOW);
  const later = await shouldAutoTrigger(first, CFG, NOW + 29_000, ready());
  assert.equal(later.run, false, '29 s is not the configured 30 s');
  assert.equal((await shouldAutoTrigger(first, CFG, NOW + 30_000, ready())).run, true);
});

test('a run of any sequence on the same console holds the watcher for the cooldown', async () => {
  // The hole this closes: the cooldown used to count only the watcher's own runs,
  // so a failed manual bring-up left the console on with the loader closed - the
  // trigger condition - and the watcher fired seconds later.
  const after = (ago) => shouldAutoTrigger({ downSince: NOW - minutes(60) }, CFG, NOW,
    ready({ lastRunEndedAt: NOW - minutes(ago) }));
  assert.equal((await after(1)).run, false);
  assert.equal((await after(9)).run, false);
  assert.equal((await after(11)).run, true);
  // Its own last run still counts, even when that run has aged out of the list.
  const own = await shouldAutoTrigger({ downSince: NOW - minutes(60), lastRunAt: NOW - minutes(2) },
    CFG, NOW, ready());
  assert.equal(own.run, false);
});

test('the watcher never takes a controller something else is holding', async () => {
  const held = (over) => shouldAutoTrigger({ downSince: NOW - minutes(60) }, CFG, NOW, ready(over));
  assert.equal((await held({ busy: true })).run, false);
  // A live session, and the warm session the wake step parks for 180 s, both count.
  assert.equal((await held({ remotePlayBusy: true })).run, false);
  // An unknown Remote Play state is treated as in use by the caller, so the same.
  assert.equal((await held({ remotePlayBusy: () => Promise.resolve(true) })).run, false);
});

test('a holding reason resets the wait, so the port has to stay closed again', async () => {
  const blocked = await shouldAutoTrigger({ downSince: NOW - minutes(60) }, CFG, NOW,
    ready({ remotePlayBusy: true }));
  assert.equal(blocked.downSince, 0);
  assert.equal((await shouldAutoTrigger(blocked, CFG, NOW + 1000, ready())).run, false);
});

test('a console in rest mode or one whose loader answers is left alone', async () => {
  const state = { downSince: NOW - minutes(60) };
  assert.equal((await shouldAutoTrigger(state, CFG, NOW, ready({ consoleOn: false }))).run, false);
  assert.equal((await shouldAutoTrigger(state, CFG, NOW, ready({ portOpen: true }))).run, false);
});

test('nothing is asked over the network while a run is in progress', async () => {
  const never = () => { throw new Error('the console was asked anyway'); };
  const decision = await shouldAutoTrigger({ downSince: NOW - minutes(60) }, CFG, NOW, {
    busy: true,
    lastRunEndedAt: 0,
    consoleOn: never,
    portOpen: never,
    remotePlayBusy: never,
  });
  assert.equal(decision.run, false);
  // The same while cooling down: the cheap facts answer first.
  const cooling = await shouldAutoTrigger({ downSince: NOW - minutes(60) }, CFG, NOW, {
    busy: false,
    lastRunEndedAt: NOW - minutes(1),
    consoleOn: never,
    portOpen: never,
    remotePlayBusy: never,
  });
  assert.equal(cooling.run, false);
});

test('a decision always says why, so a quiet watcher can be explained', async () => {
  const state = { downSince: NOW - minutes(60) };
  for (const facts of [ready({ busy: true }), ready({ lastRunEndedAt: NOW }),
                        ready({ consoleOn: false }), ready({ portOpen: true }),
                        ready({ remotePlayBusy: true })]) {
    const decision = await shouldAutoTrigger(state, CFG, NOW, facts);
    assert.equal(decision.run, false);
    assert.equal(typeof decision.reason, 'string');
    assert.ok(decision.reason.length > 0);
  }
});

test('a retry range has to point at this check or an earlier step', () => {
  assert.deepEqual(portRetry({ retryFromStep: 1, retryToStep: 2, maxRetries: 2 }, 4),
    { from: 0, to: 1, maxRetries: 2 });
  assert.equal(portRetry({ port: 9021 }, 4), null);
  assert.throws(() => portRetry({ retryFromStep: 0 }, 4), /retry range/);
  assert.throws(() => portRetry({ retryFromStep: 6 }, 4), /retry range/);
  assert.throws(() => portRetry({ retryFromStep: 2, retryToStep: 1 }, 4), /retry range/);
  assert.throws(() => portRetry({ retryFromStep: 1, maxRetries: 6 }, 4), /maxRetries/);
});

test('steps are refused before a run rather than part way through one', () => {
  assert.throws(() => validateSequenceSteps([]), /1 to 100/);
  assert.throws(() => validateSequenceSteps([{ type: 'nope' }]), /unknown step type/);
  assert.throws(() => validateSequenceSteps([{ type: 'check_port', port: 70000 }]), /invalid port/);
  assert.throws(() => validateSequenceSteps([{ type: 'check_port', waitSeconds: 4000 }]), /waitSeconds/);
  // A falsy port means the default 9021, not a rejected step.
  assert.deepEqual(validateSequenceSteps([{ type: 'check_port', port: 0 }]), [{ type: 'check_port', port: 0 }]);
  assert.throws(() => validateSequenceSteps([{ type: 'wait', duration: -1 }]), /wait duration/);
  assert.deepEqual(validateSequenceSteps([{ type: 'wol' }, { type: 'check_port', port: 9021 }]),
    [{ type: 'wol' }, { type: 'check_port', port: 9021 }]);
});
