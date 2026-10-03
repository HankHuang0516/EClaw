import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, utimes, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildPackage, collectPackageFiles, createZip, validateManifest } from '../scripts/package.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'plugin.json'), 'utf8'));
const mcp = JSON.parse(await readFile(path.join(sourceRoot, 'mcp.json'), 'utf8'));
const clone = value => structuredClone(value);
function submissionFixture() {
  const complete = clone(manifest);
  const ui = complete.extensions['com.openai'].interface;
  // Test-only URLs describe validator inputs; they are never added to the real manifest.
  ui.supportURL = 'https://eclawbot.com/review-fixture/support';
  ui.termsOfServiceURL = 'https://eclawbot.com/review-fixture/terms';
  complete.extensions['com.openai'].review.demo_recording_url = 'https://eclawbot.com/review-fixture/demo';
  const evidence = {
    developerVerified: true, domainVerified: true, reviewerAccessConfigured: true,
    liveMcpOAuthTested: true, localRuntimeTested: true, reviewCasesExecuted: true, demoAccessible: true,
    verifiedAt: '2026-10-02T12:00:00Z',
    verifiedURLs: Object.fromEntries(['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL'].map(field => [field, ui[field]]))
  };
  evidence.verifiedURLs.demo_recording_url = complete.extensions['com.openai'].review.demo_recording_url;
  return { complete, evidence };
}

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'eclawbot-package-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repository', 'codex-plugin');
  await mkdir(root, { recursive: true });
  for (const name of validateManifest(manifest, mcp)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    // Isolated packaging tests do not depend on another worker's unfinished runtime.
    const data = name.startsWith('scripts/') ? Buffer.from('// isolated runtime fixture\n') : await readFile(path.join(sourceRoot, name));
    await writeFile(path.join(root, name), data);
  }
  return { temporary, root };
}

test('portable development manifest has real identity and no registered app dependency', () => {
  const names = validateManifest(manifest, mcp);
  assert(names.includes('scripts/runtime.mjs'));
  assert(names.includes('scripts/app-server-client.mjs'));
  assert.equal(manifest.extensions['com.openai'].apps, undefined);
  assert.equal(manifest.id, undefined);
  assert.equal(manifest.extensions['com.openai'].interface.supportURL, undefined);
  assert.equal(manifest.extensions['com.openai'].interface.termsOfServiceURL, undefined);
});

test('submission fails with actionable missing real materials', () => {
  assert.throws(() => validateManifest(manifest, mcp, { submission: true }), error => {
    for (const field of ['supportURL', 'termsOfServiceURL', 'demo_recording_url', 'developerVerified', 'reviewerAccessConfigured', 'localRuntimeTested']) assert(error.message.includes(field));
    return true;
  });
});

test('submission requires externally confirmed URLs and live checks, not just a filled manifest', () => {
  const { complete, evidence } = submissionFixture();
  assert.doesNotThrow(() => validateManifest(complete, mcp, { submission: true, evidence }));
  assert.throws(() => validateManifest(complete, mcp, { submission: true }), /external --evidence/);
  const stale = clone(evidence);
  stale.verifiedURLs.supportURL = 'https://eclawbot.com/another-route';
  stale.localRuntimeTested = false;
  assert.throws(() => validateManifest(complete, mcp, { submission: true, evidence: stale }), /localRuntimeTested[\s\S]*supportURL/);
});

test('submission enforces exactly five positive and three negative complete cases', () => {
  const { complete, evidence } = submissionFixture();
  complete.extensions['com.openai'].review.test_cases.positive.pop();
  complete.extensions['com.openai'].review.test_cases.negative.push({ description: 'extra', prompt: 'extra', expected_behavior: 'extra' });
  assert.throws(() => validateManifest(complete, mcp, { submission: true, evidence }), /exactly 5 positive[\s\S]*exactly 3 negative/);
  const missing = submissionFixture();
  delete missing.complete.extensions['com.openai'].review.test_cases.positive[0].tools_triggered;
  assert.throws(() => validateManifest(missing.complete, mcp, { submission: true, evidence: missing.evidence }), /positive review case 1/);
});

test('rejects fabricated, insecure, and credential-bearing listing URLs without printing values', () => {
  for (const value of ['https://example.com/support', 'https://sub.example.org/terms', 'http://eclawbot.com/support', 'https://localhost/support', 'https://127.0.0.1/support', 'https://docs.invalid/terms', 'https://user:sensitive-fixture@eclawbot.com/support']) {
    const bad = clone(manifest);
    bad.extensions['com.openai'].interface.supportURL = value;
    assert.throws(() => validateManifest(bad, mcp), error => error.message.includes('supportURL') && !error.message.includes(value) && !error.message.includes('sensitive-fixture'));
  }
});

