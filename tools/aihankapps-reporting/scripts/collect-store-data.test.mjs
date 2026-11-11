import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectStoreData } from './collect-store-data.mjs';

const responses = {
  'gplay apps list --paginate': JSON.stringify([{ packageName: 'tw.example.one' }, { packageName: 'tw.example.two' }]),
  'asc apps list --paginate': JSON.stringify({ data: [{ type: 'apps', id: '111' }, { type: 'bundleIds', id: 'skip' }] })
};
function stub(failing = []) {
  const calls = [];
  const command = async (program, args) => {
    const line = [program, ...args].join(' ');
    calls.push(line);
    if (failing.some(part => line.includes(part))) { const error = new Error('stub failure'); error.stderr = 'stub stderr'; throw error; }
    return responses[line] || '[]';
  };
  return { calls, command, keychain: async service => { assert.equal(service, 'com.aihankapps.googleplay.report-uri'); return 'pubsite_prod_example'; } };
}
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'aihank-store-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const now = new Date('2026-11-11T01:02:03Z');

test('collects every listed store app into a dated snapshot and writes a receipt', () => withRoot(async root => {
  const { calls, command, keychain } = stub();
  const normalized = [];
  const result = await collectStoreData({ root, day: '2026-11-11', now, command, keychain, normalizeReviews: async (dir, pkg) => normalized.push(pkg) });
  assert.equal(result.status, 'succeeded');
  assert.ok(result.snapshot.startsWith(join(root, 'raw', '2026-11-11', 'runs')));
  assert.deepEqual(normalized, ['tw.example.one', 'tw.example.two']);
  assert.deepEqual((await readdir(join(result.snapshot, 'google-play', 'apps'))).sort(), ['tw.example.one', 'tw.example.two']);
  assert.deepEqual(await readdir(join(result.snapshot, 'app-store', 'apps')), ['111']);
  assert.ok(calls.includes('gplay reports stats list --bucket-id pubsite_prod_example --from 2026-10 --to 2026-11 --type all'));
  assert.ok(calls.includes('asc versions list --app 111 --latest'));
  assert.ok(!calls.some(line => /catalog|availability/.test(line)), 'report-only collection never touches the catalog');
  const receipt = JSON.parse(await readFile(join(root, 'collection-latest.json'), 'utf8'));
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.day, '2026-11-11');
  assert.equal(receipt.snapshot, result.snapshot);
  assert.equal(receipt.collectedAt, '2026-11-11T01:02:03Z');
  assert.ok(receipt.checks.every(check => check.result === 'OK'));
}));

test('a failed required step keeps the previous receipt and records the error beside the snapshot', () => withRoot(async root => {
  await writeFile(join(root, 'collection-latest.json'), '{"previous":true}');
  const { command, keychain } = stub(['status --package tw.example.two']);
  const result = await collectStoreData({ root, day: '2026-11-11', now, command, keychain, normalizeReviews: async () => {} });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.failed, ['status:tw.example.two']);
  assert.equal(await readFile(join(root, 'collection-latest.json'), 'utf8'), '{"previous":true}');
  assert.equal(await readFile(join(result.snapshot, 'google-play', 'apps', 'tw.example.two', 'status.err'), 'utf8'), 'stub stderr');
  const manifest = JSON.parse(await readFile(join(result.snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.checks.find(check => check.operation === 'status:tw.example.two').result, 'FAILED');
}));

test('unverifiable reviews fail the run; a missing financial listing is only unavailable', () => withRoot(async root => {
  const { command, keychain } = stub(['reports financial']);
  const result = await collectStoreData({ root, day: '2026-11-11', now, command, keychain, normalizeReviews: async (dir, pkg) => { if (pkg === 'tw.example.one') throw new Error('unverified'); } });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.failed, ['reviews:tw.example.one']);
  const manifest = JSON.parse(await readFile(join(result.snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.checks.find(check => check.operation === 'financial-reports').result, 'UNAVAILABLE');

  const second = stub(['reports financial']);
  const ok = await collectStoreData({ root, day: '2026-11-11', now, command: second.command, keychain: second.keychain, normalizeReviews: async () => {} });
  assert.equal(ok.status, 'succeeded');
}));

test('rejects a missing or malformed day before touching the store', async () => {
  const { calls, command, keychain } = stub();
  await assert.rejects(collectStoreData({ root: tmpdir(), day: '11/11', command, keychain }), /day/);
  assert.equal(calls.length, 0);
});
