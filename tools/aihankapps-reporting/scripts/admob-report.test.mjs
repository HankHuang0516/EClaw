import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectAdmob } from './admob-report.mjs';
import { EXPECTED_PUBLISHER } from './report-core.mjs';
import { atomicWrite, appendSnapshot } from './report-storage.mjs';

const appId = `ca-app-${EXPECTED_PUBLISHER}~2333927943`;
const app = { appId, platform: 'IOS', manualAppInfo: { displayName: 'APP' } };
const report = [
  { header: { dateRange: { startDate: { year: 2026, month: 9, day: 1 }, endDate: { year: 2026, month: 9, day: 1 } }, localizationSettings: { currencyCode: 'TWD' } } },
  { row: { dimensionValues: { DATE: { value: '20260901' }, APP: { value: appId }, PLATFORM: { value: 'iOS' } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: '123' } } } },
  { footer: { matchingRowCount: '1' } },
];
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'aihank-collector-test-'));
  try { await fn({ start: '2026-09-01', end: '2026-09-01', output: join(root, 'latest.json'), historyRoot: join(root, 'history'), inventoryOutput: join(root, 'inventory.json') }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function mock(overrides = {}) {
  const calls = [];
  return {
    calls, keychain: name => name === 'publisher-id' ? EXPECTED_PUBLISHER : 'TEST-SECRET-NOT-FOR-OUTPUT',
    sleep: async () => {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      const handled = await overrides.handle?.(url, init, calls);
      if (handled) return handled;
      if (url.includes('oauth2')) return Response.json({ access_token: 'TEST-TOKEN' });
      if (url.endsWith(EXPECTED_PUBLISHER)) return Response.json({ name: `accounts/${EXPECTED_PUBLISHER}`, publisherId: EXPECTED_PUBLISHER, reportingTimeZone: 'America/Los_Angeles' });
      if (url.includes('/apps?')) return Response.json({ apps: [app] });
      const spec = JSON.parse(init.body).reportSpec;
      assert.equal(spec.localizationSettings.currencyCode, 'TWD');
      assert.equal(spec.timeZone, undefined);
      return Response.json(overrides.report || report);
    },
  };
}
test('collector verifies account, requests TWD, stores timezone and preserves immutable snapshots on rerun', () => fixture(async options => {
  const deps = mock();
  const first = await collectAdmob(options, deps), second = await collectAdmob(options, deps);
  assert.notEqual(first.historyPath, second.historyPath);
  assert.equal((await readdir(options.historyRoot)).length, 2);
  const saved = JSON.parse(await readFile(options.output, 'utf8'));
  assert.equal(saved.reportingTimeZone, 'America/Los_Angeles'); assert.equal(saved.currency, 'TWD');
  assert.equal(saved.publisherId, EXPECTED_PUBLISHER); assert.equal(saved.inventory.length, 1);
  assert.equal((await stat(options.output)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(options.output, 'utf8')).includes('TEST-TOKEN'));
}));
test('publisher mismatch prevents all requests and writes', () => fixture(async options => {
  const deps = mock(); deps.keychain = () => 'wrong';
  await assert.rejects(collectAdmob(options, deps), /publisher mismatch/);
  assert.equal(deps.calls.length, 0);
  await assert.rejects(readFile(options.output), { code: 'ENOENT' });
}));
test('wrong currency leaves existing latest report untouched', () => fixture(async options => {
  await writeFile(options.output, 'previous-good-report');
  const wrong = structuredClone(report); wrong[0].header.localizationSettings.currencyCode = 'USD';
  await assert.rejects(collectAdmob(options, mock({ report: wrong })), /currency/);
  assert.equal(await readFile(options.output, 'utf8'), 'previous-good-report');
}));
test('inventory pagination is complete and cycles are rejected', () => fixture(async options => {
  const deps = mock({ handle: url => {
    if (url.includes('/apps?') && !url.includes('pageToken')) return Response.json({ apps: [], nextPageToken: 'next' });
    return null;
  } });
  await collectAdmob(options, deps);
  assert.equal(deps.calls.filter(c => c.url.includes('/apps?')).length, 2);
  const looping = mock({ handle: url => url.includes('/apps?') ? Response.json({ apps: [], nextPageToken: 'same' }) : null });
  await assert.rejects(collectAdmob(options, looping), /pagination cycle/);
}));
test('transient errors retry but authorization failure does not expose secrets', () => fixture(async options => {
  let failed = false;
  const deps = mock({ handle: url => {
    if (!failed && url.includes('networkReport')) { failed = true; return new Response('', { status: 503 }); }
    return null;
  } });
  await collectAdmob(options, deps);
  assert.equal(deps.calls.filter(c => c.url.includes('networkReport')).length, 2);
  const unauthorized = mock({ handle: () => new Response('PRIVATE-SERVER-ERROR', { status: 401 }) });
  await assert.rejects(collectAdmob(options, unauthorized), error => error.message.includes('HTTP 401') && !error.message.includes('PRIVATE'));
  assert.equal(unauthorized.calls.length, 1);
}));
test('atomic write failure preserves old content and removes temporary files', () => fixture(async options => {
  await writeFile(options.output, 'old');
  await assert.rejects(atomicWrite(options.output, 'new', { beforeRename: () => { throw new Error('simulated interruption'); } }), /interruption/);
  assert.equal(await readFile(options.output, 'utf8'), 'old');
  assert.ok(!(await readdir(join(options.output, '..'))).some(n => n.endsWith('.tmp')));
}));
test('append-only history refuses overwrite', () => fixture(async options => {
  const path = join(options.historyRoot, 'one.json');
  await appendSnapshot(path, 'old');
  await assert.rejects(appendSnapshot(path, 'new'), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), 'old');
}));
test('interrupted snapshot never exposes a partial historical report', () => fixture(async options => {
  const path = join(options.historyRoot, 'interrupted.json');
  await assert.rejects(appendSnapshot(path, 'complete', { beforePublish: () => { throw new Error('interrupted'); } }), /interrupted/);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  assert.deepEqual(await readdir(options.historyRoot), []);
}));
test('concurrent snapshot writers publish exactly one complete value', () => fixture(async options => {
  const path = join(options.historyRoot, 'concurrent.json');
  const results = await Promise.allSettled([appendSnapshot(path, 'first'), appendSnapshot(path, 'second')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'EEXIST');
  assert.ok(['first', 'second'].includes(await readFile(path, 'utf8')));
  assert.deepEqual(await readdir(options.historyRoot), ['concurrent.json']);
}));
test('collector failure publishing latest retains recoverable historical snapshot', () => fixture(async options => {
  await writeFile(options.output, 'old');
  const deps = mock();
  deps.atomicWrite = async (path, bytes) => {
    if (path === options.output) throw new Error('simulated disk error');
    return atomicWrite(path, bytes);
  };
  await assert.rejects(collectAdmob(options, deps), /disk error/);
  assert.equal(await readFile(options.output, 'utf8'), 'old');
  assert.equal((await readdir(options.historyRoot)).length, 1);
}));
