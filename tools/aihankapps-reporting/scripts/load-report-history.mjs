import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { decodeReport, parseDelimited, fingerprint, normalizeAdmob, mergeAdmobSnapshots, daysBetween } from './report-core.mjs';
import { aggregateApple, aggregateGoogle } from './store-history.mjs';

async function files(directory) {
  const result = [];
  // A missing required source directory is an ingestion failure, not zero data.
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

async function provenance(path, envelope) {
  if (envelope?.collectedAt) {
    const rank = Date.parse(envelope.collectedAt);
    if (!Number.isFinite(rank)) throw new Error('Invalid historical collection timestamp');
    return { rank, basis: 'collectedAt' };
  }
  const timestamp = path.match(/(\d{4}-\d{2}-\d{2})T(\d{2})[-:](\d{2})[-:](\d{2})[.-](\d{3})Z/);
  if (timestamp) return { rank: Date.parse(`${timestamp[1]}T${timestamp[2]}:${timestamp[3]}:${timestamp[4]}.${timestamp[5]}Z`), basis: 'filename-timestamp' };
  const snapshotDay = path.match(/\/snapshots\/(\d{4}-\d{2}-\d{2})\//)?.[1];
  if (snapshotDay) return { rank: Date.parse(`${snapshotDay}T00:00:00Z`), basis: 'snapshot-directory' };
  return { rank: (await stat(path)).mtimeMs, basis: 'legacy-file-mtime' };
}

function delimited(bytes, delimiter, columns) {
  const text = decodeReport(bytes);
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
  // Retain schema validation even for a legitimately header-only report.
  const header = parseDelimited(`${firstLine}\n${firstLine}\n`, delimiter)[0];
  for (const column of columns) if (!header || !(column in header)) throw new Error(`Historical report missing column: ${column}`);
  return parseDelimited(text, delimiter);
}

export async function loadReportHistory(root, catalog) {
  const apple = [], google = [], admob = [], audit = [];
  const pairedApple = new Map();
  for (const path of await files(join(root, 'app-store/sales'))) {
    const match = path.match(/(\d{4}-\d{2}-\d{2})\.tsv(?:\.gz)?$/);
    if (!match) continue;
    const rows = delimited(await readFile(path), '\t', ['Apple Identifier', 'Product Type Identifier', 'Units', 'Begin Date', 'End Date']);
    const pairKey = path.replace(/\.gz$/, '');
    const digest = fingerprint(rows);
    if (pairedApple.has(pairKey) && pairedApple.get(pairKey) !== digest) throw new Error('Apple compressed/original pair has conflicting contents');
    pairedApple.set(pairKey, digest);
    const source = await provenance(path);
    apple.push({ date: match[1], rank: source.rank, rows });
    audit.push({ source: 'apple', file: path.slice(root.length + 1), ...source, digest });
  }
  for (const path of await files(join(root, 'google-play'))) {
    const match = path.match(/\/(installs|crashes|ratings)_(.+)_(\d{4})(\d{2})_overview\.csv$/);
    if (!match) continue;
    const columns = { installs: ['Daily User Installs'], crashes: ['Daily Crashes', 'Daily ANRs'], ratings: ['Total Average Rating'] }[match[1]];
    const rows = delimited(await readFile(path), ',', ['Date', ...columns]);
    const source = await provenance(path);
    google.push({ kind: match[1], package: match[2], month: `${match[3]}-${match[4]}`, rank: source.rank, rows });
    audit.push({ source: 'google', file: path.slice(root.length + 1), ...source, digest: fingerprint(rows) });
  }
  for (const path of await files(join(root, 'admob'))) {
    if (!path.endsWith('.json')) continue;
    const text = await readFile(path, 'utf8');
    let envelope;
    try { envelope = JSON.parse(text); } catch { envelope = null; }
    const report = normalizeAdmob(envelope || text);
    const source = await provenance(path, envelope);
    admob.push({ report, rank: source.rank });
    audit.push({ source: 'admob', file: path.slice(root.length + 1), ...source, currency: report.currency, digest: fingerprint(report) });
  }
  if (!apple.length || !google.length || !admob.length) throw new Error('Required historical report source is empty');
  const twd = admob.filter(snapshot => snapshot.report.currency === 'TWD');
  if (!twd.length) throw new Error('No TWD AdMob history');
  const revenue = mergeAdmobSnapshots(twd);
  const covered = new Set(revenue.days);
  for (const snapshot of admob) {
    for (const day of daysBetween(snapshot.report.start, snapshot.report.end)) {
      if (!covered.has(day)) throw new Error('TWD backfill does not cover all preserved historical dates');
    }
  }
  return {
    apple: aggregateApple(apple, catalog), google: aggregateGoogle(google, catalog), revenue,
    audit: { files: audit, sourceFiles: { apple: apple.length, google: google.length, admob: admob.length }, preservedCurrencies: [...new Set(admob.map(x => x.report.currency))].sort() },
  };
}
