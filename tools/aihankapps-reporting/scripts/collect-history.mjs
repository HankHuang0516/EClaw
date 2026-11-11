import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { collectAdmob } from './admob-report.mjs';
import { appendSnapshot, atomicWrite } from './report-storage.mjs';
import { daysBetween, isoDate, decodeReport, parseDelimited } from './report-core.mjs';
import { ROOT } from './report-paths.mjs';

const execute = promisify(execFile);
export function expectedApplePending(program, args, error) {
  return program === 'asc' && args[0] === 'analytics' && args[1] === 'sales' && args.includes('--allow-missing') && error.code === 4 && /Report is not available yet\./.test(String(error.stderr || ''));
}
export function googleVitalsPending(program, args, error) {
  if (program !== 'gplay' || args[0] !== 'vitals' || args[1] !== 'crashes' || args[2] !== 'query') return null;
  const endIndex = args.indexOf('--to');
  if (endIndex < 0 || !args[endIndex + 1]) return null;
  const detail = String(error.stderr || error.message || '');
  const match = detail.match(/googleapi: Error 400: 'timeline_spec\.end_date' field should be at most the current freshness (\d{4}-\d{2}-\d{2}) 00:00\b/);
  if (!match) return null;
  let requestedTo, freshnessEndExclusive;
  try { requestedTo = isoDate(args[endIndex + 1]); freshnessEndExclusive = isoDate(match[1]); } catch { return null; }
  if (freshnessEndExclusive > requestedTo) return null;
  return { status: 'not-yet-available', reason: 'official-freshness-boundary', requestedTo, freshnessEndExclusive, diagnostic: match[0] };
}
async function command(program, args) {
  const attempts = program === 'gplay' ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await execute(program, args, { timeout: 180000, maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, GPLAY_PROFILE: 'aihankapps', ASC_PROFILE: 'Hank App Store Release', GPLAY_NO_UPDATE: '1', GPLAY_TIMEOUT: '60s' } });
      return result.stdout;
    } catch (error) {
      // asc's --allow-missing handles absent past reports but currently still exits
      // 4 for Apple's explicit not-yet-published response. This is not a zero day.
      if (expectedApplePending(program, args, error)) return JSON.stringify({ available: false, reason: 'report-not-published' });
      // The CLI end date is inclusive; Google's freshness boundary is not.
      // Preserve this specific official pending result without retrying a
      // deterministic 400 or masking unrelated API/authentication failures.
      if (googleVitalsPending(program, args, error)) throw error;
      if (attempt < attempts) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, attempt * 1500));
        continue;
      }
      const detail = String(error.stderr || error.message || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      throw new Error(`${program} report request failed after ${attempts} attempt${attempts === 1 ? '' : 's'}; previous publication retained${detail ? `: ${detail}` : ''}`);
    }
  }
}

