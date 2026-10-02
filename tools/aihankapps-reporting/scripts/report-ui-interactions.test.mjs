import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestSeries, filterReviews, loadCommunityReviews, automaticGranularity, chartFrame, pointMarkerVisible } from '../reports/report-view.mjs';
import { normalizedReviews, mergeReviewItems } from './report-reviews.mjs';

test('isolated real points remain visible in cumulative quarter/year views without synthetic gap markers', () => {
  const point = { x: 10, y: 20, complete: true };
  for (const mode of ['daily', 'cumulative']) {
    assert.equal(pointMarkerVisible([null, point, null], 1, mode), true);
    assert.equal(pointMarkerVisible([null, null], 1, mode), false);
    assert.equal(pointMarkerVisible([point], 0, mode), true);
  }
  assert.equal(pointMarkerVisible([point, point, point], 1, 'cumulative'), false);
  assert.equal(pointMarkerVisible([point, point, point], 1, 'daily'), false);
  assert.equal(pointMarkerVisible([point, { ...point, complete: false }, point], 1, 'daily'), true);
  assert.equal(pointMarkerVisible([point, point], 1, 'daily'), true);
});
test('line hit testing identifies the nearest APP between real connected points', () => {
  const series = [{ id: 'one', points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }, { id: 'two', points: [{ x: 0, y: 40 }, { x: 100, y: 140 }] }];
  assert.equal(nearestSeries(series, 60, 62, 10).id, 'one');
  assert.equal(nearestSeries(series, 60, 99, 10).id, 'two');
  assert.equal(nearestSeries(series, 60, 170, 10), null);
});
test('missing buckets and explicit break markers never create invisible hit-test bridges', () => {
  assert.equal(nearestSeries([{ id: 'gap', points: [{ x: 0, y: 0 }, null, { x: 100, y: 100 }] }], 50, 50, 5), null);
  assert.equal(nearestSeries([{ id: 'partial', points: [{ x: 0, y: 0 }, { x: 100, y: 100, breakBefore: true }] }], 50, 50, 5), null);
  assert.equal(nearestSeries([{ id: 'partial', points: [{ x: 0, y: 0 }, { x: 100, y: 100, breakBefore: true }] }], 100, 100, 5).index, 1);
});
test('two-month default remains daily, zoomed windows still switch to week/month/quarter/year', () => {
  assert.equal(automaticGranularity('2026-08-01', '2026-09-30'), 'day');
  assert.equal(automaticGranularity('2026-01-01', '2026-04-30'), 'week');
  assert.equal(automaticGranularity('2025-01-01', '2026-09-30'), 'month');
  assert.equal(automaticGranularity('2023-01-01', '2026-09-30'), 'quarter');
  assert.equal(automaticGranularity('2020-01-01', '2026-09-30'), 'year');
});
const rows = [
  { id: '1', appId: 'one', platform: 'google', rating: 5, date: '2026-09-01', title: '', body: '好用', author: 'A' },
  { id: '2', appId: 'two', platform: 'community', rating: null, date: '2026-09-03', title: '', body: '當機請協助', author: 'B' },
  { id: '3', appId: 'one', platform: 'apple', rating: 2, date: '2026-09-02', title: '', body: 'crash on launch', author: 'C' },
];
test('desktop coordinates stay fixed while narrow charts retain one CSS pixel per horizontal unit', () => {
  assert.deepEqual(chartFrame(1428), { width: 1428, height: 273, left: 40, span: 1358, gridRight: 1418, ticks: 8 });
  assert.equal(chartFrame(1200).width, 1428);
  for (const width of [248, 318, 680]) {
    const frame = chartFrame(width);
    assert.equal(frame.width, width);
    assert.equal(frame.left + frame.span, width - 30);
    assert.ok(frame.ticks <= 5);
    const value = 60;
    assert.ok(Math.abs(value / frame.width * width - value) < 1e-10);
    assert.equal(chartFrame(width, 'admobRevenue').left, 72);
  }
  assert.equal(chartFrame(NaN).width, 1428);
});
test('reviews combine real sources without assigning ratings to website comments', () => {
  assert.deepEqual(filterReviews(rows, { rating: 'unrated' }).map(row => row.id), ['2']);
  assert.deepEqual(filterReviews(rows, { rating: '5' }).map(row => row.id), ['1']);
  assert.deepEqual(filterReviews(rows, { app: 'one', platform: 'apple' }).map(row => row.id), ['3']);
  assert.deepEqual(filterReviews(rows, { issues: 'issues' }).map(row => row.id), ['2', '3']);
  assert.deepEqual(filterReviews(rows, { sort: 'rating-asc' }).map(row => row.id), ['3', '1', '2']);
  assert.deepEqual(filterReviews(rows, { query: '浪浪' }, { one: '浪浪地圖' }).map(row => row.id), ['3', '1']);
});
test('community collection follows cursors, deduplicates and retains only public comment fields', async () => {
  const calls = [];
  const response = (id, nextCursor) => ({ ok: true, json: async () => ({ success: true, commentCount: 2, nextCursor, comments: [{ id, nickname: 'Hank', content: 'public', createdAt: '2026-09-01T00:00:00Z', visitor_hash: 'never-publish' }] }) });
  const data = await loadCommunityReviews(['one'], async url => { calls.push(url); return calls.length === 1 ? response('2', '2') : response('1', null); });
  assert.equal(calls.length, 2); assert.ok(calls[1].endsWith('?before=2'));
  assert.equal(data.items.length, 2); assert.equal(data.items[0].rating, null);
  assert.equal(data.failures.length, 0); assert.equal(data.partial.length, 0);
  assert.ok(!JSON.stringify(data.items).includes('never-publish'));
});
test('a failed APP source remains a failed source, not a confirmed zero count', async () => {
  const data = await loadCommunityReviews(['one'], async () => ({ ok: false, status: 503 }));
  assert.deepEqual(data.failures, ['one']); assert.equal(data.totals.one, undefined);
});
test('repeated cursors and legacy fifty-comment caps are explicitly incomplete', async () => {
  const row = { id: '2', nickname: 'A', content: 'hello', createdAt: '2026-09-01' };
  const data = await loadCommunityReviews(['one'], async () => ({ ok: true, json: async () => ({ success: true, commentCount: 100, comments: [row], nextCursor: '2' }) }));
  assert.deepEqual(data.failures, ['one']); assert.equal(data.items.length, 1);
  const partial = await loadCommunityReviews(['two'], async () => ({ ok: true, json: async () => ({ success: true, commentCount: 100, comments: [row] }) }));
  assert.deepEqual(partial.partial, ['two']);
});
test('store normalization allowlists public text and keeps real rating/date', () => {
  const google = normalizedReviews({ reviews: [{ reviewId: 'r', authorName: 'A', token: 'secret', comments: [{ userComment: { text: 'hello', starRating: 4, lastModified: { seconds: '1788220800' }, appVersionName: '1.2', deviceMetadata: 'private' } }] }] }, 'google', 'one');
  assert.equal(google.length, 1); assert.equal(google[0].rating, 4); assert.equal(google[0].version, '1.2');
  assert.ok(!JSON.stringify(google).includes('secret')); assert.ok(!JSON.stringify(google).includes('private'));
  const apple = normalizedReviews({ data: [{ id: 'a', attributes: { reviewerNickname: 'B', body: 'nice', rating: 5, createdDate: '2026-09-01T00:00:00Z' } }] }, 'apple', 'one');
  assert.equal(apple[0].rating, 5);
  assert.equal(mergeReviewItems([...google, ...apple, { ...google[0], body: 'updated' }]).find(row => row.id === 'r').body, 'updated');
});
