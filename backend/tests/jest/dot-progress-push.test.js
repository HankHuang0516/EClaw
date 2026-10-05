require('./helpers/mock-setup');
const express = require('express');
const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const progress = require('../../dot-progress');
const base = '/api/dot-progress';
const fixture = id => ({ id, title: 'Synthetic push project', status: 'active', summary: 'Synthetic goal', blockers: '', nextStep: '', publicTitle: '', publicSummary: '', completedAt: '' });
const projectId = 'synthetic-push-project';
const path = `${base}/projects/${projectId}`;
const admin = call => call.set('x-test-role', 'admin');
function setup(override) {
    const db = newDb({ noAstCoverageCheck: true });
    db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
    db.public.registerFunction({ name: 'clock_timestamp', args: [], returns: DataType.timestamptz, impure: true, implementation: () => new Date() });
    const { Pool } = db.adapters.createPg();
    const pool = override === undefined ? new Pool() : override;
    const auth = {
        authMiddleware(req, res, next) {
            if (!req.get('x-test-role')) return res.status(401).json({ success: false, error: 'unauthenticated' });
            req.user = { userId: req.get('x-test-actor') || 'synthetic-admin' }; next();
        },
        adminMiddleware(req, res, next) {
            if (req.get('x-test-role') !== 'admin') return res.status(403).json({ success: false, error: 'admin_required' }); next();
        }
    };
    const app = express(); app.use(base, progress.createRouter(() => pool, auth));
    return { app, pool, auth };
}
async function initialize(app, fields = {}) {
    expect((await admin(request(app).post(`${base}/import`)).send({ mode: 'apply', data: { projects: [{ ...fixture(projectId), ...fields }] } })).status).toBe(200);
}
async function read(app, id = projectId) {
    const r = await admin(request(app).get(`${base}/projects`)); expect(r.status).toBe(200);
    return r.body.projects.find(p => p.id === id);
}
async function push(app, requestId, url = path, actor) {
    const call = admin(request(app).post(`${url}/push`)); if (actor) call.set('x-test-actor', actor);
    return call.send({ requestId });
}

