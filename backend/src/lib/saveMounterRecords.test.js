import test from 'node:test';
import assert from 'node:assert/strict';
import { addLine } from './saveMounter.js';

// What the payload sends for a save listing: dir, title, subtitle, detail,
// time - five fields, four tabs. A game is free to put a newline in the
// text it shows, and Death Stranding does.
const FIELDS = 5;
// The same loop the client runs: read until every record has its fields.
function assemble(lines, count) {
  const out = [];
  const whole = () => out.length >= count && (!count || out[out.length - 1].split('\t').length >= FIELDS);
  for (const line of lines) {
    if (whole()) break;
    out.push(...addLine(out, line, FIELDS));
  }
  return out;
}

test('a record a line, when nothing is split', () => {
  const lines = [
    'SAVEDATA00\tCeleste\tChapter 1\t\t1779906173',
    'SAVEDATA01\tCeleste\tChapter 2\t\t1779906200',
  ];
  assert.deepEqual(assemble(lines, 2), lines);
});

test('a record split over lines is joined back together', () => {
  const out = assemble([
    'PROFILE\tDEATH STRANDING\tOrder No. 3',
    '"[TOP SECRET] Cremation" - 01:37:24\tAutosave\t1779906173',
    'OPTIONS\tDEATH STRANDING\tSettings\t\t1779906200',
  ], 2);
  assert.equal(out.length, 2);
  assert.equal(out[0].split('\t')[0], 'PROFILE');
  assert.equal(out[0].split('\t').length, FIELDS);
  assert.ok(out[0].includes('\n'));                  // the text keeps its newline
  assert.equal(out[1].split('\t')[0], 'OPTIONS');    // and the next record stays its own
});

test('a record split over more than two lines still comes back whole', () => {
  const out = assemble(['A\tgame\tone', 'two', 'three\tdetail\t1779906173'], 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].split('\t').length, FIELDS);
  assert.equal(out[0].split('\t')[0], 'A');
});
