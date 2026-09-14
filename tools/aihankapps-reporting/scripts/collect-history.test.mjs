import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectHistory, expectedApplePending } from './collect-history.mjs';
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'aihank-collect-history-'));
  const options = { root, day: '2026-09-08', catalogPath: join(root, 'catalog.json'), output: join(root, 'latest.json') };
  await writeFile(options.catalogPath, JSON.stringify({ apps: [{ communityId: 'one', googlePackage: 'app.one' }] }));
  await writeFile(options.output, 'previous-success');
  const calls = [];
  const dependencies = {
    keychain: async () => 'test-reference',
    command: async (program, args) => {
      calls.push({ program, args });
      if (program === 'gplay') {
        if (args[0] === 'vitals') return '{}';
        const kind = args[args.indexOf('--type') + 1];
        if (kind !== 'installs') return JSON.stringify({ files: [] });
        const path = join(args[args.indexOf('--dir') + 1], 'installs_app.one_202609_overview.csv');
        await writeFile(path, 'Date,Package name,Daily User Installs\n2026-09-01,app.one,2\n');
        return JSON.stringify({ files: [{ path }] });
      }
      return JSON.stringify({ available: false });
    },
    collectAdmob: async options => ({ start: options.start, end: options.end }),
  };
  try { await fn(options, dependencies, calls); } finally { await rm(root, { recursive: true, force: true }); }
}
test('daily collection downloads Google history and classifies unavailable Apple reports without fabricating rows', () => fixture(async (options, deps, calls) => {
  const result = await collectHistory(options, deps);
  assert.equal(result.status, 'succeeded');
  assert.equal(calls.filter(call => call.program === 'gplay').length, 5);
  assert.ok(calls.filter(call => call.program === 'gplay' && call.args[0] === 'vitals').every(call => call.args[call.args.indexOf('--to') + 1] === '2026-09-05'));
  assert.equal(calls.filter(call => call.program === 'asc').length, 35);
  assert.ok(result.checks.filter(check => check.source === 'apple').every(check => check.status === 'not-yet-available'));
  assert.equal(JSON.parse(await readFile(options.output, 'utf8')).status, 'succeeded');
  assert.equal((await readdir(join(options.root, 'history/google-play/snapshots/2026-09-08'))).length, 1);
}));
test('repeated daily collections preserve independent snapshots instead of overwriting history', () => fixture(async (options, deps) => {
  await collectHistory(options, deps); await collectHistory(options, deps);
  assert.equal((await readdir(join(options.root, 'history/google-play/snapshots/2026-09-08'))).length, 2);
}));
test('failed required API call cannot publish successful collection receipt', () => fixture(async (options, deps) => {
  deps.command = async () => { throw new Error('simulated authorization failure'); };
  await assert.rejects(collectHistory(options, deps), /authorization/);
  assert.equal(await readFile(options.output, 'utf8'), 'previous-success');
  const [run] = await readdir(join(options.root, 'collection-runs'));
  assert.equal(JSON.parse(await readFile(join(options.root, 'collection-runs', run, 'manifest.json'), 'utf8')).status, 'failed');
}));
test('actual gplay null empty list requires matching package/type/range metadata', () => fixture(async (options, deps) => {
  const original = deps.command;
  deps.command = async (program, args) => program === 'gplay' && args[0] !== 'vitals' ? JSON.stringify({ files: null, package: 'app.one', type: args[args.indexOf('--type') + 1], from: '2026-08', to: '2026-09' }) : original(program, args);
  const result = await collectHistory(options, deps);
  assert.ok(result.checks.filter(check => check.source === 'google').every(check => check.status === 'not-yet-available'));
  deps.command = async (program, args) => program === 'gplay' && args[0] === 'vitals' ? '{}' : JSON.stringify({ files: null, package: 'wrong' });
  await assert.rejects(collectHistory(options, deps), /manifest missing files/);
}));
test('Apple explicit pending publication is unavailable, not an authentication bypass', () => {
  const args = ['analytics', 'sales', '--allow-missing'];
  assert.equal(expectedApplePending('asc', args, { code: 4, stderr: 'Report is not available yet. Daily reports for the Americas are available by 5 am Pacific Time' }), true);
  assert.equal(expectedApplePending('asc', args, { code: 4, stderr: 'Unauthorized: invalid token' }), false);
  assert.equal(expectedApplePending('asc', args, { code: 1, stderr: 'Report is not available yet.' }), false);
  assert.equal(expectedApplePending('gplay', args, { code: 4, stderr: 'Report is not available yet.' }), false);
});
test('Google vitals null response is preserved as sample-insufficient rather than zero', () => fixture(async (options, deps) => {
  const original = deps.command;
  deps.command = async (program, args) => program === 'gplay' && args[0] === 'vitals' ? 'null' : original(program, args);
  const result = await collectHistory(options, deps);
  assert.ok(result.checks.filter(check => check.source === 'google-vitals').every(check => check.status === 'sample-insufficient' && check.rows === 0));
}));