describe('private per-project push signals', () => {
    test('old records default to zero/null and empty explicit completed work without data inference', async () => {
        const { app, pool } = setup(); await initialize(app);
        // Simulate a persisted pre-feature record, not an application migration.
        await pool.query('UPDATE dot_progress_projects SET data=$2::jsonb WHERE id=$1', [projectId, JSON.stringify(fixture(projectId))]);
        const p = await read(app);
        expect(p).toMatchObject({ pushCount: 0, lastPushedAt: null, completedWork: '', version: 1 });
        expect((await pool.query('SELECT data FROM dot_progress_projects WHERE id=$1', [projectId])).rows[0].data).not.toHaveProperty('completedWork');
    });

    test('two actual click IDs count twice, repeated same ID returns latest totals and leaves project/history unchanged', async () => {
        const { app } = setup(); await initialize(app);
        const before = await read(app);
        const first = await push(app, 'synthetic-click-0001'); expect(first.status).toBe(200); expect(first.body.pushCount).toBe(1);
        expect(Number.isNaN(Date.parse(first.body.lastPushedAt))).toBe(false);
        expect((await push(app, 'synthetic-click-0001')).body).toEqual(first.body);
        const second = await push(app, 'synthetic-click-0002'); expect(second.body.pushCount).toBe(2);
        expect((await push(app, 'synthetic-click-0001')).body).toEqual(second.body);
        const after = await read(app);
        expect(after).toEqual({ ...before, pushCount: 2, lastPushedAt: second.body.lastPushedAt });
        expect((await admin(request(app).get(`${path}/history`))).body.history).toHaveLength(1);
    });

    test('dedupe is scoped to server actor and project, not caller-supplied identity', async () => {
        const { app } = setup(); await initialize(app);
        await push(app, 'same-click-0001', path, 'synthetic-admin-a');
        expect((await push(app, 'same-click-0001', path, 'synthetic-admin-b')).body.pushCount).toBe(2);
        expect((await push(app, 'same-click-0001', path, 'synthetic-admin-a')).body.pushCount).toBe(2);
        const other = 'synthetic-other-project';
        expect((await admin(request(app).post(`${base}/import`)).send({ mode: 'apply', data: { projects: [fixture(other)] } })).status).toBe(200);
        expect((await push(app, 'same-click-0001', `${base}/projects/${other}`, 'synthetic-admin-a')).body.pushCount).toBe(1);
        expect((await read(app)).pushCount).toBe(2);
    });

    test.each(['active', 'blocked', 'paused', 'completed', 'cancelled', 'archived'])('push allowed for %s without reopening, completing, publishing or editing', async status => {
        const { app } = setup(); await initialize(app, { status });
        const before = await read(app);
        expect((await push(app, `synthetic-${status}-click`)).status).toBe(200);
        const after = await read(app);
        expect(after).toMatchObject({ status, version: before.version, publicSummary: before.publicSummary, completedWork: '' });
        expect((await request(app).get(`${base}/public`)).body.projects).toHaveLength(3);
    });

    test('completed work is explicit, private, bounded, preserved with legacy edits/imports and counters survive restart', async () => {
        const first = setup(); await initialize(first.app);
        await push(first.app, 'synthetic-click-0001');
        let r = await admin(request(first.app).patch(path)).send({ version: 1, completedWork: 'Synthetic verified steps only.' });
        expect(r.status).toBe(200); expect(r.body.project).toMatchObject({ pushCount: 1, version: 2, completedWork: 'Synthetic verified steps only.' });
        r = await admin(request(first.app).patch(path)).send({ version: 2, blockers: 'Synthetic remaining blocker' });
        expect(r.body.project).toMatchObject({ pushCount: 1, version: 3, completedWork: 'Synthetic verified steps only.' });
        expect((await admin(request(first.app).post(`${base}/import`)).send({ mode: 'apply', data: { projects: [{ ...fixture(projectId), version: 3 }] } })).status).toBe(200);
        const second = setup(first.pool); const p = await read(second.app);
        expect(p).toMatchObject({ pushCount: 1, version: 4, completedWork: 'Synthetic verified steps only.' });
        expect(p.lastPushedAt).not.toBeNull();
        expect((await push(second.app, 'synthetic-click-0001')).body.pushCount).toBe(1);
        expect((await admin(request(second.app).patch(path)).send({ version: 4, completedWork: 'x'.repeat(4001) })).status).toBe(400);
        expect((await admin(request(second.app).patch(path)).send({ version: 4, completedWork: {} })).status).toBe(400);
        expect((await admin(request(second.app).patch(path)).send({ version: 4, completedWork: '' })).body.project.completedWork).toBe('');
    });

    test('anonymous/member/bot-style auth and cross-origin cannot push; invalid IDs/body and forged state are rejected', async () => {
        const { app } = setup(); await initialize(app);
        expect((await request(app).post(`${path}/push`).send({ requestId: 'synthetic-click-000' })).status).toBe(401);
        expect((await request(app).post(`${path}/push`).set('x-test-role', 'member').send({ requestId: 'synthetic-click-000' })).status).toBe(403);
        expect((await request(app).post(`${path}/push`).send({ botSecret: 'synthetic-not-a-credential' })).status).toBe(401);
        expect((await admin(request(app).post(`${path}/push`)).set('Origin', 'https://other.invalid').send({ requestId: 'synthetic-click-000' })).status).toBe(403);
        for (const body of [null, [], {}, { requestId: 'short' }, { requestId: 123456789 }, { requestId: 'x'.repeat(101) }, { requestId: 'synthetic-click-000', actorId: 'forged' }, { requestId: 'synthetic-click-000', pushCount: 99 }, { requestId: 'synthetic-click-000', lastPushedAt: '2000-01-01' }, { requestId: 'synthetic-click-000', version: 1 }, { requestId: 'synthetic-click-000', adopted: true }]) {
            expect((await admin(request(app).post(`${path}/push`)).send(body)).status).toBe(400);
        }
        expect((await push(app, 'missing-project-0001', `${base}/projects/missing`)).status).toBe(404);
        expect((await admin(request(app).patch(path)).send({ version: 1, pushCount: 99 })).status).toBe(400);
        expect((await admin(request(app).post(`${base}/import`)).send({ data: { projects: [{ ...fixture(projectId), lastPushedAt: '2000-01-01' }] } })).status).toBe(400);
        expect((await read(app)).pushCount).toBe(0);
    });

    test('public remains a strict three-field projection and debug excludes actor/click/project identifiers', async () => {
        const { app, pool, auth } = setup(); await initialize(app, { completedWork: 'Synthetic private verified steps.' });
        await push(app, 'synthetic-click-0001');
        const publicRows = (await request(app).get(`${base}/public`)).body.projects;
        for (const p of publicRows) expect(Object.keys(p).sort()).toEqual(['completedAt', 'publicSummary', 'title']);
        expect(JSON.stringify(publicRows)).not.toMatch(/pushCount|lastPushedAt|completedWork|synthetic/);
        app.use('/api/debug/dot-progress', progress.createDebugRouter(() => pool, auth));
        expect((await request(app).get('/api/debug/dot-progress')).status).toBe(401);
        const diagnostic = await admin(request(app).get('/api/debug/dot-progress'));
        expect(diagnostic.body.pushCounts).toEqual({ requests: 1 });
        expect(diagnostic.body.recentPushes[0].pushCount).toBe(1);
        expect(JSON.stringify(diagnostic.body)).not.toMatch(/synthetic|actorId|requestId|projectId|completedWork/);
    });

    test('missing storage fails closed without an in-memory increment', async () => {
        const { app } = setup(null);
        const r = await push(app, 'synthetic-click-0001'); expect(r.status).toBe(503);
        expect(r.body).toEqual({ success: false, error: 'progress_unavailable' });
    });

    test('real session role revocation/logout denies push and the server identity cannot be supplied through JSON', async () => {
        const previous = process.env.JWT_SECRET; process.env.JWT_SECRET = 'synthetic-push-test-secret';
        try {
            const jwt = require('jsonwebtoken'); const auth = jest.requireActual('../../auth')({}, () => ({}), () => {});
            let allowed = true; auth.pool.query.mockImplementation(async () => ({ rows: [{ is_admin: allowed }] }));
            const { pool } = setup(); const app = express(); app.use(require('cookie-parser')()); app.use(base, progress.createRouter(() => pool, auth));
            const cookie = `eclaw_session=${jwt.sign({ userId: 'synthetic-cookie-admin' }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
            expect((await request(app).post(`${base}/import`).set('Cookie', cookie).send({ mode: 'apply', data: { projects: [fixture(projectId)] } })).status).toBe(200);
            expect((await request(app).post(`${path}/push`).set('Cookie', cookie).send({ requestId: 'cookie-click-0001' })).body.pushCount).toBe(1);
            const row = (await pool.query('SELECT actor_id FROM dot_progress_push_requests')).rows[0]; expect(row.actor_id).toBe('synthetic-cookie-admin');
            allowed = false;
            expect((await request(app).post(`${path}/push`).set('Cookie', cookie).send({ requestId: 'cookie-click-0002' })).status).toBe(403);
            expect((await request(app).post(`${path}/push`).send({ requestId: 'cookie-click-0002' })).status).toBe(401);
            expect((await request(app).post(`${path}/push`).set('Authorization', 'Bearer synthetic-invalid').send({ requestId: 'cookie-click-0002' })).status).toBe(401);
        } finally { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; }
    });
});

const realPg = process.env.DOT_PROGRESS_TEST_PG === '1' ? test : test.skip;
realPg('real PostgreSQL: atomic distinct clicks, retry dedupe, rollback, editing/import and restart', async () => {
    const { Pool } = jest.requireActual('pg'); const schemaName = `dot_push_test_${process.pid}_${Date.now()}`;
    const config = { host: '127.0.0.1', port: 55414, database: 'postgres', user: 'progress_test', connectionTimeoutMillis: 2000, statement_timeout: 4000 };
    const owner = new Pool(config); await owner.query(`CREATE SCHEMA ${schemaName}`);
    const pool = new Pool({ ...config, options: `-c search_path=${schemaName}` });
    try {
        const { app } = setup(pool); await initialize(app);
        const repeated = await Promise.all([push(app, 'duplicate-click-0001'), push(app, 'duplicate-click-0001')]);
        expect(repeated.map(r => r.status)).toEqual([200, 200]); expect(repeated.map(r => r.body.pushCount)).toEqual([1, 1]);
        const clicks = await Promise.all([push(app, 'distinct-click-0001'), push(app, 'distinct-click-0002')]);
        expect(clicks.map(r => r.status)).toEqual([200, 200]); expect(clicks.map(r => r.body.pushCount).sort()).toEqual([2, 3]);
        const p = await read(app); expect(p).toMatchObject({ version: 1, pushCount: 3, status: 'active' });
        await pool.query('ALTER TABLE dot_progress_push_requests ADD CONSTRAINT synthetic_fail_push CHECK (push_count < 4)');
        expect((await push(app, 'rollback-click-0001')).status).toBe(503);
        expect((await read(app)).pushCount).toBe(3);
        expect(Number((await pool.query('SELECT COUNT(*) AS count FROM dot_progress_push_requests')).rows[0].count)).toBe(3);
        await pool.query('ALTER TABLE dot_progress_push_requests DROP CONSTRAINT synthetic_fail_push');
        const retry = await push(app, 'rollback-click-0001'); expect(retry.body.pushCount).toBe(4);
        const concurrentEdit = await Promise.all([
            admin(request(app).patch(path)).send({ version: 1, completedWork: 'Synthetic verified work.' }),
            push(app, 'edit-concurrent-click-0001')
        ]);
        expect(concurrentEdit.map(r => r.status)).toEqual([200, 200]);
        expect((await admin(request(app).post(`${base}/import`)).send({ mode: 'apply', data: { projects: [{ ...fixture(projectId), version: 2, status: 'archived' }] } })).status).toBe(200);
        const restarted = setup(pool); const persisted = await read(restarted.app);
        expect(persisted).toMatchObject({ version: 3, pushCount: 5, status: 'archived', completedWork: 'Synthetic verified work.' });
        expect((await push(restarted.app, 'distinct-click-0001')).body.pushCount).toBe(5);
        expect((await push(restarted.app, 'archived-click-0001')).body.pushCount).toBe(6);
        expect((await read(restarted.app)).status).toBe('archived');
        expect((await request(restarted.app).get(`${base}/public`)).body.projects).toHaveLength(3);
    } finally { await pool.end(); await owner.query(`DROP SCHEMA ${schemaName} CASCADE`); await owner.end(); }
}, 20000);
