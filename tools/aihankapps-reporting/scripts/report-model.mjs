import { EXPECTED_PUBLISHER, daysBetween, fingerprint, isoDate, sumKnown } from './report-core.mjs';
import { catalogIndex, periodTotal } from './store-history.mjs';

// Stable IDs, never substring matches. Legacy Android river-valley ID verified
// against word-civilization-td GoogleMobileAdsSettings and Android bundle ID.
export const ADMOB_IDENTITIES = {
  '2230429700': 'sleep-park', '2333927943': 'doomsday-index',
  '2507482566': 'weesh', '2622802630': 'doomsday-index',
  '3112657148': 'chumen', '4995505484': 'sleep-park',
  '3214882892': 'typeforge-twin-cities',
  '5265110405': 'property-roi', '5681375504': 'rebound',
  '7982940527': 'chumen', '8379714200': 'weesh',
  '8662678942': 'typeforge-twin-cities', '9673514301': 'property-roi',
};
const priority = category => ({ '\u904a\u6232': 0, '\u516c\u76ca': 1, '\u751f\u6d3b': 2 })[category] ?? 3;

export function revenueIdentityMap(inventory, catalog, identities = ADMOB_IDENTITIES) {
  const index = catalogIndex(catalog), map = new Map(), seen = new Set();
  for (const app of inventory) {
    if (!app.appId?.startsWith(`ca-app-${EXPECTED_PUBLISHER}~`) || !['ANDROID', 'IOS'].includes(app.platform) || seen.has(app.appId)) throw new Error('Invalid AdMob inventory provenance');
    seen.add(app.appId);
    const store = app.linkedAppInfo?.appStoreId;
    const linked = store ? (app.platform === 'ANDROID' ? index.google : index.apple).get(String(store)) : null;
    const configured = identities[app.appId.split('~')[1]];
    if (linked && configured && linked !== configured) throw new Error('AdMob configured identity conflicts with linked store');
    const id = linked || configured;
    if (id && !index.ids.has(id)) throw new Error('AdMob mapping references missing portfolio app');
    map.set(app.appId, { id: id || null, platform: app.platform });
  }
  return map;
}

function metric(points, start, end) {
  const sorted = points.map(point => ({ date: point.date, value: point.value })).sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(sorted.map(point => point.date)).size !== sorted.length) throw new Error('Duplicate metric date');
  for (const point of sorted) {
    isoDate(point.date);
    if (point.date > end || (point.value !== null && !Number.isFinite(point.value))) throw new Error('Invalid metric observation');
  }
  return {
    points: sorted, historyTotal: sumKnown(sorted.map(point => point.value)),
    historyStart: sorted[0]?.date || null, historyEnd: sorted.at(-1)?.date || null,
    last7: periodTotal(sorted, start, end),
  };
}

