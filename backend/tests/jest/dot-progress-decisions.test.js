require('./helpers/mock-setup');
const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const progress = require('../../dot-progress');
const fixture = { id: 'synthetic-decision-project', title: 'Synthetic fixture', status: 'active', summary: 'Synthetic goal', blockers: '', nextStep: '', publicTitle: '', publicSummary: '', completedAt: '' };
const base = '/api/dot-progress';
const projectPath = `${base}/projects/${fixture.id}`;
const admin = call => call.set('x-test-role', 'admin');
function setup(override) {
    const db = newDb({ noAstCoverageCheck: true });
    db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: ['integer'], returns: 'integer', implementation: () => 1 });
    const { Pool } = db.adapters.createPg();
    const memory = new Pool();
    // pg-mem does not implement transaction isolation. The optional real-PG
    // case below exercises the production statement and locking semantics.
    const rawConnect = memory.connect.bind(memory);
    memory.connect = async () => {
        const client = await rawConnect();
        const query = client.query.bind(client);
        client.query = (sql, params) => sql.startsWith('SET TRANSACTION') ? Promise.resolve({ rows: [] }) : query(sql, params);
        return client;
    };
    const pool = override === undefined ? memory : override;
    const auth = {
        authMiddleware(req, res, next) {
            if (!req.get('x-test-role')) return res.status(401).json({ success: false, error: 'unauthenticated' });
            req.user = { userId: 'synthetic-admin' }; next();
        },
        adminMiddleware(req, res, next) {
            if (req.get('x-test-role') !== 'admin') return res.status(403).json({ success: false, error: 'admin_required' });
            next();
        }
    };
    const app = express(); app.use(base, progress.createRouter(() => pool, auth));
    return { app, pool };
}
async function initialize(app) {
    expect((await admin(request(app).post(`${base}/import`)).send({ mode: 'apply', data: { projects: [fixture] } })).status).toBe(200);
}
async function create(app, requestId = 'synthetic-create-001') {
    const r = await admin(request(app).post(`${projectPath}/decisions`)).send({ question: 'Synthetic question?', recommendation: 'Synthetic recommendation.', requestId });
    expect(r.status).toBe(200); return r.body.decision;
}
const route = d => `${projectPath}/decisions/${d.id}`;
const versions = d => ({ version: d.version, recommendationVersion: d.recommendationVersion });

