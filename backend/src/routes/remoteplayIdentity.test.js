import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-identity-'));
process.env.P5M_DB_DIR = dir;
const { initDatabase, getRepo } = await import('../db/sqlite.js');
await initDatabase();
const { default: router } = await import('./remoteplay.js');
async function call(route, body) {
  let result;
  const res = { status() { return this; }, json(value) { result = value; } };
  await router.stack.find(layer => layer.route?.path === route).route.stack[0].handle({ body }, res);
  return result;
}
test('both platforms preserve console identity and registration after manual import, OAuth and forgetting Sony', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ account_id: '987654321', online_id: 'Sony OAuth' }) });
  try {
    for (const platform of ['ps4', 'ps5']) {
      getRepo().runAndSave('INSERT INTO profiles (name, ip_address, console_type, psn_account_id, rp_user_profile) VALUES (?, ?, ?, ?, ?)',
        [platform, platform, platform, 'Z8JhcG9sbG8=', 'existing-registration']);
      const profile = getRepo().queryOne('SELECT * FROM profiles WHERE name = ?', [platform]);
      for (const [route, body, id] of [
        ['/set-account', { account_id: '123456789' }, '123456789'],
        ['/oauth/exchange', { redirect_url: 'https://example.test/redirect' }, '987654321'],
        ['/forget-account', {}, null],
      ]) {
        const result = await call(route, { profile_id: profile.id, ...body });
        assert.equal(result.success, true);
        if (id) assert.equal(result.account_mismatch, true);
        const saved = getRepo().queryOne('SELECT * FROM profiles WHERE id = ?', [profile.id]);
        assert.equal(saved.sony_account_id, id);
        assert.equal(saved.psn_account_id, 'Z8JhcG9sbG8=');
        assert.equal(saved.rp_user_profile, 'existing-registration');
      }
    }
  } finally { globalThis.fetch = originalFetch; fs.rmSync(dir, { recursive: true, force: true }); }
});
