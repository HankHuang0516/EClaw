import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodeReport, parseDelimited, numeric, isoDate, daysBetween, normalizeAdmob, selectSnapshots, mergeAdmobSnapshots, sumKnown, fingerprint } from './report-core.mjs';

const app = 'ca-app-pub-7927361926882871~2333927943';
function stream(start = 1, end = 2, values = [[1, 10]]) {
  return [
    { header: { dateRange: { startDate: { year: 2026, month: 9, day: start }, endDate: { year: 2026, month: 9, day: end } }, localizationSettings: { currencyCode: 'TWD' } } },
    ...values.map(([day, micros]) => ({ row: { dimensionValues: { DATE: { value: `202609${String(day).padStart(2, '0')}` }, APP: { value: app } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: String(micros) } } } })),
    { footer: { matchingRowCount: String(values.length) } },
  ];
}

test('CSV and TSV handle BOM, CRLF, quoted delimiters, escaped quotes and newlines', () => {
  assert.deepEqual(parseDelimited('\uFEFFname,value\r\n"a,b","one\r\ntwo"\r\n"a""b",0\r\n', ','), [{ name: 'a,b', value: 'one\ntwo' }, { name: 'a"b', value: '0' }]);
  assert.deepEqual(parseDelimited('a\tb\n"x\ty"\t\n', '\t'), [{ a: 'x\ty', b: '' }]);
});
test('malformed and truncated delimited reports fail closed', () => {
  for (const s of ['', 'a,a\n1,2', 'a,b\n1', 'a,b\n"open,2', 'a,b\n"x"junk,2']) assert.throws(() => parseDelimited(s, ','));
});
test('compressed and plain UTF reports canonicalize identically', () => {
  const text = 'a\tb\n1\t2\n';
  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]);
  const expected = parseDelimited(text, '\t');
  for (const bytes of [Buffer.from(text), gzipSync(Buffer.from(text)), utf16, gzipSync(utf16)]) assert.deepEqual(parseDelimited(decodeReport(bytes), '\t'), expected);
  assert.throws(() => decodeReport(Buffer.from([0xc0, 0xc0])));
});
test('missing numbers stay null; explicit zero and negative refunds survive', () => {
  assert.equal(numeric(''), null); assert.equal(numeric(undefined), null);
  assert.equal(numeric('0'), 0); assert.equal(numeric('-2'), -2); assert.equal(numeric('1,234'), 1234);
  for (const value of ['NaN', 'Infinity', '1,2', '0x10', '9007199254740992']) assert.throws(() => numeric(value));
  assert.throws(() => numeric('1.5', { integer: true }));
  assert.equal(sumKnown([null, undefined]), null); assert.equal(sumKnown([null, 0]), 0);
});
test('dates reject rollover, malformed ranges, and invalid leap days', () => {
  assert.equal(isoDate('20260901'), '2026-09-01'); assert.equal(isoDate('09/01/2026'), '2026-09-01');
  assert.deepEqual(daysBetween('2024-02-28', '2024-03-01'), ['2024-02-28', '2024-02-29', '2024-03-01']);
  for (const value of ['2026-02-29', '2026-09-31', '', '2026-13-01']) assert.throws(() => isoDate(value));
  assert.throws(() => daysBetween('2026-09-02', '2026-09-01'));
});
test('AdMob array, pretty JSON, legacy wrapper and NDJSON normalize identically', () => {
  const raw = stream(); const expected = normalizeAdmob(raw);
  for (const format of [JSON.stringify(raw, null, 2), { rows: raw }, raw.map(x => JSON.stringify(x)).join('\n')]) assert.deepEqual(normalizeAdmob(format), expected);
});
test('AdMob prevents publisher contamination, currency omission and row loss', () => {
  assert.throws(() => normalizeAdmob({ publisherId: 'pub-other', rows: stream() }), /publisher/);
  assert.throws(() => normalizeAdmob(JSON.stringify(stream()).replace('7927361926882871', '0000000000000000')), /publisher/);
  const noCurrency = stream(); delete noCurrency[0].header.localizationSettings;
  assert.throws(() => normalizeAdmob(noCurrency), /currency/);
  assert.throws(() => normalizeAdmob(stream().slice(0, -1)), /Incomplete/);
  const truncated = stream(); truncated.at(-1).footer.matchingRowCount = '2';
  assert.throws(() => normalizeAdmob(truncated), /Truncated/);
  const warning = stream(); warning.at(-1).footer.warnings = [{ type: 'DATA_BEFORE_ACCOUNT_TIMEZONE_CHANGE' }];
  assert.throws(() => normalizeAdmob(warning), /warnings/);
});
test('real AdMob platform spellings normalize without losing platform identity', () => {
  for (const [value, expected] of [['Android', 'ANDROID'], ['iOS', 'IOS'], ['ANDROID', 'ANDROID'], ['IOS', 'IOS']]) {
    const raw = stream(); raw[1].row.dimensionValues.PLATFORM = { value };
    assert.equal(normalizeAdmob(raw).rows[0].platform, expected);
  }
});
test('duplicate AdMob rows, incompatible ranges and missing earnings fail closed', () => {
  assert.throws(() => normalizeAdmob(stream(1, 2, [[1, 1], [1, 1]])), /Duplicate/);
  assert.throws(() => normalizeAdmob(stream(1, 2, [[3, 1]])), /outside/);
  const missing = stream(); delete missing[1].row.metricValues.ESTIMATED_EARNINGS;
  assert.throws(() => normalizeAdmob(missing), /Missing/);
  assert.throws(() => normalizeAdmob({ range: { start: '2026-09-02', end: '2026-09-02' }, rows: stream() }), /range/);
});
test('overlapping Google snapshots replace rather than add; input order is irrelevant', () => {
  const old = { key: 'installs|app|202609', rank: 1, value: [{ date: '2026-09-01', value: 10 }] };
  const fresh = { ...old, rank: 2, value: [{ date: '2026-09-01', value: 12 }] };
  for (const items of [[old, fresh], [fresh, old], [old, fresh, fresh]]) assert.deepEqual(selectSnapshots(items).selected, [fresh]);
  assert.throws(() => selectSnapshots([old, { ...fresh, rank: 1 }]), /Conflicting/);
});
test('Apple compressed/original logical duplicates count once without deduplicating legitimate source rows', () => {
  const rows = parseDelimited('Apple Identifier\tUnits\n1\t2\n1\t2\n', '\t');
  const a = { key: 'apple|2026-09-01', rank: 1, value: rows };
  const result = selectSnapshots([a, { ...a, rank: 2 }]);
  assert.equal(result.selected.length, 1); assert.equal(result.duplicateCount, 1);
  assert.equal(sumKnown(result.selected[0].value.map(r => numeric(r.Units))), 4);
});
test('AdMob merges all history, replacing complete overlapping day partitions', () => {
  const a = { report: normalizeAdmob(stream(1, 2, [[1, 100], [2, 200]])), rank: 1 };
  const b = { report: normalizeAdmob(stream(2, 3, [[2, 250], [3, 300]])), rank: 2 };
  const expected = mergeAdmobSnapshots([a, b]);
  assert.deepEqual(expected.rows.map(r => r.micros), [100, 250, 300]);
  assert.deepEqual(mergeAdmobSnapshots([b, a]).rows, expected.rows);
  const empty = { report: normalizeAdmob(stream(2, 2, [])), rank: 3 };
  assert.deepEqual(mergeAdmobSnapshots([a, b, empty]).rows.map(r => r.micros), [100, 300]);
});
test('mixed currencies and same-time contradictory history are rejected', () => {
  const report = normalizeAdmob(stream());
  assert.throws(() => mergeAdmobSnapshots([{ report, rank: 1 }, { report: { ...report, currency: 'USD' }, rank: 2 }]), /currencies/);
  assert.throws(() => mergeAdmobSnapshots([{ report, rank: 1 }, { report: normalizeAdmob(stream(1, 2, [[1, 11]])), rank: 1 }]), /Conflicting/);
});
test('20 deterministic replays cannot inflate totals or depend on key order', () => {
  const snapshots = [1, 2, 3].map(rank => ({ report: normalizeAdmob(stream(1, 2, [[1, rank], [2, rank * 2]])), rank }));
  const hash = fingerprint(mergeAdmobSnapshots(snapshots).rows);
  for (let i = 0; i < 20; i++) {
    const replay = [...snapshots.slice(i % 3), ...snapshots.slice(0, i % 3), ...snapshots];
    assert.equal(fingerprint(mergeAdmobSnapshots(replay).rows), hash);
  }
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
});
