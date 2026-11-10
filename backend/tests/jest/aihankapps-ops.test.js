/**
 * AiHankApps 營運數據: the collector's parsers, the read API's query rules, and the chart maths shared with the page.
 * Fixtures are trimmed copies of what the public endpoints answered on 2026-11-10.
 */
const express = require('express');
const http = require('http');
const ops = require('../../aihankapps-ops');
const math = require('../../public/AiHankApps/ops/ops-view.js');

const cpuHistory = {
    checkedAt: 1794268793639, freshness: { latestObservedAt: 1794268789853, dataFresh: true, monitorStatus: 'healthy' },
    workers: [{ id: 'minimax-runtime', name: 'MiniMax Code runtime' }, { id: 'wishlist-retail', name: 'Wishlist 原價與 CP 查找' }, { id: 'bad id', name: 'x' }],
    points: [
        { at: 1794264900000, total: { cpuHostPercent: 0.096, cpuCorePercent: 0.974 }, partialTotal: { cpuHostPercent: 0.096, cpuCorePercent: 0.974 },
            workers: { 'minimax-runtime': { cpuHostPercent: 0.039, cpuCorePercent: 0.389 }, 'wishlist-retail': { cpuHostPercent: 0, cpuCorePercent: 0 } } },
        { at: 1794265200000, total: { cpuHostPercent: null, cpuCorePercent: null }, partialTotal: { cpuHostPercent: 0.05, cpuCorePercent: 0.5 },
            workers: { 'minimax-runtime': { cpuHostPercent: null, cpuCorePercent: null }, 'wishlist-retail': { cpuHostPercent: 0.05, cpuCorePercent: 0.5 }, 'bad id': { cpuCorePercent: 1 } } },
        { at: 'nonsense', total: { cpuCorePercent: 3 } },
    ],
};
const workHistory = {
    series: [
        { workerId: 'wishlist-retail', workerName: 'Wishlist 原價與 CP 查找', metric: 'retail_cp_evaluated', label: '完成 CP 評估的商品', unit: 'product', measured: true },
        { workerId: 'timehut-shiguang', workerName: '時光相簿場景智慧標籤', metric: 'photos_tagged', label: '完成場景標籤的照片', unit: 'photo', measured: true },
    ],
    points: [
        { at: 1794247200000, workers: { 'wishlist-retail': { retail_cp_evaluated: { count: 3, lowerBound: 3, coverage: 'complete' } }, 'timehut-shiguang': { photos_tagged: { count: 0, lowerBound: 0, coverage: 'complete' } } } },
        { at: 1794250800000, workers: { 'wishlist-retail': { retail_cp_evaluated: { count: null, lowerBound: 2, coverage: 'in_progress' } }, 'timehut-shiguang': { photos_tagged: { count: null, lowerBound: 0, coverage: 'not_observed' } } } },
    ],
};
const workSummary = { workers: [{ id: 'wishlist-retail', name: 'Wishlist 原價與 CP 查找', measured: true, metrics: [
    { id: 'retail_cp_evaluated', label: '完成 CP 評估的商品', unit: 'product', measured: true, definition: 'x', cumulative: { sinceCollectionStart: 25, knownTotalLowerBound: 25, isCompleteHistory: false }, collectionStartedAt: 1794062507000, lastCompletedAt: 1794266000000 },
] }, { id: 'minimax-runtime', name: 'MiniMax Code runtime', measured: false, metrics: [] }] };
const listingReport = {
    asOf: '2026-11-09T23:59:33.645Z', coverage: { from: '2026-10-12T09:13:54.811Z' }, freshness: { state: 'fresh', latestFirstPublishAt: '2026-11-09T23:59:32.753Z' },
    successfulListings: { today: { date: '2026-11-10', count: 868, partial: true }, yesterday: { date: '2026-11-09', count: 513 }, last60Minutes: { count: 129 }, cumulative: { from: '2026-10-12T09:13:54.811Z', count: 6782 } },
    hourly: { points: [
        { hourStart: '2026-11-08T00:00:00.000Z', firstPublished: 6, republishedNotCounted: 0, covered: true },
        { hourStart: '2026-11-08T01:00:00.000Z', firstPublished: 2, republishedNotCounted: 1, covered: true },
        { hourStart: '2026-11-08T02:00:00.000Z', firstPublished: 0, republishedNotCounted: 0, covered: false },
    ] },
    measuredRates: { last24CompleteHours: { perHour: 49.88 }, last168CompleteHours: { perHour: 19.88 } },
    target: { kind: 'target_not_actual', state: 'available', perHour: 100 },
    live: { publiclyVisible: { count: 6716 }, records: { total: 6967, published: 6794, privatePending: 104, withdrawn: 69 }, waitingToPublish: { count: 104 }, processing: { value: null, state: 'unavailable' } },
};

