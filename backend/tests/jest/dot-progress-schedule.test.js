require('./helpers/mock-setup');
const express = require('express');
const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const progress = require('../../dot-progress');
const base = '/api/dot-progress';
const day = '2040-07-19';
const admin = call => call.set('x-test-role', 'admin');
const row = (delta = {}) => ({ id: 'synthetic-row', projectId: null, projectLabel: 'Synthetic project', goal: 'Synthetic measurable goal.', plannedStart: '2040-07-19T10:00:00+08:00', plannedEnd: '2040-07-19T11:00:00+08:00', status: 'planned', actualIds: [], ...delta });
const input = (delta = {}) => ({ requestId: 'synthetic-plan-0001', version: 0, rows: [row()], ...delta });
function setup(override) {
    const db = newDb({ noAstCoverageCheck: true });
    db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
    db.public.registerFunction({ name: 'clock_timestamp', args: [], returns: DataType.timestamptz, impure: true, implementation: () => new Date() });
    const { Pool } = db.adapters.createPg(); const memory = new Pool();
    const connect = memory.connect.bind(memory);
    memory.connect = async () => {
        const client = await connect(); const query = client.query.bind(client);
        // pg-mem does not implement transaction isolation; actual PG below does.
        client.query = (sql, params) => sql.startsWith('SET TRANSACTION') ? Promise.resolve({ rows: [] }) : query(sql, params);
        return client;
    };
    const pool = override === undefined ? memory : override;
    const auth = {
        authMiddleware(req, res, next) {
            if (!req.get('x-test-role')) return res.status(401).json({ success: false, error: 'unauthenticated' });
            req.user = { userId: req.get('x-test-user') || 'synthetic-admin' }; next();
        },
        adminMiddleware(req, res, next) {
            if (req.get('x-test-role') !== 'admin') return res.status(403).json({ success: false, error: 'admin_required' }); next();
        }
    };
    const app = express(); app.use(base, progress.createRouter(() => pool, auth));
    return { app, pool, auth };
}
async function put(app, body = input(), date = day) {
    const result = await admin(request(app).put(`${base}/schedule/${date}`)).send(body);
    expect({ status: result.status, body: result.body }).toMatchObject({ status: 200 });
    return result.body.schedule;
}
async function actual(app) {
    const body = { requestId: 'synthetic-actual-0001', startedAt: null, endedAt: '2040-07-19T10:30:00+08:00', projectId: null, projectLabel: 'Synthetic actual project', workType: 'validation', actions: 'Synthetic check.', result: 'Synthetic passed.' };
    const result = await admin(request(app).post(`${base}/timeline`)).send(body);
    expect(result.status).toBe(200); return result.body.entry;
}
async function snapshots(pool) {
    const tables = ['dot_progress_timeline', 'dot_progress_timeline_revisions', 'dot_progress_timeline_requests', 'dot_progress_projects', 'dot_progress_history', 'dot_progress_push_state', 'dot_progress_push_requests', 'dot_progress_decisions', 'dot_progress_review'];
    return Promise.all(tables.map(table => pool.query(`SELECT * FROM ${table} ORDER BY 1`).then(result => result.rows)));
}

