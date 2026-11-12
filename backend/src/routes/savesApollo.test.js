import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApolloFolder } from './saves.js';

test('reads game and save name off an Apollo export folder', () => {
  assert.deepEqual(parseApolloFolder('CUSA00900_SAVEDATA00'), { title: 'CUSA00900', dir: 'SAVEDATA00' });
  assert.deepEqual(parseApolloFolder('cusa03041-SAVE'), { title: 'CUSA03041', dir: 'SAVE' });
  // No save name in the folder: the mounter still needs one.
  assert.deepEqual(parseApolloFolder('CUSA00900'), { title: 'CUSA00900', dir: 'SAVEDATA00' });
  // Path separators and spaces can't reach a save name.
  assert.equal(parseApolloFolder('CUSA00900_a/b c')?.dir, 'abc');
  assert.equal(parseApolloFolder('PPSA01284_SAVEDATA00')?.title, 'PPSA01284');
  for (const bad of ['SAVEDATA00', 'CUSA1_X', '', null]) assert.equal(parseApolloFolder(bad), null);
});
