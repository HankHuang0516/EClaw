require('./helpers/mock-setup');
const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const progress = require('../../dot-progress');
const seed = require('../../dot-progress-seed.json');

function setup(poolOverride) {
    const memory = newDb({ noAstCoverageCheck: true });
    memory.public.registerFunction({ name: 'pg_advisory_xact_lock', args: ['integer'], returns: 'integer', implementation: () => 1 });
    const { Pool } = memory.adapters.createPg();
    const pool = poolOverride === undefined ? new Pool() : poolOverride;
    const auth = {
        authMiddleware(req, res, next) {
            if (!req.get('x-test-role')) return res.status(401).json({ success: false, error: 'not_authenticated' });
            req.user = { userId: 'test-user', deviceSecret: 'never-expose', email: 'never-expose@example.invalid' };
            next();
        },
        adminMiddleware(req, res, next) {
            if (req.get('x-test-role') !== 'admin') return res.status(403).json({ success: false, error: 'admin_required' });
            next();
        }
    };
    const app = express();
    app.use('/api/dot-progress', progress.createRouter(() => pool, auth));
    return { app, pool, memory, auth };
}
const admin = call => call.set('x-test-role', 'admin');
const base = '/api/dot-progress';
const fixture = id => ({ id, title: 'Synthetic test project', status: 'active', summary: 'Synthetic private goal', blockers: '', nextStep: '', publicTitle: '', publicSummary: '', completedAt: '' });
async function initializePrivate(app) {
    const r = await admin(request(app).post(`${base}/import`)).send({ mode: 'apply', data: { projects: [fixture('private-test'), fixture('persistence-test')] } });
    expect(r.status).toBe(200);
}


