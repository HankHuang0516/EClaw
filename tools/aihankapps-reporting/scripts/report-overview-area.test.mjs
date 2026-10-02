import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewAreaPath } from '../reports/report-view.mjs';

test('overview area is bounded by the actual observed totals and baseline', () => {
  assert.equal(overviewAreaPath([0, 5, 10]), 'M0,33 L0,33 L714,18.5 L1428,4 L1428,33 L0,33 Z');
});

test('missing history closes separate areas rather than bridging gaps', () => {
  const path = overviewAreaPath([2, null, 4]);
  assert.equal(path, 'M0,33 L0,18.5 L0,33 L0,33 Z M1428,33 L1428,4 L1428,33 L1428,33 Z');
  assert.equal((path.match(/M/g) || []).length, 2);
  assert.equal((path.match(/Z/g) || []).length, 2);
});

test('all missing values have no area and are not fabricated as zero', () => {
  assert.equal(overviewAreaPath([]), '');
  assert.equal(overviewAreaPath([null, null]), '');
  assert.equal(overviewAreaPath([undefined, NaN, Infinity]), '');
});

test('a real zero remains an observed baseline, including a zero before a gap', () => {
  assert.equal(overviewAreaPath([0]), 'M0,33 L0,33 L0,33 L0,33 Z');
  assert.equal(overviewAreaPath([null, 0, null]), 'M714,33 L714,33 L714,33 L714,33 Z');
});

test('the input history is not mutated', () => {
  const values = Object.freeze([2, null, 5, 8]);
  overviewAreaPath(values);
  assert.deepEqual(values, [2, null, 5, 8]);
});
