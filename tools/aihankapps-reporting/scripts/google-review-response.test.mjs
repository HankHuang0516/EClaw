import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeGoogleCliReviews, normalizeGoogleReviewSnapshot, readGoogleReviewSnapshot } from './google-review-response.mjs';
import { reviewCount, loadReviewCounts } from './report-reviews.mjs';

test('Google paginated shapes require an independently confirmed empty first page', () => {
  assert.deepEqual(decodeGoogleCliReviews({}), {});
  const rows = [{ reviewId: 'one', comments: [] }];
  assert.deepEqual(decodeGoogleCliReviews(rows), { reviews: rows });
  for (const raw of [null, []]) {
    assert.throws(() => decodeGoogleCliReviews(raw));
    assert.deepEqual(decodeGoogleCliReviews(raw, { firstPage: {} }), { reviews: [] });
    for (const firstPage of [null, [], { error: 'failed' }, { unknown: true }, { reviews: null }, { reviews: rows }, { tokenPagination: { nextPageToken: 'next' } }, { nextPageToken: 'next' }]) assert.throws(() => decodeGoogleCliReviews(raw, { firstPage }));
  }
  for (const raw of [0, '', true, [{ error: 'failed' }], [{ reviewId: 'one' }], { errors: [] }, { reviews: null }]) assert.throws(() => decodeGoogleCliReviews(raw));
  assert.throws(() => reviewCount(null, 'google'));
});
test('verified sidecars preserve raw bytes, are reusable, and reject altered provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'google-review-proof-'));
  try {
    await writeFile(join(root, 'reviews.json'), 'null\n');
    await assert.rejects(readGoogleReviewSnapshot(root, 'app.example.game'));
    await normalizeGoogleReviewSnapshot(root, 'app.example.game', { fetchFirstPage: async () => '{}\n' });
    assert.equal(await readFile(join(root, 'reviews.json'), 'utf8'), 'null\n');
    assert.deepEqual(await readGoogleReviewSnapshot(root, 'app.example.game'), { reviews: [] });
    await normalizeGoogleReviewSnapshot(root, 'app.example.game', { fetchFirstPage: async () => { throw new Error('must reuse proof'); } });
    await assert.rejects(readGoogleReviewSnapshot(root, 'app.other.game'), /provenance/);
    await writeFile(join(root, 'reviews-first-page.json'), '{"error":"failed"}');
    await assert.rejects(readGoogleReviewSnapshot(root, 'app.example.game'), /proof/);
    await writeFile(join(root, 'reviews-first-page.json'), '{}\n');
    await writeFile(join(root, 'reviews-normalized.json'), '{}\n');
    await assert.rejects(readGoogleReviewSnapshot(root, 'app.example.game'), /provenance/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('current null reviews block release until proof exists; unverified history stays partial', async () => {
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'google-review-loader-'));
  try {
    const current = join(root, '2026-10-02'), old = join(root, '2026-10-01');
    for (const snapshot of [current, old]) { const dir = join(snapshot, 'google-play/apps/app.example.game'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'reviews.json'), 'null\n'); }
    const catalog = { apps: [{ communityId: 'game', googlePackage: 'app.example.game' }] };
    await assert.rejects(loadReviewCounts(current, catalog));
    await normalizeGoogleReviewSnapshot(join(current, 'google-play/apps/app.example.game'), 'app.example.game', { fetchFirstPage: async () => '{}\n' });
    const result = await loadReviewCounts(current, catalog, { archiveRoot: root });
    assert.equal(result.currentVisibleCount, 0); assert.equal(result.archivePartial, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