export function buildReportModel({ catalog, history, inventory, reviews = null, generatedAt, end, identities }) {
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('Missing build timestamp');
  end = isoDate(end);
  const start = new Date(Date.parse(`${end}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
  const index = catalogIndex(catalog);
  const mapping = revenueIdentityMap(inventory, catalog, identities);
  if (history.revenue.currency !== 'TWD') throw new Error('Public revenue must be TWD');
  const revenueDays = history.revenue.days.filter(date => date <= end);
  const eligible = new Set([...mapping.values()].map(value => value.id).filter(Boolean));
  const revenue = new Map([...eligible].map(id => [id, new Map(revenueDays.map(date => [date, 0]))]));
  const unallocated = new Map(revenueDays.map(date => [date, 0]));
  const publisher = new Map(revenueDays.map(date => [date, 0]));
  for (const row of history.revenue.rows) {
    if (row.date > end) continue;
    if (!publisher.has(row.date)) throw new Error('Revenue observation outside coverage');
    const target = mapping.get(row.appId);
    if (target && row.platform && target.platform !== row.platform) throw new Error('AdMob revenue platform mismatch');
    publisher.set(row.date, sumKnown([publisher.get(row.date), row.micros]));
    const bucket = target?.id ? revenue.get(target.id) : unallocated;
    bucket.set(row.date, sumKnown([bucket.get(row.date), row.micros]));
  }
  const moneyPoints = values => [...values].map(([date, micros]) => ({ date, value: micros / 1e6 }));
  const appMetrics = (points, id) => metric(points.filter(point => point.id === id && point.date <= end), start, end);
  const apps = [...catalog.apps].sort((a, b) => priority(a.category) - priority(b.category) || a.name.localeCompare(b.name, 'zh-TW')).map(app => {
    const stability = history.google.stability.filter(point => point.id === app.communityId && point.date <= end);
    const ratings = history.google.ratings.filter(point => point.id === app.communityId && point.date <= end && point.value !== null).sort((a, b) => a.date.localeCompare(b.date));
    return {
      id: app.communityId, name: app.name, category: app.category,
      platforms: { google: Boolean(app.googlePackage), apple: Boolean(app.iosId) },
      googleInstalls: appMetrics(history.google.installs, app.communityId),
      appleDownloads: appMetrics(history.apple.points, app.communityId),
      admobRevenue: metric(revenue.has(app.communityId) ? moneyPoints(revenue.get(app.communityId)) : [], start, end),
      crashes: metric(stability.map(point => ({ date: point.date, value: point.crashes })), start, end),
      anrs: metric(stability.map(point => ({ date: point.date, value: point.anrs })), start, end),
      googleRating: ratings.length ? { date: ratings.at(-1).date, value: ratings.at(-1).value } : null,
    };
  });
  if (apps.length !== index.ids.size) throw new Error('Public catalog parity failure');
  // Verify conservation in integer micros before displaying decimal currency.
  for (const date of revenueDays) {
    if (sumKnown([unallocated.get(date), ...[...revenue.values()].map(values => values.get(date))]) !== publisher.get(date)) throw new Error('Revenue attribution reconciliation failed');
  }
  const aggregate = field => {
    const days = [...new Set(apps.flatMap(app => app[field].points.map(point => point.date)))].sort();
    const lookup = apps.map(app => new Map(app[field].points.map(point => [point.date, point.value])));
    const result = metric(days.map(date => ({ date, value: sumKnown(lookup.map(values => values.get(date))) })), start, end);
    const eligibleApps = apps.filter(app => field === 'appleDownloads' ? app.platforms.apple : app.platforms.google);
    const observedAppDays = eligibleApps.reduce((total, app) => total + app[field].last7.coveredDays, 0);
    const expectedAppDays = eligibleApps.length * 7;
    result.last7 = { ...result.last7, observedAppDays, expectedAppDays,
      complete: expectedAppDays > 0 && observedAppDays === expectedAppDays };
    return result;
  };
  const model = {
    schemaVersion: 2, mode: 'real', generatedAt, catalogCheckedAt: catalog.checkedAt || null,
    period: { start, end, days: daysBetween(start, end).length }, currency: 'TWD',
    units: { googleInstalls: 'daily-user-installs', appleDownloads: 'first-download-units', admobRevenue: 'TWD', crashes: 'events', anrs: 'events' },
    apps, reviews,
    totals: { googleInstalls: aggregate('googleInstalls'), appleDownloads: aggregate('appleDownloads'), admobRevenue: metric(moneyPoints(publisher), start, end), unallocatedRevenue: metric(moneyPoints(unallocated), start, end), crashes: aggregate('crashes'), anrs: aggregate('anrs') },
    coverage: {
      appleDays: history.apple.days, revenueDays,
      googleInstallAppCount: apps.filter(app => app.googleInstalls.points.length).length,
      appleDownloadAppCount: apps.filter(app => app.appleDownloads.points.length).length,
      unmappedAppleCount: history.apple.unmapped.length, unmappedGoogleCount: history.google.unmapped.length,
      unallocatedAdmobAppCount: new Set(history.revenue.rows.filter(row => !mapping.get(row.appId)?.id).map(row => row.appId)).size,
    },
    notes: [
      'Google daily user installs and Apple first-download units are separate metrics, not unique people across platforms.',
      'Totals are observed values only; missing days remain unknown, not zero. Historical totals cover collected reports, not guaranteed lifetime totals.',
      'AdMob estimated revenue is TWD. Unallocated legacy revenue remains visible in account totals rather than being guessed or discarded.',
      'Crash and ANR figures are event counts, not money or crash-free percentages. Missing stability data does not mean no crashes.',
    ],
  };
  return { ...model, contentHash: fingerprint(model) };
}
