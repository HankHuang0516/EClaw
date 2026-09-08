import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const EXPECTED_PUBLISHER = 'pub-7927361926882871';
export const INITIAL_APP_TYPES = new Set(['1', '1F', '1T', '1E', '1EP', '1EU', 'F1']);

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function decodeReport(input) {
  let bytes = Buffer.from(input);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    bytes = Buffer.from(bytes.subarray(2));
    if (bytes.length % 2) throw new Error('Truncated UTF-16 report');
    return bytes.swap16().toString('utf16le');
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    if (bytes.length % 2) throw new Error('Truncated UTF-16 report');
    return bytes.subarray(2).toString('utf16le');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
}

export function parseDelimited(text, delimiter) {
  if (![',', '\t'].includes(delimiter)) throw new Error('Unsupported delimiter');
  const rows = [];
  let row = [], cell = '', quoted = false, closed = false;
  const pushCell = () => { row.push(cell); cell = ''; closed = false; };
  const pushRow = () => { pushCell(); if (row.some(v => v !== '')) rows.push(row); row = []; };
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === delimiter) pushCell();
    else if (c === '\n') pushRow();
    else if (c === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new Error('Malformed quoted field');
      cell += c;
    }
  }
  if (quoted) throw new Error('Unterminated quoted field');
  if (cell || closed || row.length) pushRow();
  if (!rows.length) throw new Error('Empty report without headers');
  const headers = rows.shift().map(v => v.trim());
  if (headers.some(h => !h) || new Set(headers).size !== headers.length) throw new Error('Missing or duplicate columns');
  return rows.map(values => {
    if (values.length !== headers.length) throw new Error('Report column count mismatch');
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  });
}

export function numeric(value, { integer = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) throw new Error('Invalid numeric value');
  const number = Number(text.replaceAll(',', ''));
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(number))) throw new Error('Unsafe numeric value');
  return number;
}

export function isoDate(value) {
  let text = String(value ?? '').trim();
  if (/^\d{8}$/.test(text)) text = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`;
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) text = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const ymd = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymd) text = `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text + 'T00:00:00Z')) || new Date(text + 'T00:00:00Z').toISOString().slice(0, 10) !== text) throw new Error('Invalid calendar date');
  return text;
}
export const apiDate = value => isoDate(`${value?.year}-${value?.month}-${value?.day}`);
export function daysBetween(start, end) {
  start = isoDate(start); end = isoDate(end);
  if (start > end) throw new Error('Reversed reporting range');
  const count = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  if (count > 36600) throw new Error('Reporting range too large');
  return Array.from({ length: count }, (_, i) => new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10));
}

export function normalizeAdmob(input, expected = EXPECTED_PUBLISHER) {
  let parsed = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); }
    catch { parsed = input.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  }
  if (parsed?.publisherId && parsed.publisherId !== expected) throw new Error('AdMob publisher mismatch');
  const stream = Array.isArray(parsed) ? parsed : parsed?.rows;
  if (!Array.isArray(stream)) throw new Error('Unsupported AdMob report envelope');
  const headers = stream.filter(x => x?.header);
  const footers = stream.filter(x => x?.footer);
  if (headers.length !== 1 || footers.length !== 1 || stream[0] !== headers[0] || stream.at(-1) !== footers[0]) throw new Error('Incomplete AdMob stream');
  if (stream.some(x => !x || Object.keys(x).length !== 1 || !['header', 'row', 'footer'].includes(Object.keys(x)[0]))) throw new Error('Unexpected AdMob stream record');
  if (footers[0].footer.warnings?.length) throw new Error('AdMob report warnings require review');
  const start = apiDate(headers[0].header.dateRange?.startDate);
  const end = apiDate(headers[0].header.dateRange?.endDate);
  daysBetween(start, end);
  if (parsed?.range && (isoDate(parsed.range.start) !== start || isoDate(parsed.range.end) !== end)) throw new Error('AdMob range mismatch');
  const currency = headers[0].header.localizationSettings?.currencyCode;
  if (!/^[A-Z]{3}$/.test(currency || '')) throw new Error('Missing AdMob currency');
  const seen = new Set();
  const rows = stream.filter(x => x.row).map(({ row }) => {
    const date = isoDate(row.dimensionValues?.DATE?.value);
    const appId = row.dimensionValues?.APP?.value;
    const platformValue = row.dimensionValues?.PLATFORM?.value;
    if (platformValue !== undefined && typeof platformValue !== 'string') throw new Error('Invalid AdMob platform');
    const platform = platformValue ? platformValue.toUpperCase() : null;
    if (typeof appId !== 'string' || !appId.startsWith(`ca-app-${expected}~`) || !/^\d+$/.test(appId.split('~')[1])) throw new Error('AdMob publisher provenance mismatch');
    if (platform && !['ANDROID', 'IOS'].includes(platform)) throw new Error('Unknown AdMob platform');
    if (date < start || date > end) throw new Error('AdMob row outside reporting range');
    const key = `${date}|${appId}`;
    if (seen.has(key)) throw new Error('Duplicate AdMob app/date row');
    seen.add(key);
    const micros = numeric(row.metricValues?.ESTIMATED_EARNINGS?.microsValue, { integer: true });
    if (micros === null) throw new Error('Missing AdMob estimated earnings metric');
    return { date, appId, platform, micros };
  });
  const count = numeric(footers[0].footer.matchingRowCount, { integer: true });
  if (count !== null && count !== rows.length) throw new Error('Truncated AdMob row count');
  return { start, end, currency, rows, collectedAt: parsed?.collectedAt || null };
}

// Snapshots are full logical reports, never additive increments. The caller
// supplies authoritative collection time (or legacy filesystem provenance).
export function selectSnapshots(snapshots) {
  const selected = new Map();
  let duplicateCount = 0;
  for (const item of snapshots) {
    if (!item.key || !Number.isFinite(item.rank)) throw new Error('Snapshot provenance missing');
    const prior = selected.get(item.key);
    if (!prior) { selected.set(item.key, item); continue; }
    if (fingerprint(prior.value) === fingerprint(item.value)) {
      duplicateCount++;
      if (item.rank > prior.rank) selected.set(item.key, item);
    } else if (item.rank === prior.rank) throw new Error('Conflicting snapshots at the same collection time');
    else if (item.rank > prior.rank) selected.set(item.key, item);
  }
  return { selected: [...selected.values()].sort((a, b) => a.key.localeCompare(b.key)), duplicateCount };
}

export function mergeAdmobSnapshots(snapshots) {
  const currencies = new Set(snapshots.map(x => x.report.currency));
  if (currencies.size > 1) throw new Error('Mixed AdMob currencies');
  const partitions = [];
  for (const { report, rank } of snapshots) {
    for (const date of daysBetween(report.start, report.end)) {
      const rows = report.rows.filter(r => r.date === date).sort((a, b) => a.appId.localeCompare(b.appId));
      partitions.push({ key: date, rank, value: rows });
    }
  }
  const result = selectSnapshots(partitions);
  return { currency: [...currencies][0] || null, days: result.selected.map(x => x.key), rows: result.selected.flatMap(x => x.value), duplicateCount: result.duplicateCount };
}

export function sumKnown(values) {
  const present = values.filter(x => x !== null && x !== undefined);
  if (present.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('Invalid aggregate input');
  if (!present.length) return null;
  const total = present.reduce((a, b) => a + b, 0);
  if (Math.abs(total) > Number.MAX_SAFE_INTEGER) throw new Error('Aggregate overflow');
  return total;
}
