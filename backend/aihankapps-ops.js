/**
 * AiHankApps 營運數據 (operations data) — collector + read API for the
 * portfolio page /AiHankApps/ops/ (Hank, 2026-11-10: "worker CPU 跟量化數據波形圖"
 * and "wishlist.ai 的所有開放數據 上架數/cp數 的波形圖", a page at the same level as
 * APP 趨勢).
 *
 * Sources (all public, key-free, GET only; hosts are hard-coded literals so
 * nothing from a request can select a host or path):
 *   - MiniMax worker monitor  https://minimax-monitor.eclawbot.com/api/monitor/public/
 *       status, cpu-history, work-summary, work-history, wishlist-chat-pending
 *   - Wishlist listing report https://wishlist-app-production.up.railway.app/api/public/listing-report
 *
 * The monitor keeps CPU samples for 24 hours and work counts for 7 days, the
 * listing report 90 days of hourly points, so this module keeps its own copy in
 * Postgres: minute points ('m', raw observations, pruned after RAW_KEEP_DAYS)
 * and hourly points ('h', kept). Day and month views are aggregated from the
 * hourly points at query time in Asia/Taipei. Gauges (CPU %, memory, stock
 * counts) average inside a bucket and keep the peak; counts (listings, finished
 * tasks) sum. A value the source does not know stays absent — nothing is
 * zero-filled or interpolated here either.
 */

'use strict';

const crypto = require('crypto');
const express = require('express');

const MONITOR_BASE = 'https://minimax-monitor.eclawbot.com/api/monitor/public/';
const WISHLIST_BASE = 'https://wishlist-app-production.up.railway.app/api/public/';
// A descriptive UA: the Cloudflare edge in front of eclawbot.com refuses empty or default client UAs (error 1010).
const OUTBOUND_UA = 'aihankapps-ops-collector/1.0 (+https://eclawbot.com/AiHankApps/ops/)';
// The monitor answers through a Cloudflare tunnel to a Mac; a day of CPU history (550 KB) took more than 20 s from
// Railway on 2026-11-10, so big requests get a longer limit and the bootstrap falls back to a shorter window.
const FETCH_TIMEOUT_MS = 30000, BIG_FETCH_TIMEOUT_MS = 90000;
const RAW_KEEP_DAYS = 14;
const TIME_ZONE = 'Asia/Taipei';
const MAX_IDS = 24, MAX_POINTS = 3000, ID_PATTERN = /^[a-z][a-zA-Z0-9_.-]{0,80}$/;
const GAUGE = 'gauge', COUNT = 'count';
const STEP_MS = { minute: 60000, hour: 3600000, day: 86400000, month: 30 * 86400000 };

// Series that exist regardless of what the monitor reports; worker CPU and work
// series are added from the monitor's own catalog (see catalogFrom()).
const STATIC_SERIES = [
    { id: 'cpu.total.core', group: 'cpu', kind: GAUGE, unit: '%core', label: '全部 worker CPU', note: '100 = 一顆核心全忙；多執行緒可超過 100。只在每個 worker 都量到時才有值。' },
    { id: 'cpu.total.host', group: 'cpu', kind: GAUGE, unit: '%host', label: '全部 worker CPU（整機）', note: '100 = 整台 Mac 的每顆核心都忙。' },
    { id: 'wishlist.listed', group: 'wishlist', kind: COUNT, unit: 'item', label: '成功上架', note: '每筆紀錄最早的公開事件，重新公開不計。' },
    { id: 'wishlist.republished', group: 'wishlist', kind: COUNT, unit: 'item', label: '重新公開（不計入上架）' },
    { id: 'wishlist.visible', group: 'wishlist', kind: GAUGE, unit: 'item', label: '公開可見商品數' },
    { id: 'wishlist.published', group: 'wishlist', kind: GAUGE, unit: 'item', label: '已公開紀錄數' },
    { id: 'wishlist.waiting', group: 'wishlist', kind: GAUGE, unit: 'item', label: '待公開（私人暫存）' },
    { id: 'wishlist.withdrawn', group: 'wishlist', kind: GAUGE, unit: 'item', label: '已下架紀錄數' },
    { id: 'wishlist.chatPending', group: 'wishlist', kind: GAUGE, unit: 'inquiry', label: '聊聊待問', note: '等待核准或等待轉達的買家詢問；最多延遲約 2 小時。' },
];
const LISTING_GAUGES = [
    ['wishlist.visible', j => j.live && j.live.publiclyVisible && j.live.publiclyVisible.count],
    ['wishlist.published', j => j.live && j.live.records && j.live.records.published],
    ['wishlist.waiting', j => j.live && j.live.waitingToPublish && j.live.waitingToPublish.count],
    ['wishlist.withdrawn', j => j.live && j.live.records && j.live.records.withdrawn],
];

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ms = v => { const n = typeof v === 'string' ? Date.parse(v) : v; return Number.isFinite(n) && n > 0 ? n : null; };

