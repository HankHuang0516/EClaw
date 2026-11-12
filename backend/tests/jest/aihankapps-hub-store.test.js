/**
 * AiHankApps 管理中樞 — the numbers the hub keeps itself: service probes, the counts an operator's collector imports,
 * the import script and the collector tool (tools/aihankapps-hub). Everything here is synthetic: no network, no
 * database, no Railway.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { Readable } = require('stream');
const store = require('../../aihankapps-hub-store');
const importScript = require('../../scripts/aihankapps-hub-import');
const hub = require('../../aihankapps-hub');

const toolDir = path.resolve(__dirname, '../../../tools/aihankapps-hub');
const collect = require(path.join(toolDir, 'collect.js'));
const { BACKENDS, remoteScript } = require(path.join(toolDir, 'backends.js'));
const railway = require(path.join(toolDir, 'railway-metrics.js'));

const backendDir = path.resolve(__dirname, '../..');
const NOW = Date.UTC(2026, 10, 10, 13, 0);           // 2026-11-10 21:00 in Taipei
const BUCKET = 5 * 60000, HOUR = 3600000;
const APPS = new Set(['rebound', 'weesh']);

// A stand-in pool that records every statement with its values, and fails any statement containing `failOn`.
function writePool(failOn) {
    const pool = { statements: [], connected: 0, released: 0, failOn };
    const run = async (sql, values) => {
        pool.statements.push({ sql, values });
        if (pool.failOn && sql.includes(pool.failOn)) throw new Error('synthetic failure');
        return { rows: [] };
    };
    pool.query = run;
    pool.connect = async () => { pool.connected += 1; return { query: run, release: () => { pool.released += 1; } }; };
    return pool;
}
const first = sql => sql.trim().split('\n')[0].trim();

function reply(status, body, { json = true } = {}) {
    return { status, body: { cancel: jest.fn(() => Promise.resolve()) }, json: async () => { if (!json) throw new SyntaxError('Unexpected token <'); return body; } };
}

function envelope(overrides = {}) {
    return { schemaVersion: 1, source: 'rebound', collectedAt: NOW,
        series: [{ app: 'rebound', metric: 'plays', start: '2026-11-08', values: [3, null, 0] }],
        facts: [{ app: 'rebound', key: 'playersTotal', value: { label: '玩家總數', value: 12, unit: '人', order: 10 } }],
        notes: ['一則說明'], ...overrides };
}

afterEach(() => jest.restoreAllMocks());

describe('admin hub store: service probes', () => {
    test('the services checked are fixed in code: public https health addresses of apps the portfolio knows', () => {
        expect(store.SERVICES.map(s => s.id)).toEqual(['eclaw', 'wishlist', 'rebound', 'summit', 'leaderboard', 'timehut', 'monitor']);
        const known = importScript.catalogAppIds();
        for (const service of store.SERVICES) {
            const url = new URL(service.url);
            expect(url.protocol).toBe('https:');
            expect([url.username, url.password, url.search, url.hash]).toEqual(['', '', '', '']);
            for (const app of service.apps) expect(known.has(app)).toBe(true);
        }
        expect(store.PROBE_UA).toMatch(/^aihankapps-hub-probe\/\d/);
    });

    test('a check passes only on 200 and the service\'s own healthy answer, and says how long it took', async () => {
        let t = NOW;
        const calls = [];
        const now = () => t;
        const answering = answer => async (url, init) => { calls.push({ url, init }); t += 120; if (answer instanceof Error) throw answer; return answer; };
        const eclaw = store.SERVICES.find(s => s.id === 'eclaw');
        expect(await store.probeOne(eclaw, { fetchImpl: answering(reply(200, { status: 'ok', build: 'b'.repeat(60) })), now }))
            .toEqual({ id: 'eclaw', ok: true, status: 200, ms: 120, at: NOW, info: 'b'.repeat(40) });
        expect(calls[0].url).toBe('https://eclawbot.com/api/health');
        expect(calls[0].init).toMatchObject({ headers: { 'User-Agent': store.PROBE_UA }, redirect: 'manual' });
        expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
        // 200, but the body says something is wrong, or is not JSON at all
        expect((await store.probeOne(eclaw, { fetchImpl: answering(reply(200, { status: 'degraded' })), now })).ok).toBe(false);
        expect((await store.probeOne(eclaw, { fetchImpl: answering(reply(200, null, { json: false })), now })).ok).toBe(false);
        // any other status, a redirect included; the body is not read
        const down = reply(503, {});
        expect(await store.probeOne(eclaw, { fetchImpl: answering(down), now })).toMatchObject({ ok: false, status: 503, info: null });
        expect(down.body.cancel).toHaveBeenCalled();
        expect((await store.probeOne(eclaw, { fetchImpl: answering(reply(302, {})), now })).ok).toBe(false);
        // no answer at all: refused, or timed out
        expect(await store.probeOne(eclaw, { fetchImpl: answering(new Error('The operation was aborted due to timeout')), now }))
            .toEqual({ id: 'eclaw', ok: false, status: 0, ms: 120, at: t - 120, info: null });
        // a site without a health route: answering 200 is enough, and its page is not downloaded
        const page = reply(200, null, { json: false });
        expect((await store.probeOne(store.SERVICES.find(s => s.id === 'wishlist'), { fetchImpl: answering(page), now })).ok).toBe(true);
        expect(page.body.cancel).toHaveBeenCalled();
    });

    test('a round asks every service at once, remembers the answers, and adds them to five-minute and hourly buckets', async () => {
        const pool = writePool();
        const services = [{ id: 'a', name: 'A', apps: ['x'], url: 'https://a.example/health' }, { id: 'b', name: 'B', apps: [], url: 'https://b.example/health' }];
        const T = NOW + 7 * 60000 + 1234;                 // 21:07:01 in Taipei
        let t = T;
        const fetchImpl = async url => { if (url.startsWith('https://a.')) { t += 80; return reply(200, null); } return reply(500, null); };
        const probes = store.createProbes({ getPool: () => pool, fetchImpl, now: () => t, services });
        expect(probes.latest().map(s => [s.id, s.ok, s.at])).toEqual([['a', null, null], ['b', null, null]]);

        await probes.run();
        expect(probes.latest()).toEqual([{ id: 'a', name: 'A', apps: ['x'], ok: true, status: 200, ms: 80, at: T, info: null },
            { id: 'b', name: 'B', apps: [], ok: false, status: 500, ms: 0, at: T + 80, info: null }]);
        const created = pool.statements.filter(s => s.sql.includes('CREATE TABLE'));
        expect(created.map(s => first(s.sql))).toEqual(['CREATE TABLE IF NOT EXISTS aihankapps_hub_probes (', 'CREATE TABLE IF NOT EXISTS aihankapps_hub_daily (',
            'CREATE TABLE IF NOT EXISTS aihankapps_hub_facts (', 'CREATE TABLE IF NOT EXISTS aihankapps_hub_sources (', 'CREATE TABLE IF NOT EXISTS aihankapps_hub_infra (']);
        const insert = pool.statements.find(s => s.sql.startsWith('INSERT INTO aihankapps_hub_probes'));
        expect(insert.sql).toContain('ON CONFLICT (service, step, at) DO UPDATE SET checks = aihankapps_hub_probes.checks + EXCLUDED.checks');
        expect(insert.values).toEqual([['a', 'a', 'b', 'b'], ['q', 'h', 'q', 'h'],
            [new Date(NOW + 5 * 60000), new Date(NOW), new Date(NOW + 5 * 60000), new Date(NOW)], [1, 1, 1, 1], [0, 0, 1, 1], [80, 80, 0, 0], [80, 80, 0, 0]]);

        await probes.run();
        expect(pool.statements.filter(s => s.sql.includes('CREATE TABLE'))).toHaveLength(5);      // the tables are prepared once per pool
        expect(pool.statements.filter(s => s.sql.startsWith('INSERT INTO aihankapps_hub_probes'))).toHaveLength(2);
    });

    test('rounds never overlap, and a database that cannot record costs the record, not the answer', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        let open;
        const gate = new Promise(resolve => { open = resolve; });
        const pool = writePool('INSERT INTO aihankapps_hub_probes');
        const probes = store.createProbes({ getPool: () => pool, fetchImpl: async () => { await gate; return reply(200, null); }, now: () => NOW,
            services: [{ id: 'a', name: 'A', apps: [], url: 'https://a.example/' }] });
        const round = probes.run();
        expect(await probes.run()).toBeNull();
        open();
        await round;
        expect(probes.latest()[0].ok).toBe(true);
        await probes.run();
        expect(errors).toHaveBeenCalledTimes(1);           // the same failure is reported once, not every minute
        expect(String(errors.mock.calls[0][1])).toBe('synthetic failure');
    });

    test('old buckets are pruned, and start() checks every minute until stopped', async () => {
        const pool = writePool();
        const probes = store.createProbes({ getPool: () => pool, fetchImpl: async () => reply(200, null), now: () => NOW,
            services: [{ id: 'a', name: 'A', apps: [], url: 'https://a.example/' }] });
        await probes.prune();
        expect(pool.statements.at(-1).sql).toBe("DELETE FROM aihankapps_hub_probes WHERE (step = 'q' AND at < NOW() - INTERVAL '14 days') OR (step = 'h' AND at < NOW() - INTERVAL '400 days')");

        const jobs = [];
        const cron = { schedule: (expression, run) => { const job = { expression, run, stop: jest.fn() }; jobs.push(job); return job; } };
        const handle = probes.start({ cron, firstRunDelayMs: 0 });
        expect(probes.start({ cron })).toBe(handle);
        expect(jobs.map(job => job.expression)).toEqual(['* * * * *', '23 4 * * *']);
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(probes.latest()[0].ok).toBe(true);          // the first round does not wait a whole minute
        handle.stop();
        expect(jobs.map(job => job.stop.mock.calls.length)).toEqual([1, 1]);

        jest.spyOn(console, 'error').mockImplementation(() => {});
        pool.failOn = 'DELETE';
        await expect(probes.prune()).resolves.toBeUndefined();     // a failed prune is reported, not thrown
    });

    test('the data answer gets 24 hours of five-minute buckets and 90 Taipei days; a bucket without checks is unknown', async () => {
        const services = [{ id: 'a', name: 'A', apps: ['x'] }, { id: 'b', name: 'B', apps: [] }];
        const bucket = Math.floor(NOW / BUCKET) * BUCKET;
        const rows = {
            q: [{ service: 'a', at: new Date(bucket), checks: 5, failures: 1, ms_total: 400 }, { service: 'a', at: new Date(bucket - 10 * BUCKET), checks: 5, failures: 5, ms_total: 0 },
                { service: 'a', at: new Date(bucket - 400 * BUCKET), checks: 5, failures: 0, ms_total: 50 }, { service: 'zzz', at: new Date(bucket), checks: 5, failures: 0, ms_total: 50 }],
            h: [{ service: 'a', day: '2026-11-10', checks: 100, failures: 5, ms_total: 9500 }, { service: 'a', day: '2026-11-04', checks: 60, failures: 0, ms_total: 600 },
                { service: 'a', day: '2026-10-01', checks: 10, failures: 10, ms_total: 0 }, { service: 'a', day: 'nonsense', checks: 1, failures: 0, ms_total: 1 }],
        };
        const asked = [];
        const query = async (sql, values) => { asked.push({ sql, values }); return { rows: sql.includes("step = 'q'") ? rows.q : rows.h }; };
        const [a, b] = await store.readProbes(query, NOW, services);
        expect(asked.map(q => q.values[0].toISOString())).toEqual([new Date(bucket - 287 * BUCKET).toISOString(), '2026-08-12T16:00:00.000Z']);   // 2026-08-13 00:00 in Taipei
        expect(asked.every(q => /^SELECT /.test(q.sql))).toBe(true);
        expect(a.recent).toMatchObject({ from: bucket - 287 * BUCKET, step: BUCKET });
        expect([a.recent.up[287], a.recent.ms[287], a.recent.up[277], a.recent.ms[277], a.recent.up[0]]).toEqual([80, 100, 0, null, null]);
        expect(a.recent.up.filter(v => v !== null)).toHaveLength(2);
        expect(a.uptime24h).toBe(40);
        expect(a.daily.start).toBe('2026-08-13');
        expect([a.daily.up[89], a.daily.ms[89], a.daily.up[83], a.daily.ms[83], a.daily.up[49], a.daily.ms[49]]).toEqual([95, 100, 100, 10, 0, null]);
        expect(a.daily.up.filter(v => v !== null)).toHaveLength(3);
        expect([a.uptime7d, a.uptime30d, a.uptime90d]).toEqual([96.88, 96.88, 91.18]);
        expect(b).toMatchObject({ id: 'b', uptime24h: null, uptime7d: null, uptime30d: null, uptime90d: null });
        expect(b.recent.up.every(v => v === null) && b.daily.up.every(v => v === null)).toBe(true);
    });
});

describe('admin hub store: imported back-end numbers', () => {
    test('an envelope becomes rows: known apps and metrics only, unknown days skipped, nothing in the future', () => {
        expect(store.validateEnvelope(envelope(), APPS)).toEqual({ source: 'rebound', collectedAt: NOW,
            rows: [{ app: 'rebound', metric: 'plays', day: '2026-11-08', value: 3 }, { app: 'rebound', metric: 'plays', day: '2026-11-10', value: 0 }],
            facts: [{ app: 'rebound', key: 'playersTotal', value: { label: '玩家總數', value: 12, unit: '人', order: 10 } }], notes: ['一則說明'] });
        expect(store.validateEnvelope({ schemaVersion: 1, source: 'summit', collectedAt: NOW }, ['weesh'])).toEqual({ source: 'summit', collectedAt: NOW, rows: [], facts: [], notes: [] });
        expect(store.IMPORT_METRICS).toEqual(['newUsers', 'activeUsers', 'plays', 'purchases', 'purchaseTwd', 'messages', 'listings', 'mailSent', 'mailClaimed', 'aiUses', 'netInMb', 'netOutMb']);
    });

    test('anything unexpected refuses the whole envelope', () => {
        const series = patch => [{ ...envelope().series[0], ...patch }];
        const fact = patch => [{ ...envelope().facts[0], ...patch }];
        const refused = [
            [null, 'IMPORT_SHAPE'], [[], 'IMPORT_SHAPE'], [envelope({ extra: 1 }), 'IMPORT_SHAPE'],
            [envelope({ schemaVersion: 2 }), 'IMPORT_SOURCE'], [envelope({ source: 'Bad Source' }), 'IMPORT_SOURCE'], [envelope({ source: '../x' }), 'IMPORT_SOURCE'],
            [envelope({ collectedAt: '2026-11-10' }), 'IMPORT_TIME'], [envelope({ collectedAt: Date.UTC(2025, 11, 31) }), 'IMPORT_TIME'],
            [envelope({ collectedAt: Date.now() + 2 * HOUR }), 'IMPORT_TIME'], [envelope({ collectedAt: NOW + 0.5 }), 'IMPORT_TIME'],
            [envelope({ series: {} }), 'IMPORT_SHAPE'], [envelope({ series: new Array(201).fill(envelope().series[0]) }), 'IMPORT_SHAPE'],
            [envelope({ series: series({ app: 'ghost' }) }), 'IMPORT_SERIES'], [envelope({ series: series({ metric: 'revenue' }) }), 'IMPORT_SERIES'],
            [envelope({ series: series({ start: '2026-02-30' }) }), 'IMPORT_SERIES'], [envelope({ series: series({ start: '2026-11-8' }) }), 'IMPORT_SERIES'],
            [envelope({ series: series({ values: [] }) }), 'IMPORT_SERIES'], [envelope({ series: series({ start: '2024-01-01', values: new Array(801).fill(1) }) }), 'IMPORT_SERIES'],
            [envelope({ series: series({ values: [1, 2, 3, 4] }) }), 'IMPORT_SERIES'],                 // would reach 11/11, after the collection day
            [envelope({ series: envelope().series.concat(envelope().series) }), 'IMPORT_SERIES'],
            [envelope({ series: series({ values: [-1] }) }), 'IMPORT_VALUE'], [envelope({ series: series({ values: ['3'] }) }), 'IMPORT_VALUE'],
            [envelope({ series: series({ values: [NaN] }) }), 'IMPORT_VALUE'], [envelope({ series: series({ values: [Infinity] }) }), 'IMPORT_VALUE'],
            [envelope({ series: series({ values: [1e13] }) }), 'IMPORT_VALUE'],
            [envelope({ facts: fact({ app: 'ghost' }) }), 'IMPORT_FACT'], [envelope({ facts: fact({ key: 'Bad-Key' }) }), 'IMPORT_FACT'],
            [envelope({ facts: fact({ key: '__proto__' }) }), 'IMPORT_FACT'], [envelope({ facts: fact({ value: [1] }) }), 'IMPORT_FACT'],
            [envelope({ facts: fact({ value: { label: 'x'.repeat(9000) } }) }), 'IMPORT_FACT'], [envelope({ facts: envelope().facts.concat(envelope().facts) }), 'IMPORT_FACT'],
            [envelope({ notes: 'x' }), 'IMPORT_SHAPE'], [envelope({ notes: ['x'.repeat(201)] }), 'IMPORT_SHAPE'], [envelope({ notes: new Array(21).fill('x') }), 'IMPORT_SHAPE'],
        ];
        for (const [input, code] of refused) {
            let caught = null;
            try { store.validateEnvelope(input, APPS); } catch (error) { caught = error.code; }
            expect([JSON.stringify(input).slice(0, 80), caught]).toEqual([JSON.stringify(input).slice(0, 80), code]);
        }
    });

    test('an import is all or nothing: values upserted, this source\'s facts replaced and its receipt updated in one transaction', async () => {
        const pool = writePool();
        expect(await store.importEnvelope(pool, envelope(), { appIds: APPS })).toEqual({ source: 'rebound', values: 2, facts: 1 });
        const steps = pool.statements.filter(s => !s.sql.includes('CREATE TABLE'));
        expect(steps.map(s => first(s.sql))).toEqual(['BEGIN', 'INSERT INTO aihankapps_hub_daily (app_id, metric, day, value, source)', 'DELETE FROM aihankapps_hub_facts WHERE source = $1',
            'INSERT INTO aihankapps_hub_facts (app_id, key, value, source, observed_at) VALUES ($1, $2, $3::jsonb, $4, $5)', 'INSERT INTO aihankapps_hub_sources (id, collected_at, detail) VALUES ($1, $2, $3::jsonb)', 'COMMIT']);
        expect(steps[1].values).toEqual([['rebound', 'rebound'], ['plays', 'plays'], ['2026-11-08', '2026-11-10'], [3, 0], ['rebound', 'rebound']]);
        expect(steps[2].values).toEqual(['rebound']);
        expect(steps[3].values).toEqual(['rebound', 'playersTotal', JSON.stringify({ label: '玩家總數', value: 12, unit: '人', order: 10 }), 'rebound', new Date(NOW)]);
        expect(steps[4].values).toEqual(['rebound', new Date(NOW), JSON.stringify({ values: 2, facts: 1, notes: ['一則說明'] })]);
        expect([pool.connected, pool.released]).toEqual([1, 1]);
        // only the hub's own tables are ever written
        expect(pool.statements.every(s => /^(BEGIN|COMMIT|ROLLBACK)$|aihankapps_hub_(probes|daily|facts|sources|infra)\b/.test(s.sql))).toBe(true);
    });

    test('a failure part-way rolls everything back, and a bad envelope never reaches the database', async () => {
        const pool = writePool('INSERT INTO aihankapps_hub_facts');
        await expect(store.importEnvelope(pool, envelope(), { appIds: APPS })).rejects.toThrow('synthetic failure');
        expect(pool.statements.map(s => first(s.sql)).slice(-2)).toEqual(['INSERT INTO aihankapps_hub_facts (app_id, key, value, source, observed_at) VALUES ($1, $2, $3::jsonb, $4, $5)', 'ROLLBACK']);
        expect(pool.statements.some(s => s.sql === 'COMMIT')).toBe(false);
        expect([pool.connected, pool.released]).toEqual([1, 1]);

        const untouched = writePool();
        await expect(store.importEnvelope(untouched, envelope({ series: [{ app: 'ghost', metric: 'plays', start: '2026-11-08', values: [1] }] }), { appIds: APPS })).rejects.toMatchObject({ code: 'IMPORT_SERIES' });
        expect([untouched.statements.length, untouched.connected]).toEqual([0, 0]);
    });

    test('preparing the tables is retried after a failure, and refused without a pool', async () => {
        const pool = writePool('CREATE TABLE IF NOT EXISTS aihankapps_hub_daily');
        await expect(store.prepare(pool)).rejects.toThrow('synthetic failure');
        pool.failOn = null;
        await expect(store.prepare(pool)).resolves.toBeUndefined();
        await store.prepare(pool);
        expect(pool.statements.filter(s => s.sql.includes('aihankapps_hub_probes (')).length).toBe(2);       // tried twice, then remembered
        await expect(store.prepare(null)).rejects.toThrow('POOL_UNAVAILABLE');
    });

    test('the data answer reads the imported rows, facts, receipts and service resources with four plain selects', async () => {
        const asked = [];
        const answer = await store.readImports(async (sql, values) => { asked.push({ sql, values }); return { rows: [{ n: asked.length }] }; }, '2025-10-07');
        expect(answer).toEqual({ rows: [{ n: 1 }], facts: [{ n: 2 }], sources: [{ n: 3 }], infra: [{ n: 4 }] });
        expect(asked.map(q => q.sql)).toEqual(['SELECT app_id, metric, day::text AS day, value FROM aihankapps_hub_daily WHERE day >= $1::date',
            'SELECT app_id, key, value, source, observed_at FROM aihankapps_hub_facts', 'SELECT id, collected_at, imported_at, detail FROM aihankapps_hub_sources',
            'SELECT id, source, value, observed_at FROM aihankapps_hub_infra']);
        expect(asked[0].values).toEqual(['2025-10-07']);
    });
});

describe('admin hub store: Railway service resources', () => {
    const SID = '11111111-2222-3333-4444-555555555555';
    const row = (patch = {}) => ({ id: SID, name: 'wishlist-app', project: 'Wishlist.ai', apps: ['weesh'], deploy: { status: 'SUCCESS', at: NOW - 3600000 },
        volume: { usedMb: 83.1, sizeMb: 500 }, hourly: { start: NOW - 24 * HOUR, step: HOUR, netInMb: [1, null], netOutMb: [2, 3], cpu: [0.01, 0.02], memMb: [900, 950] },
        daily: { start: '2026-11-08', netInMb: [700, 650, 600], netOutMb: [2800, 2700, 2600], cpu: [0.03, 0.03, 0.04], memMb: [1000, 1010, 990] }, ...patch });

    test('rows are checked whole: service ids, catalog apps, known deployment states, numbers only, nothing after the collection day', () => {
        const clean = store.validateEnvelope(envelope({ infra: [row()] }), APPS);
        expect(clean.infra).toEqual([row()]);
        expect(store.validateEnvelope(envelope(), APPS).infra).toBeUndefined();            // collectors without resources leave them alone
        const refused = [{ id: 'not-a-uuid' }, { apps: ['ghost'] }, { apps: ['weesh', 'weesh', 'weesh', 'weesh', 'weesh'] }, { deploy: { status: 'HACKED', at: 1 } },
            { volume: { usedMb: 1, sizeMb: 0 } }, { name: '' }, { project: 'x'.repeat(81) }, { hourly: { ...row().hourly, step: 60000 } },
            { hourly: { ...row().hourly, cpu: [0.1] } }, { daily: { ...row().daily, netOutMb: [1, -1, 2] } }, { daily: { ...row().daily, start: '2026-11-09' } },
            { daily: { ...row().daily, memMb: ['900', 1, 2] } }];
        for (const patch of refused) {
            let code = null;
            try { store.validateEnvelope(envelope({ infra: [row(patch)] }), APPS); } catch (error) { code = error.code; }
            expect([JSON.stringify(patch).slice(0, 60), code]).toEqual([JSON.stringify(patch).slice(0, 60), 'IMPORT_INFRA']);
        }
        expect(() => store.validateEnvelope(envelope({ infra: [row(), row()] }), APPS)).toThrow('IMPORT_INFRA');      // one row per service
        expect(() => store.validateEnvelope(envelope({ infra: new Array(81).fill(0).map(() => row()) }), APPS)).toThrow('IMPORT_INFRA');
    });

    test('an import replaces that collector\'s service rows in the same transaction', async () => {
        const pool = writePool();
        expect(await store.importEnvelope(pool, envelope({ source: 'railway', series: [], facts: [], infra: [row()] }), { appIds: APPS })).toEqual({ source: 'railway', values: 0, facts: 0, services: 1 });
        const steps = pool.statements.filter(s => !s.sql.includes('CREATE TABLE')).map(s => first(s.sql));
        expect(steps).toEqual(['BEGIN', 'DELETE FROM aihankapps_hub_facts WHERE source = $1', 'DELETE FROM aihankapps_hub_infra WHERE source = $1',
            'INSERT INTO aihankapps_hub_infra (id, source, value, observed_at) VALUES ($1, $2, $3::jsonb, $4)', 'INSERT INTO aihankapps_hub_sources (id, collected_at, detail) VALUES ($1, $2, $3::jsonb)', 'COMMIT']);
        const insert = pool.statements.find(s => s.sql.startsWith('INSERT INTO aihankapps_hub_infra'));
        expect(insert.values).toEqual([SID, 'railway', JSON.stringify(row()), new Date(NOW)]);
    });

    test('the Railway collector sums traffic per Taipei day, keeps the last 24 hours, and attributes each service to its first app', async () => {
        const now = Date.UTC(2026, 10, 10, 13, 30);                // 2026-11-10 21:30 in Taipei
        const hour = Date.UTC(2026, 10, 10, 13) / 1000;            // the hour that is still running
        const asked = [];
        const gql = async (query, variables) => {
            asked.push(variables);
            if (query.includes('project(id:')) {
                if (variables.id === 'p-down') throw new Error('railway_api_error');
                return { project: { environments: { edges: [{ node: { id: 'env-test', name: 'staging', serviceInstances: { edges: [] } } }, { node: { id: 'env-prod', name: 'production', serviceInstances: { edges: [
                    { node: { serviceId: SID, serviceName: 'wishlist-app', latestDeployment: { status: 'SUCCESS', createdAt: '2026-11-10T01:00:00Z' } } },
                    { node: { serviceId: '99999999-2222-3333-4444-555555555555', serviceName: 'mystery', latestDeployment: null } }] } } }] },
                volumes: { edges: [{ node: { volumeInstances: { edges: [{ node: { serviceId: SID, environmentId: 'env-prod', sizeMB: 500, currentSizeMB: 83.14 } },
                    { node: { serviceId: SID, environmentId: 'env-test', sizeMB: 500, currentSizeMB: 400 } }] } } }] } } };
            }
            return { metrics: [
                { measurement: 'NETWORK_TX_GB', tags: { serviceId: SID }, values: [
                    { ts: Date.UTC(2026, 10, 8, 16) / 1000, value: 1 },            // 11/9 00:00 Taipei
                    { ts: Date.UTC(2026, 10, 9, 15) / 1000, value: 0.5 },          // 11/9 23:00 Taipei
                    { ts: Date.UTC(2026, 10, 9, 16) / 1000, value: 0.25 },         // 11/10 00:00 Taipei: today, not a complete day
                    { ts: hour - 3600, value: 0.125 }, { ts: hour, value: 9 }] },   // the last complete hour, and the running one (ignored)
                { measurement: 'CPU_USAGE', tags: { serviceId: SID }, values: [{ ts: Date.UTC(2026, 10, 8, 16) / 1000, value: 0.02 }, { ts: Date.UTC(2026, 10, 8, 17) / 1000, value: 0.04 }] },
                { measurement: 'NETWORK_RX_GB', tags: { serviceId: SID }, values: [{ ts: Date.UTC(2026, 10, 9, 0) / 1000, value: -1 }] }] };
        };
        const out = await railway.collectRailway({ now, gql, projects: [{ projectId: 'p1', project: 'Wishlist.ai', apps: { 'wishlist-app': ['weesh'] } }, { projectId: 'p-down', project: 'Down', apps: {} }] });
        expect(out.notes).toEqual(['Down：讀不到服務清單']);
        expect(asked[1]).toMatchObject({ projectId: 'p1', environmentId: 'env-prod', startDate: '2026-10-10T16:00:00.000Z', endDate: '2026-11-10T13:00:00.000Z' });
        const [app, mystery] = out.infra;
        expect(app).toMatchObject({ id: SID, name: 'wishlist-app', project: 'Wishlist.ai', apps: ['weesh'], deploy: { status: 'SUCCESS', at: Date.parse('2026-11-10T01:00:00Z') }, volume: { usedMb: 83.1, sizeMb: 500 } });
        expect(app.daily.start).toBe('2026-10-11');
        expect(app.daily.netOutMb).toHaveLength(30);
        expect(app.daily.netOutMb[29]).toBe(1536);                         // 11/9 = (1 + 0.5) GB; 11/10 is still running, so the list ends at 11/9
        expect(app.daily.netOutMb.slice(0, 29).every(v => v === null)).toBe(true);
        expect(app.daily.cpu[29]).toBe(0.03);                              // CPU is an average of the hours
        expect(app.daily.netInMb.every(v => v === null)).toBe(true);       // a negative reading is not data
        expect(app.hourly).toMatchObject({ start: now - now % HOUR - 24 * HOUR, step: HOUR });
        expect(app.hourly.netOutMb.at(-1)).toBe(128);
        expect(app.hourly.netOutMb.filter(v => v !== null)).toEqual([512, 256, 128]);   // 11/9 23:00 and 11/10 00:00 Taipei are within the last 24 hours
        expect(mystery).toMatchObject({ name: 'mystery', apps: [], deploy: null, volume: null });
        expect(out.series).toEqual([{ app: 'weesh', metric: 'netOutMb', start: '2026-10-11', values: app.daily.netOutMb }]);
        const built = collect.toEnvelope({ id: 'railway', apps: ['weesh'] }, { value: out }, { now: Date.now() });
        expect(built.error).toBeUndefined();
    });

    test('the Railway login is read from the CLI after refreshing it, and missing logins stop that source only', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'railway-home-'));
        const calls = [];
        const spawn = (cmd, args) => { calls.push([cmd, args]); return { status: 0 }; };
        expect(railway.readToken({ spawn, home })).toBeNull();
        fs.mkdirSync(path.join(home, '.railway'));
        fs.writeFileSync(path.join(home, '.railway', 'config.json'), JSON.stringify({ user: { accessToken: 'x'.repeat(40) } }));
        expect(railway.readToken({ spawn, home })).toBe('x'.repeat(40));
        expect(calls).toEqual([['railway', ['whoami']], ['railway', ['whoami']]]);
        const logs = [];
        const source = { id: 'railway', name: 'Railway 後台資源', apps: ['weesh'], collect: async () => ({ value: null, detail: 'Railway CLI login missing (run railway login)' }) };
        expect(await collect.main(['--only', 'railway'], { log: line => logs.push(line), now: () => Date.now(), sources: [source] })).toBe(1);
        expect(logs[0]).toBe('✗ Railway 後台資源：讀取失敗（no_result：Railway CLI login missing (run railway login)）');
        expect(collect.SOURCES.map(b => b.id)).toEqual(['rebound', 'summit', 'wishlist', 'railway', 'timehut', 'attention']);
        expect(railway.RAILWAY_APPS.every(id => importScript.catalogAppIds().has(id))).toBe(true);
    });

    test('時光相簿 account counts: key from a 600 file, Bearer to the counts-only endpoint, counts become facts; the key is never logged', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timehut-key-')), file = path.join(dir, 'timehut-stats-key'), KEY = 'k'.repeat(48);
        expect(collect.readTimehutKey(file).error).toMatch(/missing/);
        fs.writeFileSync(file, KEY + '\n', { mode: 0o644 });
        fs.chmodSync(file, 0o644);
        expect(collect.readTimehutKey(file).error).toMatch(/chmod 600/);              // readable by others: refused
        fs.chmodSync(file, 0o600);
        expect(collect.readTimehutKey(file)).toEqual({ key: KEY });
        fs.writeFileSync(file, 'short');
        expect(collect.readTimehutKey(file).error).toMatch(/not a key/);
        expect(collect.TIMEHUT_KEY_FILE).toBe(path.join(os.homedir(), '.config', 'aihankapps-hub', 'timehut-stats-key'));

        const calls = [];
        const answer = (status, body) => async (url, init) => { calls.push({ url, init }); return { status, json: async () => body }; };
        const readKey = () => ({ key: KEY });
        const ok = await collect.collectTimehut({ readKey, fetchImpl: answer(200, { total: 7, last7d: 1, last30d: 3, deleted: 2, asOf: '2026-11-11T07:00:00.000Z' }) });
        expect(calls[0].url).toBe('https://just-healing-production.up.railway.app/api/internal/account-stats');
        expect(calls[0].init.headers.Authorization).toBe('Bearer ' + KEY);
        expect(calls[0].init.redirect).toBe('error');
        expect(ok.value.facts.map(f => [f.app, f.key, f.value.value])).toEqual([['timehut', 'accountsTotal', 7], ['timehut', 'accountsNew7d', 1], ['timehut', 'accountsNew30d', 3], ['timehut', 'accountsDeleted', 2]]);
        expect(ok.value.notes).toEqual([]);
        const timehut = collect.SOURCES.find(b => b.id === 'timehut');
        const built = collect.toEnvelope(timehut, ok, { now: Date.now() });
        expect(built.error).toBeUndefined();
        expect(built.envelope).toMatchObject({ source: 'timehut', series: [] });
        expect(JSON.stringify(built.envelope)).not.toContain(KEY);
        // no creation time on the server: the windows are left out, not guessed
        const partial = await collect.collectTimehut({ readKey, fetchImpl: answer(200, { total: 7, last7d: null, last30d: null, deleted: 0 }) });
        expect(partial.value.facts.map(f => f.key)).toEqual(['accountsTotal', 'accountsDeleted']);
        expect(partial.value.notes[0]).toMatch(/近 7／30 天/);
        // refusals and odd answers stop this source only, with a reason that carries no key
        for (const [fetchImpl, detail] of [[answer(401, { error: 'Unauthorized' }), 'HTTP 401'], [answer(200, { total: -1 }), 'unexpected answer'],
            [async () => { throw Object.assign(new Error('x ' + KEY), { name: 'TimeoutError' }); }, 'request failed (TimeoutError)']]) {
            const r = await collect.collectTimehut({ readKey, fetchImpl });
            expect(r).toEqual({ value: null, detail });
        }
        expect(await collect.collectTimehut({ readKey: () => ({ error: 'key file missing (x)' }), fetchImpl: answer(200, {}) })).toEqual({ value: null, detail: 'key file missing (x)' });
        const logs = [];
        const failing = { ...timehut, collect: () => collect.collectTimehut({ readKey, fetchImpl: answer(401, {}) }) };
        expect(await collect.main(['--only', 'timehut'], { log: line => logs.push(line), now: () => Date.now(), sources: [failing] })).toBe(1);
        expect(logs[0]).toBe('✗ 時光相簿伺服器：讀取失敗（no_result：HTTP 401）');
        expect(logs.join('\n')).not.toContain(KEY);
        expect(importScript.catalogAppIds().has('timehut')).toBe(true);
    });
});

describe('admin hub import script (runs inside the EClaw container)', () => {
    const script = path.join(backendDir, 'scripts', 'aihankapps-hub-import.js');
    const base64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64');

    test('takes one envelope, as a base64 argument or on stdin, and refuses anything else', async () => {
        expect(await importScript.readEnvelope(base64(envelope()))).toEqual(envelope());
        expect(await importScript.readEnvelope(undefined, Readable.from([Buffer.from(JSON.stringify(envelope()))]))).toEqual(envelope());
        await expect(importScript.readEnvelope('not base64!')).rejects.toMatchObject({ code: 'IMPORT_NOT_BASE64' });
        await expect(importScript.readEnvelope('A'.repeat(4 * Math.ceil(store.MAX_IMPORT_BYTES / 3) + 4))).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE' });
        await expect(importScript.readEnvelope(undefined, Readable.from([Buffer.alloc(store.MAX_IMPORT_BYTES + 1, 32)]))).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE' });
        await expect(importScript.readEnvelope(base64('{"schemaVersion":1'))).rejects.toMatchObject({ code: 'IMPORT_NOT_JSON' });
    });

    test('accepts only apps the portfolio catalog lists', () => {
        const ids = importScript.catalogAppIds();
        for (const id of BACKENDS.flatMap(b => b.apps)) expect(ids.has(id)).toBe(true);
        expect(ids.has('ghost')).toBe(false);
    });

    test('answers one line of JSON with a code only; a wrong envelope is refused before any connection', () => {
        const env = { ...process.env };
        delete env.DATABASE_URL;
        const run = (argument, extra = {}) => spawnSync(process.execPath, [script, argument], { cwd: backendDir, encoding: 'utf8', env: { ...env, ...extra }, timeout: 30000 });
        const missing = run(base64(envelope()));
        expect([missing.status, missing.stdout, JSON.parse(missing.stderr.trim())]).toEqual([1, '', { success: false, error: 'DATABASE_CONFIG_MISSING' }]);
        // a port nothing listens on: had the envelope been accepted, connecting would have failed differently
        const wrong = run(base64(envelope({ source: 'Bad Source' })), { DATABASE_URL: 'postgres://hub:never@127.0.0.1:9/none' });
        expect([wrong.status, JSON.parse(wrong.stderr.trim())]).toEqual([1, { success: false, error: 'IMPORT_SOURCE' }]);
        expect(wrong.stderr).not.toContain('127.0.0.1');
    });
});

describe('admin hub collector (tools/aihankapps-hub)', () => {
    const REAL_NOW = Date.now();
    const today = collect.taipeiToday(REAL_NOW), yesterday = hub.isoDay(hub.dayIndex(today) - 1);
    const CONTROL = /^(BEGIN READ ONLY|COMMIT|ROLLBACK|SET TRANSACTION READ ONLY|SET LOCAL statement_timeout = 20000)$/;

    // Runs a back-end's script against a stand-in database: every row carries every column the scripts read, plus
    // personal-looking ones that must never come back out.
    function runScript(backend, { failOn } = {}) {
        const log = [], printed = [];
        const ROW = { first: '2026-10-20', total: 5, day: yesterday, n: 2, players: 1, twd: 30, d7: 1, d30: 2, runs30: 3, users: 2, accounts: 1, product: 'dual-city',
            week: '2026-10-05', size: 4, d1: 2, d3: 1, d14: 1, email: 'SENTINEL@example.invalid', nickname: 'SENTINEL', device_secret: 'SENTINEL' };
        const answer = sql => {
            log.push(sql.trim());
            if (CONTROL.test(sql.trim())) return [];
            if (failOn && sql.includes(failOn)) throw new Error('relation does not exist');
            return [{ ...ROW }];
        };
        const fakes = {
            pg: { Pool: class { async connect() { return { query: async sql => ({ rows: answer(sql) }), release() {} }; } async end() {} } },
            '@prisma/client': { PrismaClient: class {
                async $transaction(run) { return run({ $executeRawUnsafe: async sql => { answer(sql); return 0; }, $queryRawUnsafe: async sql => answer(sql) }); }
                async $disconnect() {}
            } },
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('the script printed nothing')), 5000);
            const sandbox = {
                require: name => { if (!fakes[name]) throw new Error('unexpected require ' + name); return fakes[name]; },
                process: { env: { DATABASE_URL: 'postgres://synthetic', NODE_ENV: 'production' }, exitCode: 0 },
                console: { log: line => { printed.push(line); if (String(line).startsWith('GIFT_RESULT ')) { clearTimeout(timer); resolve({ value: JSON.parse(line.slice(12)), log, printed }); } } },
            };
            vm.runInNewContext(backend.script(today), sandbox);
        });
    }

    test.each(BACKENDS.map(b => [b.id, b]))('%s: only read-only questions, each in its own read-only transaction, and only counts come back', async (_id, backend) => {
        const { value, log, printed } = await runScript(backend);
        expect(value.error).toBeUndefined();
        expect(printed).toHaveLength(1);
        const questions = log.filter(sql => !CONTROL.test(sql));
        expect(questions.length).toBeGreaterThan(5);
        for (const sql of questions) {
            expect(sql).toMatch(/^(SELECT|WITH)\b/);
            expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|COPY|CALL)\b/i);
            expect(sql).not.toMatch(/\b(email|password\w*|token|secret|nickname|phone|address|content|body|receipt\w*)\b|SELECT \*/i);
            const at = log.indexOf(sql);
            expect(log.slice(at - 2, at)).toEqual(backend.id === 'wishlist' ? ['SET TRANSACTION READ ONLY', 'SET LOCAL statement_timeout = 20000'] : ['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 20000']);
        }
        expect(printed[0]).not.toContain('SENTINEL');
        const built = collect.toEnvelope(backend, { value }, { now: REAL_NOW });
        expect(built.error).toBeUndefined();
        expect(built.envelope).toMatchObject({ schemaVersion: 1, source: backend.id, collectedAt: REAL_NOW });
        expect(built.envelope.series.length).toBeGreaterThan(2);
        expect(built.envelope.series.every(s => backend.apps.includes(s.app) && s.start <= yesterday && hub.dayIndex(s.start) + s.values.length - 1 === hub.dayIndex(yesterday))).toBe(true);
        expect(built.envelope.facts.find(f => f.key === 'retention')).toBeTruthy();
        expect(remoteScript(backend, today)).toContain(backend.script(today));
    });

    test('a question that fails is noted, rolled back, and the rest still arrive', async () => {
        const { value, log } = await runScript(BACKENDS.find(b => b.id === 'rebound'), { failOn: 'FROM mailbox' });
        expect(value.notes).toEqual(['信件：讀不到', '領取：讀不到', '待領信件：讀不到']);
        expect(log.filter(sql => sql === 'ROLLBACK')).toHaveLength(3);
        expect(value.series.map(s => s.metric)).toEqual(['newUsers', 'plays', 'activeUsers', 'purchases']);
    });

    test('a script\'s answer becomes an envelope only for its own apps, within the size one argument can carry', () => {
        const rebound = BACKENDS.find(b => b.id === 'rebound');
        const now = REAL_NOW;
        expect(collect.toEnvelope(rebound, { value: null, detail: 'railway: not logged in' }, { now })).toEqual({ error: 'no_result', detail: 'railway: not logged in' });
        expect(collect.toEnvelope(rebound, { value: { error: 'boom' } }, { now })).toEqual({ error: 'script_failed', detail: 'boom' });
        expect(collect.toEnvelope(rebound, { value: { series: [{ app: 'weesh', metric: 'plays', start: yesterday, values: [1] }] } }, { now })).toEqual({ error: 'unexpected_app', detail: 'weesh' });
        expect(collect.toEnvelope(rebound, { value: { series: [{ app: 'rebound', metric: 'bogus', start: yesterday, values: [1] }] } }, { now }).error).toBe('IMPORT_SERIES');
        const big = { series: [], facts: Array.from({ length: 10 }, (_, i) => ({ app: 'rebound', key: 'big' + i, value: { label: 'x'.repeat(7000) } })) };
        expect(collect.toEnvelope(rebound, { value: big }, { now })).toEqual({ error: 'too_large' });
        expect(collect.MAX_SHELL_ENVELOPE_BYTES).toBeLessThanOrEqual(store.MAX_IMPORT_BYTES);
        // twice base64-encoded, the largest envelope still fits one 128 KiB argument
        expect(Math.ceil(Math.ceil(collect.MAX_SHELL_ENVELOPE_BYTES * 4 / 3 + 2000) * 4 / 3)).toBeLessThan(128 * 1024);
    });

    test('without --commit it only reads; with --commit each envelope goes to the import script in the EClaw container', async () => {
        const calls = [], logs = [];
        const log = line => logs.push(line);
        const run = (target, shell) => {
            calls.push({ target, shell });
            if (target === collect.HUB) return { value: { success: true, source: 'x', values: 1, facts: 0 } };
            const backend = BACKENDS.find(b => b.railway === target);
            return { value: { series: [{ app: backend.apps[0], metric: 'plays', start: yesterday, values: [4] }], facts: [], notes: ['說明'] } };
        };
        expect(await collect.main([], { run, log, now: () => REAL_NOW, sources: BACKENDS })).toBe(0);
        expect(calls.map(c => c.target.service)).toEqual(['rebound-api', 'summit-battle-api', 'wishlist-app']);
        expect(calls.every(c => c.shell.includes("node --input-type=commonjs - <<'GIFT_NODE_SCRIPT'"))).toBe(true);
        expect(logs.at(-1)).toContain('這次只讀取、沒有匯入');
        expect(logs.join('\n')).not.toMatch(/\b4\b/);          // the log says what would be sent, not the numbers

        calls.length = 0;
        expect(await collect.main(['--commit', '--only', 'summit'], { run, log, now: () => REAL_NOW })).toBe(0);
        expect(calls.map(c => c.target)).toEqual([BACKENDS.find(b => b.id === 'summit').railway, collect.HUB]);
        expect(collect.HUB).toMatchObject({ projectId: '844a6139-9b8f-43d6-a698-f97db1fa05c0', environment: 'production', service: 'eclaw' });
        const encoded = calls[1].shell.match(/scripts\/aihankapps-hub-import\.js', '([A-Za-z0-9+/=]+)'/)[1];
        expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toEqual({ schemaVersion: 1, source: 'summit', collectedAt: REAL_NOW,
            series: [{ app: 'typeforge-twin-cities', metric: 'plays', start: yesterday, values: [4] }], facts: [], notes: ['說明'] });
        expect(calls[1].shell).not.toMatch(/DATABASE_URL|postgres:\/\//);

        expect(await collect.main(['--only', 'nope'], { run, log, now: () => REAL_NOW })).toBe(2);
        const failing = target => (target === collect.HUB ? { value: { success: false, error: 'IMPORT_SERIES' } } : run(target, ''));
        expect(await collect.main(['--commit', '--only', 'rebound'], { run: failing, log, now: () => REAL_NOW })).toBe(1);
        expect(logs.at(-1)).toContain('匯入失敗（IMPORT_SERIES');
        expect(await collect.main(['--only', 'wishlist'], { run: () => ({ value: null, detail: 'timed out' }), log, now: () => REAL_NOW })).toBe(1);
    });

    test('the summary line counts series and facts per app', () => {
        expect(collect.describe({ series: [{ app: 'rebound', metric: 'plays', start: '2026-11-01', values: [1, 2] }], facts: [{ app: 'rebound' }, { app: 'weesh' }] }))
            .toBe('  rebound: plays(2026-11-01…2 天)；1 個目前數字\n  weesh: 沒有每日數列；1 個目前數字');
        expect(collect.taipeiToday(Date.UTC(2026, 10, 10, 16, 0))).toBe('2026-11-11');
    });
});

