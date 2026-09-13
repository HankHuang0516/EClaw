import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportModel, revenueIdentityMap } from './report-model.mjs';
const appId = 'ca-app-pub-7927361926882871~123';
const catalog = { apps: [{ communityId: 'one', name: 'One', category: 'Life', googlePackage: 'app.one', iosId: '101' }, { communityId: 'new', name: 'New', category: 'Games', googlePackage: 'app.new' }] };
function fixture() {
  return { catalog, generatedAt: '2026-09-08T01:00:00Z', end: '2026-09-07', identities: { '123': 'one' },
    inventory: [{ appId, platform: 'IOS' }],
    history: {
      apple: { points: [{ id: 'one', date: '2026-09-01', value: 2 }], days: ['2026-09-01'], unmapped: [] },
      google: { installs: [{ id: 'one', date: '2026-09-01', value: 0 }], ratings: [], stability: [], unmapped: [] },
      googleVitals: { points: [], unmapped: [] },
      revenue: { currency: 'TWD', days: ['2026-09-01'], rows: [{ date: '2026-09-01', appId, platform: 'IOS', micros: 123456 }] },
    },
  };
}
test('model includes new catalog apps with unknown rather than fabricated zero metrics', () => {
  const result = buildReportModel(fixture());
  assert.equal(result.apps.length, 2);
  const fresh = result.apps.find(app => app.id === 'new');
  assert.equal(fresh.googleInstalls.historyTotal, null);
  assert.equal(fresh.admobRevenue.historyTotal, null);
  assert.equal(result.totals.admobRevenue.historyTotal, 0.123456);
  assert.equal(result.apps.find(app => app.id === 'one').googleInstalls.historyTotal, 0);
  assert.equal(result.totals.appleDownloads.last7.complete, false);
  assert.equal(result.totals.googleInstalls.last7.expectedAppDays, 14);
  assert.equal(result.totals.googleInstalls.last7.observedAppDays, 1);
  assert.equal(result.totals.googleInstalls.last7.complete, false);
});
test('unknown legacy revenue is retained and explicitly unallocated', () => {
  const input = fixture(); input.identities = {};
  const result = buildReportModel(input);
  assert.equal(result.totals.admobRevenue.historyTotal, result.totals.unallocatedRevenue.historyTotal);
  assert.equal(result.coverage.unallocatedAdmobAppCount, 1);
  assert.equal(result.apps.find(app => app.id === 'one').admobRevenue.historyTotal, null);
});
test('linked exact store identity supports new apps without fuzzy matching', () => {
  const map = revenueIdentityMap([{ appId, platform: 'ANDROID', linkedAppInfo: { appStoreId: 'app.new' } }], catalog, {});
  assert.equal(map.get(appId).id, 'new');
  assert.throws(() => revenueIdentityMap([{ appId, platform: 'ANDROID', linkedAppInfo: { appStoreId: 'app.new' } }], catalog, { '123': 'one' }), /conflicts/);
});
test('model blocks currency, publisher and platform identity mismatches', () => {
  const currency = fixture(); currency.history.revenue.currency = 'USD';
  assert.throws(() => buildReportModel(currency), /TWD/);
  const platform = fixture(); platform.history.revenue.rows[0].platform = 'ANDROID';
  assert.throws(() => buildReportModel(platform), /platform mismatch/);
  const publisher = fixture(); publisher.inventory[0].appId = 'ca-app-pub-other~123';
  assert.throws(() => buildReportModel(publisher), /provenance/);
});
test('frozen build is reproducible and does not turn absent stability into money or zero', () => {
  assert.deepEqual(buildReportModel(fixture()), buildReportModel(fixture()));
  const result = buildReportModel(fixture());
  assert.equal(result.units.crashes, 'legacy-events');
  assert.equal(result.units.crashRate, 'percent-of-distinct-users');
  assert.equal(result.units.anrRate, 'percent-of-distinct-users');
  assert.equal(result.totals.crashes.historyTotal, null);
  assert.equal(result.totals.anrs.historyTotal, null);
  assert.equal(result.totals.crashRate.historyMax, null);
  assert.equal(result.totals.anrRate.historyMax, null);
});
