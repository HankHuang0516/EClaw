import { INITIAL_APP_TYPES, isoDate, numeric, selectSnapshots, sumKnown } from './report-core.mjs';

export function catalogIndex(catalog) {
  if (!Array.isArray(catalog?.apps) || !catalog.apps.length) throw new Error('Missing portfolio catalog');
  const ids = new Set(), google = new Map(), apple = new Map();
  for (const app of catalog.apps) {
    if (!app.communityId || !app.name || !app.category || ids.has(app.communityId)) throw new Error('Invalid or duplicate catalog identity');
    ids.add(app.communityId);
    for (const [map, key] of [[google, app.googlePackage], [apple, app.iosId]]) {
      if (!key) continue;
      if (map.has(String(key))) throw new Error('Store identity assigned to multiple apps');
      map.set(String(key), app.communityId);
    }
  }
  return { ids, google, apple };
}

function required(row, columns) {
  for (const name of columns) if (!(name in row)) throw new Error(`Missing required column: ${name}`);
}

// One complete daily sales file is one logical snapshot. Keep every legitimate
// transaction row inside it, including repeated territory/device rows and refunds.
export function aggregateApple(snapshots, catalog) {
  const index = catalogIndex(catalog);
  const selected = selectSnapshots(snapshots.map(snapshot => ({
    key: isoDate(snapshot.date), rank: snapshot.rank, value: snapshot.rows,
  })));
  const points = [], unmapped = new Set();
  let excludedRows = 0;
  for (const snapshot of selected.selected) {
    const totals = new Map([...index.apple.values()].map(id => [id, 0]));
    for (const row of snapshot.value) {
      required(row, ['Apple Identifier', 'Product Type Identifier', 'Units', 'Begin Date', 'End Date']);
      if (isoDate(row['Begin Date']) !== snapshot.key || isoDate(row['End Date']) !== snapshot.key) throw new Error('Apple daily report range mismatch');
      if (!INITIAL_APP_TYPES.has(row['Product Type Identifier']) || row['Parent Identifier']?.trim()) { excludedRows++; continue; }
      const units = numeric(row.Units, { integer: true });
      if (units === null) throw new Error('Missing Apple download units');
      const id = index.apple.get(String(row['Apple Identifier']));
      if (!id) { unmapped.add(String(row['Apple Identifier'])); continue; }
      totals.set(id, sumKnown([totals.get(id), units]));
    }
    for (const [id, value] of totals) points.push({ id, date: snapshot.key, value });
  }
  return { points, days: selected.selected.map(x => x.key), duplicateCount: selected.duplicateCount, excludedRows, unmapped: [...unmapped].sort() };
}