describe('private independent planned schedule', () => {
    test('absent board is version zero without writes; explicit save stores canonical planning and immutable history', async () => {
        const { app, pool } = setup();
        const empty = await admin(request(app).get(`${base}/schedule?date=${day}`));
        expect(empty.body).toEqual({ success: true, schedule: { date: day, version: 0, rows: [], rowOrder: [], updatedAt: null } });
        expect((await pool.query('SELECT COUNT(*) AS count FROM dot_progress_schedule')).rows[0].count).toBe(0);
        const first = await put(app);
        expect(first).toMatchObject({ date: day, version: 1, rows: [{ plannedStart: '2040-07-19T02:00:00.000Z', plannedEnd: '2040-07-19T03:00:00.000Z' }] });
        expect(Number.isNaN(Date.parse(first.updatedAt))).toBe(false);
        expect((await admin(request(app).get(`${base}/schedule?date=${day}`))).body.schedule).toEqual(first);
        const history = await admin(request(app).get(`${base}/schedule/${day}/history`));
        expect(history.body).toMatchObject({ total: 1, limit: 100, offset: 0, nextOffset: null, history: [{ version: 1, actorId: 'synthetic-admin', changes: { before: empty.body.schedule, after: first } }] });
    });

    test('retry returns original receipt after later saves; undo is a new version and actor/request scope is server-owned', async () => {
        const { app, pool } = setup(); const first = await put(app);
        const second = await put(app, input({ version: 1, requestId: 'synthetic-plan-0002', rows: [row({ status: 'active', goal: 'Synthetic revised goal.' })] }));
        expect(second.version).toBe(2); expect(await put(app)).toEqual(first);
        expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input({ rows: [] }))).body.error).toBe('request_id_conflict');
        expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input({ requestId: 'synthetic-stale-plan' }))).body.error).toBe('version_conflict');
        const undone = await put(app, input({ version: 2, requestId: 'synthetic-undo-plan', rows: first.rows }));
        expect(undone.version).toBe(3); expect(undone.rows).toEqual(first.rows);
        const otherActor = await admin(request(app).put(`${base}/schedule/${day}`)).set('x-test-user', 'synthetic-other-admin').send(input({ version: 3 }));
        expect(otherActor.status).toBe(200); expect(otherActor.body.schedule.version).toBe(4);
        const restarted = setup(pool); expect(await put(restarted.app)).toEqual(first);
        expect((await admin(request(restarted.app).get(`${base}/schedule/${day}/history`))).body.history.map(entry => entry.version)).toEqual([4, 3, 2, 1]);
    });

    test('display ordering references virtual actual IDs without creating plan rows and omitted order preserves it', async () => {
        const { app, pool } = setup(); const entry = await actual(app); const before = await snapshots(pool);
        const ordered = await put(app, input({ rows: [], rowOrder: [entry.id] }));
        expect(ordered.rows).toEqual([]); expect(ordered.rowOrder).toEqual([entry.id]);
        expect(await snapshots(pool)).toEqual(before);
        const saved = await put(app, input({ version: 1, requestId: 'synthetic-save-ordered-plan' }));
        expect(saved.rowOrder).toEqual([entry.id]); expect(saved.rows).toHaveLength(1);
        const reordered = await put(app, input({ version: 2, requestId: 'synthetic-order-only', rows: saved.rows, rowOrder: [saved.rows[0].id, entry.id] }));
        expect(reordered.rows).toEqual(saved.rows);
        const removed = await put(app, input({ version: 3, requestId: 'synthetic-remove-plan-keep-order', rows: [] }));
        expect(removed.rows).toEqual([]); expect(removed.rowOrder).toEqual(reordered.rowOrder);
        const cleared = await put(app, input({ version: 4, requestId: 'synthetic-clear-order', rows: saved.rows, rowOrder: [] }));
        expect(cleared.rowOrder).toEqual([]); expect(cleared.rows).toEqual(saved.rows);
        const restarted = setup(pool); expect(await put(restarted.app, input({ rows: [], rowOrder: [entry.id] }))).toEqual(ordered);
        expect((await admin(request(restarted.app).get(`${base}/schedule?date=${day}`))).body.schedule).toEqual(cleared);
    });

    test('archiving and restoring one row retains status, dates, links, other rows and audit history', async () => {
        const { app, pool } = setup(); const entry = await actual(app);
        const first = await put(app, input({ rows: [row({ status: 'active', actualIds: [entry.id] }), row({ id: 'synthetic-unselected', status: 'waiting', plannedStart: null, plannedEnd: null })], rowOrder: ['synthetic-unselected', 'synthetic-row'] }));
        const before = await snapshots(pool);
        expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input({ version: 1, requestId: 'synthetic-forged-archive', rows: [{ ...first.rows[0], archived: true, goal: 'Simultaneous synthetic edit.' }, first.rows[1]] }))).body.error).toBe('invalid_archive_transition');
        const archiveInput = input({ version: 1, requestId: 'synthetic-archive-row', rows: first.rows.map((value, i) => i === 0 ? { ...value, archived: true } : value) });
        const archived = await put(app, archiveInput);
        expect(archived.rows[0]).toEqual({ ...first.rows[0], archived: true });
        expect(archived.rows[1]).toEqual(first.rows[1]); expect(archived.rowOrder).toEqual(first.rowOrder);
        expect(await put(app, archiveInput)).toEqual(archived);
        expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input({ version: 2, requestId: 'synthetic-forged-restore', rows: [{ ...archived.rows[0], archived: false, status: 'done' }, archived.rows[1]] }))).body.error).toBe('invalid_archive_transition');
        const restored = await put(app, input({ version: 2, requestId: 'synthetic-restore-row', rows: archived.rows.map(value => ({ ...value, archived: false })) }));
        expect(restored.rows).toEqual(first.rows); expect(restored.rowOrder).toEqual(first.rowOrder);
        expect(await snapshots(pool)).toEqual(before);
        const history = (await admin(request(app).get(`${base}/schedule/${day}/history`))).body.history;
        expect(history[0].changes).toEqual({ before: archived, after: restored });
        expect(history[1].changes).toEqual({ before: first, after: archived });
        const restarted = setup(pool); expect((await admin(request(restarted.app).get(`${base}/schedule?date=${day}`))).body.schedule).toEqual(restored);
    });

    test('legacy request/receipt stays exact when order is absent and archived false canonicalizes away', async () => {
        const { app, pool } = setup(); const first = await put(app);
        const { rowOrder: _newField, ...legacyReceipt } = first;
        await pool.query('UPDATE dot_progress_schedule_requests SET response_schedule=$1::jsonb WHERE actor_id=$2 AND request_id=$3', [JSON.stringify(legacyReceipt), 'synthetic-admin', input().requestId]);
        const payload = (await pool.query('SELECT request_payload FROM dot_progress_schedule_requests')).rows[0].request_payload;
        expect(payload).toEqual({ date: day, version: 0, rows: first.rows });
        expect(payload).not.toHaveProperty('rowOrder'); expect(payload.rows[0]).not.toHaveProperty('archived');
        const restarted = setup(pool);
        expect(await put(restarted.app)).toEqual(legacyReceipt);
        expect(await put(restarted.app, input({ rows: [row({ archived: false })] }))).toEqual(legacyReceipt);
        expect((await admin(request(restarted.app).get(`${base}/schedule?date=${day}`))).body.schedule.rowOrder).toEqual([]);
    });

    test('invalid display order and archive values cannot bypass gates, versions or receipt conflicts', async () => {
        const { app } = setup(); const entry = await actual(app);
        expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input({ rows: [row({ archived: true })] }))).body.error).toBe('invalid_archive_transition');
        for (const rowOrder of [null, 'invalid', ['bad id'], [123], [entry.id, entry.id], Array.from({ length: 551 }, (_, i) => `synthetic-order-${i}`)]) expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input({ rowOrder }))).status).toBe(400);
        expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input({ rowOrder: ['synthetic-unknown-order'] }))).status).toBe(404);
        for (const archived of [null, 'true', 1, {}, []]) expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input({ rows: [row({ archived })] }))).status).toBe(400);
        const body = input({ rows: [], rowOrder: [entry.id] }); await put(app, body);
        expect((await admin(request(app).put(`${base}/schedule/${day}`)).send({ ...body, rowOrder: [] })).body.error).toBe('request_id_conflict');
        expect((await admin(request(app).put(`${base}/schedule/${day}`)).send({ ...body, requestId: 'synthetic-stale-order' })).body.error).toBe('version_conflict');
        expect((await request(app).put(`${base}/schedule/${day}`).send(body)).status).toBe(401);
        expect((await request(app).put(`${base}/schedule/${day}`).set('x-test-role', 'member').send(body)).status).toBe(403);
        expect((await admin(request(app).put(`${base}/schedule/${day}`)).set('Origin', 'https://synthetic-other.invalid').send(body)).status).toBe(403);
    });

    test('linked actual milestones/projects are read-only and references must exist and be unique', async () => {
        const { app, pool } = setup(); const entry = await actual(app);
        const project = (await admin(request(app).get(`${base}/projects`))).body.projects[0];
        const before = await snapshots(pool);
        await put(app, input({ rows: [row({ projectId: project.id, actualIds: [entry.id], plannedStart: null, plannedEnd: null })] }));
        expect(await snapshots(pool)).toEqual(before);
        for (const rows of [[row({ projectId: 'synthetic-missing' })], [row({ actualIds: ['synthetic-missing'] })]]) {
            expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input({ version: 1, requestId: 'synthetic-missing-ref', rows }))).status).toBe(404);
        }
        const duplicate = [row({ actualIds: [entry.id] }), row({ id: 'synthetic-row-other', actualIds: [entry.id] })];
        expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input({ rows: duplicate }))).status).toBe(400);
        expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input({ rows: [row({ actualIds: [entry.id, entry.id] })] }))).status).toBe(400);
    });

    test('planned date pairs use strict Taipei overlap and permit both unknown without inventing dates', async () => {
        const valid = [row({ plannedStart: null, plannedEnd: null }), row({ plannedStart: '2040-07-18T23:30:00+08:00', plannedEnd: '2040-07-19T00:30:00+08:00' }), row({ plannedStart: '2040-07-18T16:00:00Z', plannedEnd: '2040-07-18T16:00:00Z' })];
        for (let i = 0; i < valid.length; i++) {
            const { app } = setup(); const result = await put(app, input({ rows: [valid[i]] }));
            if (i === 0) expect(result.rows[0]).toMatchObject({ plannedStart: null, plannedEnd: null });
        }
        const invalid = [
            { plannedStart: null }, { plannedEnd: null }, { plannedStart: undefined }, { plannedEnd: undefined },
            { plannedStart: '2040-02-30T10:00:00Z' }, { plannedStart: '2040-07-19T10:00:00' }, { plannedStart: '2040-07-19T10:00:00.0001Z' },
            { plannedEnd: '2040-07-19T09:00:00+08:00' }, { plannedEnd: '2040-07-26T10:00:00.001+08:00' },
            { plannedStart: '2040-07-18T23:00:00+08:00', plannedEnd: '2040-07-19T00:00:00+08:00' },
            { plannedStart: '2040-07-20T00:00:00+08:00', plannedEnd: '2040-07-20T01:00:00+08:00' }
        ];
        const { app } = setup();
        for (const delta of invalid) expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input({ rows: [row(delta)] }))).status).toBe(400);
    });

    test('strict fields/types/limits, private text hygiene, duplicate rows and ID bounds fail without writes', async () => {
        const { app } = setup();
        const badRows = [row({ id: 'bad id' }), row({ projectId: undefined }), row({ status: 'completed' }), row({ goal: '' }), row({ goal: 'x'.repeat(4001) }), row({ goal: 'synthetic@example.invalid' }), row({ projectLabel: '/Users/synthetic/private.txt' }), row({ goal: 'apiKey=synthetic-not-real' }), row({ goal: 'https://example.invalid/?token=synthetic' }), row({ projectLabel: 'x'.repeat(161) }), row({ actorId: 'forged' }), row({ actualIds: null })];
        for (const invalid of badRows) expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input({ rows: [invalid] }))).status).toBe(400);
        for (const delta of [{ actorId: 'forged' }, { updatedAt: '2040-01-01' }, { version: -1 }, { version: 0.5 }, { version: '0' }, { requestId: 'short' }, { rows: null }, { rows: [row(), row()] }, { rows: Array.from({ length: 51 }, (_, i) => row({ id: `synthetic-row-${i}` })) }, { rows: [row({ actualIds: Array.from({ length: 501 }, (_, i) => `synthetic-actual-${i}`) })] }]) expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(input(delta))).status).toBe(400);
        for (const body of [null, [], 'invalid']) expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(JSON.stringify(body)).set('Content-Type', 'application/json')).status).toBe(400);
        for (const query of ['', '?date=2040-02-30', `?date=${day}&secret=synthetic`, `?date=${day}&date=${day}`]) expect((await admin(request(app).get(`${base}/schedule${query}`))).status).toBe(400);
        expect((await admin(request(app).get(`${base}/schedule/${day}/history?offset=-1`))).status).toBe(400);
        expect((await admin(request(app).get(`${base}/schedule?date=${day}`))).body.schedule.version).toBe(0);
    });

    test('admin/origin guards cover every path; public never contains plans and missing DB fails closed', async () => {
        const { app } = setup(); await put(app);
        for (const [method, path] of [['get', `/schedule?date=${day}`], ['put', `/schedule/${day}`], ['get', `/schedule/${day}/history`]]) {
            expect((await request(app)[method](`${base}${path}`).send(method === 'put' ? input() : undefined)).status).toBe(401);
            expect((await request(app)[method](`${base}${path}`).set('x-test-role', 'member').send(method === 'put' ? input() : undefined)).status).toBe(403);
        }
        expect((await admin(request(app).put(`${base}/schedule/${day}`)).set('Origin', 'https://synthetic-other.invalid').send(input())).status).toBe(403);
        const result = await request(app).get(`${base}/public`); expect(result.status).toBe(200);
        expect(JSON.stringify(result.body)).not.toMatch(/Synthetic|plannedStart|actualIds|goal/);
        expect(result.body.projects.every(project => Object.keys(project).sort().join(',') === 'completedAt,publicSummary,title')).toBe(true);
        const failed = setup(null);
        expect((await admin(request(failed.app).get(`${base}/schedule?date=${day}`))).status).toBe(503);
        expect((await admin(request(failed.app).put(`${base}/schedule/${day}`)).send(input())).status).toBe(503);
        expect((await admin(request(app).get(`${base}/schedule?date=${day}`))).headers['cache-control']).toBe('no-store');
    });

    test('bounded history explicitly paginates retained snapshots and allows clearing the plan', async () => {
        const { app, pool } = setup(); const first = await put(app);
        const empty = await put(app, input({ version: 1, requestId: 'synthetic-clear-plan', rows: [] })); expect(empty.rows).toEqual([]);
        for (let version = 3; version <= 102; version++) await pool.query('INSERT INTO dot_progress_schedule_revisions(date,version,actor_id,changes) VALUES ($1,$2,$3,$4::jsonb)', [day, version, 'synthetic-admin', JSON.stringify({ before: first, after: { ...empty, version } })]);
        let result = await admin(request(app).get(`${base}/schedule/${day}/history`)); expect(result.body).toMatchObject({ total: 102, limit: 100, nextOffset: 100 }); expect(result.body.history[0].version).toBe(102);
        result = await admin(request(app).get(`${base}/schedule/${day}/history?offset=100`)); expect(result.body.history.map(entry => entry.version)).toEqual([2, 1]); expect(result.body.nextOffset).toBeNull();
        expect((await admin(request(app).get(`${base}/schedule/2040-07-20/history`))).body.total).toBe(0);
    });

    test('existing diagnostics stay admin-only and production-hidden with bounded counts/version metadata only', async () => {
        const { app, pool, auth } = setup(); await put(app);
        app.use('/api/debug/dot-progress', progress.createDebugRouter(() => pool, auth));
        expect((await request(app).get('/api/debug/dot-progress')).status).toBe(401);
        expect((await request(app).get('/api/debug/dot-progress').set('x-test-role', 'member')).status).toBe(403);
        const result = await admin(request(app).get('/api/debug/dot-progress'));
        expect(result.body.scheduleCounts).toEqual({ boards: 1, revisions: 1, requests: 1 });
        expect(result.body.recentSchedules).toMatchObject([{ version: 1 }]);
        expect(Object.keys(result.body.recentSchedules[0]).sort()).toEqual(['updatedAt', 'version']);
        expect(JSON.stringify(result.body)).not.toMatch(/Synthetic|actorId|actualIds|plannedStart|projectLabel/);
        const prior = process.env.NODE_ENV;
        try { process.env.NODE_ENV = 'production'; expect((await admin(request(app).get('/api/debug/dot-progress'))).status).toBe(404); }
        finally { process.env.NODE_ENV = prior; }
    });
});