export async function collectHistory({ day, root, catalogPath, output, weekly = false }, dependencies = {}) {
  day = isoDate(day);
  const run = dependencies.command || command;
  const now = dependencies.now || (() => new Date().toISOString());
  const admob = dependencies.collectAdmob || collectAdmob;
  const keychain = dependencies.keychain || (async name => (await run('security', ['find-generic-password', '-a', 'AiHankApps', '-s', name, '-w'])).trim());
  const collectedAt = now(), runId = `${collectedAt.replaceAll(':', '-')}_${randomUUID()}`;
  const stage = join(root, 'collection-runs', runId);
  await mkdir(stage, { recursive: true, mode: 0o700 });
  const end = new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
  const date = new Date(`${day.slice(0, 7)}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() - 1);
  const from = weekly ? '2023-01' : date.toISOString().slice(0, 7);
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  if (!catalog.apps?.length) throw new Error('Empty report collection catalog');
  const bucket = await keychain('com.aihankapps.googleplay.report-uri');
  const vendor = await keychain('com.aihankapps.apple.vendor-number');
  if (!bucket || !vendor) throw new Error('Missing report credential reference');
  const checks = [];
  try {
    for (const app of catalog.apps) {
      if (!app.googlePackage) continue;
      if (!/^[A-Za-z0-9_.]+$/.test(app.googlePackage)) throw new Error('Invalid Google package');
      for (const kind of ['installs', 'ratings', 'crashes']) {
        const dir = join(stage, 'google', kind, app.googlePackage);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const result = JSON.parse(await run('gplay', ['reports', 'stats', 'download', '--bucket-id', bucket, '--package', app.googlePackage, '--type', kind, '--from', from, '--to', day.slice(0, 7), '--dir', dir]));
        // Current gplay serializes an empty Go slice as null, not []. Only
        // accept that documented-by-runtime form with matching request metadata.
        if (result.files === null && result.package === app.googlePackage && result.type === kind && result.from === from && result.to === day.slice(0, 7)) result.files = [];
        if (!Array.isArray(result.files)) throw new Error('Google download manifest missing files');
        let overviewFiles = 0;
        for (const file of result.files) {
          if (!file.path || !resolve(file.path).startsWith(resolve(dir) + '/')) throw new Error('Google report file outside staging directory');
          const bytes = await readFile(file.path);
          if (basename(file.path).endsWith('_overview.csv')) {
            parseDelimited(decodeReport(bytes), ','); overviewFiles++;
          }
          await appendSnapshot(join(root, 'history/google-play/snapshots', day, runId, kind, app.googlePackage, basename(file.path)), bytes);
        }
        checks.push({ source: 'google', id: app.communityId, kind, status: overviewFiles ? 'available' : 'not-yet-available', overviewFiles });
      }
      // D-3 remains the requested cutoff even when Google is further behind.
      // A confirmed freshness rejection is missing data, never a zero rate
      // or permission to silently substitute an earlier requested cutoff.
      const vitalsEnd = new Date(Date.parse(day) - 3 * 86400000).toISOString().slice(0, 10);
      const vitalsStart = new Date(Date.parse(vitalsEnd) - 34 * 86400000).toISOString().slice(0, 10);
      for (const type of ['crash', 'anr']) {
        const args = ['vitals', 'crashes', 'query', '--package', app.googlePackage, '--type', type, '--from', vitalsStart, '--to', vitalsEnd, '--paginate'];
        let response = null, availability = null;
        try {
          const raw = await run('gplay', args);
          response = JSON.parse(raw);
          // 2026-11-11: gplay's --paginate now prints the collected rows themselves as an array (it used to print
          // { rows }). Same rows, so keep them as rows and record that shape; anything else is still invalid.
          if (Array.isArray(response)) response = { rows: response, cliShape: 'paginated-array' };
          if (response !== null && typeof response !== 'object') throw new Error('Google vitals response is invalid');
          if (response?.rows !== undefined && !Array.isArray(response.rows)) throw new Error('Google vitals response rows are invalid');
        } catch (error) {
          availability = googleVitalsPending('gplay', args, error);
          if (!availability) throw error;
        }
        const envelope = { schemaVersion: 1, collectedAt, package: app.googlePackage, id: app.communityId, type, from: vitalsStart, to: vitalsEnd, response, ...(availability ? { availability } : {}) };
        await appendSnapshot(join(root, 'history/google-play-vitals/snapshots', day, runId, type, `${app.googlePackage}.json`), JSON.stringify(envelope));
        checks.push({ source: 'google-vitals', id: app.communityId, kind: `${type}Rate`, status: availability ? 'not-yet-available' : response?.rows?.length ? 'available' : 'sample-insufficient', rows: availability ? null : response?.rows?.length || 0, ...(availability ? { requestedTo: vitalsEnd, freshnessEndExclusive: availability.freshnessEndExclusive, reason: availability.reason } : {}) });
      }
    }
    const windowStart = new Date(Date.parse(day) - 35 * 86400000).toISOString().slice(0, 10);
    const appleStart = weekly ? '2026-08-01' : windowStart;
    for (const date of daysBetween(appleStart, end)) {
      const path = join(stage, `${date}.tsv.gz`);
      const metadata = JSON.parse(await run('asc', ['analytics', 'sales', '--vendor', vendor, '--type', 'SALES', '--subtype', 'SUMMARY', '--frequency', 'DAILY', '--date', date, '--allow-missing', '--output', path]));
      if (metadata.available === false) { checks.push({ source: 'apple', date, status: 'not-yet-available' }); continue; }
      const bytes = await readFile(path);
      parseDelimited(decodeReport(bytes), '\t');
      await appendSnapshot(join(root, 'history/app-store/sales/snapshots', runId, `${date}.tsv.gz`), bytes);
      checks.push({ source: 'apple', date, status: 'available' });
    }
    const revenue = await admob({ start: weekly ? '2026-01-01' : windowStart, end, output: join(root, 'admob-current.json'), historyRoot: join(root, 'history/admob'), inventoryOutput: join(root, 'admob-apps.json') });
    checks.push({ source: 'admob', status: 'available', start: revenue.start, end: revenue.end });
    const manifest = { schemaVersion: 2, status: 'succeeded', collectedAt, day, stage, checks };
    await atomicWrite(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await atomicWrite(output, JSON.stringify(manifest, null, 2));
    return manifest;
  } catch (error) {
    await atomicWrite(join(stage, 'manifest.json'), JSON.stringify({ schemaVersion: 2, status: 'failed', collectedAt, day, checks, error: error.message }, null, 2));
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const day = process.argv[2] || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const root = ROOT;
  try {
    const result = await collectHistory({ day, root, catalogPath: process.env.AIHANKAPPS_REPORT_CATALOG || new URL('../app-catalog.json', import.meta.url), output: join(root, 'history-collection-latest.json'), weekly: new Date(`${day}T00:00:00Z`).getUTCDay() === 1 });
    console.log(JSON.stringify({ status: result.status, day: result.day, checks: result.checks.length, stage: result.stage }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
