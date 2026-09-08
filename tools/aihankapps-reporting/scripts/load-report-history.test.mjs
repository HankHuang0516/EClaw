import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { loadReportHistory } from './load-report-history.mjs';

const catalog = { apps: [{ communityId: 'one', name: 'One', category: 'Games', googlePackage: 'app.one', iosId: '101' }] };
const tsv = 'Apple Identifier\tProduct Type Identifier\tUnits\tBegin Date\tEnd Date\n101\t1F\t2\t09/01/2026\t09/01/2026\n';
const report = (currency = 'TWD', day = 1) => [
  { header: { dateRange: { startDate: { year: 2026, month: 9, day }, endDate: { year: 2026, month: 9, day } }, localizationSettings: { currencyCode: currency } } },
  { footer: { matchingRowCount: '0' } },
];
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'aihank-history-'));
  try {
    for (const dir of ['app-store/sales', 'google-play', 'admob']) await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, 'app-store/sales/2026-09-01.tsv'), tsv);
    await writeFile(join(root, 'app-store/sales/2026-09-01.tsv.gz'), gzipSync(tsv));
    await writeFile(join(root, 'google-play/installs_app.one_202609_overview.csv'), 'Date,Package name,Daily User Installs\n2026-09-01,app.one,3\n');
    await writeFile(join(root, 'admob/one.json'), JSON.stringify(report()));
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('loader handles real source formats and records private provenance', () => fixture(async root => {
  const result = await loadReportHistory(root, catalog);
  assert.equal(result.apple.points[0].value, 2);
  assert.equal(result.apple.duplicateCount, 1);
  assert.equal(result.google.installs[0].value, 3);
  assert.equal(result.audit.files.length, 4);
  assert.equal(result.revenue.currency, 'TWD');
}));
test('conflicting Apple compressed pair fails closed regardless of mtime', () => fixture(async root => {
  await writeFile(join(root, 'app-store/sales/2026-09-01.tsv.gz'), gzipSync(tsv.replace('\t2\t', '\t99\t')));
  await assert.rejects(loadReportHistory(root, catalog), /conflicting contents/);
}));
test('legacy USD history remains on disk and requires complete TWD replacement coverage', () => fixture(async root => {
  await writeFile(join(root, 'admob/legacy.json'), JSON.stringify(report('USD')));
  assert.deepEqual((await loadReportHistory(root, catalog)).audit.preservedCurrencies, ['TWD', 'USD']);
  await writeFile(join(root, 'admob/uncovered.json'), JSON.stringify(report('USD', 2)));
  await assert.rejects(loadReportHistory(root, catalog), /does not cover/);
}));
test('header-only files still require the exact metric schema', () => fixture(async root => {
  await writeFile(join(root, 'google-play/installs_app.one_202609_overview.csv'), 'Date,Package name,Daily Device Installs\n');
  await assert.rejects(loadReportHistory(root, catalog), /missing column/);
}));
