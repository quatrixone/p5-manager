import test from 'node:test';
import assert from 'node:assert/strict';
import { ownsStoreItem, prepareStoreSubmission, prepareStoreDraft } from './storeOwnership.js';
const owner = { id: 123, login: 'owner' };
test('verified identity replaces supplied author, owner and version', () => {
  const item = prepareStoreSubmission({ id: 'app', author: 'fake', github_owner_id: 99, version: 400 }, null, owner);
  assert.equal(item.author, 'owner'); assert.equal(item.github_owner_id, 123); assert.equal(item.version, 1);
  assert.throws(() => prepareStoreSubmission({}, null, { login: 'owner' }), /verified/);
});
test('owners can update content after a rename, with next version and stable ownership', () => {
  const old = { id: 'app', github_owner_id: 123, author: 'previous-name', version: 4, script: 'home' };
  assert.ok(ownsStoreItem(old, owner));
  const next = prepareStoreSubmission({ script: 'home\nwait 500', version: 100 }, old, owner);
  assert.equal(next.id, old.id); assert.equal(next.version, 5); assert.equal(next.script, 'home\nwait 500');
  assert.equal(next.author, owner.login); assert.equal(next.github_owner_id, owner.id);
  assert.throws(() => prepareStoreSubmission({ author: 'owner', github_owner_id: 999 }, old, { id: 999, login: 'owner' }), /Only the owner/);
});
test('legacy authors can adopt their item, but submissions cannot claim curated ids', () => {
  const old = { author: 'OWNER', version: 1 };
  assert.equal(prepareStoreSubmission({}, old, owner).github_owner_id, owner.id);
  assert.throws(() => prepareStoreSubmission({}, old, { id: 999, login: 'intruder' }), /Only the owner/);
  assert.throws(() => prepareStoreSubmission({ builtin_id: 'builtin:home' }, null, owner), /Curated/);
  assert.throws(() => prepareStoreSubmission({ builtin_id: 'builtin:home' }, old, owner), /Curated/);
});

test('issue draft labels an unverified login and strips all owner claims', () => {
  const old = { id: 'app', github_owner_id: 123, author: 'owner', version: 3 };
  const draft = prepareStoreDraft({ github_owner_id: 999, version: 100, script: 'home' }, old, 'someone');
  assert.equal(draft.id, 'app'); assert.equal(draft.version, 4); assert.equal(draft.author, 'someone');
  assert.equal(draft.github_owner_id, undefined);
  assert.throws(() => prepareStoreSubmission(draft, old, { id: 999, login: 'someone' }), /Only the owner/);
  const accepted = prepareStoreSubmission(draft, old, { id: 123, login: 'renamed-owner' });
  assert.equal(accepted.github_owner_id, 123); assert.equal(accepted.author, 'renamed-owner');
});
test('drafts validate the GitHub login and cannot claim curated ids', () => {
  for (const login of ['', 'bad name', '-bad', 'bad-', 'x'.repeat(40)]) assert.throws(() => prepareStoreDraft({}, null, login), /GitHub username/);
  assert.throws(() => prepareStoreDraft({ builtin_id: 'builtin:home' }, null, 'owner'), /Curated/);
});

test('ownership reads the catalog owner object and still accepts legacy items', () => {
  const user = { id: 57962558, login: 'quatrixone' };
  assert.equal(ownsStoreItem({ owner: { github_id: 57962558, github_login: 'quatrixone' } }, user), true);
  assert.equal(ownsStoreItem({ owner: { github_id: 1, github_login: 'someone' } }, user), false);
  assert.equal(ownsStoreItem({ github_owner_id: 57962558 }, user), true);
  // A pinned id decides even when the login happens to match.
  assert.equal(ownsStoreItem({ owner: { github_id: 1, github_login: 'quatrixone' } }, user), false);
  assert.equal(ownsStoreItem({ author: 'quatrixone' }, user), true);
});
