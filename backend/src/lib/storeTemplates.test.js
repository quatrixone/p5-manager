// The curated Autoload templates in store/templates are the source the runtime
// catalog is generated from, so a broken one reaches every installation. These
// checks read the files themselves rather than the generated catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCatalog } from './catalogLinks.js';
import { validateSequenceSteps } from './sequenceChecks.js';
import { validateStoreItem } from './storeItem.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const templates = path.join(root, 'store/templates');
const read = (file) => decodeCatalog(JSON.parse(fs.readFileSync(path.join(templates, file), 'utf8')));

test('every curated template is a valid item whose steps a run would accept', () => {
  const files = fs.readdirSync(templates).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'no curated templates found');
  for (const file of files) {
    const item = read(file);
    assert.deepEqual(validateStoreItem(item), [], file);
    assert.equal(item.kind, 'template');
    assert.equal(`${item.id}.json`, file);
    validateSequenceSteps(item.steps);
  }
});

test('the PS5 chain is offered for an awake console and for one in rest mode', () => {
  const online = read('userguide-jailbreak-autoload.json');
  const rest = read('wake-userguide-jailbreak-autoload.json');
  const sent = (item) => item.steps.filter((s) => s.type === 'payload').map((s) => s.payloadName);

  // The original watches a console that is already on for a loader that went down.
  assert.equal(online.autoTrigger, 'loader_down');
  assert.notEqual(online.steps[0].type, 'wol');

  // The new one wakes the console over Remote Play first and carries no trigger, so
  // it takes the controller only when someone runs it.
  assert.equal(rest.steps[0].type, 'wol');
  assert.ok(!rest.autoTrigger, 'the wake chain must not install a watcher');
  assert.equal(rest.console_type, 'ps5');

  // Both end at the same console: kstuff, ShadowMountPlus, zftpd, then FTP proved open.
  assert.deepEqual(sent(rest), sent(online));
  assert.equal(rest.steps.at(-1).type, 'check_port');
  assert.equal(rest.steps.at(-1).port, 2120);
});

test('the generated runtime catalog carries both PS5 chains', () => {
  const list = decodeCatalog(JSON.parse(
    fs.readFileSync(path.join(root, 'store/builtin/templates.json'), 'utf8')));
  const ids = list.map((entry) => entry.store?.id);
  assert.ok(ids.includes('userguide-jailbreak-autoload'), ids.join(', '));
  assert.ok(ids.includes('wake-userguide-jailbreak-autoload'), ids.join(', '));
  const rest = list.find((entry) => entry.store?.id === 'wake-userguide-jailbreak-autoload');
  assert.equal(rest.id, 'tpl-wake-userguide-jailbreak-autoload');
  assert.equal(rest.steps[0].type, 'wol');
});
