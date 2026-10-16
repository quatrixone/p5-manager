import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverConsole, _resetConsoleStatus, requireConsoleReachable } from './consoleStatus.js';

function fakeSidecar(answers) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const a = answers.shift();
    if (!a) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => a };
  };
  return calls;
}

test('one lost answer keeps the last one, the second reports nothing', async (t) => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  t.after(() => { globalThis.fetch = realFetch; Date.now = realNow; _resetConsoleStatus(); });
  let now = 1_000_000;
  Date.now = () => now;
  _resetConsoleStatus();
  const calls = fakeSidecar([{ status: 'Ok', status_code: 200 }, null, null, { status: 'Ok', status_code: 200 }]);

  assert.equal((await discoverConsole('10.0.0.5')).status, 'Ok');
  now += 2_000; // fresh: no new search
  assert.equal((await discoverConsole('10.0.0.5')).status, 'Ok');
  assert.equal(calls.length, 1);

  now += 10_000; // stale, asked again, no answer: the last answer stands
  const first = await discoverConsole('10.0.0.5');
  assert.equal(first.status, 'Ok');
  assert.equal(first.stale, true);

  now += 4_000; // second miss in a row: nothing
  assert.equal(await discoverConsole('10.0.0.5'), null);

  now += 4_000; // it answers again
  assert.equal((await discoverConsole('10.0.0.5')).stale, undefined);
  assert.equal(calls.length, 4);
});

test('callers at the same time share one search', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; _resetConsoleStatus(); });
  _resetConsoleStatus();
  const calls = fakeSidecar([{ status: 'Server Standby', status_code: 620 }]);
  const [a, b] = await Promise.all([discoverConsole('10.0.0.6', { hostType: 'PS4' }), discoverConsole('10.0.0.6')]);
  assert.equal(a.status_code, 620);
  assert.equal(b.status_code, 620);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /host_type=PS4/);
});

test('an install that the console has to receive is refused while it does not answer', async () => {
  // A profile with an address is not the same as a console that is on; the
  // install used to start a job that then died halfway.
  await assert.rejects(
    requireConsoleReachable({ id: 1, name: 'Living room', ip_address: '192.0.2.10', console_type: 'ps5' }, async () => null),
    (e) => e.status === 400 && /Living room is not on/.test(e.message),
  );
  assert.deepEqual(
    await requireConsoleReachable({ id: 1, name: 'Living room', ip_address: '192.0.2.10', console_type: 'ps5' }, async () => ({ status: 'Ok' })),
    { status: 'Ok' },
  );
  await assert.rejects(
    requireConsoleReachable({ id: 1, name: 'No address', ip_address: '' }, async () => ({ status: 'Ok' })),
    (e) => e.status === 400 && /pick the console/.test(e.message),
  );
});
