import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { requireBrowserChecks, REQUIRED_BROWSER_CHECKS } from './browser-release-gate.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'trends-browser-gate-'));
  const files = {};
  for (const file of ['index.html', 'data.js', 'report-view.js']) { await writeFile(join(dir, file), file); files[file] = sha(file); }
  await mkdir(join(dir, 'verification'));
  const capture = { files, errors: [], checks: { ...Object.fromEntries(REQUIRED_BROWSER_CHECKS.map(key => [key, true])), dailyMode: 'true', mobileOverflow: false } };
  const save = () => writeFile(join(dir, 'verification', 'capture.json'), JSON.stringify(capture));
  try { await run({ dir, capture, save }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('browser gate fails closed without a capture', () => fixture(async ({ dir }) => {
  await assert.rejects(requireBrowserChecks(dir), /missing/);
}));
test('browser gate accepts a passing capture of the exact artifacts, with no similarity score', () => fixture(async ({ dir, save }) => {
  await save();
  assert.equal((await requireBrowserChecks(dir)).checks.allAppsInPicker, true);
}));
test('changing any release artifact invalidates the browser checks', () => fixture(async ({ dir, save }) => {
  await save();
  await writeFile(join(dir, 'data.js'), 'different');
  await assert.rejects(requireBrowserChecks(dir), /exact release/);
}));
for (const [label, change, message] of [
  ['a page error', capture => { capture.errors.push('TypeError'); }, /errors/],
  ['mobile overflow', capture => { capture.checks.mobileOverflow = true; }, /overflows/],
  ['a missing overflow result', capture => { delete capture.checks.mobileOverflow; }, /overflows/],
  ['an APP missing from the picker', capture => { capture.checks.allAppsHitTestingPassed = false; }, /allAppsHitTestingPassed/],
  ['a missing check', capture => { delete capture.checks.mobileTapPinsTooltip; }, /mobileTapPinsTooltip/],
  ['daily mode not selectable', capture => { capture.checks.dailyMode = 'false'; }, /dailyMode/],
  ['malformed errors', capture => { capture.errors = null; }, /malformed/]
]) test(`browser gate rejects ${label}`, () => fixture(async ({ dir, capture, save }) => {
  change(capture);
  await save();
  await assert.rejects(requireBrowserChecks(dir), message);
}));
