import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticGranularity, chartBuckets, combinedAcquisition, formatValue, missingReason, sortApps } from '../reports/report-view.mjs';
const app = (id, points) => ({ id, name: id, googleInstalls: { points, historyTotal: points.length ? points.reduce((sum, p) => sum + (p.value || 0), 0) : null } });
test('view distinguishes unknown, zero and small revenue without dollar stability units', () => {
  assert.equal(formatValue(null, 'crashRate'), '官方資料待補');
  assert.equal(formatValue(0, 'crashRate'), '0%');
  assert.ok(formatValue(0.000001, 'admobRevenue').includes('0.0001'));
  assert.ok(!formatValue(1, 'crashRate').includes('$'));
});
test('chart preserves missing calendar buckets instead of drawing fabricated zero', () => {
  const buckets = chartBuckets([app('one', [{ date: '2026-09-01', value: 0 }, { date: '2026-09-03', value: 4 }])], 'googleInstalls', 'day', '2026-09-01', '2026-09-03');
  assert.deepEqual(buckets.map(bucket => bucket.values[0].value), [0, null, 4]);
});
test('monthly/yearly chart exposes incomplete observed coverage including leap years', () => {
  const apps = [app('one', [{ date: '2024-02-29', value: 2 }])];
  assert.equal(chartBuckets(apps, 'googleInstalls', 'month', '2024-02-01', '2024-02-29')[0].values[0].expectedDays, 29);
  const point = chartBuckets(apps, 'googleInstalls', 'year', '2024-01-01', '2024-12-31')[0].values[0];
  assert.equal(point.expectedDays, 366); assert.equal(point.coveredDays, 1); assert.equal(point.value, 2);
});
test('automatic granularity follows the visible zoom range', () => {
  assert.equal(automaticGranularity('2026-09-01', '2026-09-30'), 'day');
  assert.equal(automaticGranularity('2026-01-01', '2026-04-30'), 'week');
  assert.equal(automaticGranularity('2025-01-01', '2026-09-10'), 'month');
  assert.equal(automaticGranularity('2020-01-01', '2026-09-10'), 'year');
});
test('cumulative chart keeps an observed running total without inventing missing daily values', () => {
  const buckets = chartBuckets([app('one', [{ date: '2026-09-01', value: 2 }, { date: '2026-09-03', value: 4 }])], 'googleInstalls', 'day', '2026-09-01', '2026-09-03', { cumulative: true });
  assert.deepEqual(buckets.map(bucket => bucket.values[0].value), [2, 2, 6]);
  assert.deepEqual(buckets.map(bucket => bucket.values[0].coveredDays), [1, 0, 1]);
});
test('zoomed cumulative totals retain earlier history and remain separate for each APP', () => {
  const apps = [
    app('one', [{ date: '2026-08-31', value: 10 }, { date: '2026-09-02', value: 3 }]),
    app('two', [{ date: '2026-09-01', value: 5 }, { date: '2026-09-03', value: 2 }]),
    app('unknown', []),
  ];
  const buckets = chartBuckets(apps, 'googleInstalls', 'day', '2026-09-02', '2026-09-03', { cumulative: true });
  assert.deepEqual(buckets.map(bucket => bucket.values.map(value => value.value)), [[13, 5, null], [13, 7, null]]);
  assert.deepEqual(buckets.map(bucket => bucket.values.map(value => value.coveredDays)), [[1, 0, 0], [0, 1, 0]]);
});
test('quarter zoom uses calendar quarters and period-end cumulative totals', () => {
  assert.equal(automaticGranularity('2023-01-01', '2026-09-15'), 'quarter');
  const apps = [app('one', [{ date: '2026-03-31', value: 2 }, { date: '2026-04-01', value: 3 }])];
  const buckets = chartBuckets(apps, 'googleInstalls', 'quarter', '2026-03-31', '2026-04-01', { cumulative: true });
  assert.deepEqual(buckets.map(bucket => [bucket.label, bucket.values[0].value]), [['2026 Q1', 2], ['2026 Q2', 5]]);
});
test('missing reasons distinguish unsupported platforms from delayed reports', () => {
  const androidOnly = { platforms: { google: true, apple: false } };
  assert.equal(missingReason(androidOnly, 'appleDownloads'), '不適用');
  assert.equal(missingReason(androidOnly, 'googleInstalls'), '官方報表尚未涵蓋');
  assert.equal(missingReason(androidOnly, 'crashRate'), '樣本量不足，Google 尚未提供率');
  assert.equal(missingReason(androidOnly, 'rating'), 'Google 評分報表尚未涵蓋');
  assert.equal(missingReason({ platforms: { google: false, apple: true } }, 'rating'), '不適用');
});
test('cross-platform visual total combines only observed source rows', () => {
  const value = combinedAcquisition({
    googleInstalls: { points: [{ date: '2026-09-01', value: 2 }] },
    appleDownloads: { points: [{ date: '2026-09-01', value: 3 }, { date: '2026-09-02', value: 1 }] },
  });
  assert.deepEqual(value.points, [{ date: '2026-09-01', value: 5 }, { date: '2026-09-02', value: 1 }]);
});
test('every numeric sort keeps unknown last in both directions', () => {
  const apps = [app('missing', []), app('zero', [{ date: '2026-09-01', value: 0 }]), app('two', [{ date: '2026-09-01', value: 2 }])];
  assert.deepEqual(sortApps(apps, 'googleInstalls', 'asc').map(app => app.id), ['zero', 'two', 'missing']);
  assert.deepEqual(sortApps(apps, 'googleInstalls', 'desc').map(app => app.id), ['two', 'zero', 'missing']);
});
