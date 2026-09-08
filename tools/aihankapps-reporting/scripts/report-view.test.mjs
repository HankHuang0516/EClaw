import test from 'node:test';
import assert from 'node:assert/strict';
import { chartBuckets, formatValue, sortApps } from '../reports/report-view.mjs';
const app = (id, points) => ({ id, name: id, googleInstalls: { points, historyTotal: points.length ? points.reduce((sum, p) => sum + (p.value || 0), 0) : null } });
test('view distinguishes unknown, zero and small revenue without dollar stability units', () => {
  assert.equal(formatValue(null, 'crashes'), '未取得');
  assert.equal(formatValue(0, 'crashes'), '0');
  assert.ok(formatValue(0.000001, 'admobRevenue').includes('0.0001'));
  assert.ok(!formatValue(1, 'crashes').includes('$'));
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
test('every numeric sort keeps unknown last in both directions', () => {
  const apps = [app('missing', []), app('zero', [{ date: '2026-09-01', value: 0 }]), app('two', [{ date: '2026-09-01', value: 2 }])];
  assert.deepEqual(sortApps(apps, 'googleInstalls', 'asc').map(app => app.id), ['zero', 'two', 'missing']);
  assert.deepEqual(sortApps(apps, 'googleInstalls', 'desc').map(app => app.id), ['two', 'zero', 'missing']);
});
