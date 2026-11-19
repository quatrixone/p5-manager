import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-proxy-'));
process.env.P5M_DB_DIR = dir;
const { initDatabase, getRepo } = await import('../db/sqlite.js');
await initDatabase();
const { default: router } = await import('./gamecompressor.js');

const handler = router.stack.find(l => l.route?.path === '/:ip/engine/*').route.stack[0].handle;
async function callProxy(req) {
  let result = { };
  const res = {
    status(code) { result.status = code; return this; },
    json(value) { result.body = value; return this; },
    type() { return this; },
    send(value) { result.body = value; return this; },
  };
  await handler({ originalUrl: '', ...req }, res);
  return result;
}

test('the engine proxy refuses a console that is not a profile', async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return { ok: true }; };
  try {
    const res = await callProxy({ params: { ip: '203.0.113.9', 0: 'lzc/games' }, method: 'GET', query: {} });
    assert.equal(res.status, 404);
    assert.match(res.body.error, /203\.0\.113\.9/);
    assert.equal(fetched, false, 'nothing may be fetched for an unknown console');
  } finally { globalThis.fetch = originalFetch; }
});

test('the engine proxy refuses a path outside the engine API', async () => {
  const originalFetch = globalThis.fetch;
  getRepo().runAndSave('INSERT INTO profiles (name, ip_address, console_type) VALUES (?, ?, ?)',
    ['t', '192.0.2.5', 'ps5']);
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return { ok: true }; };
  try {
    for (const tail of ['control/shutdown', 'lzc/../../etc/passwd', 'v1/games/mount']) {
      const res = await callProxy({ params: { ip: '192.0.2.5', 0: tail }, method: 'POST', query: {} });
      assert.equal(res.status, 400, tail);
      assert.equal(fetched, false, tail);
    }
  } finally { globalThis.fetch = originalFetch; fs.rmSync(dir, { recursive: true, force: true }); }
});