describe('aihankapps-ops parsers', () => {
    test('cpu history: totals only when measured, workers by id, bad ids and times dropped', () => {
        const { points, workers } = ops.cpuPoints(cpuHistory);
        expect(workers).toEqual({ 'minimax-runtime': 'MiniMax Code runtime', 'wishlist-retail': 'Wishlist 原價與 CP 查找' });
        const ids = points.map(p => p.series + '@' + p.at);
        expect(ids).toContain('cpu.total.core@1794264900000');
        expect(ids).toContain('cpu.total.host@1794264900000');
        expect(ids).not.toContain('cpu.total.core@1794265200000');
        expect(ids).toContain('cpu.wishlist-retail.core@1794265200000');
        expect(ids).not.toContain('cpu.minimax-runtime.core@1794265200000');
        expect(ids.some(id => id.includes('bad id'))).toBe(false);
        expect(points.find(p => p.series === 'cpu.minimax-runtime.core' && p.at === 1794264900000).value).toBe(0.389);
        expect(ops.cpuPoints(null).points).toEqual([]);
    });
    test('work history: complete hours become exact counts (zero included), everything else is left out', () => {
        const { points, catalog } = ops.workPoints(workHistory);
        expect(points).toEqual([
            { series: 'work.wishlist-retail.retail_cp_evaluated', at: 1794247200000, value: 3 },
            { series: 'work.timehut-shiguang.photos_tagged', at: 1794247200000, value: 0 },
        ]);
        expect(catalog.map(c => c.id)).toEqual(['work.wishlist-retail.retail_cp_evaluated', 'work.timehut-shiguang.photos_tagged']);
        expect(catalog[0]).toMatchObject({ group: 'work', kind: 'count', worker: 'wishlist-retail', label: '完成 CP 評估的商品', unit: 'product' });
    });
    test('work summary: catalog with definitions and running totals', () => {
        const { catalog, totals } = ops.workSummary(workSummary);
        expect(catalog).toHaveLength(1);
        expect(totals['work.wishlist-retail.retail_cp_evaluated']).toEqual({ sinceCollectionStart: 25, knownTotalLowerBound: 25, isCompleteHistory: false, collectionStartedAt: 1794062507000, lastCompletedAt: 1794266000000 });
    });
    test('listing report: covered hours, stock gauges at asOf, and the summary', () => {
        const { hourly, gauges, summary } = ops.listingPoints(listingReport);
        expect(hourly).toEqual([
            { series: 'wishlist.listed', at: Date.parse('2026-11-08T00:00:00.000Z'), value: 6 },
            { series: 'wishlist.republished', at: Date.parse('2026-11-08T00:00:00.000Z'), value: 0 },
            { series: 'wishlist.listed', at: Date.parse('2026-11-08T01:00:00.000Z'), value: 2 },
            { series: 'wishlist.republished', at: Date.parse('2026-11-08T01:00:00.000Z'), value: 1 },
        ]);
        const asOf = Date.parse('2026-11-09T23:59:33.645Z');
        expect(gauges).toEqual([
            { series: 'wishlist.visible', at: asOf, value: 6716 }, { series: 'wishlist.published', at: asOf, value: 6794 },
            { series: 'wishlist.waiting', at: asOf, value: 104 }, { series: 'wishlist.withdrawn', at: asOf, value: 69 },
        ]);
        expect(summary).toMatchObject({ today: { date: '2026-11-10', count: 868, partial: true }, yesterday: { date: '2026-11-09', count: 513 }, perHour24h: 49.88, targetPerHour: 100, publiclyVisible: 6716, waitingToPublish: 104 });
        expect(summary.cumulative.count).toBe(6782);
    });
    test('chat pending: only a fresh ok answer becomes a point; status snapshot keeps numbers and health only', () => {
        expect(ops.chatPendingPoint({ status: 'ok', observedAt: 1794263531309, pendingCount: 0, needApproval: 0, approvedWaitingSend: 0 }).points).toEqual([{ series: 'wishlist.chatPending', at: 1794263531309, value: 0 }]);
        expect(ops.chatPendingPoint({ status: 'stale', observedAt: 1794263531309, pendingCount: null }).points).toEqual([]);
        const snap = ops.statusSnapshot({ checkedAt: 1, observedAt: 2, dataFresh: true, health: 'degraded', monitor: { status: 'healthy' }, workers: [{ id: 'a', name: 'A', health: 'unknown', processOnline: true, cpuCorePercent: 2.5, cpuHostPercent: 0.25, memoryBytes: 10, coverage: 'process_only', secret: 'no' }], recordedCounts: { completed: 3 } });
        expect(snap.workers[0]).toEqual({ id: 'a', name: 'A', health: 'unknown', processOnline: true, cpuCorePercent: 2.5, cpuHostPercent: 0.25, memoryBytes: 10, coverage: 'process_only' });
        expect(snap.recordedCounts).toEqual({ completed: 3 });
        expect(ops.statusSnapshot({})).toBeNull();
    });
    test('catalog: static series plus one CPU pair per worker and the work series from the monitor', () => {
        const series = ops.catalogFrom({ workers: { 'wishlist-retail': 'Wishlist 原價與 CP 查找' }, workCatalog: ops.workSummary(workSummary).catalog });
        const ids = series.map(s => s.id);
        expect(ids).toEqual(expect.arrayContaining(['cpu.total.core', 'wishlist.listed', 'wishlist.chatPending', 'cpu.wishlist-retail.core', 'cpu.wishlist-retail.host', 'work.wishlist-retail.retail_cp_evaluated']));
        expect(series.find(s => s.id === 'cpu.wishlist-retail.core')).toMatchObject({ kind: 'gauge', unit: '%core', label: 'Wishlist 原價與 CP 查找', worker: 'wishlist-retail' });
    });
});

