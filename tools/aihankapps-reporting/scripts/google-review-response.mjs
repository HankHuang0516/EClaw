import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { appendSnapshot } from './report-storage.mjs';

const run = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const serialize = value => `${JSON.stringify(value, null, 2)}\n`;
const identity = value => { if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(value)) throw new Error('Invalid Google review identity'); };
function apiObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.error || value.errors || Object.keys(value).some(key => !['reviews', 'tokenPagination', 'pageInfo', 'nextPageToken'].includes(key))) throw new Error('Invalid Google API review response');
  if ('reviews' in value && !Array.isArray(value.reviews)) throw new Error('Invalid Google API review list');
  for (const key of ['tokenPagination', 'pageInfo']) if (key in value && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) throw new Error('Invalid Google review pagination');
  return value;
}
export function decodeGoogleCliReviews(raw, { firstPage } = {}) {
  if (raw && !Array.isArray(raw) && typeof raw === 'object') return apiObject(raw);
  if (Array.isArray(raw) && raw.length) {
    if (!raw.every(row => row && typeof row === 'object' && !row.error && !row.errors && typeof row.reviewId === 'string' && row.reviewId && Array.isArray(row.comments))) throw new Error('Invalid paginated Google review list');
    return { reviews: raw };
  }
  if (raw === null || (Array.isArray(raw) && !raw.length)) {
    const verified = apiObject(firstPage);
    if ((verified.reviews || []).length || verified.tokenPagination?.nextPageToken || verified.nextPageToken) throw new Error('Google empty review result was not confirmed');
    return { reviews: [] };
  }
  throw new Error('Invalid Google CLI review response');
}
async function appendIdentical(path, bytes) {
  try { await appendSnapshot(path, bytes); } catch (error) {
    if (error.code !== 'EEXIST' || !Buffer.from(await readFile(path)).equals(Buffer.from(bytes))) throw error;
  }
}
export async function readGoogleReviewSnapshot(directory, packageName) {
  identity(packageName);
  const original = await readFile(join(directory, 'reviews.json'));
  const raw = JSON.parse(original);
  if (raw && !Array.isArray(raw) && typeof raw === 'object') return decodeGoogleCliReviews(raw);
  const receipt = JSON.parse(await readFile(join(directory, 'reviews-format.json'), 'utf8'));
  const normalized = await readFile(join(directory, 'reviews-normalized.json'));
  if (receipt.formatVersion !== 1 || receipt.packageName !== packageName || receipt.rawSha256 !== hash(original) || receipt.normalizedSha256 !== hash(normalized)) throw new Error('Google review provenance mismatch');
  const empty = raw === null || (Array.isArray(raw) && !raw.length);
  let firstPage;
  if (empty) {
    const proof = await readFile(join(directory, 'reviews-first-page.json'));
    if (receipt.method !== 'successful-independent-first-page-empty' || receipt.firstPageSha256 !== hash(proof)) throw new Error('Google empty review proof mismatch');
    firstPage = JSON.parse(proof);
  } else if (receipt.method !== 'successful-cli-all-pages-array') throw new Error('Google review format proof mismatch');
  const derived = decodeGoogleCliReviews(raw, { firstPage });
  if (serialize(derived) !== normalized.toString('utf8')) throw new Error('Google review normalization mismatch');
  return derived;
}
export async function normalizeGoogleReviewSnapshot(directory, packageName, { fetchFirstPage } = {}) {
  identity(packageName);
  const original = await readFile(join(directory, 'reviews.json'));
  const raw = JSON.parse(original);
  if (raw && !Array.isArray(raw) && typeof raw === 'object') return decodeGoogleCliReviews(raw);
  try {
    await readFile(join(directory, 'reviews-format.json'));
    return await readGoogleReviewSnapshot(directory, packageName);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const empty = raw === null || (Array.isArray(raw) && !raw.length);
  let firstPage, proof;
  if (empty) {
    proof = fetchFirstPage ? await fetchFirstPage(packageName) : (await run('gplay', ['--profile', 'aihankapps', 'reviews', 'list', '--package', packageName, '--output', 'json'], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout;
    if (typeof proof !== 'string' && !Buffer.isBuffer(proof)) throw new Error('Invalid Google review probe output');
    firstPage = JSON.parse(proof);
  }
  const normalized = decodeGoogleCliReviews(raw, { firstPage });
  const bytes = serialize(normalized);
  if (empty) await appendIdentical(join(directory, 'reviews-first-page.json'), proof);
  await appendIdentical(join(directory, 'reviews-normalized.json'), bytes);
  await appendSnapshot(join(directory, 'reviews-format.json'), serialize({ formatVersion: 1, packageName, rawSha256: hash(original), normalizedSha256: hash(bytes), method: empty ? 'successful-independent-first-page-empty' : 'successful-cli-all-pages-array', ...(empty ? { firstPageSha256: hash(proof) } : {}), verifiedAt: new Date().toISOString() }));
  return readGoogleReviewSnapshot(directory, packageName);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await normalizeGoogleReviewSnapshot(process.argv[2], process.argv[3]); } catch { process.stderr.write('Google review normalization failed; original response preserved.\n'); process.exitCode = 1; }
}
