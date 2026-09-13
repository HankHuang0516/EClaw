import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateApple, aggregateGoogle, aggregateGoogleVitals, catalogIndex, periodTotal } from './store-history.mjs';
import { fingerprint } from './report-core.mjs';

const catalog = { apps: [
  { communityId: 'one', name: 'One', category: 'Games', googlePackage: 'app.one', iosId: '101' },
  { communityId: 'two', name: 'Two', category: 'Life', googlePackage: 'app.two', iosId: '102' },
] };
const appleRow = (units = '2', type = '1F', appleId = '101') => ({
  'Apple Identifier': appleId, 'Product Type Identifier': type, Units: units,
  'Begin Date': '09/01/2026', 'End Date': '09/01/2026', 'Parent Identifier': '',
});
const appleSnapshot = (rows, rank = 1) => ({ date: '2026-09-01', rank, rows });
const googleRow = value => ({ Date: '2026-09-01', 'Package name': 'app.one', 'Daily User Installs': value });
const googleSnapshot = (rows, rank = 1) => ({ kind: 'installs', package: 'app.one', month: '2026-09', rank, rows });

test('catalog maps exact stable IDs and rejects ambiguous identities', () => {
  assert.equal(catalogIndex(catalog).apple.get('101'), 'one');
  assert.throws(() => catalogIndex({ apps: [...catalog.apps, catalog.apps[0]] }), /duplicate/);
  assert.throws(() => catalogIndex({ apps: [catalog.apps[0], { ...catalog.apps[1], iosId: '101' }] }), /multiple/);
});
test('Apple deduplicates whole reports without dropping repeated legitimate rows', () => {
  const snapshot = appleSnapshot([appleRow(), appleRow(), appleRow('-1')]);
  const result = aggregateApple([snapshot, structuredClone(snapshot)], catalog);
  assert.equal(result.duplicateCount, 1);
  assert.deepEqual(result.points, [{ id: 'one', date: '2026-09-01', value: 3 }, { id: 'two', date: '2026-09-01', value: 0 }]);
});
test('Apple updates, redownloads and IAP do not inflate first downloads', () => {
  const result = aggregateApple([appleSnapshot([appleRow(), appleRow('99', '7'), appleRow('99', '3'), appleRow('99', 'IA1'), { ...appleRow('99'), 'Parent Identifier': 'parent' }])], catalog);
  assert.equal(result.points[0].value, 2);
  assert.equal(result.excludedRows, 4);
});
test('Apple revised snapshot replaces previous transactions and validates range/units', () => {
  assert.equal(aggregateApple([appleSnapshot([appleRow('8')]), appleSnapshot([appleRow('3')], 2)], catalog).points[0].value, 3);
  assert.throws(() => aggregateApple([appleSnapshot([appleRow('')])], catalog), /Missing Apple/);
  assert.throws(() => aggregateApple([appleSnapshot([{ ...appleRow(), 'End Date': '09/02/2026' }])], catalog), /range/);
});
test('unknown store identities are audited, never fuzzily attributed', () => {
  assert.deepEqual(aggregateApple([appleSnapshot([appleRow('5', '1F', '999')])], catalog).unmapped, ['999']);
  assert.equal(aggregateApple([appleSnapshot([appleRow('5', '1F', '999')])], catalog).points[0].value, 0);
});
test('Google newer monthly snapshot replaces deleted as well as updated rows', () => {
  const old = googleSnapshot([googleRow('10'), { ...googleRow('20'), Date: '2026-09-02' }]);
  const fresh = googleSnapshot([googleRow('3')], 2);
  const result = aggregateGoogle([old, fresh, fresh], catalog);
  assert.deepEqual(result.installs, [{ id: 'one', date: '2026-09-01', value: 3 }]);
  assert.equal(fingerprint(result), fingerprint(aggregateGoogle([fresh, old, fresh], catalog)));
});
test('Google missing metric stays null and device installs never substitute', () => {
  assert.equal(aggregateGoogle([googleSnapshot([googleRow('')])], catalog).installs[0].value, null);
  const wrong = { ...googleRow(''), 'Daily Device Installs': '40' }; delete wrong['Daily User Installs'];
  assert.throws(() => aggregateGoogle([googleSnapshot([wrong])], catalog), /Daily User Installs/);
});
test('Google rejects duplicate dates, wrong month and wrong package', () => {
  for (const rows of [[googleRow('2'), googleRow('3')], [{ ...googleRow('1'), Date: '2026-08-31' }], [{ ...googleRow('1'), 'Package name': 'app.other' }]]) {
    assert.throws(() => aggregateGoogle([googleSnapshot(rows)], catalog), /Google/);
  }
});
test('stability preserves separate count units and unknown values', () => {
  const snapshot = { ...googleSnapshot([{ Date: '2026-09-01', 'Package Name': 'app.one', 'Daily Crashes': '0', 'Daily ANRs': '' }]), kind: 'crashes' };
  assert.deepEqual(aggregateGoogle([snapshot], catalog).stability, [{ id: 'one', date: '2026-09-01', crashes: 0, anrs: null }]);
});
test('vitals rates keep crash and ANR separate and prefer the newest snapshot', () => {
  const row = (metric, value) => ({ startTime: { year: 2026, month: 9, day: 1 }, metrics: [{ metric, decimalValue: { value } }] });
  const snapshots = [
    { rank: 1, from: '2026-09-01', to: '2026-09-01', id: 'one', package: 'app.one', type: 'crash', response: { rows: [row('crashRate', '0.20')] } },
    { rank: 2, from: '2026-09-01', to: '2026-09-01', id: 'one', package: 'app.one', type: 'crash', response: { rows: [row('crashRate', '0.10')] } },
    { rank: 2, from: '2026-09-01', to: '2026-09-01', id: 'one', package: 'app.one', type: 'anr', response: { rows: [row('anrRate', '0.05')] } },
  ];
  assert.deepEqual(aggregateGoogleVitals(snapshots, catalog).points, [
    { id: 'one', date: '2026-09-01', type: 'anr', value: 0.05 },
    { id: 'one', date: '2026-09-01', type: 'crash', value: 0.1 },
  ]);
});
test('period summaries distinguish missing, zero and partial coverage', () => {
  assert.deepEqual(periodTotal([], '2026-09-01', '2026-09-02'), { value: null, coveredDays: 0, expectedDays: 2, complete: false });
  assert.deepEqual(periodTotal([{ date: '2026-09-01', value: 0 }], '2026-09-01', '2026-09-02'), { value: 0, coveredDays: 1, expectedDays: 2, complete: false });
  assert.equal(periodTotal([{ date: '2026-09-01', value: 0 }], '2026-09-01', '2026-09-01').complete, true);
  assert.throws(() => periodTotal([{ date: '2026-09-01', value: 1 }, { date: '2026-09-01', value: 1 }], '2026-09-01', '2026-09-02'), /Duplicate/);
});