// ---- turning the sources' answers into points ---------------------------------------------------------------------
// Each parser is pure and returns { points: [{ series, at, value }], ... }. Only numbers the source states as
// measured become points: a null total, an hour that is still in progress, or a stale summary is left out.

function cpuPoints(json) {
    const points = [], workers = {};
    for (const w of Array.isArray(json && json.workers) ? json.workers : []) if (w && typeof w.id === 'string' && ID_PATTERN.test('cpu.' + w.id)) workers[w.id] = String(w.name || w.id).slice(0, 80);
    for (const p of Array.isArray(json && json.points) ? json.points : []) {
        const at = ms(p && p.at); if (!at) continue;
        for (const [axis, key] of [['core', 'cpuCorePercent'], ['host', 'cpuHostPercent']]) {
            const total = p.total && num(p.total[key]);
            if (total !== null) points.push({ series: 'cpu.total.' + axis, at, value: total });
            for (const [id, v] of Object.entries(p.workers || {})) {
                const value = v && num(v[key]);
                if (value !== null && ID_PATTERN.test('cpu.' + id)) points.push({ series: 'cpu.' + id + '.' + axis, at, value });
            }
        }
    }
    return { points, workers };
}

function workPoints(json) {
    const points = [], catalog = [];
    for (const s of Array.isArray(json && json.series) ? json.series : []) {
        if (!s || typeof s.workerId !== 'string' || typeof s.metric !== 'string') continue;
        const id = 'work.' + s.workerId + '.' + s.metric;
        if (!ID_PATTERN.test(id)) continue;
        catalog.push({ id, group: 'work', kind: COUNT, worker: s.workerId, workerName: String(s.workerName || s.workerId).slice(0, 80), metric: s.metric,
            label: String(s.label || s.metric).slice(0, 80), unit: String(s.unit || '').slice(0, 30), measured: s.measured !== false });
    }
    for (const p of Array.isArray(json && json.points) ? json.points : []) {
        const at = ms(p && p.at); if (!at) continue;
        for (const [worker, metrics] of Object.entries(p.workers || {})) {
            for (const [metric, v] of Object.entries(metrics || {})) {
                // "complete" hours are exact (and may be 0); every other coverage leaves count null on purpose.
                if (!v || v.coverage !== 'complete') continue;
                const value = num(v.count), id = 'work.' + worker + '.' + metric;
                if (value !== null && ID_PATTERN.test(id)) points.push({ series: id, at, value });
            }
        }
    }
    return { points, catalog };
}

