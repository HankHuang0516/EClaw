// Daily APP 趨勢 report, report-only path (Hank 2026-11-11: 「作品集商店報表更新系統用看門狗自動更新工具自動觸發更新」).
//
// Run from an EClaw checkout. It refreshes only the report: the published portfolio catalog, icons and guides stay
// exactly as people left them. Steps, each of which must succeed before the next starts:
//   1. collect-store-data   store apps, versions and reviews (private snapshot + receipt)
//   2. collect-history      Google / Apple / AdMob history (private, append-only)
//   3. report regression tests
//   4. report-release --prepare against the checkout's published catalog (catalog mode 'published')
//   5. Golden capture + comparison; a missing or failing score stops publication
//   6. report-release --apply into the checkout's backend/public/AiHankApps/reports, then --check
//   7. the checkout's tracked changes must be the four report files and nothing else
// The caller (the report watchdog on Hank's Mac) commits those four files through a pull request; this script never
// pushes, deploys or edits the catalog. A failure keeps the previously published report.
//
// Usage: node tools/aihankapps-reporting/scripts/daily-report.mjs [--day YYYY-MM-DD] [--skip-collect]
// Environment: AIHANKAPPS_REPORT_PYTHON (Python with Pillow and NumPy, default python3),
//              AIHANKAPPS_PLAYWRIGHT_FROM (a package.json whose node_modules has playwright),
//              AIHANKAPPS_ANALYTICS_ROOT (private store, default ~/.local/share/AiHankApps/analytics).
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { atomicWrite } from './report-storage.mjs';

const TOOL = resolve(import.meta.dirname, '..');
const CHECKOUT = resolve(TOOL, '../..');
const PUBLIC = join(CHECKOUT, 'backend/public/AiHankApps');
export const REPORT_FILES = ['index.html', 'data.js', 'report-view.js', 'release.json'].map(file => `backend/public/AiHankApps/reports/${file}`);

export function reportEnvironment(base = process.env) {
  return {
    ...base,
    AIHANKAPPS_REPORT_CATALOG_MODE: 'published',
    AIHANKAPPS_REPORT_CATALOG: join(PUBLIC, 'app-catalog.json'),
    AIHANKAPPS_REPORT_VIEW: join(TOOL, 'reports/report-view.mjs'),
    AIHANKAPPS_REPORT_INDEX: join(PUBLIC, 'reports/index.html'),
    AIHANKAPPS_REPORT_PUBLIC: PUBLIC,
    AIHANKAPPS_REPORT_TARGETS: join(PUBLIC, 'reports')
  };
}

// Tracked changes other than the four report files mean something besides the report moved; publication stops.
export function unexpectedChanges(porcelain) {
  return porcelain.split('\n').filter(Boolean).map(line => line.slice(3).trim()).filter(path => !REPORT_FILES.includes(path));
}

function run(label, program, args, { env, cwd = CHECKOUT, capture = false, timeout = 30 * 60 * 1000 } = {}) {
  console.log(`--- ${new Date().toISOString()} ${label}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', chunk => { if (capture) out += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('error', error => { clearTimeout(timer); reject(Object.assign(error, { step: label })); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out);
      else reject(Object.assign(new Error(`${label} failed (exit ${code})`), { step: label }));
    });
  });
}

export async function dailyReport({ day, skipCollect = false, env = reportEnvironment(), python = env.AIHANKAPPS_REPORT_PYTHON || 'python3' } = {}) {
  const scripts = join(TOOL, 'scripts');
  if (!skipCollect) {
    await run('collect store data', process.execPath, [join(scripts, 'collect-store-data.mjs'), day], { env });
    await run('collect history', process.execPath, [join(scripts, 'collect-history.mjs'), day], { env });
  }
  const tests = (await readdir(scripts)).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(scripts, name));
  await run('report regression tests', process.execPath, ['--test', ...tests], { env });
  const prepared = JSON.parse((await run('prepare release', process.execPath, [join(scripts, 'report-release.mjs'), '--prepare'], { env, capture: true })).trim().split('\n').pop());
  const directory = prepared.directory, verification = join(directory, 'verification');
  await run('golden capture', process.execPath, [join(scripts, 'capture-trends-golden.mjs'), '--release', directory, '--output', verification], { env });
  await run('golden comparison', python, ['-I', join(scripts, 'compare-trends-golden.py'), '--actual', join(verification, 'app-trends-desktop.png'), '--capture', join(verification, 'capture.json'), '--output', join(directory, 'golden-score.json')], { env });
  await run('apply release', process.execPath, [join(scripts, 'report-release.mjs'), '--apply', directory], { env });
  await run('check release', process.execPath, [join(scripts, 'report-release.mjs'), '--check'], { env });
  const extra = unexpectedChanges(await run('tracked changes', 'git', ['status', '--porcelain', '--untracked-files=no'], { env, capture: true }));
  if (extra.length) throw Object.assign(new Error(`Unexpected tracked changes: ${extra.join(', ')}`), { step: 'tracked changes' });
  return { day: prepared.day, contentHash: prepared.contentHash, directory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const day = args.includes('--day') ? args[args.indexOf('--day') + 1]
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const env = reportEnvironment();
  const { ROOT } = await import('./report-paths.mjs');
  const startedAt = new Date().toISOString();
  let summary;
  try {
    summary = { status: 'succeeded', ...(await dailyReport({ day, env, skipCollect: args.includes('--skip-collect') })) };
  } catch (error) {
    summary = { status: 'failed', day, step: error.step || 'unknown', error: error.message };
    process.exitCode = 1;
  }
  summary = { ...summary, startedAt, finishedAt: new Date().toISOString() };
  await atomicWrite(join(ROOT, 'daily-report-latest.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}
