'use strict';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const createInference = require('../../dream-buddy-inference');

const url = process.env.DREAM_BUDDY_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const PREFIX = '/api/app-bot/inference';
const WORKER_TOKEN = 'synthetic-worker-credential-for-tests-only';
const PERSONA = 'SYNTHETIC_SERVER_PERSONA';
const START = Date.parse('2026-10-21T12:00:00Z');

suite('Dream Buddy durable inference — real PostgreSQL', () => {
    let admin, pool, app, clock, selectedProvider, credential, ready;
    const schema = `dream_buddy_inference_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
    const devices = Object.fromEntries(['owner', 'other', ...Array.from({ length: 12 }, (_, i) => `device${i}`)]
        .map(id => [id, { deviceSecret: `synthetic-${id}-secret` }]));
    const getPersona = (appId, personaId) => appId === 'dream-buddy' && personaId === 'dream-buddy'
        ? { app: { entityId: 0, dailyQuota: 8 }, persona: { systemPrompt: PERSONA } } : null;
    const makeApp = (overrides = {}) => {
        const server = express();
        server.use(express.json());
        const inference = createInference({ getPool: async () => pool, getDevices: () => devices,
            getPersona, isReady: () => ready, now: () => clock,
            provider: () => selectedProvider, workerToken: () => credential, ...overrides });
        server.use(PREFIX, inference.router);
        server.use('/debug', inference.diagnostics);
        // Only mimic the parent's already-authenticated boundary. Never load
        // index.js or its global mocks/services for this factory-level suite.
        server.post('/submit', (req, res) => {
            const device = devices[req.body.deviceId];
            if (!device || device.deviceSecret !== req.body.deviceSecret) {
                return res.status(403).json({ success: false, error: 'invalid_device' });
            }
            return inference.submit(req, res, getPersona(req.body.appId, req.body.personaId));
        });
        return server;
    };
    const ownerGet = (path, id = 'owner', server = app) => request(server).get(path)
        .query({ deviceId: id }).set('X-Device-Secret', devices[id].deviceSecret);
    const worker = (method, path, server = app) => request(server)[method](PREFIX + path)
        .set('Authorization', 'Bearer ' + WORKER_TOKEN);
    const heartbeat = (server = app) => worker('post', '/worker/heartbeat', server).send({});
    const next = (server = app) => worker('get', '/worker/next', server);
    const submit = (body = {}, id = 'owner', server = app) => request(server).post('/submit').send({
        appId: 'dream-buddy', personaId: 'dream-buddy', deviceId: id,
        deviceSecret: devices[id].deviceSecret, message: 'synthetic private dream',
        operationId: crypto.randomUUID(), ...body,
    });
    const status = (id, owner = 'owner', server = app) => ownerGet(PREFIX + '/jobs/' + id, owner, server);
    const operation = (id, owner = 'owner', server = app) => ownerGet(PREFIX + '/operations/' + id, owner, server);
    const result = (lease, body = {}, server = app) => worker('post', '/worker/jobs/' + lease.jobId + '/result', server)
        .send({ leaseToken: lease.leaseToken, status: 'completed', reply: 'synthetic reply', ...body });
    const usage = async (id = 'owner') => (await pool.query(
        'SELECT COALESCE(SUM(messages_used),0)::int AS n FROM app_bot_quota WHERE device_id=$1', [id])).rows[0].n;
    const count = async table => (await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
    const enqueue = async (body = {}, id = 'owner') => {
        const response = await submit(body, id);
        expect(response.status).toBe(200);
        return response.body;
    };
    const lease = async () => {
        const response = await next();
        expect({ status: response.status, body: response.body }).toMatchObject({ status: 200 });
        return response.body;
    };

    beforeAll(async () => {
        const parsed = new URL(url);
        // Refuse remote/ambiguous connection strings before opening a socket.
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.search ||
            !/^\/dream_buddy_inference_test[a-z0-9_]*$/.test(parsed.pathname)) {
            throw new Error('Only an isolated localhost Dream Buddy inference test database is permitted');
        }
        admin = new Pool({ connectionString: url, max: 2 });
        await admin.query(`CREATE SCHEMA ${schema}`);
        pool = new Pool({ connectionString: url, max: 20,
            options: `-c search_path=${schema} -c statement_timeout=10000`, connectionTimeoutMillis: 3000 });
        // Match production types/defaults, including UUID chat IDs and raw text.
        await pool.query(`CREATE TABLE devices(device_id VARCHAR(64) PRIMARY KEY,device_secret TEXT NOT NULL);
            CREATE TABLE app_bot_quota (
                id SERIAL PRIMARY KEY,app_id TEXT NOT NULL,device_id TEXT NOT NULL,quota_date DATE NOT NULL,
                messages_used INTEGER NOT NULL DEFAULT 0,bonus_from_ads INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(app_id,device_id,quota_date));
            CREATE TABLE chat_messages (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),device_id VARCHAR(64) NOT NULL,entity_id INTEGER,
                text TEXT NOT NULL,source VARCHAR(64) NOT NULL,is_from_user BOOLEAN DEFAULT FALSE,
                is_from_bot BOOLEAN DEFAULT FALSE,read_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW());`);
        clock = START; selectedProvider = 'local-minimax'; credential = WORKER_TOKEN; ready = true;
        app = makeApp();
        expect((await heartbeat()).status).toBe(200); // Lazily initialize once before TRUNCATE.
    });
    beforeEach(async () => {
        await pool.query(`TRUNCATE dream_buddy_inference_jobs,dream_buddy_inference_worker,chat_messages,
            app_bot_quota,devices CASCADE`);
        for (const [id, device] of Object.entries(devices)) {
            await pool.query('INSERT INTO devices(device_id,device_secret) VALUES($1,$2)', [id, device.deviceSecret]);
        }
        clock = START; selectedProvider = 'local-minimax'; credential = WORKER_TOKEN; ready = true;
        app = makeApp();
        expect((await heartbeat()).status).toBe(200);
    });
    afterAll(async () => {
        if (pool) await pool.end();
        if (admin) {
            await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            await admin.end();
        }
    });

    test('accepts, leases and completes exactly one owned history pair with precise reply correlation', async () => {
        const op = crypto.randomUUID();
        const raw = '  原始夢境：雲端的魚  ';
        const accepted = await enqueue({ operationId: op, message: raw, prompt: 'UNTRUSTED_PROMPT',
            systemPrompt: 'UNTRUSTED_SYSTEM', reply: 'UNTRUSTED_REPLY' });
        expect(accepted).toEqual({ success: true, jobId: expect.any(String), quotaRemaining: 7,
            poll: '/api/chat/history', pollAfterMs: 1200 });
        expect((await status(accepted.jobId)).body).toEqual({ success: true, jobId: accepted.jobId,
            status: 'queued', replyMessageId: null, quotaRemaining: 7 });
        const claimed = await lease();
        expect(Object.keys(claimed).sort()).toEqual(['jobId', 'leaseToken', 'prompt', 'success']);
        expect(claimed.prompt).toContain(PERSONA);
        expect(claimed.prompt).toContain(raw);
        expect(claimed.prompt).not.toMatch(/UNTRUSTED|synthetic-owner-secret|synthetic-worker-credential/);
        expect((await status(accepted.jobId)).body.status).toBe('leased');
        const completed = await result(claimed);
        expect(completed.status).toBe(200);
        expect(completed.body.replyMessageId).toMatch(/^[a-f0-9-]{36}$/);
        const lookup = await operation(op);
        expect(lookup.body).toEqual({ success: true, jobId: accepted.jobId, status: 'completed',
            replyMessageId: completed.body.replyMessageId, quotaRemaining: 7 });
        const history = (await pool.query('SELECT * FROM chat_messages ORDER BY is_from_bot')).rows;
        expect(history).toHaveLength(2);
        expect(history[0]).toMatchObject({ device_id: 'owner', entity_id: 0, text: raw,
            source: 'dream-buddy-user', is_from_user: true, is_from_bot: false });
        expect(history[1]).toMatchObject({ id: lookup.body.replyMessageId, device_id: 'owner', entity_id: 0,
            text: 'synthetic reply', source: 'dream-buddy-minimax', is_from_user: false, is_from_bot: true });
        expect((await pool.query('SELECT prompt FROM dream_buddy_inference_jobs')).rows[0].prompt).toBeNull();
        expect(await usage()).toBe(1);
        expect((await next()).status).toBe(204);
    });

    test('owner auth and job/operation lookups never reveal another owner or private payload', async () => {
        const op = crypto.randomUUID();
        const accepted = await enqueue({ operationId: op });
        const paths = ['/connection', '/jobs/' + accepted.jobId, '/operations/' + op];
        for (const path of paths) {
            expect((await request(app).get(PREFIX + path).query({ deviceId: 'owner' })).status).toBe(403);
            expect((await request(app).get(PREFIX + path).query({ deviceId: 'owner' })
                .set('X-Device-Secret', 'incorrect')).status).toBe(403);
        }
        expect((await status(accepted.jobId, 'other')).status).toBe(404);
        expect((await operation(op, 'other')).status).toBe(404);
        expect((await status('invalid-uuid')).status).toBe(404);
        expect((await operation(crypto.randomUUID())).status).toBe(404);
        const debug = await ownerGet('/debug');
        expect(debug.body).toEqual({ success: true, provider: 'local-minimax', workerOnline: true,
            counts: { queued: 1 }, quotaRemaining: 7 });
        expect((await ownerGet('/debug', 'other')).body.counts).toEqual({});
        for (const response of [await status(accepted.jobId), await operation(op), debug]) {
            expect(JSON.stringify(response.body)).not.toMatch(/private dream|SERVER_PERSONA|deviceSecret|leaseToken|prompt/);
            expect(response.headers['cache-control']).toBe('no-store');
        }
        expect((await request(app).get('/debug?deviceId=owner')).status).toBe(403);
    });

    test('connection selects only local-minimax or official-bot; provider switch never leases to local worker', async () => {
        expect((await ownerGet(PREFIX + '/connection')).body).toEqual({
            success: true, provider: 'local-minimax', workerOnline: true });
        await enqueue();
        selectedProvider = 'official-bot';
        expect((await ownerGet(PREFIX + '/connection')).body).toEqual({ success: true, provider: 'official-bot', workerOnline: true });
        expect((await next()).status).toBe(204);
        expect((await submit({}, 'other')).body.error).toBe('provider_unavailable');
        expect(await usage('other')).toBe(0);
        selectedProvider = undefined;
        expect((await ownerGet(PREFIX + '/connection')).body.provider).toBe('official-bot');
    });

    test('heartbeat establishes readiness before activation; rollback stops claims but accepts an outstanding result', async () => {
        selectedProvider = undefined;
        await pool.query('DELETE FROM dream_buddy_inference_worker');
        expect((await ownerGet(PREFIX + '/connection')).body).toEqual({
            success: true, provider: 'official-bot', workerOnline: false });
        expect((await heartbeat()).status).toBe(200);
        expect((await ownerGet(PREFIX + '/connection')).body.workerOnline).toBe(true);
        expect((await next()).status).toBe(204);
        selectedProvider = 'local-minimax';
        const accepted = await enqueue();
        const claimed = await lease();
        const queued = await enqueue({}, 'other');
        selectedProvider = 'official-bot';
        expect((await heartbeat()).status).toBe(200);
        expect((await next()).status).toBe(204);
        expect((await result(claimed)).body.status).toBe('completed');
        expect((await status(accepted.jobId)).body.status).toBe('completed');
        expect((await status(queued.jobId, 'other')).body.status).toBe('queued');
        expect(await usage()).toBe(1);
    });

    test('worker auth requires a dedicated configured Bearer token of at least 32 characters', async () => {
        const accepted = await enqueue();
        const endpoints = [['post', '/worker/heartbeat'], ['get', '/worker/next'],
            ['post', '/worker/jobs/' + accepted.jobId + '/result']];
        for (const [method, path] of endpoints) {
            for (const auth of ['', 'Bearer short', 'Basic ' + WORKER_TOKEN,
                'Bearer ' + devices.owner.deviceSecret, 'Bearer ' + 'x'.repeat(WORKER_TOKEN.length)]) {
                const req = request(app)[method](PREFIX + path);
                if (auth) req.set('Authorization', auth);
                expect((await req.send({})).status).toBe(403);
            }
        }
        credential = 'short';
        expect((await heartbeat()).status).toBe(403);
        expect((await ownerGet(PREFIX + '/connection')).body.workerOnline).toBe(false);
        credential = undefined;
        expect((await heartbeat()).status).toBe(403);
        expect((await status(accepted.jobId)).body.status).toBe('queued');
    });

    test.each(['absent', 'expired', 'unconfigured'])('offline %s rejects before charge with accepted:false', async condition => {
        if (condition === 'absent') await pool.query('DELETE FROM dream_buddy_inference_worker');
        if (condition === 'expired') clock += 30_000;
        if (condition === 'unconfigured') credential = undefined;
        const response = await submit();
        expect(response.status).toBe(503);
        expect(response.body).toEqual({ success: false, error: 'local_worker_offline', accepted: false });
        expect(await count('dream_buddy_inference_jobs')).toBe(0);
        expect(await count('chat_messages')).toBe(0);
        expect(await count('app_bot_quota')).toBe(0);
    });

    test('simultaneous identical operations across factories are accepted once, including after worker goes offline', async () => {
        const op = crypto.randomUUID();
        const servers = [app, makeApp(), makeApp()];
        const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => submit({ operationId: op }, 'owner', servers[i % 3])));
        expect(responses.every(r => r.status === 200)).toBe(true);
        expect(new Set(responses.map(r => r.body.jobId)).size).toBe(1);
        expect(await usage()).toBe(1);
        expect(await count('chat_messages')).toBe(1);
        expect(await count('dream_buddy_inference_jobs')).toBe(1);
        clock += 30_000;
        expect((await submit({ operationId: op })).body.jobId).toBe(responses[0].body.jobId);
        expect((await submit({ operationId: op, message: 'changed private dream' })).status).toBe(409);
        expect(await usage()).toBe(1);
    });

    test('different concurrent operations permit at most one in-flight job per owner', async () => {
        const responses = await Promise.all(Array.from({ length: 10 }, () => submit()));
        expect(responses.filter(r => r.status === 200)).toHaveLength(1);
        expect(responses.filter(r => r.status === 409 && r.body.error === 'inference_in_progress')).toHaveLength(9);
        await lease();
        expect((await submit()).body.error).toBe('inference_in_progress');
        expect(await usage()).toBe(1);
    });

    test('operations are namespaced by owner and worker prompts contain only that owners current message', async () => {
        const op = crypto.randomUUID();
        const first = await enqueue({ operationId: op, message: 'ONLY_OWNER_DREAM' });
        const second = await enqueue({ operationId: op, message: 'ONLY_OTHER_DREAM' }, 'other');
        expect(first.jobId).not.toBe(second.jobId);
        const claims = [await lease(), await lease()];
        const byId = new Map(claims.map(c => [c.jobId, c]));
        expect(byId.get(first.jobId).prompt).toContain('ONLY_OWNER_DREAM');
        expect(byId.get(first.jobId).prompt).not.toContain('ONLY_OTHER_DREAM');
        expect(byId.get(second.jobId).prompt).not.toContain('ONLY_OWNER_DREAM');
        await result(byId.get(second.jobId));
        const recovered = await operation(op, 'other');
        expect({ status: recovered.status, body: recovered.body }).toMatchObject({ status: 200, body: { jobId: second.jobId } });
        expect((await pool.query('SELECT device_id FROM chat_messages WHERE is_from_bot')).rows).toEqual([{ device_id: 'other' }]);
    });

    test('quota eight plus verified SSV bonus is enforced atomically and quota exhaustion never queues', async () => {
        await pool.query(`INSERT INTO app_bot_quota(app_id,device_id,quota_date,messages_used)
            VALUES('dream-buddy','owner','2026-10-21',7)`);
        expect((await enqueue()).quotaRemaining).toBe(0);
        await result(await lease());
        const exhausted = await submit();
        expect(exhausted.status).toBe(429);
        expect(exhausted.body).toMatchObject({ error: 'daily_quota_exceeded', quotaRemaining: 0, needAd: true });
        expect(await count('dream_buddy_inference_jobs')).toBe(1);
        // Exactly the quota-row increment used by validated SSV; inference does
        // not grant bonus from any client fields.
        await pool.query("UPDATE app_bot_quota SET bonus_from_ads=bonus_from_ads+6 WHERE device_id='owner'");
        expect((await enqueue({ bonus_from_ads: 999, dailyQuota: 999 })).quotaRemaining).toBe(5);
        expect(await usage()).toBe(9);
    });

    test('concurrent SSV row credit and inference reservation preserve both updates', async () => {
        await pool.query(`INSERT INTO app_bot_quota(app_id,device_id,quota_date,messages_used)
            VALUES('dream-buddy','owner','2026-10-21',7)`);
        await Promise.all([submit(), pool.query("UPDATE app_bot_quota SET bonus_from_ads=bonus_from_ads+6 WHERE device_id='owner'")]);
        expect((await pool.query("SELECT messages_used,bonus_from_ads FROM app_bot_quota WHERE device_id='owner'")).rows[0])
            .toEqual({ messages_used: 8, bonus_from_ads: 6 });
    });

    test('capacity is ten globally even under concurrent submissions, with no charge or message for rejection', async () => {
        const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => submit({}, `device${i}`)));
        expect(responses.filter(r => r.status === 200)).toHaveLength(10);
        expect(responses.filter(r => r.status === 503 && r.body.error === 'queue_full')).toHaveLength(2);
        expect(await count('dream_buddy_inference_jobs')).toBe(10);
        expect(await count('chat_messages')).toBe(10);
        expect(await count('app_bot_quota')).toBe(10);
        const claims = await Promise.all(Array.from({ length: 15 }, () => next()));
        expect(claims.filter(r => r.status === 200)).toHaveLength(10);
        expect(new Set(claims.filter(r => r.status === 200).map(r => r.body.jobId)).size).toBe(10);
        expect(claims.filter(r => r.status === 204)).toHaveLength(5);
    });

    test('concurrent successful callbacks and replay return the same reply UUID exactly once', async () => {
        const accepted = await enqueue();
        const claimed = await lease();
        const responses = await Promise.all(Array.from({ length: 8 }, () => result(claimed)));
        expect(responses.every(r => r.status === 200)).toBe(true);
        expect(responses.filter(r => r.body.idempotent)).toHaveLength(7);
        expect(new Set(responses.map(r => r.body.replyMessageId)).size).toBe(1);
        expect((await result(claimed, { reply: 'changed on replay' })).body.idempotent).toBe(true);
        expect((await result(claimed, { status: 'failed' })).body.status).toBe('completed');
        expect((await result(claimed, { leaseToken: 'incorrect' })).status).toBe(403);
        expect(await count('chat_messages')).toBe(2);
        expect(await usage()).toBe(1);
        expect((await status(accepted.jobId)).body.status).toBe('completed');
    });

    test('worker failure refunds once and neither duplicate nor contrary callbacks can write a reply', async () => {
        const op = crypto.randomUUID();
        const accepted = await enqueue({ operationId: op });
        const claimed = await lease();
        const responses = await Promise.all(Array.from({ length: 6 }, () => result(claimed, { status: 'failed' })));
        expect(responses.every(r => r.status === 200)).toBe(true);
        expect((await result(claimed)).body).toMatchObject({ status: 'failed', idempotent: true, error: 'inference_failed' });
        expect((await status(accepted.jobId)).body).toMatchObject({ status: 'failed', quotaRemaining: 8 });
        const repeated = await submit({ operationId: op });
        expect({ status: repeated.status, body: repeated.body }).toMatchObject({ status: 200, body: { jobId: accepted.jobId } });
        expect(await usage()).toBe(0);
        expect(await count('chat_messages')).toBe(1);
        expect((await next()).status).toBe(204);
        expect((await enqueue()).jobId).not.toBe(accepted.jobId);
    });

    test('queued jobs expire at 180 seconds; status settles and refunds exactly once without requeueing', async () => {
        const accepted = await enqueue();
        clock += 179_999;
        expect((await status(accepted.jobId)).body.status).toBe('queued');
        clock += 1;
        const responses = await Promise.all([status(accepted.jobId), status(accepted.jobId), next()]);
        expect(responses[0].body).toMatchObject({ status: 'failed', error: 'job_expired', quotaRemaining: 8 });
        expect(responses[2].status).toBe(204);
        expect(await usage()).toBe(0);
        expect(await count('chat_messages')).toBe(1);
    });

    test('leased inference remains valid for 120 seconds and an uncertain expired lease is never retried', async () => {
        const accepted = await enqueue();
        const claimed = await lease();
        clock += 119_999;
        expect((await status(accepted.jobId)).body.status).toBe('leased');
        clock += 1;
        expect((await next()).status).toBe(204);
        expect((await status(accepted.jobId)).body).toMatchObject({ status: 'failed', error: 'lease_expired', quotaRemaining: 8 });
        expect((await result(claimed)).body).toMatchObject({ status: 'failed', idempotent: true });
        expect(await usage()).toBe(0);
        expect(await count('chat_messages')).toBe(1);
    });

    test('a late callback itself expires/refunds the lease before checking its result', async () => {
        const accepted = await enqueue();
        const claimed = await lease();
        clock += 120_000;
        expect((await result(claimed)).body).toMatchObject({ status: 'failed', error: 'lease_expired', idempotent: true });
        expect((await status(accepted.jobId)).body.quotaRemaining).toBe(8);
        expect(await count('chat_messages')).toBe(1);
    });

    test('a delayed claim still receives the full 120-second lease needed by the bounded text runner', async () => {
        await enqueue();
        clock += 179_000;
        const claimed = await lease();
        clock += 90_000;
        expect((await result(claimed)).body.status).toBe('completed');
        expect(await usage()).toBe(1);
    });

    test('submission maintenance refunds the original UTC day once without changing todays usage or SSV bonus', async () => {
        clock = Date.parse('2026-10-21T23:59:30Z');
        await heartbeat();
        const accepted = await enqueue();
        await lease();
        clock += 120_000;
        await pool.query(`INSERT INTO app_bot_quota(app_id,device_id,quota_date,messages_used,bonus_from_ads)
            VALUES('dream-buddy','owner','2026-10-22',3,6)`);
        await heartbeat();
        const current = await enqueue();
        expect(current.quotaRemaining).toBe(10);
        expect((await status(accepted.jobId)).body.status).toBe('failed');
        const rows = (await pool.query(`SELECT quota_date::text,messages_used,bonus_from_ads FROM app_bot_quota
            WHERE device_id='owner' ORDER BY quota_date`)).rows;
        expect(rows).toEqual([{ quota_date: '2026-10-21', messages_used: 0, bonus_from_ads: 0 },
            { quota_date: '2026-10-22', messages_used: 4, bonus_from_ads: 6 }]);
    });

    test('jobs, heartbeats, operation recovery and outstanding leases survive a new factory/pool', async () => {
        const op = crypto.randomUUID();
        const accepted = await enqueue({ operationId: op });
        const claimed = await lease();
        const reopened = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
        try {
            const restarted = makeApp({ getPool: () => reopened });
            expect((await ownerGet(PREFIX + '/connection', 'owner', restarted)).body.workerOnline).toBe(true);
            expect((await operation(op, 'owner', restarted)).body.jobId).toBe(accepted.jobId);
            expect((await next(restarted)).status).toBe(204);
            expect((await result(claimed, {}, restarted)).body.status).toBe('completed');
        } finally { await reopened.end(); }
        expect(await count('chat_messages')).toBe(2);
    });

    test.each(['user insert', 'quota increment'])('submission rollback at %s restores job, quota and history together', async point => {
        const statement = point === 'user insert'
            ? 'ALTER TABLE chat_messages ADD CONSTRAINT test_reject_user CHECK (NOT is_from_user)'
            : 'ALTER TABLE app_bot_quota ADD CONSTRAINT test_reject_usage CHECK (messages_used=0)';
        await pool.query(statement);
        const op = crypto.randomUUID();
        let response;
        try { response = await submit({ operationId: op }); }
        finally { await pool.query(point === 'user insert'
            ? 'ALTER TABLE chat_messages DROP CONSTRAINT test_reject_user'
            : 'ALTER TABLE app_bot_quota DROP CONSTRAINT test_reject_usage'); }
        expect(response.status).toBe(503);
        expect(response.body).toEqual({ success: false, error: 'db_unavailable' });
        expect(await count('dream_buddy_inference_jobs')).toBe(0);
        expect(await count('chat_messages')).toBe(0);
        expect(await count('app_bot_quota')).toBe(0);
        expect((await submit({ operationId: op })).status).toBe(200);
    });

    test.each(['reply insert', 'completion update'])('completion rollback at %s keeps the lease and can accept the same callback later', async point => {
        const accepted = await enqueue();
        const claimed = await lease();
        await pool.query(point === 'reply insert'
            ? 'ALTER TABLE chat_messages ADD CONSTRAINT test_reject_reply CHECK (NOT is_from_bot)'
            : "ALTER TABLE dream_buddy_inference_jobs ADD CONSTRAINT test_reject_completion CHECK (status <> 'completed')");
        let response;
        try { response = await result(claimed); }
        finally { await pool.query(point === 'reply insert'
            ? 'ALTER TABLE chat_messages DROP CONSTRAINT test_reject_reply'
            : 'ALTER TABLE dream_buddy_inference_jobs DROP CONSTRAINT test_reject_completion'); }
        expect(response.body).toEqual({ success: false, error: 'db_unavailable' });
        expect((await status(accepted.jobId)).body.status).toBe('leased');
        expect(await count('chat_messages')).toBe(1);
        expect(await usage()).toBe(1);
        expect((await result(claimed)).body.status).toBe('completed');
        expect(await count('chat_messages')).toBe(2);
    });

    test('refund and terminal update rollback together, then concurrent maintenance settles once', async () => {
        const accepted = await enqueue();
        await pool.query("ALTER TABLE dream_buddy_inference_jobs ADD CONSTRAINT test_reject_failure CHECK (status <> 'failed')");
        clock += 180_000;
        let response;
        try { response = await status(accepted.jobId); }
        finally { await pool.query('ALTER TABLE dream_buddy_inference_jobs DROP CONSTRAINT test_reject_failure'); }
        expect(response.status).toBe(503);
        expect(await usage()).toBe(1);
        expect((await pool.query('SELECT status,refunded_at FROM dream_buddy_inference_jobs')).rows[0])
            .toEqual({ status: 'queued', refunded_at: null });
        const settled = await Promise.all([status(accepted.jobId), next()]);
        expect(settled[0].body.status).toBe('failed');
        expect(await usage()).toBe(0);
    });

    test('a missing original quota row cannot falsely mark a job refunded', async () => {
        const accepted = await enqueue();
        clock += 180_000;
        await pool.query("DELETE FROM app_bot_quota WHERE device_id='owner'");
        expect((await status(accepted.jobId)).body).toEqual({ success: false, error: 'db_unavailable' });
        expect((await pool.query('SELECT status,refunded_at FROM dream_buddy_inference_jobs')).rows[0])
            .toEqual({ status: 'queued', refunded_at: null });
        await pool.query(`INSERT INTO app_bot_quota(app_id,device_id,quota_date,messages_used)
            VALUES('dream-buddy','owner','2026-10-21',1)`);
        expect((await status(accepted.jobId)).body).toMatchObject({ status: 'failed', quotaRemaining: 8 });
    });

    test('uncertain commit acknowledgement stays db_unavailable and owner operation lookup recovers the committed job', async () => {
        let loseAcknowledgement = false;
        // Real PG commit, followed by a synthetic connection-acknowledgement
        // failure. This exercises the ambiguous-POST boundary without mocks.
        const connection = { query: (...args) => pool.query(...args), connect: async () => {
            const client = await pool.connect();
            return { release: () => client.release(), query: async (sql, ...args) => {
                const value = await client.query(sql, ...args);
                if (sql === 'COMMIT' && loseAcknowledgement) {
                    loseAcknowledgement = false;
                    throw new Error('synthetic private connection failure');
                }
                return value;
            } };
        } };
        const server = makeApp({ getPool: () => connection });
        expect((await heartbeat(server)).status).toBe(200);
        loseAcknowledgement = true;
        const op = crypto.randomUUID();
        const response = await submit({ operationId: op }, 'owner', server);
        expect(response.status).toBe(503);
        expect(response.body).toEqual({ success: false, error: 'db_unavailable' });
        const recovered = await operation(op);
        expect(recovered.status).toBe(200);
        expect(recovered.body.status).toBe('queued');
        expect((await submit({ operationId: op })).body.jobId).toBe(recovered.body.jobId);
        expect(await usage()).toBe(1);
        expect(await count('chat_messages')).toBe(1);
    });

    test('initialization failure rolls back DDL and retries the same pool after prerequisites become available', async () => {
        const retrySchema = schema + '_retry';
        await admin.query(`CREATE SCHEMA ${retrySchema}`);
        const retryPool = new Pool({ connectionString: url, options: `-c search_path=${retrySchema}` });
        try {
            const server = makeApp({ getPool: () => Promise.resolve(retryPool) });
            expect((await heartbeat(server)).body).toEqual({ success: false, error: 'db_unavailable' });
            expect((await retryPool.query("SELECT to_regclass('dream_buddy_inference_jobs') AS relation")).rows[0].relation).toBeNull();
            await retryPool.query('CREATE TABLE devices(device_id VARCHAR(64) PRIMARY KEY)');
            const responses = await Promise.all([heartbeat(server), heartbeat(server), heartbeat(server)]);
            expect(responses.every(r => r.status === 200)).toBe(true);
        } finally {
            await retryPool.end();
            await admin.query(`DROP SCHEMA ${retrySchema} CASCADE`);
        }
    });

    test('database/readiness errors are 503 without private errors or false claims that no job was accepted', async () => {
        const accepted = await enqueue();
        ready = false;
        for (const response of [await submit(), await status(accepted.jobId), await heartbeat(), await next(),
            await ownerGet('/debug'), await ownerGet(PREFIX + '/connection')]) {
            expect(response.status).toBe(503);
            expect(response.body).toEqual({ success: false, error: 'db_unavailable' });
        }
        ready = true;
        const missing = makeApp({ getPool: async () => null });
        expect((await heartbeat(missing)).body.error).toBe('db_unavailable');
        const unavailable = makeApp({ getPool: async () => { throw new Error('synthetic-private-db-error'); } });
        expect((await submit({}, 'owner', unavailable)).body).toEqual({ success: false, error: 'db_unavailable' });
        expect(await usage()).toBe(1);
    });

    test('deleting a device cascades queued/leased jobs and stale in-memory owners cannot recreate or complete them', async () => {
        const accepted = await enqueue();
        const claimed = await lease();
        await pool.query("DELETE FROM devices WHERE device_id='owner'");
        expect(await count('dream_buddy_inference_jobs')).toBe(0);
        expect((await status(accepted.jobId)).status).toBe(404);
        expect((await result(claimed)).status).toBe(404);
        expect((await submit()).body.error).toBe('invalid_device');
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM chat_messages WHERE is_from_bot')).rows[0].n).toBe(0);
    });

    test('validates message/operation and worker output boundaries; legacy operations still generate a UUID', async () => {
        for (const body of [{ message: '' }, { message: ' ' }, { message: 4 }, { message: 'x'.repeat(2001) },
            { operationId: null }, { operationId: 'invalid' }]) {
            expect((await submit(body)).status).toBe(400);
        }
        expect((await submit({ appId: 'other-app' })).status).toBe(403);
        expect((await submit({ personaId: 'other-persona' })).status).toBe(403);
        const accepted = await enqueue({ operationId: undefined, message: 'x'.repeat(2000) });
        const claimed = await lease();
        for (const body of [{ reply: '' }, { reply: '  ' }, { reply: 5 }, { reply: 'x'.repeat(2001) },
            { status: 'unknown' }, { leaseToken: '' }, { leaseToken: 5 }]) {
            expect((await result(claimed, body)).status).toBe(400);
        }
        expect((await result({ ...claimed, jobId: 'invalid' })).status).toBe(404);
        expect((await result({ ...claimed, jobId: crypto.randomUUID() })).status).toBe(404);
        expect((await result(claimed, { leaseToken: 'incorrect' })).status).toBe(403);
        expect((await result(claimed, { reply: 'x'.repeat(2000) })).status).toBe(200);
        expect((await status(accepted.jobId)).body.status).toBe('completed');
    });

    test('diagnostics are disabled in production outside the debug environment', async () => {
        const oldNode = process.env.NODE_ENV, oldRailway = process.env.RAILWAY_ENVIRONMENT;
        try {
            process.env.NODE_ENV = 'production'; process.env.RAILWAY_ENVIRONMENT = 'production';
            expect((await ownerGet('/debug')).status).toBe(404);
            process.env.RAILWAY_ENVIRONMENT = 'debug';
            expect((await ownerGet('/debug')).status).toBe(200);
        } finally {
            if (oldNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNode;
            if (oldRailway === undefined) delete process.env.RAILWAY_ENVIRONMENT; else process.env.RAILWAY_ENVIRONMENT = oldRailway;
        }
    });

    test('default environment provider, worker token, clock and readiness support the same contract', async () => {
        const oldProvider = process.env.DREAM_BUDDY_AI_PROVIDER;
        const oldToken = process.env.DREAM_BUDDY_WORKER_TOKEN;
        try {
            process.env.DREAM_BUDDY_AI_PROVIDER = 'local-minimax';
            process.env.DREAM_BUDDY_WORKER_TOKEN = WORKER_TOKEN;
            const server = makeApp({ provider: undefined, workerToken: undefined, now: undefined, isReady: undefined });
            expect((await heartbeat(server)).status).toBe(200);
            expect((await ownerGet(PREFIX + '/connection', 'owner', server)).body.workerOnline).toBe(true);
            expect((await submit({}, 'owner', server)).status).toBe(200);
        } finally {
            if (oldProvider === undefined) delete process.env.DREAM_BUDDY_AI_PROVIDER;
            else process.env.DREAM_BUDDY_AI_PROVIDER = oldProvider;
            if (oldToken === undefined) delete process.env.DREAM_BUDDY_WORKER_TOKEN;
            else process.env.DREAM_BUDDY_WORKER_TOKEN = oldToken;
        }
    });
});