describe('private decision records', () => {
    test('creation defaults off; request ID is persistent and cannot overwrite revised content', async () => {
        const { app } = setup(); await initialize(app);
        let d = await create(app);
        expect(d).toMatchObject({ projectId: fixture.id, version: 1, recommendationVersion: 1, state: 'pending', adopted: false, adoption: null, comments: [] });
        expect(d.events[0]).toMatchObject({ actorId: 'synthetic-admin', action: 'created' });
        d = (await admin(request(app).patch(route(d))).send({ version: d.version, recommendation: 'Revised synthetic recommendation.' })).body.decision;
        const retry = await create(app);
        expect(retry.id).toBe(d.id); expect(retry.version).toBe(2);
        expect(retry.recommendation).toBe('Revised synthetic recommendation.');
        expect((await admin(request(app).post(`${projectPath}/decisions`)).send({ question: 'Different?', recommendation: 'Different.', requestId: 'synthetic-create-001' })).status).toBe(409);
    });

    test('adoption and withdrawal have server identity/time; question/content revision invalidates adoption and preserves audit', async () => {
        const { app } = setup(); await initialize(app); let d = await create(app);
        let r = await admin(request(app).post(`${route(d)}/adoption`)).send({ ...versions(d), adopted: true });
        expect(r.status).toBe(200); d = r.body.decision;
        expect(d.state).toBe('adopted');
        expect(d.adoption).toMatchObject({ actorId: 'synthetic-admin', recommendationVersion: 1 });
        expect(Number.isNaN(Date.parse(d.adoption.at))).toBe(false);
        r = await admin(request(app).patch(route(d))).send({ version: d.version, question: d.question });
        expect(r.body.decision.version).toBe(d.version); expect(r.body.decision.adopted).toBe(true);
        r = await admin(request(app).patch(route(d))).send({ version: d.version, question: 'Revised synthetic question?' });
        d = r.body.decision; expect(d).toMatchObject({ version: 3, recommendationVersion: 2, adopted: false, adoption: null, state: 'pending' });
        expect(d.events.map(e => e.action)).toEqual(['created', 'adopted', 'revised']);
        expect(d.events[2].data.before.adoption.actorId).toBe('synthetic-admin');
        d = (await admin(request(app).post(`${route(d)}/adoption`)).send({ ...versions(d), adopted: true })).body.decision;
        d = (await admin(request(app).post(`${route(d)}/adoption`)).send({ ...versions(d), adopted: false })).body.decision;
        expect(d).toMatchObject({ adopted: false, adoption: null, state: 'pending' });
        expect(d.events.at(-1).action).toBe('withdrawn');
    });

    test('every comment conservatively requires clarification; retries survive stale versions and revision retains comments', async () => {
        const { app } = setup(); await initialize(app); let d = await create(app);
        d = (await admin(request(app).post(`${route(d)}/adoption`)).send({ ...versions(d), adopted: true })).body.decision;
        const payload = { ...versions(d), body: 'A synthetic alternative', requestId: 'synthetic-comment-001' };
        let r = await admin(request(app).post(`${route(d)}/comments`)).send(payload); expect(r.status).toBe(200); d = r.body.decision;
        expect(d).toMatchObject({ state: 'clarification', adopted: false, adoption: null, recommendationVersion: 1 });
        const saved = r.body.comment;
        r = await admin(request(app).post(`${route(d)}/adoption`)).send({ ...versions(d), adopted: true });
        expect(r.status).toBe(409); expect(r.body.error).toBe('clarification_required');
        r = await admin(request(app).patch(route(d))).send({ version: d.version, recommendation: d.recommendation });
        expect(r.body.decision.state).toBe('clarification'); expect(r.body.decision.version).toBe(d.version);
        d = (await admin(request(app).patch(route(d))).send({ version: d.version, recommendation: 'Clarified synthetic plan.' })).body.decision;
        expect(d).toMatchObject({ state: 'pending', adopted: false, recommendationVersion: 2 }); expect(d.comments).toHaveLength(1);
        r = await admin(request(app).post(`${route(d)}/comments`)).send(payload);
        expect(r.status).toBe(200); expect(r.body.comment.id).toBe(saved.id); expect(r.body.decision.version).toBe(d.version);
        expect((await admin(request(app).post(`${route(d)}/comments`)).send({ ...payload, body: 'Changed request' })).status).toBe(409);
        d = (await admin(request(app).post(`${route(d)}/adoption`)).send({ ...versions(d), adopted: true })).body.decision;
        expect(d.state).toBe('adopted');
        expect((await admin(request(app).get(`${projectPath}/decisions`))).body.decisions[0]).toMatchObject({ id: d.id, state: 'adopted' });
    });

    test('unknown fields, metadata forgery, invalid versions and text bounds are rejected', async () => {
        const { app } = setup(); await initialize(app); const d = await create(app);
        for (const body of [null, [], { question: 'q', recommendation: 'r', requestId: 'request-000', adopted: true }, { question: 'x'.repeat(1001), recommendation: 'r', requestId: 'request-001' }, { question: 'q', recommendation: 'x'.repeat(4001), requestId: 'request-001' }, { question: 'q', recommendation: 'r', requestId: 123456789 }]) {
            expect((await admin(request(app).post(`${projectPath}/decisions`)).send(body)).status).toBe(400);
        }
        for (const body of [{ version: 1, adoption: {} }, { version: null, recommendation: 'r' }, { version: '1', question: 'q' }, { version: 0, question: 'q' }, { version: 1, recommendation: '' }]) expect((await admin(request(app).patch(route(d))).send(body)).status).toBe(400);
        for (const body of [{ ...versions(d), adopted: 'true' }, { ...versions(d), adopted: true, actorId: 'forged' }, { version: 1, recommendationVersion: 0, adopted: true }]) expect((await admin(request(app).post(`${route(d)}/adoption`)).send(body)).status).toBe(400);
        expect((await admin(request(app).post(`${route(d)}/comments`)).send({ ...versions(d), body: 'x'.repeat(4001), requestId: 'request-000' })).status).toBe(400);
        expect((await admin(request(app).patch(`${base}/projects/${fixture.id}`)).send({ version: 1, decisions: [{ adopted: true }] })).status).toBe(400);
        expect((await admin(request(app).post(`${base}/import`)).send({ data: { projects: [{ ...fixture, adoption: {} }] } })).status).toBe(400);
        expect((await admin(request(app).post(`${route(d)}/adoption`)).send({ version: 999, recommendationVersion: 1, adopted: true })).status).toBe(409);
        expect((await admin(request(app).post(`${route(d)}/comments`)).send({ version: 1, recommendationVersion: 999, body: 'other', requestId: 'request-000' })).status).toBe(409);
    });

    test('all decision routes require auth/admin, cross-origin writes are rejected, public never includes decisions', async () => {
        const { app } = setup(); await initialize(app); const d = await create(app);
        const paths = [['get', `${projectPath}/decisions`], ['post', `${projectPath}/decisions`], ['patch', route(d)], ['post', `${route(d)}/adoption`], ['post', `${route(d)}/comments`]];
        for (const [method, url] of paths) {
            expect((await request(app)[method](url).send({})).status).toBe(401);
            expect((await request(app)[method](url).set('x-test-role', 'member').send({})).status).toBe(403);
        }
        expect((await admin(request(app).post(`${route(d)}/adoption`)).set('Origin', 'https://other.invalid').send({ ...versions(d), adopted: true })).status).toBe(403);
        const result = await request(app).get(`${base}/public`);
        expect(result.body.projects).toHaveLength(3);
        for (const p of result.body.projects) expect(Object.keys(p).sort()).toEqual(['completedAt', 'publicSummary', 'title']);
        expect(JSON.stringify(result.body)).not.toMatch(/Synthetic|question|recommendation|adoption|actorId/);
    });

    test.each(['cancelled', 'archived'])('%s preserves histories/comments, excludes public and blocks reopening through decisions', async status => {
        const { app } = setup(); await initialize(app); let d = await create(app);
        d = (await admin(request(app).post(`${route(d)}/adoption`)).send({ ...versions(d), adopted: true })).body.decision;
        let p = (await admin(request(app).patch(projectPath)).send({ version: 1, status: 'completed', publicTitle: 'Synthetic public title', publicSummary: 'Synthetic public completion.', completedAt: '2026-10-04' })).body.project;
        expect((await request(app).get(`${base}/public`)).body.projects).toHaveLength(4);
        p = (await admin(request(app).patch(projectPath)).send({ version: p.version, status })).body.project;
        expect(p.publicSummary).toBe(''); expect((await request(app).get(`${base}/public`)).body.projects).toHaveLength(3);
        expect((await admin(request(app).post(`${projectPath}/decisions`)).send({ question: 'q', recommendation: 'r', requestId: 'closed-create-000' })).body.error).toBe('project_inactive');
        expect((await admin(request(app).patch(route(d))).send({ version: d.version, recommendation: 'changed' })).body.error).toBe('project_inactive');
        expect((await admin(request(app).post(`${route(d)}/adoption`)).send({ ...versions(d), adopted: true })).body.error).toBe('project_inactive');
        d = (await admin(request(app).post(`${route(d)}/adoption`)).send({ ...versions(d), adopted: false })).body.decision;
        const r = await admin(request(app).post(`${route(d)}/comments`)).send({ ...versions(d), body: 'Synthetic closure note', requestId: 'closed-comment-000' });
        expect(r.status).toBe(200); expect(r.body.decision.state).toBe('clarification');
        expect((await admin(request(app).get(`${projectPath}/history`))).body.history.map(h => h.changes.after.status)).toContain(status);
        expect((await admin(request(app).get(`${projectPath}/decisions`))).body.decisions[0].comments).toHaveLength(1);
    });

    test('decision rows persist across router restart with append-only events', async () => {
        const first = setup(); await initialize(first.app); const d = await create(first.app);
        const second = setup(first.pool);
        const r = await admin(request(second.app).get(`${projectPath}/decisions`));
        expect(r.status).toBe(200); expect(r.body.decisions[0]).toMatchObject({ id: d.id, version: 1, state: 'pending' });
    });

    test('renders bounded latest comments/events chronologically without losing stored history or clarification state', async () => {
        const { app, pool } = setup(); await initialize(app); const d = await create(app);
        for (let i = 0; i < 1002; i++) await pool.query('INSERT INTO dot_progress_decision_comments(decision_id, actor_id, request_id, body, recommendation_version) VALUES ($1,$2,$3,$4,$5)', [d.id, 'synthetic-admin', `bounded-comment-${i}`, `Synthetic comment ${i}`, 1]);
        for (let i = 0; i < 102; i++) await pool.query('INSERT INTO dot_progress_decision_events(decision_id, actor_id, action, version, recommendation_version, data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [d.id, 'synthetic-admin', 'synthetic_event', i + 2, 1, '{}']);
        const r = await admin(request(app).get(`${projectPath}/decisions`));
        const read = r.body.decisions[0];
        expect(read.state).toBe('clarification'); expect(read.adopted).toBe(false);
        expect(read.comments).toHaveLength(1000); expect(read.comments[0].body).toBe('Synthetic comment 2'); expect(read.comments.at(-1).body).toBe('Synthetic comment 1001');
        expect(read.events).toHaveLength(100); expect(read.events[0].version).toBe(4); expect(read.events.at(-1).version).toBe(103);
        expect(Number((await pool.query('SELECT COUNT(*) AS count FROM dot_progress_decision_comments')).rows[0].count)).toBe(1002);
        expect((await admin(request(app).post(`${route(d)}/adoption`)).send({ ...versions(d), adopted: true })).body.error).toBe('clarification_required');
    });

    test('existing auth session and fresh admin checks protect decisions after role revocation/logout', async () => {
        const previous = process.env.JWT_SECRET;
        process.env.JWT_SECRET = 'synthetic-decision-session-secret';
        try {
            const jwt = require('jsonwebtoken');
            const auth = jest.requireActual('../../auth')({}, () => ({}), () => {});
            let isAdmin = true;
            auth.pool.query.mockImplementation(async () => ({ rows: [{ is_admin: isAdmin }] }));
            const { pool } = setup();
            const app = express(); app.use(require('cookie-parser')()); app.use(base, progress.createRouter(() => pool, auth));
            const cookie = `eclaw_session=${jwt.sign({ userId: 'synthetic-session-user' }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
            const r = await request(app).post(`${base}/import`).set('Cookie', cookie).send({ mode: 'apply', data: { projects: [fixture] } });
            expect(r.status).toBe(200);
            expect((await request(app).get(`${projectPath}/decisions`).set('Cookie', cookie)).status).toBe(200);
            const review = await request(app).post(`${base}/review`).set('Cookie', cookie).send({ kind: 'permission', title: 'Synthetic authorization review', body: 'Synthetic historical question only.', occurredAt: '2026-10-04', source: 'Synthetic source', scope: 'Synthetic scope', requestId: 'synthetic-review-000' });
            expect(review.status).toBe(200);
            isAdmin = false;
            expect((await request(app).get(`${projectPath}/decisions`).set('Cookie', cookie)).status).toBe(403);
            expect((await request(app).post(`${projectPath}/decisions`).set('Cookie', cookie).send({})).status).toBe(403);
            expect((await request(app).get(`${base}/review`).set('Cookie', cookie)).status).toBe(403);
            expect((await request(app).post(`${base}/review/${review.body.entry.id}/comments`).set('Cookie', cookie).send({ body: 'Correction', requestId: 'correction-0000' })).status).toBe(403);
            expect((await request(app).get(`${projectPath}/decisions`)).status).toBe(401);
            expect((await request(app).get(`${base}/review`)).status).toBe(401);
        } finally { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; }
    });
});

const realPg = process.env.DOT_PROGRESS_TEST_PG === '1' ? test : test.skip;
realPg('real PostgreSQL decision concurrency, cancellation serialization, rollback and restart', async () => {
    const { Pool } = jest.requireActual('pg');
    const schemaName = `dot_decision_test_${process.pid}_${Date.now()}`;
    const config = { host: '127.0.0.1', port: 55414, database: 'postgres', user: 'progress_test', connectionTimeoutMillis: 2000, statement_timeout: 4000 };
    const owner = new Pool(config); await owner.query(`CREATE SCHEMA ${schemaName}`);
    const pool = new Pool({ ...config, options: `-c search_path=${schemaName}` });
    try {
        const { app } = setup(pool); await initialize(app); 
        const creates = await Promise.all([create(app), create(app)]);
        expect(creates[0].id).toBe(creates[1].id); let d = creates[0];
        const competing = await Promise.all([
            admin(request(app).post(`${route(d)}/adoption`)).send({ ...versions(d), adopted: true }),
            admin(request(app).post(`${route(d)}/comments`)).send({ ...versions(d), body: 'Synthetic alternative', requestId: 'concurrent-comment-000' })
        ]);
        expect(competing.map(r => r.status).sort()).toEqual([200, 409]);
        d = (await admin(request(app).get(`${projectPath}/decisions`))).body.decisions[0];
        expect(d.events).toHaveLength(2);
        if (competing[1].status === 200) expect(d).toMatchObject({ state: 'clarification', adopted: false });
        else expect(d).toMatchObject({ state: 'adopted', adopted: true, comments: [] });
        const eventCount = d.events.length;
        // Force a late audit write failure and verify no adopted/version state can
        // commit without the associated audit record.
        await pool.query(`ALTER TABLE dot_progress_decision_events ADD CONSTRAINT synthetic_fail_adoption CHECK (action <> 'withdrawn')`);
        const failed = await admin(request(app).post(`${route(d)}/adoption`)).send({ ...versions(d), adopted: false });
        expect(failed.status).toBe(503);
        await pool.query('ALTER TABLE dot_progress_decision_events DROP CONSTRAINT synthetic_fail_adoption');
        let persisted = (await admin(request(app).get(`${projectPath}/decisions`))).body.decisions[0];
        expect(persisted.version).toBe(d.version); expect(persisted.events).toHaveLength(eventCount);
        const race = await Promise.all([
            admin(request(app).patch(projectPath)).send({ version: 1, status: 'cancelled' }),
            admin(request(app).post(`${route(persisted)}/adoption`)).send({ ...versions(persisted), adopted: true })
        ]);
        expect(race[0].status).toBe(200);
        // Adoption either serialized before cancellation, or was rejected after
        // cancellation (clarification may independently prohibit adoption).
        expect([200, 409]).toContain(race[1].status);
        persisted = (await admin(request(app).get(`${projectPath}/decisions`))).body.decisions[0];
        expect((await admin(request(app).post(`${route(persisted)}/adoption`)).send({ ...versions(persisted), adopted: true })).body.error).toBe('project_inactive');
        const restarted = setup(pool);
        expect((await admin(request(restarted.app).get(`${projectPath}/decisions`))).body.decisions[0].id).toBe(d.id);
        const p = (await admin(request(restarted.app).get(`${base}/projects`))).body.projects.find(x => x.id === fixture.id);
        expect(p.status).toBe('cancelled');
    } finally { await pool.end(); await owner.query(`DROP SCHEMA ${schemaName} CASCADE`); await owner.end(); }
}, 20000);
