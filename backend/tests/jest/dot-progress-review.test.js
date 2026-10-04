require('./helpers/mock-setup');
const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const progress = require('../../dot-progress');
const base = '/api/dot-progress';
const admin = call => call.set('x-test-role', 'admin');
const fixture = { kind: 'permission', title: 'Synthetic permission question', body: 'Synthetic user-provided record only.', occurredAt: '2026-10-04', source: 'Synthetic test conversation', scope: 'Synthetic test scope', requestId: 'review-create-0001' };
function setup(override) {
    const db = newDb({ noAstCoverageCheck: true });
    db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: ['integer'], returns: 'integer', implementation: () => 1 });
    const { Pool } = db.adapters.createPg(); const memory = new Pool();
    const connect = memory.connect.bind(memory);
    memory.connect = async () => {
        const client = await connect(); const query = client.query.bind(client);
        client.query = (sql, params) => sql.startsWith('SET TRANSACTION') ? Promise.resolve({ rows: [] }) : query(sql, params);
        return client;
    };
    const pool = override === undefined ? memory : override;
    const auth = {
        authMiddleware(req, res, next) {
            if (!req.get('x-test-role')) return res.status(401).json({ success: false, error: 'unauthenticated' });
            req.user = { userId: 'synthetic-review-admin' }; next();
        },
        adminMiddleware(req, res, next) {
            if (req.get('x-test-role') !== 'admin') return res.status(403).json({ success: false, error: 'admin_required' }); next();
        }
    };
    const app = express(); app.use(base, progress.createRouter(() => pool, auth));
    return { app, pool, auth };
}
async function create(app, data = fixture) {
    const r = await admin(request(app).post(`${base}/review`)).send(data);
    expect({ status: r.status, response: r.body, ...(r.status !== 200 && !r.body.success ? { text: r.text.slice(0, 400) } : {}) }).toMatchObject({ status: 200 }); return r.body.entry;
}

