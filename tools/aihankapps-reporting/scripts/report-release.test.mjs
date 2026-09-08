import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fingerprint } from './report-core.mjs';
import { atomicWrite } from './report-storage.mjs';
import { requireFresh, validateRelease, applyRelease, requirePreservedHistory } from './report-release.mjs';

const catalog = { apps: [{ communityId: 'one', name: 'One', category: 'Life' }] };
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'aihank-release-'));
  const source = join(root, 'source'), targets = [join(root, 'a'), join(root, 'b')];
  try {
    await mkdir(source); for (const target of targets) { await mkdir(target); await writeFile(join(target, 'index.html'), 'old-index'); }
    const model = { schemaVersion: 2, apps: [{ id: 'one', name: 'One', category: 'Life' }] };
    const contentHash = fingerprint(model);
    const contents = { 'index.html': '<h1>new</h1>', 'report-view.js': '/* renderer */', 'data.js': `window.AIHANK_REPORT = ${JSON.stringify({ ...model, contentHash })};\n` };
    const hashes = {};
    for (const [name, bytes] of Object.entries(contents)) { await writeFile(join(source, name), bytes); hashes[name] = createHash('sha256').update(bytes).digest('hex'); }
    await writeFile(join(source, 'release.json'), JSON.stringify({ schemaVersion: 2, catalogHash: fingerprint(catalog), contentHash, files: hashes }));
    await fn(source, targets);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('stale or failed collections cannot prepare releases', () => {
  const receipt = { status: 'succeeded', day: '2026-09-08', collectedAt: '2026-09-08T01:00:00Z', checks: [{ result: 'OK' }] };
  requireFresh(receipt, '2026-09-08', '2026-09-08T02:00:00Z', 'test');
  assert.throws(() => requireFresh({ ...receipt, checks: [{ result: 'FAILED' }] }, receipt.day, receipt.collectedAt, 'test'), /failed/);
  assert.throws(() => requireFresh(receipt, receipt.day, '2026-09-10T01:00:00Z', 'test'), /stale/);
});
test('complete release applies identical artifacts to every destination', () => fixture(async (source, targets) => {
  await applyRelease(source, targets, catalog);
  for (const target of targets) assert.deepEqual(await validateRelease(target, catalog), await validateRelease(source, catalog));
}));
test('failure in second destination rolls back every touched file including first destination', () => fixture(async (source, targets) => {
  let count = 0;
  await assert.rejects(applyRelease(source, targets, catalog, { write: async (...args) => { if (++count === 6) throw new Error('simulated disk failure'); return atomicWrite(...args); } }), /disk failure/);
  for (const target of targets) {
    assert.equal(await readFile(join(target, 'index.html'), 'utf8'), 'old-index');
    await assert.rejects(readFile(join(target, 'data.js')), { code: 'ENOENT' });
  }
}));
test('tampered artifact or changed catalog blocks copying', () => fixture(async (source, targets) => {
  await assert.rejects(applyRelease(source, targets, { apps: [] }), /catalog/);
  await writeFile(join(source, 'data.js'), 'tampered');
  await assert.rejects(applyRelease(source, targets, catalog), /mismatch/);
  assert.equal(await readFile(join(targets[0], 'index.html'), 'utf8'), 'old-index');
}));
test('history ledger blocks deleted or overwritten source files but permits new snapshots', () => {
  const previous = { files: [{ file: 'apple/day.tsv', digest: 'original' }] };
  requirePreservedHistory(previous, { files: [...previous.files, { file: 'apple/new.tsv', digest: 'new' }] });
  assert.throws(() => requirePreservedHistory(previous, { files: [] }), /disappeared/);
  assert.throws(() => requirePreservedHistory(previous, { files: [{ file: 'apple/day.tsv', digest: 'changed' }] }), /modified/);
});
