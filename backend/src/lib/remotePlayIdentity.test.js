import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSonyIdentity } from './remotePlayIdentity.js';
import { parsePsnAccountId } from './psnAccount.js';

test('different Sony account preserves console identity and credentials', () => {
  const profile = { psn_account_id: 'Z8JhcG9sbG8=', psn_online_id: 'Console user', rp_user_profile: 'credentials' };
  const before = { ...profile };
  const result = linkSonyIdentity(profile, '123456789', 'Sony user');
  assert.equal(result.psn_account_id, profile.psn_account_id);
  assert.equal(result.psn_online_id, profile.psn_online_id);
  assert.equal(result.sony_account_id, '123456789');
  assert.equal(result.account_mismatch, true);
  assert.deepEqual(profile, before);
});
test('equivalent decimal and base64 IDs match and update the name', () => {
  const result = linkSonyIdentity({ psn_account_id: 'Z8JhcG9sbG8=' }, parsePsnAccountId('Z8JhcG9sbG8='), 'Sony user');
  assert.equal(result.account_mismatch, false);
  assert.equal(result.psn_online_id, 'Sony user');
});
test('a new manual profile can pair using the imported identity', () => {
  assert.equal(linkSonyIdentity({}, '123456789', null).psn_account_id, '123456789');
});
test('invalid imports are rejected', () => {
  assert.throws(() => linkSonyIdentity({}, 'invalid', null), /Invalid/);
});