describe('collector: the listing schedules\' attention board', () => {
    const collect = require('../../../tools/aihankapps-hub/collect');
    const NOW_MS = Date.parse('2026-11-12T03:00:00Z');
    const item = (id, kind, extra) => ({ id, kind, platform: 'shopee', title: '蝦皮需要手動通過驗證', detail: '請在 Chrome 開 shopee.tw', since: '2026-11-12T01:00:00Z', count: 2, ...extra });
    const read = body => () => (typeof body === 'string' ? body : JSON.stringify(body));
    test('carries the board as one fact for Wishlist: people first, text cleaned, nothing else read', () => {
        const r = collect.collectAttention({ now: NOW_MS, read: read({ schemaVersion: 1, observedAt: '2026-11-12T02:59:00Z', items: [
            item('fb-hard-posts', 'healing', { since: '2026-11-11T01:00:00Z' }), item('shopee-verification', 'human', { title: ' 蝦皮需要\n手動通過驗證 ', count: 3 }),
            item('Bad Id', 'human'), item('no-title', 'human', { title: '' }), item('odd-kind', 'other'), item('no-time', 'human', { since: 'soon' })] }) });
        const fact = r.value.facts[0];
        expect([fact.app, fact.key, fact.value.value, fact.value.healing, fact.value.boardAt]).toEqual(['weesh', 'attention', 1, 1, Date.parse('2026-11-12T02:59:00Z')]);
        expect(fact.value.items).toEqual([
            { id: 'shopee-verification', kind: 'human', platform: 'shopee', title: '蝦皮需要 手動通過驗證', detail: '請在 Chrome 開 shopee.tw', since: Date.parse('2026-11-12T01:00:00Z'), count: 3 },
            { id: 'fb-hard-posts', kind: 'healing', platform: 'shopee', title: '蝦皮需要手動通過驗證', detail: '請在 Chrome 開 shopee.tw', since: Date.parse('2026-11-11T01:00:00Z'), count: 2 }]);
        const source = collect.LOCAL.find(s => s.id === 'attention');
        expect(source.apps).toEqual(['weesh']);
        const built = collect.toEnvelope(source, r, NOW_MS, new Set(['weesh']));
        expect(built.envelope.source).toBe('attention');
        expect(built.envelope.facts).toHaveLength(1);
    });
    test('a long board keeps every entry that needs a person before any healing one, and says what was left out', () => {
        const items = Array.from({ length: 10 }, (_, i) => item('healing-' + i, 'healing')).concat(Array.from({ length: 5 }, (_, i) => item('human-' + i, 'human')));
        const r = collect.collectAttention({ now: NOW_MS, read: read({ schemaVersion: 1, observedAt: '2026-11-12T02:59:00Z', items }) });
        const sent = r.value.facts[0].value;
        expect([sent.value, sent.healing, sent.items.length, sent.items.filter(x => x.kind === 'human').length]).toEqual([5, 10, 12, 5]);
        expect(r.value.notes).toEqual(['警示板有 15 項，只送前 12 項']);
        expect(JSON.stringify(sent).length).toBeLessThan(8192);
    });
    test('no file, another shape or a time in the future sends nothing', () => {
        expect(collect.collectAttention({ now: NOW_MS, read: () => { throw new Error('ENOENT'); } }).value).toBeNull();
        expect(collect.collectAttention({ now: NOW_MS, read: read('not json') }).value).toBeNull();
        expect(collect.collectAttention({ now: NOW_MS, read: read({ schemaVersion: 2, observedAt: '2026-11-12T02:59:00Z', items: [] }) }).value).toBeNull();
        expect(collect.collectAttention({ now: NOW_MS, read: read({ schemaVersion: 1, observedAt: '2026-11-12T04:00:00Z', items: [] }) }).value).toBeNull();
        expect(collect.collectAttention({ now: NOW_MS, read: read({ schemaVersion: 1, observedAt: '2026-11-12T02:59:00Z', items: [] }) }).value.facts[0].value).toMatchObject({ value: 0, healing: 0, items: [] });
        expect(collect.ATTENTION_FILE).toMatch(/aihankapps-hub[\\/]attention-summary\.json$/);
    });
});