// Google overview files are complete per-package/month snapshots, not increments.
// Only explicitly present date rows establish coverage. Device installs and
// install events must never substitute for daily user installs.
export function aggregateGoogle(snapshots, catalog) {
  const index = catalogIndex(catalog);
  const selected = selectSnapshots(snapshots.map(snapshot => {
    if (!['installs', 'crashes', 'ratings'].includes(snapshot.kind) || !snapshot.package || !/^\d{4}-(0[1-9]|1[0-2])$/.test(snapshot.month)) throw new Error('Invalid Google snapshot identity');
    return { key: `${snapshot.kind}|${snapshot.package}|${snapshot.month}`, rank: snapshot.rank, value: snapshot.rows };
  }));
  const installs = [], stability = [], ratings = [], unmapped = new Set();
  for (const snapshot of selected.selected) {
    const [kind, packageName, month] = snapshot.key.split('|');
    const id = index.google.get(packageName), dates = new Set();
    if (!id) unmapped.add(packageName);
    for (const row of snapshot.value) {
      required(row, ['Date']);
      const date = isoDate(row.Date);
      if (!date.startsWith(`${month}-`) || dates.has(date)) throw new Error('Google duplicate or out-of-month date');
      dates.add(date);
      const reportedPackage = row['Package name'] ?? row['Package Name'];
      if (reportedPackage !== packageName) throw new Error('Google package provenance mismatch');
      if (kind === 'installs') {
        required(row, ['Daily User Installs']);
        const value = numeric(row['Daily User Installs'], { integer: true });
        if (value !== null && value < 0) throw new Error('Negative Google user installs');
        if (id) installs.push({ id, date, value });
      } else if (kind === 'crashes') {
        required(row, ['Daily Crashes', 'Daily ANRs']);
        const crashes = numeric(row['Daily Crashes'], { integer: true });
        const anrs = numeric(row['Daily ANRs'], { integer: true });
        if ([crashes, anrs].some(x => x !== null && x < 0)) throw new Error('Negative stability events');
        if (id) stability.push({ id, date, crashes, anrs });
      } else {
        required(row, ['Total Average Rating']);
        const value = numeric(row['Total Average Rating']);
        if (value !== null && (value < 0 || value > 5)) throw new Error('Invalid Google rating');
        if (id) ratings.push({ id, date, value });
      }
    }
  }
  const sort = values => values.sort((a, b) => a.id.localeCompare(b.id) || a.date.localeCompare(b.date));
  return { installs: sort(installs), stability: sort(stability), ratings: sort(ratings), duplicateCount: selected.duplicateCount, unmapped: [...unmapped].sort() };
}

function vitalsDate(row) {
  const value = row.startTime || row.start_time;
  if (!value) throw new Error('Google vitals row missing start time');
  if (typeof value === 'string') return isoDate(value.slice(0, 10));
  const year = Number(value.year), month = Number(value.month), day = Number(value.day);
  return isoDate(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}

function vitalsValue(row, type) {
  const expected = `${type}Rate`;
  const metric = (row.metrics || []).find(item => item.metric === expected);
  if (!metric) throw new Error(`Google vitals row missing ${expected}`);
  const raw = metric.decimalValue?.value ?? metric.decimalValue ?? metric.decimal_value?.value ?? metric.decimal_value;
  const value = numeric(raw);
  if (value === null || value < 0) throw new Error('Invalid Google vitals rate');
  return value;
}

export function aggregateGoogleVitals(snapshots, catalog) {
  const index = catalogIndex(catalog), candidates = [], unmapped = new Set();
  for (const snapshot of snapshots) {
    if (!['crash', 'anr'].includes(snapshot.type) || !snapshot.package || !Number.isFinite(snapshot.rank)) throw new Error('Invalid Google vitals snapshot identity');
    const id = index.google.get(snapshot.package);
    if (!id) unmapped.add(snapshot.package);
    const dates = new Set();
    for (const row of snapshot.response?.rows || []) {
      const date = vitalsDate(row);
      if (dates.has(date) || date < snapshot.from || date > snapshot.to) throw new Error('Google vitals duplicate or out-of-range date');
      dates.add(date);
      if (id) candidates.push({ key: `${snapshot.type}|${id}|${date}`, rank: snapshot.rank, value: { id, type: snapshot.type, date, value: vitalsValue(row, snapshot.type) } });
    }
  }
  const selected = selectSnapshots(candidates);
  return { points: selected.selected.map(item => item.value).sort((a, b) => a.id.localeCompare(b.id) || a.type.localeCompare(b.type) || a.date.localeCompare(b.date)), duplicateCount: selected.duplicateCount, unmapped: [...unmapped].sort() };
}

export function periodTotal(points, start, end) {
  start = isoDate(start); end = isoDate(end);
  if (start > end) throw new Error('Reversed aggregate period');
  const present = points.filter(point => point.date >= start && point.date <= end);
  if (new Set(present.map(point => point.date)).size !== present.length) throw new Error('Duplicate app date in aggregate');
  const value = sumKnown(present.map(point => point.value));
  const coveredDays = present.filter(point => point.value !== null && point.value !== undefined).length;
  const expectedDays = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  return { value, coveredDays, expectedDays, complete: coveredDays === expectedDays };
}
