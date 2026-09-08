#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXPECTED_PUBLISHER, isoDate, daysBetween, normalizeAdmob } from './report-core.mjs';
import { atomicWrite, appendSnapshot } from './report-storage.mjs';

const ACCOUNT = `accounts/${EXPECTED_PUBLISHER}`;
const PRIVATE = '/Users/hank/.local/share/AiHankApps/analytics';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export function keychainValue(name) {
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-a', 'AiHankApps', '-s', 'com.aihankapps.admob.' + name, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { throw new Error(`AdMob credential unavailable: ${name}`); }
}
function json(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON from ${label}`); }
}

export async function collectAdmob(options, dependencies = {}) {
  const start = isoDate(options.start), end = isoDate(options.end);
  daysBetween(start, end);
  if (!options.output) throw new Error('A private output path is required');
  const fetcher = dependencies.fetch || fetch;
  const wait = dependencies.sleep || sleep;
  const keychain = dependencies.keychain || keychainValue;
  const write = dependencies.atomicWrite || atomicWrite;
  const append = dependencies.appendSnapshot || appendSnapshot;
  const now = dependencies.now || (() => new Date());
  if (keychain('publisher-id') !== EXPECTED_PUBLISHER) throw new Error('AdMob publisher mismatch; collection stopped');

  async function request(url, init, label) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try { response = await fetcher(url, { ...init, signal: AbortSignal.timeout(45000) }); }
      catch {
        if (attempt === 2) throw new Error(`${label} network request failed`);
        await wait(750 * 2 ** attempt); continue;
      }
      if (response.ok) return response.text();
      if ((response.status === 429 || response.status >= 500) && attempt < 2) { await wait(750 * 2 ** attempt); continue; }
      throw new Error(`${label} failed (HTTP ${response.status})`);
    }
    throw new Error(`${label} retry limit reached`);
  }
  const token = json(await request('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({
      client_id: keychain('oauth-client-id'), client_secret: keychain('oauth-client-secret'),
      refresh_token: keychain('refresh-token'), grant_type: 'refresh_token',
    }),
  }, 'AdMob authorization'), 'AdMob authorization');
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('AdMob authorization returned no token');
  const headers = { Authorization: 'Bearer ' + token.access_token };
  const account = json(await request('https://admob.googleapis.com/v1/' + ACCOUNT, { headers }, 'AdMob account'), 'AdMob account');
  if (account.name !== ACCOUNT || account.publisherId !== EXPECTED_PUBLISHER) throw new Error('AdMob account identity mismatch');
  if (typeof account.reportingTimeZone !== 'string' || !account.reportingTimeZone) throw new Error('AdMob reporting timezone missing');
  try { new Intl.DateTimeFormat('en', { timeZone: account.reportingTimeZone }).format(); }
  catch { throw new Error('AdMob reporting timezone invalid'); }

  const apps = [], ids = new Set(), pageTokens = new Set();
  let pageToken;
  do {
    const url = new URL('https://admob.googleapis.com/v1/' + ACCOUNT + '/apps');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = json(await request(url.href, { headers }, 'AdMob APP inventory'), 'AdMob APP inventory');
    if (page.apps !== undefined && !Array.isArray(page.apps)) throw new Error('Malformed AdMob APP inventory');
    for (const app of page.apps || []) {
      if (typeof app.appId !== 'string' || !app.appId.startsWith(`ca-app-${EXPECTED_PUBLISHER}~`)) throw new Error('AdMob APP inventory publisher mismatch');
      if (!['ANDROID', 'IOS'].includes(app.platform) || ids.has(app.appId)) throw new Error('Invalid or duplicate AdMob APP identity');
      ids.add(app.appId); apps.push(app);
    }
    pageToken = page.nextPageToken;
    if (pageToken) {
      if (typeof pageToken !== 'string' || pageTokens.has(pageToken)) throw new Error('AdMob pagination cycle');
      pageTokens.add(pageToken);
      if (pageTokens.size > 1000) throw new Error('AdMob inventory pagination limit');
    }
  } while (pageToken);
  const date = value => { const [year, month, day] = value.split('-').map(Number); return { year, month, day }; };
  const reportText = await request('https://admob.googleapis.com/v1/' + ACCOUNT + '/networkReport:generate', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportSpec: {
      dateRange: { startDate: date(start), endDate: date(end) },
      dimensions: ['DATE', 'APP', 'PLATFORM'],
      metrics: ['ESTIMATED_EARNINGS', 'AD_REQUESTS', 'MATCHED_REQUESTS', 'IMPRESSIONS', 'CLICKS', 'IMPRESSION_CTR', 'IMPRESSION_RPM'],
      localizationSettings: { currencyCode: 'TWD', languageCode: 'zh-TW' },
      maxReportRows: 100000,
      // Use the verified account default; do not label these days Asia/Taipei.
    } }),
  }, 'AdMob report');
  const report = normalizeAdmob(reportText);
  if (report.currency !== 'TWD') throw new Error('AdMob returned unexpected currency');
  if (report.start !== start || report.end !== end) throw new Error('AdMob returned unexpected range');
  for (const row of report.rows) {
    const app = apps.find(a => a.appId === row.appId);
    if (!app || (row.platform && row.platform !== app.platform)) throw new Error('AdMob report/inventory identity mismatch');
  }
  let rows;
  try { const value = JSON.parse(reportText); rows = Array.isArray(value) ? value : value.rows; }
  catch { rows = reportText.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  const collectedAt = now().toISOString();
  const envelope = { schemaVersion: 2, publisherId: EXPECTED_PUBLISHER, collectedAt,
    reportingTimeZone: account.reportingTimeZone, currency: 'TWD', range: { start, end },
    inventory: apps, rows };
  const bytes = JSON.stringify(envelope, null, 2) + '\n';
  const historyRoot = options.historyRoot || join(PRIVATE, 'history/admob');
  const historyPath = join(historyRoot, `${start}_${end}_TWD_${collectedAt.replaceAll(':', '-')}_${randomUUID()}.json`);
  // The immutable historical snapshot is written before any latest pointer.
  await append(historyPath, bytes);
  await write(options.inventoryOutput || join(PRIVATE, 'admob-apps.json'), JSON.stringify({ publisherId: EXPECTED_PUBLISHER, collectedAt, apps }, null, 2) + '\n');
  await write(options.output, bytes);
  return { historyPath, output: options.output, start, end, currency: 'TWD', reportingTimeZone: account.reportingTimeZone, rows: report.rows.length, apps: apps.length };
}

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--start', '--end', '--output', '--history-root', '--inventory-output']);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error('Invalid AdMob collector arguments');
    options[args[i]] = args[i + 1];
  }
  const end = options['--end'] || new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const result = await collectAdmob({ start: options['--start'] || end, end, output: options['--output'], historyRoot: options['--history-root'], inventoryOutput: options['--inventory-output'] });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