const realPg = process.env.DOT_PROGRESS_TEST_PG === '1' ? test : test.skip;
realPg('actual PostgreSQL additive migration, absent-board races, receipts, rollback and unchanged actual persistence', async () => {
    const { Pool } = jest.requireActual('pg'); const name = `dot_schedule_test_${process.pid}_${Date.now()}`;
    const config = { host: '127.0.0.1', port: 55414, database: 'postgres', user: 'progress_test', connectionTimeoutMillis: 2000, statement_timeout: 4000 };
    const owner = new Pool(config); await owner.query(`CREATE SCHEMA ${name}`);
    const pool = new Pool({ ...config, options: `-c search_path=${name}` });
    try {
        const initial = setup(pool); const entry = await actual(initial.app); const before = await snapshots(pool);
        await pool.query('DROP TABLE dot_progress_schedule_requests,dot_progress_schedule_revisions,dot_progress_schedule');
        const { app } = setup(pool); const body = input({ rows: [row({ actualIds: [entry.id] })] });
        const same = await Promise.all([put(app, body), put(app, body)]); expect(same[0]).toEqual(same[1]); const first = same[0];
        const dateRace = await Promise.all(['a', 'b'].map(key => admin(request(app).put(`${base}/schedule/2040-07-20`)).send(input({ requestId: `synthetic-create-race-${key}`, rows: [] }))));
        expect(dateRace.map(result => result.status).sort()).toEqual([200, 409]);
        const race = await Promise.all(['a', 'b'].map(key => admin(request(app).put(`${base}/schedule/${day}`)).send(input({ version: 1, requestId: `synthetic-update-race-${key}`, rows: [row({ goal: `Synthetic goal ${key}`, actualIds: [entry.id] })] }))));
        expect(race.map(result => result.status).sort()).toEqual([200, 409]);
        const winner = race.find(result => result.status === 200).body.schedule;
        expect(await put(app, body)).toEqual(first);
        await pool.query("ALTER TABLE dot_progress_schedule_requests ADD CONSTRAINT synthetic_schedule_fail CHECK (request_id <> 'synthetic-rollback-plan')");
        const failed = input({ version: 2, requestId: 'synthetic-rollback-plan', rows: [] });
        expect((await admin(request(app).put(`${base}/schedule/${day}`)).send(failed)).status).toBe(503);
        expect((await admin(request(app).get(`${base}/schedule?date=${day}`))).body.schedule).toEqual(winner);
        expect((await admin(request(app).get(`${base}/schedule/${day}/history`))).body.total).toBe(2);
        expect((await admin(request(app).put(`${base}/schedule/2040-07-21`)).send({ ...failed, version: 0 })).status).toBe(503);
        expect((await admin(request(app).get(`${base}/schedule?date=2040-07-21`))).body.schedule.version).toBe(0);
        await pool.query('ALTER TABLE dot_progress_schedule_requests DROP CONSTRAINT synthetic_schedule_fail');
        const third = await put(app, failed); expect(third.version).toBe(3);
        const restarted = setup(pool); expect(await put(restarted.app, body)).toEqual(first); expect(await put(restarted.app, failed)).toEqual(third);
        expect((await admin(request(restarted.app).get(`${base}/schedule/${day}/history`))).body.history.map(entry => entry.version)).toEqual([3, 2, 1]);
        // Simulate the previous schema/receipt shape, then apply only the additive column migration.
        await pool.query('ALTER TABLE dot_progress_schedule DROP COLUMN row_order');
        const { rowOrder: _newField, ...legacyReceipt } = first;
        await pool.query('UPDATE dot_progress_schedule_requests SET response_schedule=$1::jsonb WHERE actor_id=$2 AND request_id=$3', [JSON.stringify(legacyReceipt), 'synthetic-admin', body.requestId]);
        const migrated = setup(pool); expect(await put(migrated.app, body)).toEqual(legacyReceipt);
        expect((await admin(request(migrated.app).get(`${base}/schedule?date=${day}`))).body.schedule).toEqual(third);
        const fourth = await put(migrated.app, input({ version: 3, requestId: 'synthetic-order-migrated', rows: [], rowOrder: [entry.id] }));
        expect(fourth.rows).toEqual([]); expect(fourth.rowOrder).toEqual([entry.id]);
        const planned = await put(migrated.app, input({ version: 4, requestId: 'synthetic-plan-migrated', rows: [row({ actualIds: [entry.id] })] }));
        const fifth = await put(migrated.app, input({ version: 5, requestId: 'synthetic-archive-migrated', rows: [{ ...planned.rows[0], archived: true }] }));
        expect(fifth.rowOrder).toEqual([entry.id]); expect(fifth.rows[0].archived).toBe(true);
        const finalRestart = setup(pool); expect(await put(finalRestart.app, body)).toEqual(legacyReceipt);
        expect((await admin(request(finalRestart.app).get(`${base}/schedule?date=${day}`))).body.schedule).toEqual(fifth);
        expect(await snapshots(pool)).toEqual(before);
    } finally { await pool.end(); await owner.query(`DROP SCHEMA ${name} CASCADE`); await owner.end(); }
}, 20000);
