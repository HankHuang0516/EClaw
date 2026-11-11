import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { reportEnvironment, unexpectedChanges, REPORT_FILES } from './daily-report.mjs';

const checkout = resolve(import.meta.dirname, '../../..');

test('daily report builds against the checkout\'s published catalog and writes only its report route', () => {
  const env = reportEnvironment({ KEEP: '1', AIHANKAPPS_REPORT_CATALOG_MODE: 'synced' });
  assert.equal(env.KEEP, '1');
  assert.equal(env.AIHANKAPPS_REPORT_CATALOG_MODE, 'published');
  assert.equal(env.AIHANKAPPS_REPORT_CATALOG, join(checkout, 'backend/public/AiHankApps/app-catalog.json'));
  assert.equal(env.AIHANKAPPS_REPORT_TARGETS, join(checkout, 'backend/public/AiHankApps/reports'));
  assert.equal(env.AIHANKAPPS_REPORT_VIEW, join(checkout, 'tools/aihankapps-reporting/reports/report-view.mjs'));
  assert.ok(!env.AIHANKAPPS_REPORT_TARGETS.includes(':'), 'a single target: the old showcase copies are gone');
});

test('anything besides the four report files stops publication', () => {
  assert.equal(REPORT_FILES.length, 4);
  assert.deepEqual(unexpectedChanges(REPORT_FILES.map(path => ` M ${path}`).join('\n') + '\n'), []);
  assert.deepEqual(unexpectedChanges(' M backend/public/AiHankApps/reports/data.js\n M backend/public/AiHankApps/app-catalog.json\n'), ['backend/public/AiHankApps/app-catalog.json']);
  assert.deepEqual(unexpectedChanges('D  backend/public/AiHankApps/icons/one.png\n'), ['backend/public/AiHankApps/icons/one.png']);
  assert.deepEqual(unexpectedChanges(''), []);
});
