require('./helpers/mock-setup');
const express = require('express');
const request = require('supertest');
const { newDb, DataType } = require('pg-mem');
const progress = require('../../dot-progress');
const base = '/api/dot-progress';
const admin = call => call.set('x-test-role', 'admin');
const fixture = (requestId = 'synthetic-timeline-0001') => ({ requestId, startedAt: '2040-07-19T10:00:00+08:00', endedAt: '2040-07-19T10:30:00+08:00', projectId: null, projectLabel: 'Synthetic project', workType: 'validation', actions: 'Synthetic check.', result: 'Synthetic passed.', blockers: '', nextStep: '', evidence: [{ label: 'Synthetic PR', url: 'https://github.com/HankHuang0516/EClaw/pull/123' }] });
function setup(override) {
    const db = newDb({ noAstCoverageCheck: true });
    db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
    db.public.registerFunction({ name: 'clock_timestamp', args: [], returns: DataType.timestamptz, impure: true, implementation: () => new Date() });
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
            req.user = { userId: 'synthetic-admin' }; next();
        },
        adminMiddleware(req, res, next) {
            if (req.get('x-test-role') !== 'admin') return res.status(403).json({ success: false, error: 'admin_required' }); next();
        }
    };
    const app = express(); app.use(base, progress.createRouter(() => pool, auth));
    return { app, pool, auth };
}
async function create(app, input = fixture()) {
    const r = await admin(request(app).post(`${base}/timeline`)).send(input);
    expect({ status: r.status, body: r.body }).toMatchObject({ status: 200 }); return r.body.entry;
}
async function history(app, id) {
    const r = await admin(request(app).get(`${base}/timeline/${id}/history`)); expect(r.status).toBe(200); return r.body;
}

