/**
 * AiHankApps 管理中樞 — the numbers the hub keeps itself (Hank, 2026-11-10: "接下來你全部接起來 … 完整接上").
 *
 * 1. Service probes. Once a minute this server asks each back-end's public health URL and records whether it
 *    answered and how long it took: five-minute buckets for 14 days, hourly buckets for 400 days. The URLs are
 *    hard-coded below; nothing from a request can choose a host or a path.
 *
 * 2. Imported back-end numbers. The game servers, Wishlist and other back-ends live in their own projects and
 *    databases, which this server cannot reach. An operator's collector (tools/aihankapps-hub) reads daily counts
 *    inside each back-end's own container and hands them over through the existing deployment channel
 *    (scripts/aihankapps-hub-import.js). There is no HTTP write API, and only counts cross over: no account,
 *    device or message content. The two per-account details (拾光's thUser… and Weesh's wlUser… facts) add a
 *    display name and a masked sign-in address to their counts; AIHANKAPPS_HUB.md says exactly what.
 *
 * Everything lives in four tables of the hub's own (aihankapps_hub_*); no existing table is written.
 */

'use strict';

const DAY_MS = 86400000, HOUR_MS = 3600000, BUCKET_MS = 5 * 60000, TAIPEI_OFFSET_MS = 8 * HOUR_MS;
const RECENT_BUCKETS = 288, DAILY_DAYS = 90;                 // what the page gets: 24 hours of buckets, 90 days of days
const KEEP_BUCKET_DAYS = 14, KEEP_HOUR_DAYS = 400;
const PROBE_TIMEOUT_MS = 10000;
const PROBE_UA = 'aihankapps-hub-probe/1.0 (+https://eclawbot.com/AiHankApps/)';
const MAX_IMPORT_BYTES = 512 * 1024, MAX_SERIES = 200, MAX_VALUES = 800, MAX_FACTS = 200, MAX_FACT_BYTES = 8192;
const IMPORT_SOURCE = /^[a-z][a-z0-9-]{1,30}$/, FACT_KEY = /^[a-z][a-zA-Z0-9]{1,40}$/, ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// Daily series a collector may hand over. The page knows each of these by name.
const IMPORT_METRICS = ['newUsers', 'activeUsers', 'plays', 'purchases', 'purchaseTwd', 'messages', 'listings', 'mailSent', 'mailClaimed', 'aiUses', 'netInMb', 'netOutMb'];
// Per-service resources from the Railway collector (2026-11-11): traffic, CPU, memory, space, latest deployment.
const MAX_INFRA = 80, INFRA_FIELDS = ['netInMb', 'netOutMb', 'cpu', 'memMb'];
const DEPLOY_STATES = ['SUCCESS', 'FAILED', 'CRASHED', 'BUILDING', 'DEPLOYING', 'INITIALIZING', 'QUEUED', 'WAITING', 'REMOVED', 'REMOVING', 'SLEEPING', 'SKIPPED'];
const SERVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isOk = body => !!body && body.ok === true;
const text = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : null);
// `healthy` judges the JSON the service's own health route gives; without it, answering 200 is enough.
const SERVICES = [
    { id: 'eclaw', name: 'EClaw 主站', apps: ['eclawbot', 'dreambuddy'], url: 'https://eclawbot.com/api/health', healthy: body => !!body && body.status === 'ok', info: body => text(body.build, 40) },
    { id: 'wishlist', name: 'Wishlist.ai', apps: ['weesh'], url: 'https://wishlist-app-production.up.railway.app/' },
    { id: 'rebound', name: 'REBOUND 遊戲伺服器', apps: ['rebound'], url: 'https://rebound-api-production-801c.up.railway.app/health', healthy: isOk },
    { id: 'summit', name: '活字戰紀對戰伺服器', apps: ['typeforge-twin-cities', 'summit-battle'], url: 'https://summit-battle-api-production.up.railway.app/health', healthy: isOk, info: body => text(body.version, 40) },
    { id: 'leaderboard', name: '雙城烽火排行榜', apps: ['typeforge-twin-cities'], url: 'https://leaderboard-api-production-3ec9.up.railway.app/health', healthy: isOk },
    { id: 'timehut', name: '時光相簿後台', apps: ['timehut'], url: 'https://just-healing-production.up.railway.app/health', healthy: body => !!body && body.status === 'ok', info: body => text(body.version, 40) },
    { id: 'monitor', name: 'AI worker 監控', apps: [], url: 'https://minimax-monitor.eclawbot.com/api/monitor/public/status', healthy: body => !!body && Array.isArray(body.workers), info: body => text(body.version, 40) },
];

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS aihankapps_hub_probes (
        service TEXT NOT NULL, step CHAR(1) NOT NULL CHECK (step IN ('q', 'h')), at TIMESTAMPTZ NOT NULL,
        checks INTEGER NOT NULL, failures INTEGER NOT NULL, ms_total DOUBLE PRECISION NOT NULL, ms_peak DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (service, step, at))`,
    `CREATE TABLE IF NOT EXISTS aihankapps_hub_daily (
        app_id TEXT NOT NULL, metric TEXT NOT NULL, day DATE NOT NULL, value DOUBLE PRECISION NOT NULL CHECK (value >= 0), source TEXT NOT NULL,
        PRIMARY KEY (app_id, metric, day))`,
    `CREATE TABLE IF NOT EXISTS aihankapps_hub_facts (
        app_id TEXT NOT NULL, key TEXT NOT NULL, value JSONB NOT NULL, source TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (app_id, key))`,
    `CREATE TABLE IF NOT EXISTS aihankapps_hub_sources (
        id TEXT PRIMARY KEY, collected_at TIMESTAMPTZ NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), detail JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS aihankapps_hub_infra (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, value JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL)`,
];
const preparations = new WeakMap();
function prepare(pool) {
    if (!pool) return Promise.reject(new Error('POOL_UNAVAILABLE'));
    if (!preparations.has(pool)) {
        const promise = (async () => { for (const sql of SCHEMA) await pool.query(sql); })().catch(error => { preparations.delete(pool); throw error; });
        preparations.set(pool, promise);
    }
    return preparations.get(pool);
}

const dayIndex = iso => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS);
const isoDay = index => new Date(index * DAY_MS).toISOString().slice(0, 10);
const round = (value, digits) => { const f = 10 ** digits; return Math.round(value * f) / f; };

// ---- probes -----------------------------------------------------------------------------------------------------------
async function probeOne(service, { fetchImpl = fetch, now = Date.now } = {}) {
    const at = now();
    try {
        const response = await fetchImpl(service.url, { headers: { 'User-Agent': PROBE_UA, Accept: 'application/json, text/html;q=0.5' }, redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        let ok = response.status === 200, info = null;
        if (ok && service.healthy) {
            let body = null;
            try { body = await response.json(); } catch (_) { body = null; }
            ok = !!service.healthy(body);
            if (ok && service.info) info = service.info(body);
        } else if (response.body && typeof response.body.cancel === 'function') {
            Promise.resolve(response.body.cancel()).catch(() => {});       // a page's body is not needed
        }
        return { id: service.id, ok, status: response.status, ms: Math.max(0, now() - at), at, info };
    } catch (error) {
        return { id: service.id, ok: false, status: 0, ms: Math.max(0, now() - at), at, info: null };
    }
}

function createProbes({ getPool, fetchImpl, now = Date.now, services = SERVICES }) {
    const latest = new Map();
    let running = false, scheduled = null, lastError = '';
    async function store(results) {
        const pool = getPool();
        await prepare(pool);
        const cols = [[], [], [], [], [], [], []];
        for (const r of results) {
            for (const [step, size] of [['q', BUCKET_MS], ['h', HOUR_MS]]) {
                [r.id, step, new Date(Math.floor(r.at / size) * size), 1, r.ok ? 0 : 1, r.ok ? r.ms : 0, r.ok ? r.ms : 0].forEach((v, i) => cols[i].push(v));
            }
        }
        await pool.query(`INSERT INTO aihankapps_hub_probes (service, step, at, checks, failures, ms_total, ms_peak)
            SELECT * FROM UNNEST($1::text[], $2::text[], $3::timestamptz[], $4::int[], $5::int[], $6::float8[], $7::float8[])
            ON CONFLICT (service, step, at) DO UPDATE SET checks = aihankapps_hub_probes.checks + EXCLUDED.checks,
                failures = aihankapps_hub_probes.failures + EXCLUDED.failures, ms_total = aihankapps_hub_probes.ms_total + EXCLUDED.ms_total,
                ms_peak = GREATEST(aihankapps_hub_probes.ms_peak, EXCLUDED.ms_peak)`, cols);
    }
    // One round: ask every service at once, remember the answers, then record them. A database that is not
    // ready costs the record, not the answer the page shows.
    async function run() {
        if (running) return null;
        running = true;
        try {
            const results = await Promise.all(services.map(service => probeOne(service, { fetchImpl, now })));
            for (const r of results) latest.set(r.id, r);
            try { await store(results); lastError = ''; } catch (error) {
                if (error.message !== lastError) console.error('[AiHankAppsHub] probe record failed:', error.message);
                lastError = error.message;
            }
            return results;
        } finally { running = false; }
    }
    async function prune() {
        try {
            const pool = getPool();
            await prepare(pool);
            await pool.query(`DELETE FROM aihankapps_hub_probes WHERE (step = 'q' AND at < NOW() - INTERVAL '${KEEP_BUCKET_DAYS} days') OR (step = 'h' AND at < NOW() - INTERVAL '${KEEP_HOUR_DAYS} days')`);
        } catch (error) { console.error('[AiHankAppsHub] probe prune failed:', error.message); }
    }
    return {
        run, prune,
        // What the page shows as "now": the last answer of each service, or ok: null before the first round.
        latest: () => services.map(s => { const r = latest.get(s.id); return { id: s.id, name: s.name, apps: s.apps, ok: r ? r.ok : null, status: r ? r.status : null, ms: r ? r.ms : null, at: r ? r.at : null, info: r ? r.info : null }; }),
        start(options = {}) {
            if (scheduled) return scheduled;
            const cron = options.cron || require('node-cron');
            const jobs = [cron.schedule('* * * * *', () => { run(); }), cron.schedule('23 4 * * *', () => { prune(); })];
            const timer = setTimeout(() => { run(); }, options.firstRunDelayMs === undefined ? 20000 : options.firstRunDelayMs);
            if (timer.unref) timer.unref();
            scheduled = { jobs, stop() { for (const job of jobs) job.stop(); clearTimeout(timer); scheduled = null; } };
            return scheduled;
        },
    };
}

// For the data answer: per service, 24 hours of five-minute buckets and 90 Taipei days. `query` runs inside the
// caller's read-only transaction. A bucket without a check is null (this server was not running), not "down".
async function readProbes(query, nowMs, services = SERVICES) {
    const recentFrom = Math.floor(nowMs / BUCKET_MS) * BUCKET_MS - (RECENT_BUCKETS - 1) * BUCKET_MS;
    const todayIndex = Math.floor((nowMs + TAIPEI_OFFSET_MS) / DAY_MS), firstDay = todayIndex - DAILY_DAYS + 1;
    const recent = (await query("SELECT service, at, checks, failures, ms_total FROM aihankapps_hub_probes WHERE step = 'q' AND at >= $1", [new Date(recentFrom)])).rows;
    const days = (await query(`SELECT service, (at AT TIME ZONE 'Asia/Taipei')::date::text AS day, SUM(checks)::int AS checks, SUM(failures)::int AS failures, SUM(ms_total)::float8 AS ms_total
        FROM aihankapps_hub_probes WHERE step = 'h' AND at >= $1 GROUP BY 1, 2`, [new Date(firstDay * DAY_MS - TAIPEI_OFFSET_MS)])).rows;
    const up = row => (row.checks ? round((row.checks - row.failures) / row.checks * 100, 2) : null);
    const ms = row => (row.checks > row.failures ? Math.round(row.ms_total / (row.checks - row.failures)) : null);
    return services.map(service => {
        const out = { id: service.id, name: service.name, apps: service.apps,
            recent: { from: recentFrom, step: BUCKET_MS, up: new Array(RECENT_BUCKETS).fill(null), ms: new Array(RECENT_BUCKETS).fill(null) },
            daily: { start: isoDay(firstDay), up: new Array(DAILY_DAYS).fill(null), ms: new Array(DAILY_DAYS).fill(null) } };
        const sum = { checks: 0, failures: 0 };
        for (const row of recent) {
            if (row.service !== service.id) continue;
            const i = Math.round((new Date(row.at).getTime() - recentFrom) / BUCKET_MS);
            if (i < 0 || i >= RECENT_BUCKETS) continue;
            out.recent.up[i] = up(row); out.recent.ms[i] = ms(row);
            sum.checks += row.checks; sum.failures += row.failures;
        }
        out.uptime24h = up(sum);
        const windows = { 7: { checks: 0, failures: 0 }, 30: { checks: 0, failures: 0 }, 90: { checks: 0, failures: 0 } };
        for (const row of days) {
            if (row.service !== service.id || !ISO_DAY.test(row.day)) continue;
            const i = dayIndex(row.day) - firstDay;
            if (i < 0 || i >= DAILY_DAYS) continue;
            out.daily.up[i] = up(row); out.daily.ms[i] = ms(row);
            for (const span of [7, 30, 90]) if (i >= DAILY_DAYS - span) { windows[span].checks += row.checks; windows[span].failures += row.failures; }
        }
        out.uptime7d = up(windows[7]); out.uptime30d = up(windows[30]); out.uptime90d = up(windows[90]);
        return out;
    });
}

// ---- imported back-end numbers ----------------------------------------------------------------------------------------
function fail(code) { const error = new Error(code); error.code = code; throw error; }

// { schemaVersion: 1, source, collectedAt, series: [{ app, metric, start: 'YYYY-MM-DD', values: [n | null, …] }],
//   facts: [{ app, key, value: {…} }], notes: [short strings] } → rows ready to store. Anything unexpected is refused whole.
function validateEnvelope(envelope, appIds) {
    const known = appIds instanceof Set ? appIds : new Set(appIds || []);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) fail('IMPORT_SHAPE');
    if (Object.keys(envelope).some(key => !['schemaVersion', 'source', 'collectedAt', 'series', 'facts', 'notes', 'infra', 'quota'].includes(key))) fail('IMPORT_SHAPE');
    if (envelope.schemaVersion !== 1 || typeof envelope.source !== 'string' || !IMPORT_SOURCE.test(envelope.source)) fail('IMPORT_SOURCE');
    const collectedAt = envelope.collectedAt;
    if (!Number.isSafeInteger(collectedAt) || collectedAt < Date.UTC(2026, 0, 1) || collectedAt > Date.now() + HOUR_MS) fail('IMPORT_TIME');
    const series = envelope.series === undefined ? [] : envelope.series, facts = envelope.facts === undefined ? [] : envelope.facts;
    if (!Array.isArray(series) || series.length > MAX_SERIES || !Array.isArray(facts) || facts.length > MAX_FACTS) fail('IMPORT_SHAPE');
    const lastDay = Math.floor((collectedAt + TAIPEI_OFFSET_MS) / DAY_MS), rows = [], seen = new Set();
    for (const item of series) {
        if (!item || typeof item !== 'object' || !known.has(item.app) || !IMPORT_METRICS.includes(item.metric)) fail('IMPORT_SERIES');
        if (typeof item.start !== 'string' || !ISO_DAY.test(item.start) || !Array.isArray(item.values) || item.values.length < 1 || item.values.length > MAX_VALUES) fail('IMPORT_SERIES');
        if (seen.has(item.app + '\n' + item.metric)) fail('IMPORT_SERIES');
        seen.add(item.app + '\n' + item.metric);
        const first = dayIndex(item.start);
        if (isoDay(first) !== item.start || first + item.values.length - 1 > lastDay) fail('IMPORT_SERIES');      // a real date, and nothing in the future
        item.values.forEach((value, i) => {
            if (value === null) return;
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12) fail('IMPORT_VALUE');
            rows.push({ app: item.app, metric: item.metric, day: isoDay(first + i), value });
        });
    }
    const cleanFacts = facts.map(item => {
        if (!item || typeof item !== 'object' || !known.has(item.app) || typeof item.key !== 'string' || !FACT_KEY.test(item.key)) fail('IMPORT_FACT');
        if (!item.value || typeof item.value !== 'object' || Array.isArray(item.value) || JSON.stringify(item.value).length > MAX_FACT_BYTES) fail('IMPORT_FACT');
        return { app: item.app, key: item.key, value: item.value };
    });
    if (new Set(cleanFacts.map(f => f.app + '\n' + f.key)).size !== cleanFacts.length) fail('IMPORT_FACT');
    const notes = envelope.notes === undefined ? [] : envelope.notes;
    if (!Array.isArray(notes) || notes.length > 20 || notes.some(note => typeof note !== 'string' || note.length > 200)) fail('IMPORT_SHAPE');
    const infra = envelope.infra === undefined ? undefined : validateInfra(envelope.infra, known, lastDay);
    const quota = envelope.quota === undefined ? undefined : validateQuota(envelope.quota);
    return { source: envelope.source, collectedAt, rows, facts: cleanFacts, notes, infra, quota };
}

// A usage meter that belongs to no app (Claude's plan limits, read on the operator's Mac without a model call):
// { plan?, windows: [{ id, label, usedPct, resetsAt, resetsText? }] }. Percentages and times only.
function validateQuota(quota) {
    if (!quota || typeof quota !== 'object' || Array.isArray(quota) || Object.keys(quota).some(k => !['plan', 'windows'].includes(k))) fail('IMPORT_QUOTA');
    if (quota.plan !== undefined && (typeof quota.plan !== 'string' || !quota.plan || quota.plan.length > 40)) fail('IMPORT_QUOTA');
    if (!Array.isArray(quota.windows) || quota.windows.length < 1 || quota.windows.length > 8) fail('IMPORT_QUOTA');
    const ids = new Set();
    const windows = quota.windows.map(w => {
        if (!w || typeof w !== 'object' || Object.keys(w).some(k => !['id', 'label', 'usedPct', 'resetsAt', 'resetsText'].includes(k))) fail('IMPORT_QUOTA');
        if (typeof w.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(w.id) || ids.has(w.id)) fail('IMPORT_QUOTA');
        ids.add(w.id);
        if (typeof w.label !== 'string' || !w.label || w.label.length > 80) fail('IMPORT_QUOTA');
        if (typeof w.usedPct !== 'number' || !Number.isFinite(w.usedPct) || w.usedPct < 0 || w.usedPct > 100) fail('IMPORT_QUOTA');
        if (w.resetsAt !== null && w.resetsAt !== undefined && (!Number.isSafeInteger(w.resetsAt) || w.resetsAt < Date.UTC(2026, 0, 1))) fail('IMPORT_QUOTA');
        if (w.resetsText !== undefined && (typeof w.resetsText !== 'string' || w.resetsText.length > 80)) fail('IMPORT_QUOTA');
        return { id: w.id, label: w.label, usedPct: w.usedPct, resetsAt: w.resetsAt === undefined ? null : w.resetsAt, ...(w.resetsText ? { resetsText: w.resetsText } : {}) };
    });
    return { ...(quota.plan ? { plan: quota.plan } : {}), windows };
}

// One row per service: { id, name, project, apps, deploy, volume, hourly, daily } with numbers only.
function validateInfra(list, known, lastDay) {
    if (!Array.isArray(list) || list.length > MAX_INFRA) fail('IMPORT_INFRA');
    const numbers = (values, max) => {
        if (!Array.isArray(values) || values.length < 1 || values.length > max) fail('IMPORT_INFRA');
        return values.map(v => {
            if (v === null) return null;
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e9) fail('IMPORT_INFRA');
            return v;
        });
    };
    const text = (v, max) => { if (typeof v !== 'string' || !v || v.length > max) fail('IMPORT_INFRA'); return v; };
    const ids = new Set();
    return list.map(row => {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !SERVICE_ID.test(row.id) || ids.has(row.id)) fail('IMPORT_INFRA');
        ids.add(row.id);
        if (!Array.isArray(row.apps) || row.apps.length > 4 || row.apps.some(app => !known.has(app))) fail('IMPORT_INFRA');
        let deploy = null;
        if (row.deploy !== null && row.deploy !== undefined) {
            if (typeof row.deploy !== 'object' || !DEPLOY_STATES.includes(row.deploy.status)) fail('IMPORT_INFRA');
            const at = row.deploy.at;
            if (at !== null && (!Number.isSafeInteger(at) || at < 0)) fail('IMPORT_INFRA');
            deploy = { status: row.deploy.status, at };
        }
        let volume = null;
        if (row.volume !== null && row.volume !== undefined) {
            const { usedMb, sizeMb } = row.volume || {};
            if (![usedMb, sizeMb].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9) || sizeMb <= 0) fail('IMPORT_INFRA');
            volume = { usedMb, sizeMb };
        }
        const h = row.hourly || {}, d = row.daily || {};
        if (!Number.isSafeInteger(h.start) || h.start <= 0 || h.step !== HOUR_MS) fail('IMPORT_INFRA');
        if (typeof d.start !== 'string' || !ISO_DAY.test(d.start) || isoDay(dayIndex(d.start)) !== d.start) fail('IMPORT_INFRA');
        const hourly = { start: h.start, step: HOUR_MS }, daily = { start: d.start };
        for (const key of INFRA_FIELDS) { hourly[key] = numbers(h[key], 48); daily[key] = numbers(d[key], 62); }
        if (new Set(INFRA_FIELDS.map(k => hourly[k].length)).size !== 1 || new Set(INFRA_FIELDS.map(k => daily[k].length)).size !== 1) fail('IMPORT_INFRA');
        if (dayIndex(d.start) + daily.netInMb.length - 1 > lastDay) fail('IMPORT_INFRA');      // nothing after the collection day
        return { id: row.id, name: text(row.name, 80), project: text(row.project, 80), apps: row.apps.slice(), deploy, volume, hourly, daily };
    });
}

// All or nothing: the daily values are upserted, this source's current facts are replaced, and the source's
// receipt is updated, in one transaction.
async function importEnvelope(pool, envelope, { appIds } = {}) {
    const clean = validateEnvelope(envelope, appIds);
    await prepare(pool);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (clean.rows.length) {
            await client.query(`INSERT INTO aihankapps_hub_daily (app_id, metric, day, value, source)
                SELECT * FROM UNNEST($1::text[], $2::text[], $3::date[], $4::float8[], $5::text[])
                ON CONFLICT (app_id, metric, day) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source`,
            [clean.rows.map(r => r.app), clean.rows.map(r => r.metric), clean.rows.map(r => r.day), clean.rows.map(r => r.value), clean.rows.map(() => clean.source)]);
        }
        await client.query('DELETE FROM aihankapps_hub_facts WHERE source = $1', [clean.source]);
        for (const fact of clean.facts) {
            await client.query(`INSERT INTO aihankapps_hub_facts (app_id, key, value, source, observed_at) VALUES ($1, $2, $3::jsonb, $4, $5)
                ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, observed_at = EXCLUDED.observed_at`,
            [fact.app, fact.key, JSON.stringify(fact.value), clean.source, new Date(clean.collectedAt)]);
        }
        if (clean.infra) {
            await client.query('DELETE FROM aihankapps_hub_infra WHERE source = $1', [clean.source]);
            for (const row of clean.infra) {
                await client.query(`INSERT INTO aihankapps_hub_infra (id, source, value, observed_at) VALUES ($1, $2, $3::jsonb, $4)
                    ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source, value = EXCLUDED.value, observed_at = EXCLUDED.observed_at`,
                [row.id, clean.source, JSON.stringify(row), new Date(clean.collectedAt)]);
            }
        }
        await client.query(`INSERT INTO aihankapps_hub_sources (id, collected_at, detail) VALUES ($1, $2, $3::jsonb)
            ON CONFLICT (id) DO UPDATE SET collected_at = EXCLUDED.collected_at, imported_at = NOW(), detail = EXCLUDED.detail`,
        [clean.source, new Date(clean.collectedAt), JSON.stringify({ values: clean.rows.length, facts: clean.facts.length, services: clean.infra ? clean.infra.length : undefined, notes: clean.notes, quota: clean.quota })]);
        await client.query('COMMIT');
        return { source: clean.source, values: clean.rows.length, facts: clean.facts.length, ...(clean.infra ? { services: clean.infra.length } : {}),
            ...(clean.quota ? { meters: clean.quota.windows.length } : {}) };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

// For the data answer, inside the caller's read-only transaction.
async function readImports(query, startIso) {
    const rows = (await query('SELECT app_id, metric, day::text AS day, value FROM aihankapps_hub_daily WHERE day >= $1::date', [startIso])).rows;
    const facts = (await query('SELECT app_id, key, value, source, observed_at FROM aihankapps_hub_facts')).rows;
    const sources = (await query('SELECT id, collected_at, imported_at, detail FROM aihankapps_hub_sources')).rows;
    const infra = (await query('SELECT id, source, value, observed_at FROM aihankapps_hub_infra')).rows;
    return { rows, facts, sources, infra };
}

module.exports = { SERVICES, IMPORT_METRICS, DEPLOY_STATES, MAX_IMPORT_BYTES, PROBE_UA, prepare, probeOne, createProbes, readProbes, validateEnvelope, importEnvelope, readImports };
