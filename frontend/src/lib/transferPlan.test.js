import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTransfer } from './transferPlan.js';

const local = (path) => ({ kind: 'local', path });
const ps5 = (ip, path) => ({ kind: 'ftp', ftpIp: ip, path });
const remote = (id, path) => ({ kind: 'smb', smbId: id, path });
const route = (s, d, op) => planTransfer(s, d, op).route;

test('server disk <-> console goes through the queue', () => {
  assert.equal(route(local('/mnt/a'), ps5('10.0.0.1', '/data'), 'copy'), 'queue');
  assert.equal(route(local('/mnt/a'), ps5('10.0.0.1', '/data'), 'move'), 'queue');
  assert.equal(route(ps5('10.0.0.1', '/data'), local('/mnt/a'), 'copy'), 'queue');
  assert.equal(route(ps5('10.0.0.1', '/data'), local('/mnt/a'), 'move'), 'queue');
});

test('same console: move is a rename, copy is queued', () => {
  assert.equal(route(ps5('10.0.0.1', '/data/a'), ps5('10.0.0.1', '/data/b'), 'move'), 'ftp-rename');
  assert.equal(route(ps5('10.0.0.1', '/data/a'), ps5('10.0.0.1', '/data/b'), 'copy'), 'queue');
});

test('two different consoles are always queued', () => {
  assert.equal(route(ps5('10.0.0.1', '/data'), ps5('10.0.0.2', '/data'), 'copy'), 'queue');
  assert.equal(route(ps5('10.0.0.1', '/data'), ps5('10.0.0.2', '/data'), 'move'), 'queue');
});

test('server disk to server disk uses the direct endpoints', () => {
  assert.equal(route(local('/mnt/a'), local('/mnt/b'), 'copy'), 'local-copy');
  assert.equal(route(local('/mnt/a'), local('/mnt/b'), 'move'), 'local-move');
});

test('remote source is a source only', () => {
  assert.equal(route(remote(3, 'games'), ps5('10.0.0.1', '/data'), 'copy'), 'queue');
  assert.equal(route(remote(3, 'games'), local('/mnt/a'), 'move'), 'queue');
  const r = planTransfer(local('/mnt/a'), remote(3, 'games'), 'copy');
  assert.equal(r.route, 'unsupported');
  assert.match(r.reason, /read-only/);
});

test('dropping into the folder the items came from does nothing', () => {
  assert.equal(route(local('/mnt/a/'), local('/mnt/a'), 'copy'), 'noop');
  assert.equal(route(ps5('10.0.0.1', '/data'), ps5('10.0.0.1', '/data/'), 'move'), 'noop');
  assert.equal(route(ps5('10.0.0.1', '/data'), ps5('10.0.0.2', '/data'), 'move'), 'queue');
});

test('a console pane without a console selected cannot receive', () => {
  assert.equal(route(local('/mnt/a'), { kind: 'ftp', ftpIp: '', path: '' }, 'copy'), 'unsupported');
});
