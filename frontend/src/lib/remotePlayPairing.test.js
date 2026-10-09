import test from 'node:test';
import assert from 'node:assert/strict';
import { pairRemotePlay, sameAccountId } from './remotePlayPairing.js';

for (const console_type of ['ps4', 'ps5']) {
  for (const offline of [false, true]) {
    test(`${console_type} ${offline ? 'offline activation' : 'activated'} pairs using the captured account and PIN`, async () => {
      const calls = [], progress = [];
      const profile = { id: 4, ip_address: '10.0.0.180', console_type, psn_account_id: 'OLD_ACCOUNT=' };
      const result = await pairRemotePlay({ profile, offline, wait: async () => {}, onProgress: p => progress.push(p),
        post: async (route, body) => {
          calls.push({ route, body });
          if (route.endsWith('/activate-account')) return { success: true, account_id: 'Z8JhcG9sbG8=', activated: 'already' };
          if (route.endsWith('/get-pin')) return { success: true, account_id: 'Z8JhcG9sbG8=', pin: '0001 0023', user: 'Local user' };
          return { success: true, profile: { name: 'Paired console' } };
        } });
      assert.deepEqual(calls.map(c => c.route), offline
        ? ['/remoteplay/activate-account', '/remoteplay/get-pin', '/remoteplay/register']
        : ['/remoteplay/get-pin', '/remoteplay/register']);
      assert.equal(calls.at(-1).body.account_id, 'Z8JhcG9sbG8=');
      assert.equal(calls.at(-1).body.pin, '00010023');
      assert.equal(calls.at(-1).body.online_id, undefined);
      assert.equal(result.success, true);
      assert.equal(progress.at(-1), 'Paired');
    });
  }
}

test('failed activation stops before requesting a PIN or registering', async () => {
  const calls = [];
  await assert.rejects(pairRemotePlay({ profile: { id: 4, ip_address: '10.0.0.180' }, offline: true,
    post: async route => { calls.push(route); return { success: false, message: 'No account ID', log: ['No account'] }; } }),
  error => error.message === 'No account ID' && error.log[0] === 'No account');
  assert.equal(calls.length, 1);
});

test('invalid or missing PIN/account never registers using stale profile information', async () => {
  for (const pinResult of [{ success: true, pin: '1234', account_id: 'Z8JhcG9sbG8=' },
    { success: true, pin: '1234 5678' }, { success: false, pin: '1234 5678', account_id: 'Z8JhcG9sbG8=', error: 'Timed out' }]) {
    const calls = [];
    await assert.rejects(pairRemotePlay({ profile: { id: 4, ip_address: '10.0.0.180', psn_account_id: 'OLD_ACCOUNT=' },
      post: async route => { calls.push(route); return pinResult; } }));
    assert.deepEqual(calls, ['/remoteplay/get-pin']);
  }
});

test('registration failure never reports paired', async () => {
  const progress = [];
  await assert.rejects(pairRemotePlay({ profile: { id: 3, ip_address: '10.0.0.127' }, wait: async () => {}, onProgress: p => progress.push(p),
    post: async route => route.endsWith('/get-pin')
      ? { success: true, pin: '1234 5678', account_id: 'Z8JhcG9sbG8=' }
      : { success: false, error: 'PIN expired' } }), /PIN expired/);
  assert.ok(!progress.includes('Paired'));
});

test('service discovery retries reuse the same PIN without repeating activation', async () => {
  const calls = [], waits = [];
  let tries = 0;
  await pairRemotePlay({ profile: { id: 4, ip_address: '10.0.0.180' }, offline: true,
    wait: async ms => waits.push(ms), post: async (route, body) => {
      calls.push({ route, body });
      if (route.endsWith('/activate-account')) return { success: true };
      if (route.endsWith('/get-pin')) return { success: true, pin: '0001 0023', account_id: 'Z8JhcG9sbG8=' };
      if (++tries < 3) throw new Error('Register failed: Regist search failed');
      return { success: true, profile: {} };
    } });
  assert.equal(calls.filter(c => c.route.endsWith('/activate-account')).length, 1);
  assert.equal(calls.filter(c => c.route.endsWith('/get-pin')).length, 1);
  assert.equal(calls.filter(c => c.route.endsWith('/register')).length, 3);
  assert.ok(calls.filter(c => c.route.endsWith('/register')).every(c => c.body.pin === '00010023'));
  assert.deepEqual(waits, [1000, 1500, 3000]);
});

test('identity comparison supports decimal, base64 and 64-bit precision', () => {
  assert.equal(sameAccountId('Z8JhcG9sbG8=', '8028911461577376359'), true);
  assert.equal(sameAccountId('Z8JhcG9sbG8=', '123456789'), false);
  assert.equal(sameAccountId(null, null), false);
});
test('offline activation does not override the active console account with linked Sony ID', async () => {
  const calls = [];
  await pairRemotePlay({ profile: { id: 1, ip_address: 'console' }, offline: true,
    wait: async () => {}, post: async (route, body) => {
      calls.push({ route, body });
      return route.endsWith('/get-pin') ? { success: true, pin: '00010023', account_id: 'captured' } : { success: true };
    } });
  assert.equal(calls[0].body.account_id, undefined);
  assert.equal(calls[2].body.account_id, 'captured');
});