function workSummary(json) {
    const catalog = [], totals = {};
    for (const w of Array.isArray(json && json.workers) ? json.workers : []) {
        if (!w || typeof w.id !== 'string') continue;
        for (const m of Array.isArray(w.metrics) ? w.metrics : []) {
            if (!m || typeof m.id !== 'string') continue;
            const id = 'work.' + w.id + '.' + m.id;
            if (!ID_PATTERN.test(id)) continue;
            catalog.push({ id, group: 'work', kind: COUNT, worker: w.id, workerName: String(w.name || w.id).slice(0, 80), metric: m.id,
                label: String(m.label || m.id).slice(0, 80), unit: String(m.unit || '').slice(0, 30), measured: m.measured !== false,
                definition: typeof m.definition === 'string' ? m.definition.slice(0, 400) : undefined });
            const c = m.cumulative || {};
            totals[id] = { sinceCollectionStart: num(c.sinceCollectionStart), knownTotalLowerBound: num(c.knownTotalLowerBound), isCompleteHistory: c.isCompleteHistory === true,
                collectionStartedAt: ms(m.collectionStartedAt), lastCompletedAt: ms(m.lastCompletedAt) };
            const window60 = m.last60Minutes;
            if (window60 && ms(window60.from) && ms(window60.to) && window60.to - window60.from === 3600000 && ['complete', 'partial', 'in_progress', 'not_observed', 'not_measured'].includes(window60.coverage)) {
                const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
                totals[id].last60Minutes = { from: window60.from, to: window60.to, coverage: window60.coverage,
                    count: window60.coverage === 'complete' ? count(window60.count) : null, lowerBound: count(window60.lowerBound), fresh: window60.fresh === true };
            }
        }
    }
    return { catalog, totals };
}

function listingPoints(json) {
    const hourly = [], gauges = [];
    const asOf = ms(json && json.asOf);
    for (const p of Array.isArray(json && json.hourly && json.hourly.points) ? json.hourly.points : []) {
        const at = ms(p && p.hourStart);
        if (!at || p.covered !== true) continue;
        const listed = num(p.firstPublished), re = num(p.republishedNotCounted);
        if (listed !== null) hourly.push({ series: 'wishlist.listed', at, value: listed });
        if (re !== null) hourly.push({ series: 'wishlist.republished', at, value: re });
    }
    if (asOf) for (const [series, pick] of LISTING_GAUGES) { const value = num(pick(json)); if (value !== null) gauges.push({ series, at: asOf, value }); }
    const s = (json && json.successfulListings) || {}, live = (json && json.live) || {}, rates = (json && json.measuredRates) || {};
    const summary = {
        asOf, coverageFrom: ms(json && json.coverage && json.coverage.from), freshness: json && json.freshness ? String(json.freshness.state || '') : '',
        today: s.today ? { date: s.today.date, count: num(s.today.count), partial: s.today.partial === true } : null,
        yesterday: s.yesterday ? { date: s.yesterday.date, count: num(s.yesterday.count) } : null,
        last60Minutes: s.last60Minutes ? num(s.last60Minutes.count) : null,
        cumulative: s.cumulative ? { from: ms(s.cumulative.from), count: num(s.cumulative.count) } : null,
        perHour24h: rates.last24CompleteHours ? num(rates.last24CompleteHours.perHour) : null,
        perHour168h: rates.last168CompleteHours ? num(rates.last168CompleteHours.perHour) : null,
        targetPerHour: json && json.target && json.target.state === 'available' ? num(json.target.perHour) : null,
        publiclyVisible: live.publiclyVisible ? num(live.publiclyVisible.count) : null,
        records: live.records ? { total: num(live.records.total), published: num(live.records.published), privatePending: num(live.records.privatePending), withdrawn: num(live.records.withdrawn) } : null,
        waitingToPublish: live.waitingToPublish ? num(live.waitingToPublish.count) : null,
        latestFirstPublishAt: ms(json && json.freshness && json.freshness.latestFirstPublishAt),
    };
    return { hourly, gauges, summary };
}

function chatPendingPoint(json) {
    const at = ms(json && json.observedAt), value = num(json && json.pendingCount);
    if (!json || json.status !== 'ok' || !at || value === null) return { points: [], summary: null };
    return { points: [{ series: 'wishlist.chatPending', at, value }], summary: { observedAt: at, pendingCount: value, needApproval: num(json.needApproval), approvedWaitingSend: num(json.approvedWaitingSend) } };
}

