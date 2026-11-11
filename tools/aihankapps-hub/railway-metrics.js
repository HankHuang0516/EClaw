'use strict';

// Railway 後台資源（Hank 2026-11-11「管理中樞還需要知道後台相關上傳／下載的流量」「再多提供各種數據監控」）.
// For every service in the production environment of each project below: data received (uploads: photos, listings,
// anything users send) and sent (downloads: pages, images, photos), CPU, memory, volume space and the latest
// deployment's status. Read from Railway's own metrics API with this Mac's Railway CLI login; read-only queries only.
// The session token is used in memory for those requests and is never printed, stored or sent anywhere else.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const API = 'https://backboard.railway.com/graphql/v2';
const HOUR = 3600000, DAY = 86400000, TZ = 8 * HOUR;
const DAYS = 30, HOURS = 24;

// service name → the portfolio apps it serves; the first app carries the service's traffic in the per-app series.
// Services not listed still appear in the resource table, attributed to no app.
const PROJECTS = [
  { projectId: '844a6139-9b8f-43d6-a698-f97db1fa05c0', project: 'EClaw',
    apps: { eclaw: ['eclawbot', 'dreambuddy'], Postgres: ['eclawbot'], 'postgres-pgvector': ['eclawbot'], 'claude-cli-proxy': ['eclawbot'], 'signal-cli-rest-api': ['eclawbot'] } },
  { projectId: 'c4bb972e-46b8-4e54-a9d1-5d38f619879a', project: 'Wishlist.ai', apps: { 'wishlist-app': ['weesh'], Postgres: ['weesh'] } },
  { projectId: '02c061a3-6cae-4261-b916-30857a9648f3', project: '時光相簿', apps: { Timehunt: ['timehut'] } },
  { projectId: '642452f8-405c-4d07-8565-bd409a136fe8', project: 'REBOUND', apps: { 'rebound-api': ['rebound'], Postgres: ['rebound'] } },
  { projectId: '68db2b85-9ead-420e-abec-587eb84b41b1', project: '活字戰紀與其他遊戲',
    apps: { 'summit-battle-api': ['summit-battle', 'typeforge-twin-cities'], 'leaderboard-api': ['typeforge-twin-cities'], 'leaderboard-backup': ['typeforge-twin-cities'],
      'doomsday-score-api': ['doomsday-index'], 'vibe-empire-bata': ['vibe-empire'] } },
];

// [Railway measurement, field, scale to MB or vCPU, how hours make a day, decimals]
const MEASURES = [['NETWORK_RX_GB', 'netInMb', 1024, 'sum', 3], ['NETWORK_TX_GB', 'netOutMb', 1024, 'sum', 3],
  ['CPU_USAGE', 'cpu', 1, 'avg', 4], ['MEMORY_USAGE_GB', 'memMb', 1024, 'avg', 1]];

const STRUCTURE = `query($id: String!) { project(id: $id) {
  environments { edges { node { id name serviceInstances { edges { node { serviceId serviceName latestDeployment { status createdAt } } } } } } }
  volumes { edges { node { volumeInstances { edges { node { serviceId environmentId sizeMB currentSizeMB } } } } } } } }`;
const METRICS = `query($projectId: String!, $environmentId: String!, $startDate: DateTime!, $endDate: DateTime!, $measurements: [MetricMeasurement!]!) {
  metrics(projectId: $projectId, environmentId: $environmentId, startDate: $startDate, endDate: $endDate, measurements: $measurements, groupBy: [SERVICE_ID], sampleRateSeconds: 3600) {
    measurement tags { serviceId } values { ts value } } }`;

const round = (value, digits) => { const f = 10 ** digits; return Math.round(value * f) / f; };
const isoDay = index => new Date(index * DAY).toISOString().slice(0, 10);

// The CLI keeps a session token that lasts about an hour; any CLI command refreshes it.
function readToken({ spawn = spawnSync, home = os.homedir() } = {}) {
  spawn('railway', ['whoami'], { encoding: 'utf8', timeout: 30000 });
  try {
    const token = JSON.parse(fs.readFileSync(path.join(home, '.railway', 'config.json'), 'utf8')).user.accessToken;
    return typeof token === 'string' && token.length > 20 ? token : null;
  } catch (_error) {
    return null;
  }
}

function client(token, fetchImpl = fetch) {
  return async (query, variables) => {
    const response = await fetchImpl(API, { method: 'POST', body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(60000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'aihankapps-hub-collector/1.0' } });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.errors || !body.data) throw new Error('railway_api_' + (response.ok ? 'error' : response.status));
    return body.data;
  };
}