describe('dot progress backend security and persistence', () => {
    test('public projection is exactly the three approved summaries with no private IDs, goals or comments', async () => {
        const { app } = setup();
        const r = await request(app).get(`${base}/public`);
        expect(r.status).toBe(200);
        expect(r.body.projects).toHaveLength(3);
        for (const p of r.body.projects) expect(Object.keys(p).sort()).toEqual(['completedAt', 'publicSummary', 'title']);
        expect(JSON.stringify(r.body)).not.toMatch(/private-test|persistence-test|deviceSecret|blockers|nextStep/);
        expect(r.headers['cache-control']).toBe('no-store');
    });

    test.each(['get', 'post', 'patch'])('anonymous %s cannot reach private surfaces', async method => {
        const { app } = setup();
        const url = method === 'get' ? `${base}/projects` : method === 'post' ? `${base}/projects/private-test/comments` : `${base}/projects/private-test`;
        const r = await request(app)[method](url).send({ body: 'private', version: 1 });
        expect(r.status).toBe(401);
        expect(JSON.stringify(r.body)).not.toContain('使用者');
    });

    test.each(['/projects', '/projects/private-test/comments', '/projects/private-test/history'])('nonadmin cannot read %s', async route => {
        const { app } = setup();
        expect((await request(app).get(base + route).set('x-test-role', 'member')).status).toBe(403);
    });

    test('nonadmin cannot mutate or import and cross-origin admin writes are rejected', async () => {
        const { app } = setup();
        expect((await request(app).post(`${base}/import`).set('x-test-role', 'member').send({})).status).toBe(403);
        expect((await request(app).patch(`${base}/projects/private-test`).set('x-test-role', 'member').send({ version: 1 })).status).toBe(403);
        const r = await admin(request(app).patch(`${base}/projects/private-test`)).set('Origin', 'https://other.invalid').send({ version: 1, status: 'active' });
        expect(r.status).toBe(403);
    });

    test('minimal session uses a fresh database role and never returns enriched user fields', async () => {
        const pool = { query: jest.fn().mockResolvedValue({ rows: [{ is_admin: true, device_secret: 'hidden' }] }) };
        const { app } = setup(pool);
        const r = await admin(request(app).get(`${base}/session`));
        expect(r.body).toEqual({ success: true, authenticated: true, isAdmin: true });
        expect(pool.query.mock.calls[0][0]).toBe('SELECT is_admin FROM user_accounts WHERE id = $1');
        pool.query.mockResolvedValueOnce({ rows: [{ is_admin: false }] });
        expect((await admin(request(app).get(`${base}/session`))).body.isAdmin).toBe(false);
        expect((await request(app).get(`${base}/session`)).status).toBe(401);
    });

    test('database unavailable fails closed without exposing seed or database errors', async () => {
        const { app } = setup(null);
        expect((await request(app).get(`${base}/public`)).status).toBe(503);
        expect((await admin(request(app).get(`${base}/projects`))).body).toEqual({ success: false, error: 'progress_unavailable' });
        const failed = setup({ connect: async () => { throw new Error('postgres://private'); } });
        const r = await request(failed.app).get(`${base}/public`);
        expect(r.status).toBe(503);
        expect(JSON.stringify(r.body)).not.toContain('postgres');
    });

    test('versioned edits persist, stale writes conflict, explicit completion publishes only summary and preserves history', async () => {
        const { app } = setup();
        await initializePrivate(app);
        let r = await admin(request(app).patch(`${base}/projects/persistence-test`)).send({ version: 1, summary: 'Private goal', blockers: 'Private blocker' });
        expect(r.status).toBe(200);
        expect(r.body.project.version).toBe(2);
        r = await admin(request(app).patch(`${base}/projects/persistence-test`)).send({ version: 1, summary: 'stale' });
        expect(r.status).toBe(409);
        r = await admin(request(app).patch(`${base}/projects/persistence-test`)).send({ version: 2, status: 'completed', publicTitle: 'Approved title', publicSummary: 'Approved short summary', completedAt: '2026-10-04' });
        expect(r.status).toBe(200);
        const publicRows = (await request(app).get(`${base}/public`)).body.projects;
        expect(publicRows).toContainEqual({ title: 'Approved title', publicSummary: 'Approved short summary', completedAt: '2026-10-04' });
        expect(JSON.stringify(publicRows)).not.toMatch(/Private goal|Private blocker/);
        const history = (await admin(request(app).get(`${base}/projects/persistence-test/history`))).body.history;
        expect(history.map(h => h.version)).toEqual([3, 2, 1]);
        expect(history[0].changes.before.status).toBe('active');
        expect(history[0].changes.after.status).toBe('completed');
        await admin(request(app).patch(`${base}/projects/persistence-test`)).send({ version: 3, publicSummary: '' });
        expect((await request(app).get(`${base}/public`)).body.projects).toHaveLength(3);
    });

    test('rejects secret-shaped unknown fields, incomplete publication, invalid dates and long summaries', () => {
        const entry = seed[0];
        expect(() => progress.normalize({ ...entry, deviceSecret: 'secret' })).toThrow('unknown_field');
        expect(() => progress.normalize({ ...entry, completedAt: '2026-02-30' })).toThrow('invalid_date');
        expect(() => progress.normalize({ ...entry, publicTitle: '' })).toThrow('publication_requires_completion');
        expect(() => progress.normalize({ ...entry, publicSummary: 'a'.repeat(401) })).toThrow('invalid_text');
        expect(() => progress.normalize({ ...entry, status: 'active' })).toThrow('publication_requires_completion');
    });

    test('comments persist and retry is idempotent; reuse with different body conflicts', async () => {
        const { app } = setup();
        await initializePrivate(app);
        const url = `${base}/projects/private-test/comments`;
        const data = { body: 'Do not resume pairing', requestId: 'comment-id-1234' };
        const first = await admin(request(app).post(url)).send(data);
        expect(first.status).toBe(200);
        const repeated = await admin(request(app).post(url)).send(data);
        expect(repeated.body.comment.id).toBe(first.body.comment.id);
        expect((await admin(request(app).get(url))).body.comments).toHaveLength(1);
        expect((await admin(request(app).post(url)).send({ ...data, body: 'different' })).status).toBe(409);
        expect((await admin(request(app).post(url)).send({ body: 'bad', requestId: 'short' })).status).toBe(400);
    });

    test('authorized import previews without writes, preserves existing version and comment history, rejects collision', async () => {
        const { app } = setup();
        await initializePrivate(app);
        const data = { projects: [{ ...fixture('private-test'), version: 1, summary: 'Imported authorized note', comments: [{ body: 'Old comment supplied by owner', requestId: 'old-comment-1' }] }] };
        let r = await admin(request(app).post(`${base}/import`)).send({ data });
        expect(r.body.mode).toBe('preview');
        expect((await admin(request(app).get(`${base}/projects`))).body.projects.find(p => p.id === 'private-test').summary).not.toBe('Imported authorized note');
        r = await admin(request(app).post(`${base}/import`)).send({ mode: 'apply', data });
        expect(r.status).toBe(200);
        expect((await admin(request(app).get(`${base}/projects/private-test/history`))).body.history[0].action).toBe('import');
        expect((await admin(request(app).get(`${base}/projects/private-test/comments`))).body.comments[0].body).toBe('Old comment supplied by owner');
        expect((await admin(request(app).post(`${base}/import`)).send({ mode: 'apply', data })).status).toBe(409);
    });

    test('initialization cannot overwrite persistent edits on a new router', async () => {
        const first = setup();
        await initializePrivate(first.app);
        await admin(request(first.app).patch(`${base}/projects/private-test`)).send({ version: 1, summary: 'Persistent user edit' });
        const second = setup(first.pool);
        const projects = (await admin(request(second.app).get(`${base}/projects`))).body.projects;
        expect(projects.find(p => p.id === 'private-test')).toMatchObject({ summary: 'Persistent user edit', version: 2 });
    });

    test('import validates IDs, versions and duplicate entries before any mutation', async () => {
        const { app } = setup();
        for (const projects of [[{ ...fixture('private-test'), id: undefined }], [{ ...fixture('private-test'), version: '1' }], [fixture('private-test'), fixture('private-test')], [null]]) {
            expect((await admin(request(app).post(`${base}/import`)).send({ mode: 'apply', data: { projects } })).status).toBe(400);
        }
        expect(() => progress.commentInput({ body: 'hello', requestId: 123456789 })).toThrow('invalid_request_id');
    });

    test('diagnostics require an admin and reveal only bounded metadata, and are disabled in production', async () => {
        const { app, pool, auth } = setup();
        app.use('/api/debug/dot-progress', progress.createDebugRouter(() => pool, auth));
        await request(app).get(`${base}/public`);
        expect((await request(app).get('/api/debug/dot-progress')).status).toBe(401);
        expect((await request(app).get('/api/debug/dot-progress').set('x-test-role', 'member')).status).toBe(403);
        const r = await admin(request(app).get('/api/debug/dot-progress'));
        expect(r.status).toBe(200);
        expect(r.body.counts).toEqual({ projects: 3, comments: 0, history: 3 });
        expect(r.body.recentHistory).toHaveLength(3);
        expect(JSON.stringify(r.body)).not.toMatch(/summary|blockers|changes|authorId|deviceSecret/);
        const oldEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try { expect((await admin(request(app).get('/api/debug/dot-progress'))).status).toBe(404); }
        finally { if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv; }
    });

    test('malformed JSON and nonobject mutation bodies fail with bounded JSON errors', async () => {
        const { app } = setup();
        await initializePrivate(app);
        for (const body of ['null', '[]', '"string"', '{']) {
            for (const call of [request(app).patch(`${base}/projects/private-test`), request(app).post(`${base}/import`)]) {
                const r = await admin(call).set('Content-Type', 'application/json').send(body);
                expect(r.status).toBe(400);
                expect(r.body.success).toBe(false);
                expect(r.headers['content-type']).toMatch(/application\/json/);
                expect(JSON.stringify(r.body)).not.toMatch(/TypeError|SyntaxError|stack/);
            }
        }
    });
});