describe('append-only private project review', () => {
    test('preserves supplied original date/source/scope and obtains identity/time only from the server', async () => {
        const { app } = setup(); const e = await create(app);
        expect(e).toMatchObject({ kind: fixture.kind, title: fixture.title, body: fixture.body, occurredAt: fixture.occurredAt, source: fixture.source, scope: fixture.scope, actorId: 'synthetic-review-admin', comments: [] });
        expect(e.id).toMatch(/^[a-f0-9-]{36}$/); expect(Number.isNaN(Date.parse(e.createdAt))).toBe(false);
        const same = await create(app); expect(same).toEqual(e);
        expect((await admin(request(app).post(`${base}/review`)).send({ ...fixture, scope: 'Different scope' })).status).toBe(409);
        expect((await admin(request(app).get(`${base}/review`))).body.entries).toEqual([e]);
    });

    test('corrections append and deduplicate without overwriting the original', async () => {
        const { app } = setup(); const e = await create(app);
        const payload = { body: 'Synthetic correction supplied by user.', requestId: 'review-comment-0001' };
        const r = await admin(request(app).post(`${base}/review/${e.id}/comments`)).send(payload);
        expect(r.status).toBe(200); expect(r.body.entry.body).toBe(e.body);
        const retry = await admin(request(app).post(`${base}/review/${e.id}/comments`)).send(payload);
        expect(retry.body.comment).toEqual(r.body.comment); expect(retry.body.entry.comments).toHaveLength(1);
        expect((await admin(request(app).post(`${base}/review/${e.id}/comments`)).send({ ...payload, body: 'Different correction' })).status).toBe(409);
        const createRetry = await create(app); expect(createRetry.comments).toHaveLength(1);
        expect((await admin(request(app).patch(`${base}/review/${e.id}`)).send({ body: 'Overwrite' })).status).toBe(404);
        expect((await admin(request(app).delete(`${base}/review/${e.id}`))).status).toBe(404);
        const reloaded = (await admin(request(app).get(`${base}/review`))).body.entries[0];
        expect(reloaded.body).toBe(fixture.body); expect(reloaded.comments[0].actorId).toBe('synthetic-review-admin');
    });

    test.each(['permission', 'decision', 'change'])('accepts explicit %s historical records without creating decisions', async kind => {
        const { app, pool } = setup(); await create(app, { ...fixture, kind });
        expect(Number((await pool.query('SELECT COUNT(*) AS count FROM dot_progress_decisions')).rows[0].count)).toBe(0);
    });

    test('all review reads and writes require admin; public projection and debug never expose originals', async () => {
        const { app, pool, auth } = setup(); const e = await create(app);
        for (const [method, url] of [['get', `${base}/review`], ['post', `${base}/review`], ['post', `${base}/review/${e.id}/comments`]]) {
            expect((await request(app)[method](url).send({})).status).toBe(401);
            expect((await request(app)[method](url).set('x-test-role', 'member').send({})).status).toBe(403);
        }
        expect((await admin(request(app).post(`${base}/review`)).set('Origin', 'https://other.invalid').send(fixture)).status).toBe(403);
        const publicRows = (await request(app).get(`${base}/public`)).body.projects;
        expect(publicRows).toHaveLength(3); for (const p of publicRows) expect(Object.keys(p).sort()).toEqual(['completedAt', 'publicSummary', 'title']);
        expect(JSON.stringify(publicRows)).not.toMatch(/Synthetic|actorId|scope|source|permission/);
        app.use('/api/debug/dot-progress', progress.createDebugRouter(() => pool, auth));
        const diagnostic = await admin(request(app).get('/api/debug/dot-progress'));
        expect(diagnostic.body.reviewCounts).toEqual({ entries: 1, comments: 0 });
        expect(diagnostic.body.decisionCounts).toEqual({ decisions: 0, comments: 0, events: 0 });
        expect(JSON.stringify(diagnostic.body)).not.toMatch(/Synthetic|scope|source|actorId|body|question/);
    });

    test('rejects forged metadata, invalid dates, unknown fields, oversized text, NUL, nonstrings and malformed bodies', async () => {
        const { app } = setup();
        for (const delta of [{ actorId: 'forged' }, { createdAt: '2000-01-01' }, { id: 'forged' }, { version: 1 }, { adopted: true }, { kind: 'other' }, { occurredAt: '2026-02-30' }, { occurredAt: '2026-10-04T24:61:00Z' }, { occurredAt: '2026-10-04T12:00:00' }, { title: 'x'.repeat(161) }, { body: 'x'.repeat(4001) }, { source: 'x'.repeat(501) }, { scope: 'x'.repeat(501) }, { source: {} }, { scope: '' }, { requestId: 123456789 }, { body: 'nul\0text' }]) {
            const r = await admin(request(app).post(`${base}/review`)).send({ ...fixture, ...delta });
            expect(r.status).toBe(400); expect(r.body.success).toBe(false);
        }
        for (const data of [null, [], 'invalid']) expect((await admin(request(app).post(`${base}/review`)).send(data)).status).toBe(400);
        const e = await create(app);
        for (const payload of [{ body: 'correction', requestId: 'comment-000', actorId: 'forged' }, { body: 'x'.repeat(4001), requestId: 'comment-000' }, { body: '', requestId: 'comment-000' }]) expect((await admin(request(app).post(`${base}/review/${e.id}/comments`)).send(payload)).status).toBe(400);
        expect((await admin(request(app).post(`${base}/review/missing/comments`)).send({ body: 'q', requestId: 'comment-000' })).status).toBe(404);
        expect((await admin(request(app).get(`${base}/review`))).body.entries).toHaveLength(1);
    });

    test('retains exact ISO timestamp timezone notation and data across a router restart', async () => {
        const first = setup(); const e = await create(first.app, { ...fixture, occurredAt: '2026-10-04T07:40:00+08:00' });
        await admin(request(first.app).post(`${base}/review/${e.id}/comments`)).send({ body: 'A synthetic correction', requestId: 'comment-0001' });
        const second = setup(first.pool); const read = await admin(request(second.app).get(`${base}/review`));
        expect(read.status).toBe(200); expect(read.body.entries[0]).toMatchObject({ occurredAt: '2026-10-04T07:40:00+08:00' });
        expect(read.body.entries[0].comments).toHaveLength(1);
    });

    test('round-trips six fractional digits and timezone without truncating the supplied date', async () => {
        const { app } = setup();
        const occurredAt = '2041-07-19T11:22:33.654321+05:30';
        const entry = await create(app, { ...fixture, occurredAt });
        expect(entry.occurredAt).toBe(occurredAt);
        const read = await admin(request(app).get(`${base}/review`));
        expect(read.status).toBe(200);
        expect(read.body.entries[0].occurredAt).toBe(occurredAt);
    });

    test('missing database fails closed; no supplied historical record is returned', async () => {
        const { app } = setup(null);
        expect((await admin(request(app).get(`${base}/review`))).status).toBe(503);
        const r = await admin(request(app).post(`${base}/review`)).send(fixture);
        expect(r.status).toBe(503); expect(JSON.stringify(r.body)).not.toContain(fixture.body);
    });

    test('review returns the latest bounded entries while retaining older originals in storage', async () => {
        const { app, pool } = setup(); await create(app);
        for (let i = 0; i < 260; i++) await pool.query('INSERT INTO dot_progress_review(id, kind, title, body, occurred_at, source, scope, actor_id, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [`synthetic-review-${String(i).padStart(4, '0')}`, 'change', `Synthetic record ${i}`, 'Synthetic body', '2026-10-04', 'Synthetic source', 'Synthetic scope', 'synthetic-review-admin', `bounded-review-${i}`]);
        const r = await admin(request(app).get(`${base}/review`));
        expect(r.body.entries).toHaveLength(250);
        expect(r.body.entries[0].title).toBe('Synthetic record 259');
        expect(r.body.entries.map(e => e.title)).not.toContain('Synthetic record 0');
        expect(Number((await pool.query('SELECT COUNT(*) AS count FROM dot_progress_review')).rows[0].count)).toBe(261);
    });
});

const realPg = process.env.DOT_PROGRESS_TEST_PG === '1' ? test : test.skip;
realPg('real PostgreSQL retrospective create/comment concurrency, transaction rollback and restart', async () => {
    const { Pool } = jest.requireActual('pg');
    const schemaName = `dot_review_test_${process.pid}_${Date.now()}`;
    const config = { host: '127.0.0.1', port: 55414, database: 'postgres', user: 'progress_test', connectionTimeoutMillis: 2000 };
    const owner = new Pool(config); await owner.query(`CREATE SCHEMA ${schemaName}`);
    const pool = new Pool({ ...config, options: `-c search_path=${schemaName}` });
    try {
        const { app } = setup(pool);
        const pair = await Promise.all([create(app), create(app)]); expect(pair[0].id).toBe(pair[1].id);
        const url = `${base}/review/${pair[0].id}/comments`;
        const payload = { body: 'Synthetic concurrent correction', requestId: 'concurrent-correction-0001' };
        const comments = await Promise.all([1, 2].map(() => admin(request(app).post(url)).send(payload)));
        expect(comments.map(r => r.status)).toEqual([200, 200]); expect(comments[0].body.comment.id).toBe(comments[1].body.comment.id);
        await pool.query("ALTER TABLE dot_progress_review_comments ADD CONSTRAINT synthetic_fail_comment CHECK (body <> 'rollback synthetic comment')");
        expect((await admin(request(app).post(url)).send({ body: 'rollback synthetic comment', requestId: 'rollback-comment-0001' })).status).toBe(503);
        await pool.query('ALTER TABLE dot_progress_review_comments DROP CONSTRAINT synthetic_fail_comment');
        const restarted = setup(pool); const records = (await admin(request(restarted.app).get(`${base}/review`))).body.entries;
        expect(records).toHaveLength(1); expect(records[0].comments).toHaveLength(1); expect(records[0].body).toBe(fixture.body);
    } finally { await pool.end(); await owner.query(`DROP SCHEMA ${schemaName} CASCADE`); await owner.end(); }
}, 20000);