test('rejects unsupported hooks and app mappings, metadata credentials, and inline MCP auth', () => {
  for (const field of ['apps', 'hooks']) {
    const bad = clone(manifest);
    bad.extensions['com.openai'][field] = './unreviewed.json';
    assert.throws(() => validateManifest(bad, mcp), /app references and lifecycle hooks/);
  }
  const secret = clone(manifest);
  secret.extensions['com.openai'].review.test_credentials = 'sensitive-fixture';
  assert.throws(() => validateManifest(secret, mcp), error => error.message.includes('credentials') && !error.message.includes('sensitive-fixture'));
  const inlineAuth = clone(mcp);
  inlineAuth.mcpServers.eclawbot.headers = { Authorization: 'sensitive-fixture' };
  assert.throws(() => validateManifest(manifest, inlineAuth), /metadata must not contain credentials/);
});

test('checks schema, semantic version, listing limits, required onboarding, and MCP transport', () => {
  const mutations = [
    bad => { bad.$schema = 'unrecognized'; },
    bad => { bad.version = '01.0.0'; },
    bad => { bad.extensions['com.openai'].interface.shortDescription = 'a'.repeat(31); },
    bad => { bad.extensions['com.openai'].interface.displayName = 'two\nlines'; },
    bad => { bad.extensions['com.openai'].onboardingSkill = './missing/SKILL.md'; }
  ];
  for (const change of mutations) {
    const bad = clone(manifest); change(bad);
    assert.throws(() => validateManifest(bad, mcp), /Package validation failed/);
  }
  const transport = clone(mcp);
  transport.mcpServers.eclawbot.type = 'stdio';
  assert.throws(() => validateManifest(manifest, transport), /streamable-http/);
  const extra = clone(mcp);
  extra.mcpServers.another = clone(extra.mcpServers.eclawbot);
  assert.throws(() => validateManifest(manifest, extra), /exactly one/);
  assert.throws(() => validateManifest(null, mcp), /JSON objects/);
});

test('asset paths cannot escape the package or pull in local state', () => {
  for (const file of ['./assets/../../auth.json', '/absolute/icon.png', './assets/private/key.json', './assets/../icon.png', './assets/.env']) {
    const bad = clone(manifest); bad.extensions['com.openai'].interface.logo = file;
    assert.throws(() => validateManifest(bad, mcp), /safe .\/assets\//);
  }
});

test('allowlist bundles both runtimes and excludes dependencies, development tools, state, and secrets', async t => {
  const { root } = await fixture(t);
  for (const file of ['.env', 'auth.json', '.codex-plugin/plugin.json', 'node_modules/package/index.js', 'test/runtime.test.mjs', 'scripts/package.mjs', 'package.json', 'assets/unused.png', 'skills/connect-codex/references/local-state.json', 'data/binding.json']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'do-not-ship-fixture');
  }
  const { files } = await collectPackageFiles(root);
  assert.deepEqual(files.map(x => x.name), [
    'README.md', 'assets/LICENSE', 'assets/icon.png', 'mcp.json', 'plugin.json',
    'scripts/app-server-client.mjs', 'scripts/runtime.mjs', 'skills/connect-codex/SKILL.md',
    'skills/connect-codex/references/runtime.md'
  ]);
  assert(files.every(x => !x.data.includes('do-not-ship-fixture')));
});

test('missing runtime prevents a build without writing an incomplete ZIP', async t => {
  const { root, temporary } = await fixture(t);
  await rm(path.join(root, 'scripts/runtime.mjs'));
  const output = path.join(temporary, 'incomplete.zip');
  await assert.rejects(buildPackage({ root, output }), /Required package file missing: scripts\/runtime.mjs/);
  await assert.rejects(access(output));
});

test('symlink files and symlink parent directories cannot enter the ZIP', async t => {
  const { root, temporary } = await fixture(t);
  const external = path.join(temporary, 'external.txt');
  await writeFile(external, 'outside-fixture');
  await rm(path.join(root, 'scripts/runtime.mjs'));
  await symlink(external, path.join(root, 'scripts/runtime.mjs'));
  await assert.rejects(collectPackageFiles(root), /without symlinks/);
  await rm(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(temporary, 'external-scripts'));
  await symlink(path.join(temporary, 'external-scripts'), path.join(root, 'scripts'));
  await assert.rejects(collectPackageFiles(root), /without symlinks/);
});