// → { series: daily netInMb / netOutMb per app, facts: [], notes, infra: one row per production service }
async function collectRailway({ now = Date.now(), gql, projects = PROJECTS }) {
  const out = { series: [], facts: [], notes: [], infra: [] };
  const today = Math.floor((now + TZ) / DAY), firstDay = today - DAYS;          // DAYS complete Taipei days, ending yesterday
  const hourEnd = Math.floor(now / HOUR) * HOUR, hourStart = hourEnd - HOURS * HOUR;   // HOURS complete hours
  const perApp = {};
  for (const p of projects) {
    let structure;
    try { structure = (await gql(STRUCTURE, { id: p.projectId })).project; } catch (_error) { out.notes.push(p.project + '：讀不到服務清單'); continue; }
    const env = ((structure && structure.environments && structure.environments.edges) || []).map(e => e.node).find(e => e && e.name === 'production');
    if (!env) { out.notes.push(p.project + '：沒有 production 環境'); continue; }
    const volumes = {};
    for (const v of (structure.volumes && structure.volumes.edges) || []) {
      for (const vi of (v.node.volumeInstances && v.node.volumeInstances.edges) || []) {
        const n = vi.node;
        if (!n || n.environmentId !== env.id || !n.serviceId) continue;
        const acc = volumes[n.serviceId] || (volumes[n.serviceId] = { usedMb: 0, sizeMb: 0 });
        acc.usedMb += Number(n.currentSizeMB) || 0;
        acc.sizeMb += Number(n.sizeMB) || 0;
      }
    }
    const byService = {};
    try {
      const data = await gql(METRICS, { projectId: p.projectId, environmentId: env.id, startDate: new Date(firstDay * DAY - TZ).toISOString(),
        endDate: new Date(hourEnd).toISOString(), measurements: MEASURES.map(m => m[0]) });
      for (const m of data.metrics || []) {
        const id = m && m.tags && m.tags.serviceId;
        if (id) (byService[id] || (byService[id] = {}))[m.measurement] = m.values || [];
      }
    } catch (_error) {
      out.notes.push(p.project + '：讀不到流量與資源數據');
    }
    for (const si of ((env.serviceInstances && env.serviceInstances.edges) || []).map(e => e.node)) {
      if (!si || typeof si.serviceId !== 'string' || typeof si.serviceName !== 'string') continue;
      const apps = (p.apps[si.serviceName] || []).slice(0, 4);
      const samples = byService[si.serviceId] || {};
      const daily = { start: isoDay(firstDay) }, hourly = { start: hourStart, step: HOUR };
      for (const [measurement, key, scale, kind, digits] of MEASURES) {
        daily[key] = new Array(DAYS).fill(null);
        hourly[key] = new Array(HOURS).fill(null);
        const days = {};
        for (const point of samples[measurement] || []) {
          const at = Number(point.ts) * 1000, value = Number(point.value);
          if (!Number.isFinite(at) || !Number.isFinite(value) || value < 0) continue;
          const d = Math.floor((at + TZ) / DAY) - firstDay;
          if (d >= 0 && d < DAYS) { const a = days[d] || (days[d] = { sum: 0, n: 0 }); a.sum += value * scale; a.n += 1; }
          const h = Math.round((at - hourStart) / HOUR);
          if (h >= 0 && h < HOURS) hourly[key][h] = round(value * scale, digits);
        }
        for (const [d, a] of Object.entries(days)) daily[key][d] = round(kind === 'sum' ? a.sum : a.sum / a.n, digits);
      }
      const deployment = si.latestDeployment;
      const volume = volumes[si.serviceId];
      out.infra.push({ id: si.serviceId, name: si.serviceName.slice(0, 80), project: p.project, apps,
        deploy: deployment ? { status: String(deployment.status || '').slice(0, 20), at: Date.parse(deployment.createdAt) || null } : null,
        volume: volume && volume.sizeMb > 0 ? { usedMb: round(volume.usedMb, 1), sizeMb: round(volume.sizeMb, 1) } : null, hourly, daily });
      if (apps[0]) {
        const a = perApp[apps[0]] || (perApp[apps[0]] = { netInMb: new Array(DAYS).fill(null), netOutMb: new Array(DAYS).fill(null) });
        for (const key of ['netInMb', 'netOutMb']) daily[key].forEach((v, i) => { if (v !== null) a[key][i] = round((a[key][i] || 0) + v, 3); });
      }
    }
  }
  for (const [app, v] of Object.entries(perApp)) {
    for (const key of ['netInMb', 'netOutMb']) if (v[key].some(x => x !== null)) out.series.push({ app, metric: key, start: isoDay(firstDay), values: v[key] });
  }
  return out;
}

const RAILWAY_APPS = [...new Set(PROJECTS.flatMap(p => Object.values(p.apps).flat()))];

module.exports = { PROJECTS, RAILWAY_APPS, MEASURES, readToken, client, collectRailway };
