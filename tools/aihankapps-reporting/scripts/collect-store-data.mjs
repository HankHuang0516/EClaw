// Daily store snapshot for the APP 趨勢 report, in the report-only path (Hank 2026-11-11).
//
// It writes the same snapshot files and receipt as the original collect-app-data.zsh — Google Play app status and
// reviews, the Play report bucket listings, App Store apps, versions, reviews and analytics requests — but it never
// touches the portfolio catalog, icons or guides: the old catalog sync overwrote curated names, guides and
// H-watermarked icons. A failed required step keeps the previous receipt, so the previous public report stays.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from './report-storage.mjs';
import { normalizeGoogleReviewSnapshot } from './google-review-response.mjs';
import { ROOT } from './report-paths.mjs';

const exec = promisify(execFile);
const ENV = { ...process.env, GPLAY_PROFILE: process.env.GPLAY_PROFILE || 'aihankapps', ASC_PROFILE: process.env.ASC_PROFILE || 'Hank App Store Release' };
const safeName = value => String(value).replace(/[^A-Za-z0-9._-]+/g, '_');
const taipeiMonth = (date, back = 0) => {
  const d = new Date(date.getTime() + 8 * 3600000);
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
};
const unique = values => [...new Set(values.filter(v => typeof v === 'string' && v))].sort();
function walk(value, visit) {
  if (Array.isArray(value)) value.forEach(item => walk(item, visit));
  else if (value && typeof value === 'object') { visit(value); Object.values(value).forEach(item => walk(item, visit)); }
}

export async function defaultCommand(program, args) {
  const { stdout } = await exec(program, args, { env: ENV, maxBuffer: 256 * 1024 * 1024, timeout: 300000 });
  return stdout;
}
export async function defaultKeychain(service) {
  const { stdout } = await exec('security', ['find-generic-password', '-a', 'AiHankApps', '-s', service, '-w'], { env: ENV, timeout: 30000 });
  return stdout.trim();
}

export async function collectStoreData({ root = ROOT, day, now = new Date(), command = defaultCommand, keychain = defaultKeychain, normalizeReviews = normalizeGoogleReviewSnapshot } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new Error('A collection day is required');
  const runId = `${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${randomUUID()}`;
  const snapshot = join(root, 'raw', day, 'runs', runId), google = join(snapshot, 'google-play'), apple = join(snapshot, 'app-store');
  for (const dir of [join(google, 'apps'), join(apple, 'apps'), join(snapshot, 'admob')]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const checks = [];
  const record = (source, operation, result) => checks.push({ source, operation, result });
  // Runs one CLI call into FILE; on failure keeps its error text in FILE.err and returns null.
  async function capture(program, args, file) {
    try {
      const out = await command(program, args);
      await writeFile(file, out, { mode: 0o600 });
      return out;
    } catch (error) {
      await writeFile(file.replace(/\.json$/, '.err'), String((error && (error.stderr || error.message)) || error).slice(-4000), { mode: 0o600 });
      return null;
    }
  }
  const parse = text => { try { return JSON.parse(text); } catch (_error) { return null; } };

  const playUri = await keychain('com.aihankapps.googleplay.report-uri');
  const playApps = await capture('gplay', ['apps', 'list', '--paginate'], join(google, 'apps.json'));
  if (playApps === null) record('google-play', 'apps', 'FAILED');
  else {
    record('google-play', 'apps', 'OK');
    const packages = [];
    walk(parse(playApps), node => packages.push(node.packageName || node.package));
    for (const pkg of unique(packages)) {
      const dir = join(google, 'apps', safeName(pkg));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      record('google-play', `status:${pkg}`, await capture('gplay', ['status', '--package', pkg], join(dir, 'status.json')) === null ? 'FAILED' : 'OK');
      let reviews = await capture('gplay', ['reviews', 'list', '--package', pkg, '--paginate'], join(dir, 'reviews.json')) !== null;
      if (reviews) {
        try { await normalizeReviews(dir, pkg); } catch (_error) { reviews = false; }
      }
      record('google-play', `reviews:${pkg}`, reviews ? 'OK' : 'FAILED');
    }
  }
  const months = ['--from', taipeiMonth(now, 1), '--to', taipeiMonth(now)];
  record('google-play', 'statistics-reports', await capture('gplay', ['reports', 'stats', 'list', '--bucket-id', playUri, ...months, '--type', 'all'], join(google, 'statistics-reports.json')) === null ? 'FAILED' : 'OK');
  record('google-play', 'financial-reports', await capture('gplay', ['reports', 'financial', 'list', '--bucket-id', playUri, ...months, '--type', 'all'], join(google, 'financial-reports.json')) === null ? 'UNAVAILABLE' : 'OK');

  const appleApps = await capture('asc', ['apps', 'list', '--paginate'], join(apple, 'apps.json'));
  if (appleApps === null) record('app-store', 'apps', 'FAILED');
  else {
    record('app-store', 'apps', 'OK');
    const ids = [];
    walk(parse(appleApps), node => { if (node.type === 'apps') ids.push(node.id); });
    for (const id of unique(ids)) {
      const dir = join(apple, 'apps', safeName(id));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      record('app-store', `versions:${id}`, await capture('asc', ['versions', 'list', '--app', id, '--latest'], join(dir, 'versions.json')) === null ? 'FAILED' : 'OK');
      record('app-store', `reviews:${id}`, await capture('asc', ['reviews', '--app', id, '--paginate'], join(dir, 'reviews.json')) === null ? 'FAILED' : 'OK');
      record('app-store', `analytics:${id}`, await capture('asc', ['analytics', 'requests', '--app', id], join(dir, 'analytics-requests.json')) === null ? 'FAILED' : 'OK');
    }
  }

  const manifest = { collectedAt: now.toISOString().slice(0, 19) + 'Z', day, mode: 'report-only', checks };
  await atomicWrite(join(snapshot, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  if (checks.some(check => check.result === 'FAILED')) return { status: 'failed', snapshot, failed: checks.filter(check => check.result === 'FAILED').map(check => check.operation) };
  await atomicWrite(join(root, 'collection-latest.json'), JSON.stringify({ ...manifest, status: 'succeeded', snapshot }), { mode: 0o600 });
  return { status: 'succeeded', snapshot, checks: checks.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const day = process.argv[2] || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  try {
    const result = await collectStoreData({ day });
    console.log(JSON.stringify(result));
    if (result.status !== 'succeeded') process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
