import { readFile, mkdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildReport } from './build-report.mjs';
import { atomicWrite } from './report-storage.mjs';
import { fingerprint, isoDate } from './report-core.mjs';

const FILES = ['index.html', 'data.js', 'report-view.js'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const SOURCE = '/Users/hank/Desktop/Project/app-showcase-site';
const ROOT = '/Users/hank/.local/share/AiHankApps/analytics';
const TARGETS = [join(SOURCE, 'reports'), join(SOURCE, 'public/reports'), '/Users/hank/Desktop/Project/EClaw-ai-hank-apps-route/backend/public/AiHankApps/reports'];

export function versionReportIndex(index, contentHash) {
  const pattern = /src=(['"])\.\/data\.js(?:\?v=[^'"]+)?\1/;
  if (!pattern.test(index)) throw new Error('Report index is missing the data.js script');
  return index.replace(pattern, `src="./data.js?v=${contentHash}"`);
}

export function requirePreservedHistory(previous, current) {
  const files = new Map(current.files.map(file => [file.file, file.digest]));
  for (const file of previous.files || []) {
    if (!files.has(file.file)) throw new Error('Previously accepted historical source disappeared');
    if (files.get(file.file) !== file.digest) throw new Error('Previously accepted historical source was modified');
  }
}

export function requireFresh(receipt, day, now, label) {
  if (receipt.status !== 'succeeded' || receipt.day !== day) throw new Error(`${label} is not a successful current-day collection`);
  const age = Date.parse(now) - Date.parse(receipt.collectedAt);
  if (!Number.isFinite(age) || age < -300000 || age > 24 * 60 * 60 * 1000) throw new Error(`${label} is stale`);
  if (!Array.isArray(receipt.checks) || !receipt.checks.length || receipt.checks.some(check => check.result === 'FAILED' || check.status === 'failed')) throw new Error(`${label} has failed or missing checks`);
}

export async function prepareRelease({ root = ROOT, source = SOURCE, now = new Date().toISOString(), day } = {}) {
  day = isoDate(day || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now)));
  const inventoryReceipt = JSON.parse(await readFile(join(root, 'collection-latest.json'), 'utf8'));
  const historyReceipt = JSON.parse(await readFile(join(root, 'history-collection-latest.json'), 'utf8'));
  requireFresh(inventoryReceipt, day, now, 'Inventory'); requireFresh(historyReceipt, day, now, 'History');
  if (!inventoryReceipt.checks.some(check => check.source === 'portfolio' && check.operation === 'full-store-catalog' && check.result === 'OK')) throw new Error('Full store inventory was not synchronized');
  if (!historyReceipt.checks.some(check => check.source === 'admob' && check.status === 'available')) throw new Error('Missing current AdMob collection');
  const catalogPath = join(source, 'app-catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  requireFresh({ status: 'succeeded', day, collectedAt: catalog.checkedAt, checks: [{ result: 'OK' }] }, day, now, 'Catalog');
  for (const app of catalog.apps) {
    if (!app.googlePackage) continue;
    for (const kind of ['installs', 'ratings', 'crashes']) if (!historyReceipt.checks.some(check => check.source === 'google' && check.id === app.communityId && check.kind === kind && ['available', 'not-yet-available'].includes(check.status))) throw new Error('New catalog app lacks report collection coverage');
  }
  const directory = join(root, 'report-releases', `${now.replaceAll(':', '-')}_${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const end = new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
  const result = await buildReport({ historyRoot: join(root, 'history'), catalogPath, inventoryPath: join(root, 'admob-current.json'), reviewSnapshot: inventoryReceipt.snapshot, output: join(directory, 'data.js'), auditOutput: join(directory, 'source-audit.json'), end, generatedAt: now });
  const audit = JSON.parse(await readFile(join(directory, 'source-audit.json'), 'utf8'));
  const ledgerPath = join(root, 'report-history-ledger.json');
  let previous = { files: [] };
  try { previous = JSON.parse(await readFile(ledgerPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  requirePreservedHistory(previous, audit);
  const view = await readFile(join(source, 'reports/report-view.mjs'), 'utf8');
  await atomicWrite(join(directory, 'report-view.js'), '// Generated from report-view.mjs; do not edit directly.\n(function () {\n' + view.replace(/^export /gm, '') + '\n})();\n');
  const index = versionReportIndex(await readFile(join(source, 'reports/index.html'), 'utf8'), result.contentHash);
  await atomicWrite(join(directory, 'index.html'), index);
  const hashes = {};
  for (const file of FILES) hashes[file] = sha(await readFile(join(directory, file)));
  const release = { schemaVersion: 2, generatedAt: now, day, catalogHash: fingerprint(catalog), contentHash: result.contentHash, files: hashes };
  await atomicWrite(join(directory, 'release.json'), JSON.stringify(release, null, 2) + '\n');
  await atomicWrite(ledgerPath, JSON.stringify(audit, null, 2) + '\n');
  return { directory, ...release };
}

export async function validateRelease(directory, catalog) {
  const release = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
  if (release.schemaVersion !== 2 || fingerprint(catalog) !== release.catalogHash) throw new Error('Release catalog does not match portfolio');
  if (Object.keys(release.files || {}).sort().join() !== [...FILES].sort().join()) throw new Error('Incomplete report release');
  for (const file of FILES) if (sha(await readFile(join(directory, file))) !== release.files[file]) throw new Error(`Report artifact mismatch: ${file}`);
  const script = await readFile(join(directory, 'data.js'), 'utf8');
  const match = script.match(/^window\.AIHANK_REPORT = ([\s\S]+);\n$/);
  if (!match) throw new Error('Unexpected report data format');
  const { contentHash, ...model } = JSON.parse(match[1]);
  if (model.schemaVersion !== 2 || fingerprint(model) !== contentHash || contentHash !== release.contentHash) throw new Error('Report content hash mismatch');
  const identities = apps => apps.map(app => [app.id || app.communityId, app.name, app.category]).sort((a, b) => a[0].localeCompare(b[0]));
  if (fingerprint(identities(model.apps)) !== fingerprint(identities(catalog.apps))) throw new Error('Report/catalog identity mismatch');
  return release;
}

// These are local deployment inputs, not live servers. Only a complete validated
// release is copied; a failed copy restores all touched targets before returning.
export async function applyRelease(directory, targets, catalog, { write = atomicWrite } = {}) {
  const release = await validateRelease(directory, catalog);
  const files = [...FILES, 'release.json'], backups = [];
  const bytes = new Map();
  for (const file of files) bytes.set(file, await readFile(join(directory, file)));
  try {
    for (const target of targets) {
      if (resolve(target) === resolve(directory)) throw new Error('Cannot apply release onto its archive');
      for (const file of files) {
        const path = join(target, file);
        let previous = null;
        try { previous = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        backups.push({ path, previous });
        await write(path, bytes.get(file), { mode: 0o644 });
      }
    }
  } catch (error) {
    const failures = [];
    for (const { path, previous } of backups.reverse()) {
      try {
        if (previous === null) await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
        else await atomicWrite(path, previous, { mode: 0o644 });
      } catch { failures.push(path); }
    }
    if (failures.length) throw new Error('Release copy and rollback failed; deployment must stop');
    throw error;
  }
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, directory] = process.argv.slice(2);
    const catalog = JSON.parse(await readFile(join(SOURCE, 'app-catalog.json'), 'utf8'));
    if (mode === '--prepare') console.log(JSON.stringify(await prepareRelease()));
    else if (mode === '--apply' && directory) console.log(JSON.stringify(await applyRelease(directory, TARGETS, catalog)));
    else if (mode === '--check') {
      const releases = [];
      for (const target of TARGETS) releases.push(await validateRelease(target, catalog));
      if (new Set(releases.map(release => fingerprint(release))).size !== 1) throw new Error('Deployment targets have different report releases');
      console.log(JSON.stringify({ status: 'verified', contentHash: releases[0].contentHash, targets: TARGETS.length }));
    } else throw new Error('Expected --prepare, --apply RELEASE_DIRECTORY or --check');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