describe('aihankapps-ops read API', () => {
    test('series query rules', () => {
        expect(ops.parseSeriesQuery({ ids: 'cpu.total.core, wishlist.listed', step: 'hour', from: '1000', to: '7210000' })).toEqual({ ids: ['cpu.total.core', 'wishlist.listed'], from: 1000, to: 7210000, step: 'hour' });
        expect(ops.parseSeriesQuery({ ids: '' }).error).toBe('INVALID_IDS');
        expect(ops.parseSeriesQuery({ ids: 'bad id' }).error).toBe('INVALID_IDS');
        expect(ops.parseSeriesQuery({ ids: Array.from({ length: 25 }, (_, i) => 'a' + i).join(',') }).error).toBe('INVALID_IDS');
        expect(ops.parseSeriesQuery({ ids: 'cpu.total.core', step: 'week' }).error).toBe('INVALID_STEP');
        expect(ops.parseSeriesQuery({ ids: 'cpu.total.core', from: '10', to: '5' }).error).toBe('INVALID_RANGE');
        expect(ops.parseSeriesQuery({ ids: 'cpu.total.core', step: 'minute', from: '0', to: String(15 * 86400000) }).error).toBe('RANGE_TOO_WIDE_FOR_MINUTE');
        expect(ops.parseSeriesQuery({ ids: 'cpu.total.core', step: 'hour', from: '0', to: String(4000 * 3600000) }).error).toBe('TOO_MANY_POINTS');
        const dflt = ops.parseSeriesQuery({ ids: 'cpu.total.core' });
        expect(dflt.step).toBe('hour'); expect(dflt.to - dflt.from).toBe(24 * 3600000);
    });
    test('observation rate: measured from the first stored hour when the table is younger than a week', async () => {
        const now = Date.parse('2026-11-10T01:30:00Z'), first = Date.parse('2026-11-09T00:16:00Z');
        const pool = { query: async sql => (/MIN\(at\)/.test(sql) ? { rows: [{ first: new Date(first) }] } : { rows: [{ hours: 23 }] }) };
        expect(await ops.observation7d(pool, now)).toEqual({ observedHours: 23, windowHours: 25, rate: 0.92, since: '2026-11-09T00:00:00.000Z' });
        const week = { query: async sql => (/MIN\(at\)/.test(sql) ? { rows: [{ first: new Date(now - 30 * 86400000) }] } : { rows: [{ hours: 170 }] }) };
        expect(await ops.observation7d(week, now)).toMatchObject({ observedHours: 168, windowHours: 168, rate: 1 });
        expect(await ops.observation7d({ query: async () => ({ rows: [{ first: null }] }) }, now)).toBeNull();
    });
    test('router: 400 on bad queries, 503 when the database is down, catalog without a database row', async () => {
        const calls = [];
        const pool = { query: async (sql, params) => { calls.push({ sql, params }); if (/FROM aihankapps_ops_meta/.test(sql) || /FROM aihankapps_ops_points GROUP BY step/.test(sql)) return { rows: [], rowCount: 0 }; return { rows: [], rowCount: 0 }; } };
        const app = express(); app.use('/api/aihankapps/ops', ops.createRouter(() => pool));
        const server = await new Promise(resolve => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
        const base = 'http://127.0.0.1:' + server.address().port + '/api/aihankapps/ops';
        const get = async path => { const res = await fetch(base + path); return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') }; };
        try {
            const bad = await get('/series?ids=nope%20nope');
            expect(bad.status).toBe(400); expect(bad.body.errorCode).toBe('INVALID_IDS'); expect(bad.cache).toBe('no-store');
            const cat = await get('/catalog');
            expect(cat.status).toBe(200); expect(cat.body.series.map(s => s.id)).toContain('wishlist.listed'); expect(cat.cache).toBe('public, max-age=30');
            expect(calls.some(c => /CREATE TABLE IF NOT EXISTS aihankapps_ops_points/.test(c.sql))).toBe(true);
            const ok = await get('/series?ids=wishlist.listed&step=day&from=0&to=' + 40 * 86400000);
            expect(ok.status).toBe(200); expect(ok.body.series['wishlist.listed']).toEqual({ kind: 'count', points: [] });
            const dayQuery = calls.find(c => /date_trunc\(\$4/.test(c.sql));
            expect(dayQuery.params[3]).toBe('day'); expect(dayQuery.params[4]).toBe('Asia/Taipei');
            const down = express(); down.use('/x', ops.createRouter(() => ({ query: async () => { throw new Error('connection refused'); } })));
            const s2 = await new Promise(resolve => { const s = http.createServer(down).listen(0, '127.0.0.1', () => resolve(s)); });
            const res = await fetch('http://127.0.0.1:' + s2.address().port + '/x/latest');
            expect(res.status).toBe(503); expect((await res.json()).errorCode).toBe('OPS_UNAVAILABLE');
            s2.close();
        } finally { server.close(); }
    });
    test('collector: fetches with a named UA, stores points, and records errors without throwing', async () => {
        const store = { points: [], meta: {} }, urls = [];
        const pool = { query: async (sql, params) => {
            if (/INSERT INTO aihankapps_ops_points \(series, step, at, value, peak, n\) VALUES/.test(sql)) { for (let i = 0; i < params.length; i += 6) store.points.push({ series: params[i], step: params[i + 1], at: params[i + 2].getTime(), value: params[i + 3] }); return { rowCount: params.length / 6 }; }
            if (/INSERT INTO aihankapps_ops_meta/.test(sql)) { store.meta[params[0]] = JSON.parse(params[1]); return { rowCount: 1 }; }
            if (/GROUP BY step/.test(sql)) return { rows: [], rowCount: 0 };
            return { rows: [], rowCount: 0 };
        } };
        const fetchImpl = async (url, init) => { urls.push(url); expect(init.headers['User-Agent']).toBe(ops.OUTBOUND_UA);
            if (url.includes('cpu-history')) return { status: 200, json: async () => cpuHistory };
            if (url.includes('work-summary')) return { status: 200, json: async () => workSummary };
            if (url.includes('work-history')) return { status: 200, json: async () => workHistory };
            if (url.includes('listing-report')) return { status: 200, json: async () => listingReport };
            if (url.includes('wishlist-chat-pending')) return { status: 503, json: async () => ({}) };
            if (url.includes('status')) return { status: 200, json: async () => ({ checkedAt: 1, observedAt: 2, dataFresh: true, health: 'healthy', monitor: { status: 'healthy' }, workers: [{ id: 'wishlist-retail', name: 'W', processOnline: true, cpuCorePercent: 1, cpuHostPercent: 0.1, memoryBytes: 500 }] }) };
            throw new Error('unexpected ' + url);
        };
        const c = ops.createCollector(() => pool, { fetchImpl, log: { error() {} }, now: () => 1794270000000 });
        await c.bootstrap();
        expect(urls[0]).toBe('https://minimax-monitor.eclawbot.com/api/monitor/public/cpu-history?minutes=1440&stepMinutes=2');
        expect(urls).toContain('https://wishlist-app-production.up.railway.app/api/public/listing-report?hours=2160');
        expect(store.points.filter(p => p.step === 'm' && p.series === 'cpu.total.core')).toHaveLength(1);
        expect(store.points.filter(p => p.step === 'h' && p.series === 'wishlist.listed')).toHaveLength(2);
        expect(store.points.find(p => p.series === 'mem.wishlist-retail')).toMatchObject({ step: 'm', at: 2, value: 500 });
        expect(store.meta.workers).toEqual({ 'minimax-runtime': 'MiniMax Code runtime', 'wishlist-retail': 'Wishlist 原價與 CP 查找' });
        expect(store.meta.listingSummary.today.count).toBe(868);
        expect(store.meta.workTotals.totals['work.wishlist-retail.retail_cp_evaluated'].knownTotalLowerBound).toBe(25);
        expect(c.state.errors.chat.message).toBe('HTTP_503');
        expect(c.state.errors.cpu).toBeUndefined();
    });
});

describe('ops chart maths', () => {
    test('zoom thresholds pick the axis unit, never finer than the series allows', () => {
        expect(math.pickStep(3600e3)).toBe('minute');
        expect(math.pickStep(6 * 3600e3)).toBe('minute');
        expect(math.pickStep(6 * 3600e3 + 1)).toBe('hour');
        expect(math.pickStep(7 * 86400e3)).toBe('hour');
        expect(math.pickStep(30 * 86400e3)).toBe('day');
        expect(math.pickStep(121 * 86400e3)).toBe('month');
        expect(math.pickStep(3600e3, 'hour')).toBe('hour');
    });
    test('Taipei buckets and labels', () => {
        const t = Date.parse('2026-11-09T23:40:00Z'); // 2026-11-10 07:40 Taipei
        expect(math.bucketStart(t, 'minute')).toBe(Date.parse('2026-11-09T23:40:00Z'));
        expect(math.bucketStart(t, 'hour')).toBe(Date.parse('2026-11-09T23:00:00Z'));
        expect(math.bucketStart(t, 'day')).toBe(Date.parse('2026-11-09T16:00:00Z'));
        expect(math.bucketStart(t, 'month')).toBe(Date.parse('2026-10-31T16:00:00Z'));
        expect(math.bucketNext(math.bucketStart(t, 'month'), 'month')).toBe(Date.parse('2026-11-30T16:00:00Z'));
        expect(math.formatTick(t, 'minute')).toBe('11/10 07:40');
        expect(math.formatTick(t, 'minute', t - 60e3)).toBe('07:40');
        expect(math.formatTick(math.bucketStart(t, 'day'), 'day')).toBe('2026/11/10');
        expect(math.formatTick(math.bucketStart(t, 'month'), 'month')).toBe('2026/11');
        expect(math.formatBucket(math.bucketStart(t, 'hour'), 'hour')).toBe('2026/11/10 07:00–08:00');
        expect(math.formatBucket(math.bucketStart(t, 'day'), 'day')).toBe('2026/11/10');
    });
    test('ticks stay readable and align to local boundaries; nice ticks and number formats', () => {
        const from = Date.parse('2026-11-01T16:00:00Z'), to = Date.parse('2026-11-08T16:00:00Z');
        const days = math.ticksFor(from, to, 'day', 700, 72);
        expect(days.length).toBeGreaterThan(3); expect(days.every(x => math.parts(x).h === 0)).toBe(true);
        const hours = math.ticksFor(from, from + 6 * 3600e3, 'minute', 1000, 72);
        expect(hours.length).toBeGreaterThan(4); expect(hours.length).toBeLessThan(16);
        expect(math.niceTicks(0, 7, 4)).toEqual({ ticks: [0, 2, 4, 6, 8], unit: 2, min: 0, max: 8 });
        expect(math.formatNumber(0.974, '%core')).toBe('1.0%');
        expect(math.formatNumber(6716, 'item')).toBe('6,716');
        expect(math.formatNumber(null)).toBe('—');
        expect(math.unitLabel('product')).toBe('件');
        expect(math.cumulative([[1, 2], [2, 3], [3, 0]])).toEqual([[1, 2], [2, 5], [3, 5]]);
    });
});