describe('private persistent history timeline', () => {
    test('normalizes timezone, records server identity and creates an immutable initial revision and receipt', async () => {
        const { app } = setup(); const e = await create(app);
        expect(e).toMatchObject({ startedAt: '2040-07-19T02:00:00.000Z', endedAt: '2040-07-19T02:30:00.000Z', version: 1, actorId: 'synthetic-admin', projectId: null });
        expect(e.id).toMatch(/^[a-f0-9-]{36}$/); expect(Number.isNaN(Date.parse(e.createdAt))).toBe(false);
        expect(await create(app)).toEqual(e);
        expect((await admin(request(app).post(`${base}/timeline`)).send({ ...fixture(), result: 'Different result' })).status).toBe(409);
        const h = await history(app, e.id); expect(h.total).toBe(1); expect(h.history[0].changes).toEqual({ before: null, after: e });
        const list = await admin(request(app).get(`${base}/timeline`)); expect(list.body).toMatchObject({ total: 1, limit: 500, offset: 0, nextOffset: null });
        expect(list.body.entries).toEqual([e]);
    });

    test('update uses optimistic versions, preserves revisions and returns original receipts after later edits', async () => {
        const { app } = setup(); const first = await create(app);
        const payload = { requestId: 'synthetic-update-0001', version: 1, result: 'Synthetic revised result.' };
        let r = await admin(request(app).patch(`${base}/timeline/${first.id}`)).send(payload); expect(r.status).toBe(200); const second = r.body.entry;
        expect(second.version).toBe(2);
        r = await admin(request(app).patch(`${base}/timeline/${first.id}`)).send({ requestId: 'synthetic-update-0002', version: 2, nextStep: 'Synthetic next step.' });
        expect(r.status).toBe(200); expect(r.body.entry.version).toBe(3);
        expect((await admin(request(app).patch(`${base}/timeline/${first.id}`)).send(payload)).body.entry).toEqual(second);
        expect(await create(app)).toEqual(first);
        expect((await admin(request(app).patch(`${base}/timeline/${first.id}`)).send({ ...payload, result: 'Changed duplicate' })).status).toBe(409);
        expect((await admin(request(app).patch(`${base}/timeline/${first.id}`)).send({ ...payload, requestId: 'new-stale-request' })).body.error).toBe('version_conflict');
        const h = await history(app, first.id); expect(h.history.map(x => x.version)).toEqual([3, 2, 1]);
        expect(h.history[1].changes).toEqual({ before: first, after: second });
        expect((await admin(request(app).get(`${base}/timeline`))).body.entries[0].version).toBe(3);
    });

    test('malformed driver update timestamps return null without crashing the timeline read', async () => {
        const { app, pool } = setup(); const entry = await create(app);
        const connect = pool.connect.bind(pool);
        let malformed;
        pool.connect = async () => {
            const client = await connect(); const query = client.query.bind(client);
            client.query = async (sql, params) => {
                const result = await query(sql, params);
                if (sql.startsWith('SELECT * FROM dot_progress_timeline')) return { ...result, rows: result.rows.map(row => ({ ...row, updated_at: malformed })) };
                return result;
            };
            return client;
        };
        for (malformed of ['not-a-date', new Date(NaN), null, { unexpected: true }]) {
            const result = await admin(request(app).get(`${base}/timeline`));
            expect(result.status).toBe(200);
            expect(result.body.entries[0]).toEqual({ ...entry, updatedAt: null });
        }
    });

    test('Taipei half-open overlap, midnight ending, zero-duration points and exact project labels filter correctly', async () => {
        const { app } = setup();
        const intervals = [
            ['previous', '2040-07-18T23:00:00+08:00', '2040-07-19T00:00:00+08:00'],
            ['crossing', '2040-07-18T23:30:00+08:00', '2040-07-19T00:30:00+08:00'],
            ['point', '2040-07-18T16:00:00Z', '2040-07-18T16:00:00Z'],
            ['next', '2040-07-20T00:00:00+08:00', '2040-07-20T01:00:00+08:00']
        ];
        for (const [label, startedAt, endedAt] of intervals) await create(app, { ...fixture(`synthetic-${label}-0001`), projectLabel: label, startedAt, endedAt });
        let r = await admin(request(app).get(`${base}/timeline?date=2040-07-19`)); expect(r.status).toBe(200);
        expect(r.body.entries.map(e => e.projectLabel)).toEqual(['crossing', 'point']);
        r = await admin(request(app).get(`${base}/timeline`).query({ date: '2040-07-19', project: 'point' }));
        expect(r.body.total).toBe(1); expect(r.body.entries[0].startedAt).toBe('2040-07-18T16:00:00.000Z');
        expect((await admin(request(app).get(`${base}/timeline?project=POINT`))).body.total).toBe(0);
    });

    test('rejects invalid calendar/timezone, reverse spans, more than seven days and submillisecond rounding hazards', async () => {
        const { app } = setup();
        const cases = [
            { startedAt: '2040-02-30T10:00:00+08:00' }, { startedAt: '2040-07-19T24:00:00+08:00' },
            { startedAt: '2040-07-19T10:00:00' }, { startedAt: '2040-07-19T10:00:60Z' },
            { endedAt: '2040-07-19T09:59:59+08:00' }, { endedAt: '2040-07-26T10:00:00.001+08:00' },
            { startedAt: '2040-07-19T10:00:00.0009Z', endedAt: '2040-07-19T10:00:00.0001Z' },
            { startedAt: '2040-07-19T10:00:00.123456+08:00' }, { startedAt: '2040-07-19T10:00:00.123456789+08:00' }
        ];
        for (const delta of cases) expect((await admin(request(app).post(`${base}/timeline`)).send({ ...fixture(), ...delta })).status).toBe(400);
        expect((await admin(request(app).get(`${base}/timeline?date=2040-02-30`))).status).toBe(400);
        const exact = await create(app, { ...fixture(), endedAt: '2040-07-26T10:00:00+08:00' }); expect(exact.version).toBe(1);
        expect((await admin(request(app).patch(`${base}/timeline/${exact.id}`)).send({ version: 1, requestId: 'invalid-span-update', endedAt: '2040-07-19T09:59:59+08:00' })).status).toBe(400);
    });

    test('only exact public EClaw GitHub evidence is allowed, including raw URL boundary variants', async () => {
        const { app } = setup();
        const good = ['https://github.com/HankHuang0516/EClaw/pull/123', 'https://github.com/HankHuang0516/EClaw/actions/runs/456', 'https://github.com/HankHuang0516/EClaw/commit/abc1234'];
        for (let i = 0; i < good.length; i++) await create(app, { ...fixture(`public-evidence-${i}`), evidence: [{ label: 'Synthetic evidence', url: good[i] }] });
        const invalid = [good[0] + '\n', good[0] + '\r\n', good[0] + '\u2028', good[0] + '?', good[0] + '#', good[0] + '?token=synthetic', good[0] + '/files', good[1] + '/job/1', good[0].replace('github.com', 'github.com:443'), good[0].replace('github.com', 'synthetic@github.com'), good[0].replace('HankHuang0516', '%48ankHuang0516'), good[0].replace('/pull/', '/tree/../pull/'), good[0].replace('/pull/', '\\pull/'), good[0].replace('EClaw', 'OtherRepo'), good[0].replace('https:', 'http:')];
        for (const url of invalid) expect((await admin(request(app).post(`${base}/timeline`)).send({ ...fixture(), evidence: [{ label: 'Synthetic evidence', url }] })).status).toBe(400);
    });

    test('hygiene rejects obvious secrets, email, private paths/capability links, metadata forgery and oversized values', async () => {
        const { app } = setup();
        for (const actions of ['synthetic@example.invalid', 'apiKey=synthetic-not-a-real-key', 'sk-SYNTHETIC_NOT_REAL_12345', 'eyJsynthetic.payload.signature', '/Users/synthetic/private.txt', 'C:\\synthetic\\private.txt', '~/synthetic/private.txt', 'https://chatgpt.com/share/synthetic-id', 'https://example.invalid/?token=synthetic']) {
            const r = await admin(request(app).post(`${base}/timeline`)).send({ ...fixture(), actions }); expect(r.status).toBe(400); expect(JSON.stringify(r.body)).not.toContain(actions);
        }
        for (const delta of [{ actorId: 'forged' }, { createdAt: '2040-01-01' }, { version: 9 }, { workType: 'other' }, { projectLabel: 'x'.repeat(161) }, { actions: 'x'.repeat(4001) }, { evidence: Array(11).fill({ label: 'Evidence', url: 'https://github.com/HankHuang0516/EClaw/pull/123' }) }, { projectId: 1 }, { requestId: 123456789 }, { actions: '' }]) expect((await admin(request(app).post(`${base}/timeline`)).send({ ...fixture(), ...delta })).status).toBe(400);
        const e = await create(app);
        for (const body of [null, [], { version: '1', requestId: 'invalid-patch-000', result: 'r' }, { version: 1, requestId: 'invalid-patch-000', actorId: 'forged' }, { version: 1, requestId: 'invalid-patch-000' }]) expect((await admin(request(app).patch(`${base}/timeline/${e.id}`)).send(body)).status).toBe(400);
        for (const query of ['offset=-1', 'offset=1.5', 'offset=01', 'date[]=2040-01-01', 'unknown=1']) expect((await admin(request(app).get(`${base}/timeline?${query}`))).status).toBe(400);
    });

    test('optional existing project link preserves project, counters, decisions and review and accepts unlinked legacy labels', async () => {
        const { app } = setup();
        const project = { id: 'synthetic-linked-project', title: 'Synthetic project', status: 'archived', summary: 'Synthetic goal', blockers: '', nextStep: '', completedWork: '', publicTitle: '', publicSummary: '', completedAt: '' };
        expect((await admin(request(app).post(`${base}/import`)).send({ mode: 'apply', data: { projects: [project] } })).status).toBe(200);
        await admin(request(app).post(`${base}/projects/${project.id}/push`)).send({ requestId: 'synthetic-push-000' });
        const before = (await admin(request(app).get(`${base}/projects`))).body.projects;
        await create(app, { ...fixture(), projectId: project.id });
        expect((await admin(request(app).get(`${base}/projects`))).body.projects).toEqual(before);
        expect((await admin(request(app).post(`${base}/timeline`)).send({ ...fixture('missing-project-000'), projectId: 'missing' })).status).toBe(404);
        expect((await request(app).get(`${base}/public`)).body.projects).toHaveLength(3);
    });

    test('admin/origin gates cover all timeline routes; no public or debug text leakage and no storage fallback', async () => {
        const { app, pool, auth } = setup(); const e = await create(app);
        const calls = [['get', `${base}/timeline`], ['post', `${base}/timeline`], ['patch', `${base}/timeline/${e.id}`], ['get', `${base}/timeline/${e.id}/history`]];
        for (const [method, url] of calls) {
            expect((await request(app)[method](url).send({})).status).toBe(401);
            expect((await request(app)[method](url).set('x-test-role', 'member').send({})).status).toBe(403);
        }
        expect((await admin(request(app).post(`${base}/timeline`)).set('Origin', 'https://other.invalid').send(fixture())).status).toBe(403);
        const publicRows = (await request(app).get(`${base}/public`)).body.projects;
        for (const p of publicRows) expect(Object.keys(p).sort()).toEqual(['completedAt', 'publicSummary', 'title']);
        expect(JSON.stringify(publicRows)).not.toMatch(/Synthetic|actions|timeline|actorId/);
        app.use('/api/debug/dot-progress', progress.createDebugRouter(() => pool, auth));
        const debug = await admin(request(app).get('/api/debug/dot-progress')); expect(debug.body.timelineCounts).toEqual({ entries: 1, revisions: 1, requests: 1 });
        expect(JSON.stringify(debug.body)).not.toMatch(/Synthetic|projectLabel|actorId|evidence/);
        const failed = setup(null); expect((await admin(request(failed.app).get(`${base}/timeline`))).status).toBe(503);
        expect((await admin(request(failed.app).post(`${base}/timeline`)).send(fixture())).status).toBe(503);
    });

    test('explicit pagination avoids silently dropping list or revision history and preserves storage across restart', async () => {
        const { app, pool } = setup(); const e = await create(app);
        const data = progress.normalizeTimelineInput(fixture()); delete data.requestId;
        for (let i = 0; i < 502; i++) await pool.query('INSERT INTO dot_progress_timeline(id,project_label,started_at,ended_at,data,actor_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [`synthetic-timeline-${String(i).padStart(4, '0')}`, data.projectLabel, data.startedAt, data.endedAt, JSON.stringify(data), 'synthetic-admin']);
        let r = await admin(request(app).get(`${base}/timeline`)); expect(r.body).toMatchObject({ total: 503, limit: 500, offset: 0, nextOffset: 500 }); expect(r.body.entries).toHaveLength(500);
        r = await admin(request(app).get(`${base}/timeline?offset=500`)); expect(r.body.entries).toHaveLength(3); expect(r.body.nextOffset).toBeNull();
        for (let version = 2; version <= 102; version++) await pool.query('INSERT INTO dot_progress_timeline_revisions(timeline_id,version,actor_id,changes) VALUES ($1,$2,$3,$4::jsonb)', [e.id, version, 'synthetic-admin', JSON.stringify({ before: e, after: { ...e, version } })]);
        let h = await history(app, e.id); expect(h).toMatchObject({ total: 102, limit: 100, nextOffset: 100 }); expect(h.history[0].version).toBe(102);
        h = (await admin(request(app).get(`${base}/timeline/${e.id}/history?offset=100`))).body; expect(h.history.map(x => x.version)).toEqual([2, 1]); expect(h.nextOffset).toBeNull();
        const restarted = setup(pool); expect((await admin(request(restarted.app).get(`${base}/timeline`))).body.total).toBe(503);
        expect(await create(restarted.app)).toEqual(e);
    });
});

const realPg = process.env.DOT_PROGRESS_TEST_PG === '1' ? test : test.skip;
realPg('real PostgreSQL timeline concurrency, exact receipts, revision/receipt rollback and restart', async () => {
    const { Pool } = jest.requireActual('pg'); const name = `dot_timeline_test_${process.pid}_${Date.now()}`;
    const config = { host: '127.0.0.1', port: 55414, database: 'postgres', user: 'progress_test', connectionTimeoutMillis: 2000, statement_timeout: 4000 };
    const owner = new Pool(config); await owner.query(`CREATE SCHEMA ${name}`);
    const pool = new Pool({ ...config, options: `-c search_path=${name}` });
    try {
        const { app } = setup(pool); const pair = await Promise.all([create(app), create(app)]); expect(pair[0]).toEqual(pair[1]); const first = pair[0];
        const patch = { version: 1, requestId: 'synthetic-update-0001', result: 'Synthetic changed.' };
        const updates = await Promise.all([1, 2].map(() => admin(request(app).patch(`${base}/timeline/${first.id}`)).send(patch)));
        expect(updates.map(r => r.status)).toEqual([200, 200]); expect(updates[0].body.entry).toEqual(updates[1].body.entry);
        const race = await Promise.all(['a', 'b'].map(key => admin(request(app).patch(`${base}/timeline/${first.id}`)).send({ version: 2, requestId: `synthetic-race-${key}`, result: `Synthetic result ${key}` })));
        expect(race.map(r => r.status).sort()).toEqual([200, 409]);
        expect(await create(app)).toEqual(first);
        expect((await admin(request(app).patch(`${base}/timeline/${first.id}`)).send(patch)).body.entry).toEqual(updates[0].body.entry);
        await pool.query("ALTER TABLE dot_progress_timeline_requests ADD CONSTRAINT synthetic_fail_receipt CHECK (request_id <> 'rollback-request-0001')");
        expect((await admin(request(app).post(`${base}/timeline`)).send(fixture('rollback-request-0001'))).status).toBe(503);
        expect((await admin(request(app).patch(`${base}/timeline/${first.id}`)).send({ version: 3, requestId: 'rollback-request-0001', result: 'Synthetic failed edit.' })).status).toBe(503);
        expect((await admin(request(app).get(`${base}/timeline`))).body).toMatchObject({ total: 1, entries: [{ version: 3 }] });
        expect((await history(app, first.id)).total).toBe(3);
        await pool.query('ALTER TABLE dot_progress_timeline_requests DROP CONSTRAINT synthetic_fail_receipt');
        expect((await admin(request(app).patch(`${base}/timeline/${first.id}`)).send({ version: 3, requestId: 'rollback-request-0001', result: 'Synthetic successful retry.' })).body.entry.version).toBe(4);
        const restarted = setup(pool); expect((await history(restarted.app, first.id)).total).toBe(4); expect(await create(restarted.app)).toEqual(first);
        expect((await admin(request(restarted.app).get(`${base}/timeline?date=2040-07-19`))).body.total).toBe(1);
    } finally { await pool.end(); await owner.query(`DROP SCHEMA ${name} CASCADE`); await owner.end(); }
}, 20000);
