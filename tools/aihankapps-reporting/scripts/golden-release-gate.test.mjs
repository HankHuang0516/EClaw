import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { requireGoldenScore } from './golden-release-gate.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'trends-golden-gate-'));
  const config = { image: 'golden.png', threshold: 0.9, rawFloor: 0.8, maximumExcludedFraction: 0.25, geometryTolerancePx: 8, metric: 'test fixture SSIM' };
  const configText = JSON.stringify(config);
  const files = {};
  for (const file of ['index.html', 'data.js', 'report-view.js']) { await writeFile(join(dir, file), file); files[file] = sha(file); }
  await writeFile(join(dir, 'app-trends-v1.json'), configText);
  await writeFile(join(dir, 'golden.png'), 'test-only baseline');
  const score = { passed: true, threshold: 0.9, metric: config.metric, maskedSimilarity: 0.92, rawSimilarity: 0.84, excludedFraction: 0.18, functionalChecksPassed: true, geometryErrors: [], files, configSha256: sha(configText), goldenSha256: sha('test-only baseline') };
  const save = () => writeFile(join(dir, 'golden-score.json'), JSON.stringify(score));
  try { await run({ dir, config, score, save, options: { goldenRoot: dir } }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
test('Golden gate fails closed without an exact measurement', () => fixture(async ({ dir, options }) => { await assert.rejects(requireGoldenScore(dir, options), /missing/); }));
test('Golden gate accepts only passing measurements covering every exact artifact', () => fixture(async ({ dir, save, options }) => { await save(); assert.equal((await requireGoldenScore(dir, options)).maskedSimilarity, 0.92); }));
test('Changing any renderer artifact invalidates the visual measurement', () => fixture(async ({ dir, save, options }) => { await save(); await writeFile(join(dir, 'report-view.js'), 'different'); await assert.rejects(requireGoldenScore(dir, options), /exact release/); }));
for (const [label, change] of [
  ['below 90%', { maskedSimilarity: 0.899 }],
  ['too much masking', { excludedFraction: 0.251 }],
  ['low raw similarity', { rawSimilarity: 0.799 }],
  ['failed functional check', { functionalChecksPassed: false }],
  ['geometry failure', { geometryErrors: ['wrong panel'] }],
  ['nonfinite score', { maskedSimilarity: null }],
  ['failed result', { passed: false }],
]) test(`Golden gate rejects ${label}`, () => fixture(async ({ dir, score, save, options }) => { Object.assign(score, change); await save(); await assert.rejects(requireGoldenScore(dir, options), /90%/); }));
test('Changing the approved Golden invalidates the measurement', () => fixture(async ({ dir, save, options }) => { await save(); await writeFile(join(dir, 'golden.png'), 'changed baseline'); await assert.rejects(requireGoldenScore(dir, options), /baseline/); }));