// The monitor's issue codes (monitor 1.7.0+): fixed codes and times only, never error text.
const ISSUE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const issueCodes = list => (Array.isArray(list) ? list.filter(c => typeof c === 'string' && ISSUE_CODE.test(c)).slice(0, 12) : []);
const issueDetails = list => (Array.isArray(list) ? list.filter(d => d && typeof d.code === 'string' && ISSUE_CODE.test(d.code)).slice(0, 12)
    .map(d => ({ code: d.code, since: ms(d.since), nextAttemptAt: ms(d.nextAttemptAt), httpStatus: Number.isInteger(d.httpStatus) && d.httpStatus >= 100 && d.httpStatus <= 599 ? d.httpStatus : null })) : []);

function statusSnapshot(json) {
    if (!json || !Array.isArray(json.workers)) return null;
    return {
        checkedAt: ms(json.checkedAt), observedAt: ms(json.observedAt), dataFresh: json.dataFresh === true, health: String(json.health || ''), monitorStatus: json.monitor ? String(json.monitor.status || '') : '',
        workers: json.workers.filter(w => w && typeof w.id === 'string').map(w => ({ id: w.id, name: String(w.name || w.id).slice(0, 80), health: String(w.health || ''), processOnline: w.processOnline === true,
            cpuCorePercent: num(w.cpuCorePercent), cpuHostPercent: num(w.cpuHostPercent), memoryBytes: num(w.memoryBytes), coverage: String(w.coverage || ''),
            issues: issueCodes(w.issues), issueDetails: issueDetails(w.issueDetails) })),
        recordedCounts: json.recordedCounts && typeof json.recordedCounts === 'object' ? Object.fromEntries(Object.entries(json.recordedCounts).map(([k, v]) => [k, num(v)])) : null,
    };
}

// The catalog served to the page: static series, one CPU pair per worker the monitor lists, and the work series
// the monitor describes. Labels come from the monitor so renaming a worker there renames it here.
function catalogFrom(meta) {
    const workers = (meta && meta.workers) || {}, work = Array.isArray(meta && meta.workCatalog) ? meta.workCatalog : [];
    const series = STATIC_SERIES.map(s => ({ ...s }));
    for (const [id, name] of Object.entries(workers)) {
        series.push({ id: 'cpu.' + id + '.core', group: 'cpu', kind: GAUGE, unit: '%core', label: name, worker: id, workerName: name });
        series.push({ id: 'cpu.' + id + '.host', group: 'cpu', kind: GAUGE, unit: '%host', label: name + '（整機）', worker: id, workerName: name });
    }
    for (const w of work) series.push({ ...w });
    return series;
}