// Optional local integration. Never reads application env, production DB, or credentials.
// The commander owns this disposable trust-authenticated PostgreSQL instance.
const localPgTest = process.env.DOT_PROGRESS_TEST_PG === '1' ? test : test.skip;
localPgTest('real PostgreSQL: atomic rollback, concurrent version/comment writes and restart durability', async () => {
    const { Pool } = jest.requireActual('pg');
    const schemaName = `dot_progress_test_${process.pid}_${Date.now()}`;
    const config = { host: '127.0.0.1', port: 55414, database: 'postgres', user: 'progress_test', connectionTimeoutMillis: 2000 };
    const owner = new Pool(config);
    await owner.query(`CREATE SCHEMA ${schemaName}`);
    const pool = new Pool({ ...config, options: `-c search_path=${schemaName}` });
    try {
        const { app } = setup(pool);
        expect((await request(app).get(`${base}/public`)).status).toBe(200);
        await initializePrivate(app);
        const concurrent = await Promise.all([
            admin(request(app).patch(`${base}/projects/persistence-test`)).send({ version: 1, summary: 'Version winner A' }),
            admin(request(app).patch(`${base}/projects/persistence-test`)).send({ version: 1, summary: 'Version winner B' })
        ]);
        expect(concurrent.map(r => r.status).sort()).toEqual([200, 409]);
        const rollback = await admin(request(app).post(`${base}/import`)).send({ mode: 'apply', data: { projects: [
            { ...seed[2], version: 1, summary: 'Must be rolled back' },
            { ...fixture('private-test'), version: 999 }
        ] } });
        expect(rollback.status).toBe(409);
        const persisted = (await admin(request(app).get(`${base}/projects`))).body.projects;
        expect(persisted.find(p => p.id === seed[2].id).summary).toBe(seed[2].summary);
        expect((await admin(request(app).get(`${base}/projects/${seed[2].id}/history`))).body.history).toHaveLength(1);
        const comments = await Promise.all([1, 2].map(() => admin(request(app).post(`${base}/projects/private-test/comments`)).send({ body: 'Same click, one comment', requestId: 'concurrent-comment-1' })));
        expect(comments.map(r => r.status)).toEqual([200, 200]);
        expect(comments[0].body.comment.id).toBe(comments[1].body.comment.id);
        const restart = setup(pool);
        const afterRestart = await admin(request(restart.app).get(`${base}/projects`));
        expect(afterRestart.body.projects.find(p => p.id === 'persistence-test').version).toBe(2);
        expect((await admin(request(restart.app).get(`${base}/projects/private-test/comments`))).body.comments).toHaveLength(1);
        expect((await admin(request(restart.app).get(`${base}/projects/persistence-test/history`))).body.history).toHaveLength(2);
    } finally {
        await pool.end();
        await owner.query(`DROP SCHEMA ${schemaName} CASCADE`);
        await owner.end();
    }
}, 15000);
