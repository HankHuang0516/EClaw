require('./helpers/mock-setup');
const express = require('express');
const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const progress = require('../../dot-progress');
const base = '/api/dot-progress'; const admin = call => call.set('x-test-role', 'admin'); let sequence = 0;
const token = () => `synthetic-period-${++sequence}`;
function setup(override) {
    const db = newDb({ noAstCoverageCheck: true });
    db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
    db.public.registerFunction({ name: 'clock_timestamp', args: [], returns: DataType.timestamptz, impure: true, implementation: () => new Date() });
    const { Pool } = db.adapters.createPg(); const memory = new Pool(); const connect = memory.connect.bind(memory);
    memory.connect = async () => { const client = await connect(); const query = client.query.bind(client); client.query = (sql, params) => sql.startsWith('SET TRANSACTION') ? Promise.resolve({ rows: [] }) : query(sql, params); return client; };
    const pool = override === undefined ? memory : override;
    const auth = {
        authMiddleware(req, res, next) { if (!req.get('x-test-role')) return res.status(401).json({ success: false, error: 'unauthenticated' }); req.user = { userId: 'synthetic-admin' }; next(); },
        adminMiddleware(req, res, next) { if (req.get('x-test-role') !== 'admin') return res.status(403).json({ success: false, error: 'admin_required' }); next(); }
    };
    const app = express(); app.use(base, progress.createRouter(() => pool, auth)); return { app, pool };
}
const plan = delta => ({ id: 'synthetic-repeated-row', projectId: null, projectLabel: 'Synthetic period project', goal: 'Synthetic explicit goal.', plannedStart: null, plannedEnd: null, status: 'planned', actualIds: [], ...delta });
async function board(app, date, rows) {
    const result = await admin(request(app).put(`${base}/schedule/${date}`)).send({ requestId: token(), version: 0, rows, rowOrder: rows.map(row => row.id) });
    expect({ status: result.status, body: result.body }).toMatchObject({ status: 200 }); return result.body.schedule;
}
async function actual(app, startedAt, endedAt) {
    const result = await admin(request(app).post(`${base}/timeline`)).send({ requestId: token(), startedAt, endedAt, projectId: null, projectLabel: 'Synthetic period actual', goal: 'Synthetic actual goal.', workType: 'validation', actions: 'Synthetic check.', result: 'Synthetic passed.' });
    expect({ status: result.status, body: result.body }).toMatchObject({ status: 200 }); return result.body.entry;
}
const period = (app, date, view) => admin(request(app).get(`${base}/schedule-period`).query({ date, view }));
async function snapshots(pool) {
    const tables = ['dot_progress_timeline', 'dot_progress_timeline_revisions', 'dot_progress_timeline_requests', 'dot_progress_projects', 'dot_progress_history', 'dot_progress_push_state', 'dot_progress_push_requests', 'dot_progress_schedule', 'dot_progress_schedule_revisions', 'dot_progress_schedule_requests'];
    return Promise.all(tables.map(table => pool.query(`SELECT * FROM ${table} ORDER BY 1`).then(result => result.rows)));
}