// ---- storage ---------------------------------------------------------------------------------------------------------
const preparations = new WeakMap();
function prepare(pool) {
    if (!pool) return Promise.reject(new Error('Database unavailable'));
    if (!preparations.has(pool)) {
        const promise = (async () => {
            await pool.query(`CREATE TABLE IF NOT EXISTS aihankapps_ops_points (
                series TEXT NOT NULL,
                step   CHAR(1) NOT NULL CHECK (step IN ('m', 'h')),
                at     TIMESTAMPTZ NOT NULL,
                value  DOUBLE PRECISION NOT NULL,
                peak   DOUBLE PRECISION,
                n      INTEGER NOT NULL DEFAULT 1 CHECK (n >= 1),
                PRIMARY KEY (series, step, at)
            )`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_aihankapps_ops_points_step_at ON aihankapps_ops_points (step, at)`);
            await pool.query(`CREATE TABLE IF NOT EXISTS aihankapps_ops_meta (
                key        TEXT PRIMARY KEY,
                value      JSONB NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`);
        })().catch(error => { preparations.delete(pool); throw error; });
        preparations.set(pool, promise);
    }
    return preparations.get(pool);
}

async function upsertPoints(pool, step, points) {
    let written = 0;
    for (let i = 0; i < points.length; i += 400) {
        const chunk = points.slice(i, i + 400), values = [], params = [];
        chunk.forEach((p, k) => {
            params.push(p.series, step, new Date(p.at), p.value, p.peak === undefined ? null : p.peak, p.n === undefined ? 1 : p.n);
            const b = k * 6; values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`);
        });
        const r = await pool.query(`INSERT INTO aihankapps_ops_points (series, step, at, value, peak, n) VALUES ${values.join(', ')}
            ON CONFLICT (series, step, at) DO UPDATE SET value = EXCLUDED.value, peak = EXCLUDED.peak, n = EXCLUDED.n`, params);
        written += r.rowCount || 0;
    }
    return written;
}

// Hourly rows for gauges are the average (and peak) of the minute points in that hour; recomputed for every hour
// the new points touched, so a late observation still corrects its hour.
async function rollupHours(pool, seriesIds, fromMs) {
    if (!seriesIds.length) return 0;
    const r = await pool.query(`INSERT INTO aihankapps_ops_points (series, step, at, value, peak, n)
        SELECT series, 'h', date_trunc('hour', at), AVG(value), MAX(COALESCE(peak, value)), COUNT(*)
        FROM aihankapps_ops_points WHERE step = 'm' AND series = ANY($1) AND at >= date_trunc('hour', $2::timestamptz)
        GROUP BY series, date_trunc('hour', at)
        ON CONFLICT (series, step, at) DO UPDATE SET value = EXCLUDED.value, peak = EXCLUDED.peak, n = EXCLUDED.n`, [seriesIds, new Date(fromMs)]);
    return r.rowCount || 0;
}

async function setMeta(pool, key, value) {
    await pool.query(`INSERT INTO aihankapps_ops_meta (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, JSON.stringify(value)]);
}
async function getMeta(pool) {
    const r = await pool.query(`SELECT key, value, updated_at FROM aihankapps_ops_meta`);
    const meta = {}; for (const row of r.rows) meta[row.key] = row.value; meta.__updatedAt = Object.fromEntries(r.rows.map(row => [row.key, row.updated_at]));
    return meta;
}
async function pruneRaw(pool) {
    const r = await pool.query(`DELETE FROM aihankapps_ops_points WHERE step = 'm' AND at < NOW() - ($1 || ' days')::interval`, [String(RAW_KEEP_DAYS)]);
    return r.rowCount || 0;
}
// How much of the last seven days the monitor actually observed (hours with a complete CPU total), measured from the
// first stored hour when the table is younger than a week, so a fresh deployment is not reported as downtime.
async function observation7d(pool, now = Date.now()) {
    const first = await pool.query(`SELECT MIN(at) AS first FROM aihankapps_ops_points WHERE step = 'h' AND series = 'cpu.total.core'`);
    const firstAt = first.rows[0] && first.rows[0].first ? new Date(first.rows[0].first).getTime() : null;
    if (!firstAt) return null;
    const windowStart = Math.max(now - 7 * 86400000, Math.floor(firstAt / 3600000) * 3600000);
    const windowHours = Math.max(1, Math.floor((now - windowStart) / 3600000));
    const r = await pool.query(`SELECT COUNT(DISTINCT at)::int AS hours FROM aihankapps_ops_points WHERE step = 'h' AND series = 'cpu.total.core' AND at >= $1 AND at < $2`,
        [new Date(windowStart), new Date(Math.floor(now / 3600000) * 3600000)]);
    const observedHours = Math.min(windowHours, r.rows[0] ? r.rows[0].hours : 0);
    return { observedHours, windowHours, rate: Math.round(observedHours / windowHours * 1000) / 1000, since: new Date(windowStart).toISOString() };
}
async function countPoints(pool) {
    const r = await pool.query(`SELECT step, COUNT(*)::int AS n, MIN(at) AS first, MAX(at) AS last FROM aihankapps_ops_points GROUP BY step`);
    return Object.fromEntries(r.rows.map(row => [row.step, { n: row.n, first: row.first, last: row.last }]));
}

// ---- collecting --------------------------------------------------------------------------------------------------------
async function getJson(url, fetchImpl, timeoutMs = FETCH_TIMEOUT_MS) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': OUTBOUND_UA, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) throw new Error('HTTP_' + res.status);
    return res.json();
}

function createCollector(getPool, { fetchImpl = (...a) => globalThis.fetch(...a), log = console, now = Date.now } = {}) {
    const state = { runs: {}, errors: {}, lastOk: {} };
    const guard = async (name, fn) => {
        const pool = getPool();
        if (!pool) return;
        state.runs[name] = (state.runs[name] || 0) + 1;
        try {
            await prepare(pool);
            const out = await fn(pool);
            state.lastOk[name] = now(); delete state.errors[name];
            return out;
        } catch (error) {
            state.errors[name] = { at: now(), message: String(error && error.message || error).slice(0, 200) };
            log.error('[AiHankAppsOps] ' + name + ' failed:', String(error && error.message || error));
        }
    };

    // CPU: minute points for the requested window (the monitor serves 720 points at most), then hourly averages.
    const collectCpu = (minutes = 20, stepMinutes = 1) => guard('cpu', async pool => {
        const json = await getJson(MONITOR_BASE + 'cpu-history?minutes=' + minutes + '&stepMinutes=' + stepMinutes, fetchImpl, minutes > 60 ? BIG_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS);
        const { points, workers } = cpuPoints(json);
        if (Object.keys(workers).length) await setMeta(pool, 'workers', workers);
        if (!points.length) return { points: 0 };
        await upsertPoints(pool, 'm', points);
        const from = Math.min(...points.map(p => p.at));
        await rollupHours(pool, [...new Set(points.map(p => p.series))], from);
        await setMeta(pool, 'cpuFreshness', { checkedAt: ms(json.checkedAt), latestObservedAt: ms(json.freshness && json.freshness.latestObservedAt), dataFresh: !!(json.freshness && json.freshness.dataFresh), monitorStatus: json.freshness ? String(json.freshness.monitorStatus || '') : '' });
        return { points: points.length };
    });

    const collectStatus = () => guard('status', async pool => {
        const snap = statusSnapshot(await getJson(MONITOR_BASE + 'status', fetchImpl));
        if (!snap) throw new Error('STATUS_SHAPE');
        await setMeta(pool, 'latestStatus', snap);
        const at = snap.observedAt || snap.checkedAt, points = [];
        if (at) for (const w of snap.workers) if (w.memoryBytes !== null && ID_PATTERN.test('mem.' + w.id)) points.push({ series: 'mem.' + w.id, at, value: w.memoryBytes });
        if (points.length) { await upsertPoints(pool, 'm', points); await rollupHours(pool, points.map(p => p.series), at); }
        return { workers: snap.workers.length };
    });

    // Work: exact hourly counts (complete hours only) plus the monitor's own catalog and running totals.
    const collectWork = (hours = 48) => guard('work', async pool => {
        const summary = workSummary(await getJson(MONITOR_BASE + 'work-summary', fetchImpl));
        const history = workPoints(await getJson(MONITOR_BASE + 'work-history?hours=' + hours, fetchImpl, hours > 48 ? BIG_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS));
        const catalog = summary.catalog.length ? summary.catalog : history.catalog;
        if (catalog.length) await setMeta(pool, 'workCatalog', catalog);
        await setMeta(pool, 'workTotals', { at: now(), totals: summary.totals });
        if (history.points.length) await upsertPoints(pool, 'h', history.points);
        return { points: history.points.length, series: catalog.length };
    });

    const collectListing = (hours = 72) => guard('listing', async pool => {
        const { hourly, gauges, summary } = listingPoints(await getJson(WISHLIST_BASE + 'listing-report?hours=' + hours, fetchImpl, hours > 168 ? BIG_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS));
        if (hourly.length) await upsertPoints(pool, 'h', hourly);
        if (gauges.length) { await upsertPoints(pool, 'm', gauges); await rollupHours(pool, gauges.map(p => p.series), gauges[0].at); }
        await setMeta(pool, 'listingSummary', { ...summary, fetchedAt: now() });
        return { hourly: hourly.length, gauges: gauges.length };
    });

    const collectChat = () => guard('chat', async pool => {
        const { points, summary } = chatPendingPoint(await getJson(MONITOR_BASE + 'wishlist-chat-pending', fetchImpl));
        if (points.length) { await upsertPoints(pool, 'm', points); await rollupHours(pool, ['wishlist.chatPending'], points[0].at); }
        if (summary) await setMeta(pool, 'chatPending', { ...summary, fetchedAt: now() });
        return { points: points.length };
    });

    const prune = () => guard('prune', pool => pruneRaw(pool));

    // First run on an empty table: reach as far back as the sources go (CPU 24 h at 2-minute steps, work 7 days,
    // listings 90 days). Later runs only refresh the recent window.
    const bootstrap = () => guard('bootstrap', async pool => {
        const counts = await countPoints(pool);
        const empty = !counts.m && !counts.h;
        // A day of CPU first; when that is too slow for the tunnel, six hours, then the usual 20 minutes.
        if (empty) { for (const [m, step] of [[1440, 2], [360, 1], [20, 1]]) if (await collectCpu(m, step)) break; }
        else await collectCpu(20, 1);
        await collectStatus();
        await collectWork(empty ? 168 : 48);
        await collectListing(empty ? 2160 : 72);
        await collectChat();
        return { empty };
    });

    return { collectCpu, collectStatus, collectWork, collectListing, collectChat, prune, bootstrap, state };
}

let scheduled = null;
function startCollector(getPool, options = {}) {
    if (scheduled) return scheduled;
    const collector = createCollector(getPool, options);
    const cron = options.cron || require('node-cron');
    const jobs = [
        cron.schedule('*/5 * * * *', () => collector.collectCpu(20, 1)),
        cron.schedule('2-59/5 * * * *', () => collector.collectStatus()),
        cron.schedule('7,37 * * * *', () => collector.collectWork(48)),
        cron.schedule('9,39 * * * *', () => collector.collectListing(72)),
        cron.schedule('4,34 * * * *', () => collector.collectChat()),
        cron.schedule('13 4 * * *', () => collector.prune()),
    ];
    const timer = setTimeout(() => { collector.bootstrap(); }, options.bootstrapDelayMs === undefined ? 15000 : options.bootstrapDelayMs);
    if (timer.unref) timer.unref();
    scheduled = { collector, jobs, stop() { for (const j of jobs) j.stop(); clearTimeout(timer); scheduled = null; } };
    return scheduled;
}

// ---- reading -------------------------------------------------------------------------------------------------------------
function parseSeriesQuery(query) {
    const q = query || {};
    const ids = String(q.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length || ids.length > MAX_IDS || ids.some(id => !ID_PATTERN.test(id))) return { error: 'INVALID_IDS' };
    const step = String(q.step || 'hour');
    if (!STEP_MS[step]) return { error: 'INVALID_STEP' };
    const to = q.to === undefined ? Date.now() : Number(q.to), from = q.from === undefined ? to - 24 * STEP_MS.hour : Number(q.from);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) return { error: 'INVALID_RANGE' };
    if (step === 'minute' && to - from > RAW_KEEP_DAYS * 86400000) return { error: 'RANGE_TOO_WIDE_FOR_MINUTE' };
    if ((to - from) / STEP_MS[step] > MAX_POINTS) return { error: 'TOO_MANY_POINTS' };
    return { ids: [...new Set(ids)], from: Math.floor(from), to: Math.ceil(to), step };
}

async function readSeries(pool, { ids, from, to, step }, catalog) {
    const kinds = Object.fromEntries(catalog.map(s => [s.id, s.kind]));
    const series = Object.fromEntries(ids.map(id => [id, { kind: kinds[id] || (id.startsWith('work.') || id.startsWith('wishlist.listed') || id.startsWith('wishlist.republished') ? COUNT : GAUGE), points: [] }]));
    const range = [ids, new Date(from), new Date(to)];
    if (step === 'minute' || step === 'hour') {
        const r = await pool.query(`SELECT series, at, value, peak FROM aihankapps_ops_points WHERE step = $4 AND series = ANY($1) AND at >= $2 AND at < $3 ORDER BY at`, [...range, step === 'minute' ? 'm' : 'h']);
        for (const row of r.rows) series[row.series].points.push([new Date(row.at).getTime(), row.value, row.peak === null ? undefined : row.peak].filter(v => v !== undefined));
    } else {
        // Taipei days and months: truncate in local time, then express the bucket start as an instant again.
        const r = await pool.query(`SELECT series, (date_trunc($4, at AT TIME ZONE $5) AT TIME ZONE $5) AS bucket,
                SUM(value) AS total, AVG(value) AS mean, MAX(COALESCE(peak, value)) AS peak, SUM(n)::int AS n
            FROM aihankapps_ops_points WHERE step = 'h' AND series = ANY($1) AND at >= $2 AND at < $3
            GROUP BY series, bucket ORDER BY bucket`, [...range, step, TIME_ZONE]);
        for (const row of r.rows) {
            const s = series[row.series];
            s.points.push(s.kind === COUNT ? [new Date(row.bucket).getTime(), Number(row.total)] : [new Date(row.bucket).getTime(), Number(row.mean), Number(row.peak)]);
        }
    }
    return series;
}

const rates = new Map();
function limited(req) {
    const now = Date.now();
    if (rates.size >= 5000) for (const [key, value] of rates) if (value.until <= now) rates.delete(key);
    const key = crypto.createHash('sha256').update(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').digest('hex');
    let rate = rates.get(key);
    if (!rate || rate.until <= now) {
        if (rates.size >= 5000 && !rate) return true;
        rate = { count: 0, until: now + 60000 }; rates.set(key, rate);
    }
    return ++rate.count > 120;
}

function createRouter(getPool) {
    const router = express.Router();
    router.use((req, res, next) => {
        if (limited(req)) return res.status(429).set('Retry-After', '60').json({ success: false, errorCode: 'RATE_LIMIT' });
        res.set('Cache-Control', 'public, max-age=30');
        next();
    });
    const withPool = handler => async (req, res) => {
        try {
            const pool = getPool();
            await prepare(pool);
            await handler(pool, req, res);
        } catch (error) {
            console.error('[AiHankAppsOps] read failed:', error.message);
            res.status(503).set('Cache-Control', 'no-store').json({ success: false, errorCode: 'OPS_UNAVAILABLE' });
        }
    };
    router.get('/catalog', withPool(async (pool, _req, res) => {
        const meta = await getMeta(pool), counts = await countPoints(pool);
        res.json({ success: true, schemaVersion: 1, timeZone: TIME_ZONE, rawKeepDays: RAW_KEEP_DAYS, series: catalogFrom(meta),
            coverage: { minute: counts.m || null, hour: counts.h || null }, updatedAt: meta.__updatedAt || {} });
    }));
    router.get('/latest', withPool(async (pool, _req, res) => {
        const meta = await getMeta(pool), observation = await observation7d(pool);
        res.json({ success: true, schemaVersion: 1, timeZone: TIME_ZONE, status: meta.latestStatus || null, cpuFreshness: meta.cpuFreshness || null,
            listing: meta.listingSummary || null, chatPending: meta.chatPending || null, workTotals: meta.workTotals || null, observation7d: observation, updatedAt: meta.__updatedAt || {} });
    }));
    router.get('/series', withPool(async (pool, req, res) => {
        const parsed = parseSeriesQuery(req.query);
        if (parsed.error) return res.status(400).set('Cache-Control', 'no-store').json({ success: false, errorCode: parsed.error });
        const meta = await getMeta(pool);
        const series = await readSeries(pool, parsed, catalogFrom(meta));
        res.json({ success: true, schemaVersion: 1, timeZone: TIME_ZONE, step: parsed.step, from: parsed.from, to: parsed.to, series });
    }));
    return router;
}

module.exports = { createRouter, startCollector, createCollector, prepare, observation7d, cpuPoints, workPoints, workSummary, listingPoints, chatPendingPoint, statusSnapshot, catalogFrom, parseSeriesQuery, readSeries, upsertPoints, rollupHours, STATIC_SERIES, RAW_KEEP_DAYS, OUTBOUND_UA };
