import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function requireGoldenScore(directory, { goldenRoot = resolve(import.meta.dirname, '../design/golden') } = {}) {
  let score;
  try { score = JSON.parse(await readFile(join(directory, 'golden-score.json'), 'utf8')); }
  catch { throw new Error('Golden visual verification is missing; publication stopped'); }
  const configBytes = await readFile(join(goldenRoot, 'app-trends-v1.json'));
  const config = JSON.parse(configBytes);
  const goldenBytes = await readFile(join(goldenRoot, config.image));
  if (!Number.isFinite(config.threshold) || config.threshold < 0.9 || !Number.isFinite(config.rawFloor) || config.rawFloor < 0.8 || !Number.isFinite(config.maximumExcludedFraction) || config.maximumExcludedFraction > 0.25 || !Number.isFinite(config.geometryTolerancePx) || config.geometryTolerancePx > 8 || score.threshold !== config.threshold || score.metric !== config.metric || score.configSha256 !== hash(configBytes) || score.goldenSha256 !== hash(goldenBytes)) throw new Error('Golden baseline or comparison rules do not match');
  if (score.passed !== true || !Number.isFinite(score.maskedSimilarity) || score.maskedSimilarity < config.threshold || !Number.isFinite(score.rawSimilarity) || score.rawSimilarity < config.rawFloor || !Number.isFinite(score.excludedFraction) || score.excludedFraction > config.maximumExcludedFraction || score.excludedFraction < 0 || score.functionalChecksPassed !== true || !Array.isArray(score.geometryErrors) || score.geometryErrors.length) throw new Error('Golden similarity must reach 90% with all integrity checks passing; publication stopped');
  for (const file of ['index.html', 'data.js', 'report-view.js']) {
    if (score.files?.[file] !== hash(await readFile(join(directory, file)))) throw new Error('Golden verification does not cover the exact release artifacts');
  }
  return score;
}