describe('read-only Taipei calendar periods', () => {
    test('calendar months31/29/leap exceptions and ISO Monday cross-year boundaries are exact', async () => {
        const { app } = setup();
        const cases = [
            ['2021-07-15', 'month', '2021-07-01', '2021-08-01'], ['2040-02-29', 'month', '2040-02-01', '2040-03-01'],
            ['2100-02-28', 'month', '2100-02-01', '2100-03-01'], ['2000-02-29', 'month', '2000-02-01', '2000-03-01'],
            ['2021-01-01', 'week', '2020-12-28', '2021-01-04'], ['2020-12-31', 'week', '2020-12-28', '2021-01-04'],
            ['2018-12-31', 'week', '2018-12-31', '2019-01-07'], ['2040-07-19', 'day', '2040-07-19', '2040-07-20']
        ];
        for (const [date, view, from, to] of cases) {
            const result = await period(app, date, view); expect(result.status).toBe(200);
            expect(result.body).toEqual({ success: true, period: { date, view, from, to, startAt: new Date(`${from}T00:00:00+08:00`).toISOString(), endAt: new Date(`${to}T00:00:00+08:00`).toISOString() }, schedules: [] });
        }
        expect((await period(app, '2100-02-29', 'month')).status).toBe(400);
    });

    test('carry-in/out owners and repeated IDs keep full boards while untimed rows match only their owner date', async () => {
        const { app, pool } = setup();
        const beforeOwner = await board(app, '2020-12-27', [plan({ plannedStart: '2020-12-27T23:00:00+08:00', plannedEnd: '2020-12-28T01:00:00+08:00' }), plan({ id: 'synthetic-untimed-before' })]);
        const afterOwner = await board(app, '2021-01-04', [plan({ plannedStart: '2021-01-03T23:00:00+08:00', plannedEnd: '2021-01-04T01:00:00+08:00' }), plan({ id: 'synthetic-untimed-after' })]);
        const inside = await board(app, '2021-01-01', [plan({ id: 'synthetic-untimed-inside' })]);
        await board(app, '2020-12-26', [plan({ plannedStart: '2020-12-26T23:00:00+08:00', plannedEnd: '2020-12-28T00:00:00+08:00' })]);
        const snapshot = await snapshots(pool);
        const result = await period(app, '2021-01-01', 'week'); expect(result.status).toBe(200);
        expect(result.body.schedules).toEqual([
            { ...beforeOwner, matchingRowIds: ['synthetic-repeated-row'] },
            { ...inside, matchingRowIds: ['synthetic-untimed-inside'] },
            { ...afterOwner, matchingRowIds: ['synthetic-repeated-row'] }
        ]);
        expect(result.body.schedules[0].rows).toHaveLength(2); expect(result.body.schedules[2].rows).toHaveLength(2);
        const day = await period(app, '2020-12-28', 'day'); expect(day.body.schedules.map(value => value.date)).toEqual(['2020-12-27']);
        expect((await admin(request(app).get(`${base}/schedule?date=2020-12-28`))).body.schedule.version).toBe(0);
        expect(await snapshots(pool)).toEqual(snapshot);
    });

    test('native timeline periods retain half-open spans, milestones, zero points and exact legacy day JSON', async () => {
        const { app } = setup(); const included = [];
        included.push(await actual(app, '2020-12-27T23:00:00+08:00', '2020-12-28T01:00:00+08:00'));
        await actual(app, '2020-12-27T23:00:00+08:00', '2020-12-28T00:00:00+08:00');
        included.push(await actual(app, '2020-12-28T00:00:00+08:00', '2020-12-28T00:00:00+08:00'));
        included.push(await actual(app, null, '2020-12-28T00:00:00+08:00'));
        await actual(app, null, '2021-01-04T00:00:00+08:00');
        await actual(app, '2021-01-04T00:00:00+08:00', '2021-01-04T00:30:00+08:00');
        const week = await admin(request(app).get(`${base}/timeline?date=2021-01-01&view=week`));
        expect(week.status).toBe(200); expect(week.body.entries.map(entry => entry.id).sort()).toEqual(included.map(entry => entry.id).sort());
        const legacy = await admin(request(app).get(`${base}/timeline?date=2020-12-28`));
        const explicit = await admin(request(app).get(`${base}/timeline?date=2020-12-28&view=day`));
        expect(explicit.body).toEqual(legacy.body);
        expect(Object.keys(explicit.body).sort()).toEqual(['success', 'entries', 'total', 'limit', 'offset', 'nextOffset'].sort());
        expect((await admin(request(app).get(`${base}/timeline?date=2021-01-01&view=month`))).body.total).toBe(2);
    });

    test('500 pagination remains explicit and no duplicates or silent caps enter period lists', async () => {
        const { app, pool } = setup(); const entry = await actual(app, null, '2040-02-29T10:00:00+08:00');
        const data = progress.normalizeTimelineInput({ ...Object.fromEntries(['startedAt', 'endedAt', 'projectId', 'projectLabel', 'goal', 'workType', 'actions', 'result', 'blockers', 'nextStep', 'evidence'].map(key => [key, entry[key]])), requestId: token() }); delete data.requestId;
        for (let i = 0; i < 500; i++) await pool.query('INSERT INTO dot_progress_timeline(id,project_label,started_at,ended_at,data,actor_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [`synthetic-period-actual-${i}`, data.projectLabel, null, data.endedAt, JSON.stringify(data), 'synthetic-admin']);
        let result = await admin(request(app).get(`${base}/timeline?date=2040-02-29&view=month`));
        expect(result.body).toMatchObject({ total: 501, limit: 500, offset: 0, nextOffset: 500 });
        const ids = result.body.entries.map(value => value.id);
        result = await admin(request(app).get(`${base}/timeline?date=2040-02-29&view=month&offset=500`));
        expect(result.body.entries).toHaveLength(1); expect(result.body.nextOffset).toBeNull();
        expect(new Set([...ids, ...result.body.entries.map(value => value.id)]).size).toBe(501);
    });

    test('candidate bounds clamp safely, unsupported periods fail closed and omitted-view legacy extreme day stays valid', async () => {
        const { app } = setup();
        const first = await board(app, '1000-01-01', [plan()]);
        expect((await period(app, '1000-01-01', 'month')).body.schedules[0]).toEqual({ ...first, matchingRowIds: [first.rows[0].id] });
        const last = await board(app, '9999-12-31', [plan({ plannedStart: '9999-12-30T23:00:00+08:00', plannedEnd: '9999-12-31T01:00:00+08:00' })]);
        expect((await period(app, '9999-12-30', 'day')).body.schedules[0]).toEqual({ ...last, matchingRowIds: [last.rows[0].id] });
        expect((await period(app, '1000-01-01', 'week')).body.error).toBe('invalid_range');
        expect((await period(app, '9999-12-31', 'day')).body.error).toBe('invalid_range');
        expect((await period(app, '9999-12-01', 'month')).body.error).toBe('invalid_range');
        expect((await admin(request(app).get(`${base}/timeline?date=9999-12-31`))).status).toBe(200);
        expect((await admin(request(app).get(`${base}/timeline?date=9999-12-31&view=day`))).body.error).toBe('invalid_range');
    });

    test('strict query validation/admin gates/no-store and DB failures cover new read-only paths', async () => {
        const { app } = setup();
        for (const suffix of ['', '?date=2040-07-19', '?view=week', '?date=2040-07-19&view=year', '?date=2040-02-30&view=month', '?date=2040-07-19&view=week&secret=synthetic', '?date=2040-07-19&view=week&view=month']) expect((await admin(request(app).get(`${base}/schedule-period${suffix}`))).status).toBe(400);
        for (const suffix of ['?view=week', '?date=2040-07-19&view=year', '?date=2040-07-19&view=week&view=month']) expect((await admin(request(app).get(`${base}/timeline${suffix}`))).status).toBe(400);
        for (const path of ['/schedule-period?date=2040-07-19&view=week', '/timeline?date=2040-07-19&view=week']) {
            expect((await request(app).get(`${base}${path}`)).status).toBe(401);
            expect((await request(app).get(`${base}${path}`).set('x-test-role', 'member')).status).toBe(403);
            expect((await admin(request(app).get(`${base}${path}`))).headers['cache-control']).toBe('no-store');
        }
        expect((await admin(request(app).post(`${base}/schedule-period`)).set('Origin', 'https://synthetic-other.invalid').send({})).status).toBe(403);
        const failed = setup(null); expect((await period(failed.app, '2040-07-19', 'week')).status).toBe(503);
    });
});

const realPg = process.env.DOT_PROGRESS_TEST_PG === '1' ? test : test.skip;
realPg('actual PostgreSQL period boundaries/native overlap and full read-only snapshot durability', async () => {
    const { Pool } = jest.requireActual('pg'); const name = `dot_period_test_${process.pid}_${Date.now()}`;
    const config = { host: '127.0.0.1', port: 55414, database: 'postgres', user: 'progress_test', connectionTimeoutMillis: 2000, statement_timeout: 4000 };
    const owner = new Pool(config); await owner.query(`CREATE SCHEMA ${name}`); const pool = new Pool({ ...config, options: `-c search_path=${name}` });
    try {
        const { app } = setup(pool);
        const saved = await board(app, '2040-02-28', [plan()]);
        const milestone = await actual(app, null, '2040-02-29T23:59:59.999+08:00');
        const point = await actual(app, '2040-02-01T00:00:00+08:00', '2040-02-01T00:00:00+08:00');
        await actual(app, null, '2040-03-01T00:00:00+08:00');
        await actual(app, '2040-01-31T23:00:00+08:00', '2040-02-01T00:00:00+08:00');
        const before = await snapshots(pool);
        const result = await period(app, '2040-02-29', 'month'); expect(result.body.period).toMatchObject({ from: '2040-02-01', to: '2040-03-01' });
        expect(result.body.schedules).toEqual([{ ...saved, matchingRowIds: [saved.rows[0].id] }]);
        const actuals = await admin(request(app).get(`${base}/timeline?date=2040-02-29&view=month`));
        expect(actuals.body.entries.map(entry => entry.id).sort()).toEqual([milestone.id, point.id].sort());
        const restarted = setup(pool); expect((await period(restarted.app, '2040-02-29', 'month')).body).toEqual(result.body);
        expect(await snapshots(pool)).toEqual(before);
    } finally { await pool.end(); await owner.query(`DROP SCHEMA ${name} CASCADE`); await owner.end(); }
}, 20000);
