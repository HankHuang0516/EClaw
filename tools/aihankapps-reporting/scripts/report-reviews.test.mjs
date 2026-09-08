import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewCount } from './report-reviews.mjs';
test('official empty Google/Apple review responses are confirmed zero', () => {
  assert.deepEqual(reviewCount({}, 'google'), { count: 0, partial: false });
  assert.deepEqual(reviewCount({ data: [], links: {} }, 'apple'), { count: 0, partial: false });
});
test('review count marks unread pages and never includes personal review content', () => {
  assert.deepEqual(reviewCount({ reviews: [{ text: 'private' }], tokenPagination: { nextPageToken: 'private-token' } }, 'google'), { count: 1, partial: true });
  assert.deepEqual(reviewCount({ data: [{ attributes: { body: 'private' } }], links: { next: 'next-page' } }, 'apple'), { count: 1, partial: true });
  assert.throws(() => reviewCount({ error: 'unauthorized' }, 'google'), /Invalid/);
  assert.throws(() => reviewCount({}, 'apple'), /Invalid/);
});