test('invalid JSON and invalid or non-square icon files fail validation', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'mcp.json'), '{');
  await assert.rejects(collectPackageFiles(root), /invalid JSON/);
  await writeFile(path.join(root, 'mcp.json'), JSON.stringify(mcp));
  await writeFile(path.join(root, 'assets/icon.png'), 'not-a-png');
  await assert.rejects(collectPackageFiles(root), /Invalid PNG/);
  const icon = await readFile(path.join(sourceRoot, 'assets/icon.png'));
  icon.writeUInt32BE(49, 20);
  await writeFile(path.join(root, 'assets/icon.png'), icon);
  await assert.rejects(collectPackageFiles(root), /square/);
});

test('deterministic ZIP survives a separate standard-library reader with fixed date, CRC, and permissions', async t => {
  const { root, temporary } = await fixture(t);
  const first = await buildPackage({ root, output: path.join(temporary, 'first.zip') });
  for (const name of validateManifest(manifest, mcp)) await utimes(path.join(root, name), new Date('2020-02-03T00:00:00Z'), new Date());
  const second = await buildPackage({ root, output: path.join(temporary, 'second.zip') });
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(await readFile(first.output), await readFile(second.output));
  const read = spawnSync('python3', ['-c',
    'import io,json,sys,zipfile\nwith zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:\n assert z.testzip() is None\n print(json.dumps([{"name":i.filename,"date":i.date_time,"mode":i.external_attr>>16,"compression":i.compress_type} for i in z.infolist()]))'],
  { input: await readFile(first.output), maxBuffer: 1024 * 1024 });
  assert.equal(read.status, 0, read.stderr.toString());
  const entries = JSON.parse(read.stdout.toString());
  assert.deepEqual(entries.map(x => x.name), first.files);
  assert(entries.some(x => x.name === 'plugin.json'));
  assert(entries.every(x => x.date.join(',') === '1980,1,1,0,0,0' && x.mode === 0o100644 && x.compression === 0));
});

test('check mode is read-only and submission evidence stays outside the repository', async t => {
  const { root, temporary } = await fixture(t);
  const output = path.join(temporary, 'check.zip');
  const result = await buildPackage({ root, output, check: true });
  assert.equal(result.mode, 'development');
  await assert.rejects(access(output));
  const { complete, evidence } = submissionFixture();
  await writeFile(path.join(root, 'plugin.json'), JSON.stringify(complete));
  const internalEvidence = path.join(root, 'readiness.json');
  await writeFile(internalEvidence, JSON.stringify(evidence));
  await assert.rejects(buildPackage({ root, check: true, submission: true, evidencePath: internalEvidence }), /outside the repository/);
  const externalEvidence = path.join(temporary, 'readiness.json');
  await writeFile(externalEvidence, JSON.stringify(evidence));
  const ready = await buildPackage({ root, check: true, submission: true, evidencePath: externalEvidence });
  assert.equal(ready.mode, 'submission');
  assert(!ready.files.some(x => x.includes('readiness')));
});

test('ZIP writer rejects duplicate or escaping paths and build never overwrites an existing archive', async t => {
  assert.throws(() => createZip([{ name: '../escape', data: Buffer.alloc(0) }]), /Unsafe ZIP/);
  assert.throws(() => createZip([{ name: 'same', data: Buffer.alloc(0) }, { name: 'same', data: Buffer.alloc(0) }]), /unique paths/);
  const { root, temporary } = await fixture(t);
  const output = path.join(temporary, 'existing.zip');
  await writeFile(output, 'keep-this');
  await assert.rejects(buildPackage({ root, output }), { code: 'EEXIST' });
  assert.equal(await readFile(output, 'utf8'), 'keep-this');
  await assert.rejects(buildPackage({ root, output: path.join(root, 'plugin.json') }), /overwrite source/);
});

test('CLI --submission exits nonzero with no ZIP and does not infer that draft cases were live-tested', async t => {
  const { temporary } = await fixture(t);
  const output = path.join(temporary, 'not-ready.zip');
  const result = spawnSync(process.execPath, [path.join(sourceRoot, 'scripts/package.mjs'), '--submission', '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /supportURL/);
  assert.match(result.stderr, /demo_recording_url/);
  await assert.rejects(access(output));
});
