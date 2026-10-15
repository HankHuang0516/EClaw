'use strict';
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const createRouter = require('../../app-bot-ads');
const url = process.env.DREAM_BUDDY_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('Dream Buddy real PostgreSQL reward transactions', () => {
    let pool;
    let app;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const devices = { owner: { deviceSecret: 'owner-test-secret' }, other: { deviceSecret: 'other-test-secret' } };
    const signed = (session, transaction, unit = '6438262242', timestamp = Date.now()) => {
        const content = 'ad_unit=' + unit + '&custom_data=' + session +
            '&reward_amount=6&reward_item=messages&timestamp=' + timestamp + '&transaction_id=' + transaction;
        return content + '&signature=' + crypto.sign('sha256', Buffer.from(content), privateKey).toString('base64url') + '&key_id=1';
    };
    const callback = (session, transaction, unit, timestamp) => request(app).get('/ads/ssv?' + signed(session, transaction, unit, timestamp));
    const deviceRequest = (method, path, owner = 'owner') => request(app)[method](path)
        .set('X-Device-Secret', devices[owner].deviceSecret);
    const session = async (platform = 'ios') => {
        const response = await deviceRequest('post', '/ads/sessions?deviceId=owner').send({ platform });
        expect(response.status).toBe(200);
        return response.body.sessionId;
    };
    const bonus = async () => {
        const rows = (await pool.query("SELECT bonus_from_ads FROM app_bot_quota WHERE app_id='dream-buddy' AND device_id='owner'")).rows;
        return rows.reduce((total, row) => total + row.bonus_from_ads, 0);
    };
    beforeAll(async () => {
        const parsed = new URL(url);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
            !parsed.pathname.startsWith('/dream_buddy_ads_test')) {
            throw new Error('Only an isolated local Dream Buddy test database is permitted');
        }
        pool = new Pool({ connectionString: url, max: 12 });
        await pool.query('CREATE TABLE app_bot_quota (' +
            'app_id TEXT NOT NULL,device_id TEXT NOT NULL,quota_date DATE NOT NULL,' +
            'messages_used INTEGER NOT NULL DEFAULT 0,bonus_from_ads INTEGER NOT NULL DEFAULT 0,' +
            'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(app_id,device_id,quota_date))');
        await pool.query('CREATE TABLE chat_messages (id UUID PRIMARY KEY,device_id TEXT NOT NULL,entity_id INTEGER NOT NULL,is_from_bot BOOLEAN NOT NULL)');
        app = express();
        app.use(express.json());
        const router = createRouter({ getDevices: () => devices, getPool: () => pool,
            loadKeys: async () => new Map([['1', publicKey]]) });
        app.use('/ads', router); app.use('/debug', router.diagnostics);
        expect((await deviceRequest('get', '/ads/quota?deviceId=owner')).status).toBe(200);
    });
    beforeEach(async () => {
        await pool.query('TRUNCATE dream_buddy_content_reports,chat_messages,dream_buddy_ad_transactions,dream_buddy_ad_sessions,app_bot_quota');
    });
    afterAll(async () => { if (pool) await pool.end(); });

    test('content reports accept only the owners AI replies and repeated reports are idempotent', async () => {
        const ownerBot = crypto.randomUUID(), otherBot = crypto.randomUUID(), ownerUser = crypto.randomUUID();
        await pool.query('INSERT INTO chat_messages VALUES ($1,$4,0,TRUE),($2,$5,0,TRUE),($3,$4,0,FALSE)',
            [ownerBot, otherBot, ownerUser, 'owner', 'other']);
        const report = id => deviceRequest('post', '/ads/reports?deviceId=owner').send({ messageId: id, reason: 'offensive' });
        expect((await report(otherBot)).status).toBe(404);
        expect((await report(ownerUser)).status).toBe(404);
        expect((await report(crypto.randomUUID())).status).toBe(404);
        const first = await report(ownerBot), repeated = await report(ownerBot);
        expect(first.status).toBe(200);
        expect(repeated.body.reportId).toBe(first.body.reportId);
        expect(Object.keys(first.body).sort()).toEqual(['reportId', 'success']);
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM dream_buddy_content_reports')).rows[0].n).toBe(1);
        const diagnostics = await deviceRequest('get', '/debug?deviceId=owner');
        expect(diagnostics.body.reports).toHaveLength(1);
        expect(diagnostics.body.reports[0].message_id).toBe(ownerBot);
        expect((await deviceRequest('get', '/debug?deviceId=other', 'other')).body.reports).toEqual([]);
    });
    test('credits six messages and owner sees redeemed session and quota', async () => {
        const id = await session();
        const response = await callback(id, 'credit-once');
        expect(response.status).toBe(200);
        expect(response.body.credited).toBe(true);
        expect(await bonus()).toBe(6);
        const status = await deviceRequest('get', '/ads/sessions/' + id + '?deviceId=owner');
        expect(status.body.status).toBe('rewarded');
        const quota = await deviceRequest('get', '/ads/quota?deviceId=owner');
        expect(quota.body.remaining).toBe(14);
    });
    test('concurrent duplicate callbacks credit a session exactly once', async () => {
        const id = await session();
        const results = await Promise.all(Array.from({ length: 8 }, () => callback(id, 'concurrent-one')));
        expect(results.every((result) => result.status === 200)).toBe(true);
        expect(results.filter((result) => result.body.credited).length).toBe(1);
        expect(await bonus()).toBe(6);
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM dream_buddy_ad_transactions')).rows[0].n).toBe(1);
    });
    test('same transaction replayed against different sessions cannot double credit', async () => {
        const first = await session();
        const second = await session();
        const results = await Promise.all([callback(first, 'shared-transaction'), callback(second, 'shared-transaction')]);
        expect(results.every((result) => result.status === 200)).toBe(true);
        expect(results.filter((result) => result.body.credited).length).toBe(1);
        expect(await bonus()).toBe(6);
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM dream_buddy_ad_sessions WHERE redeemed')).rows[0].n).toBe(1);
    });
    test('database failure rolls back transaction and redemption; retry can succeed', async () => {
        const id = await session();
        await pool.query('ALTER TABLE app_bot_quota ADD CONSTRAINT test_reject_bonus CHECK (bonus_from_ads < 6)');
        let response;
        try { response = await callback(id, 'retry-after-rollback'); }
        finally { await pool.query('ALTER TABLE app_bot_quota DROP CONSTRAINT test_reject_bonus'); }
        expect(response.status).toBe(503);
        expect(await bonus()).toBe(0);
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM dream_buddy_ad_transactions')).rows[0].n).toBe(0);
        expect((await pool.query('SELECT redeemed FROM dream_buddy_ad_sessions WHERE session_id=$1', [id])).rows[0].redeemed).toBe(false);
        expect((await callback(id, 'retry-after-rollback')).body.credited).toBe(true);
        expect(await bonus()).toBe(6);
    });
    test('a signed callback for the other platform never credits', async () => {
        const id = await session('android');
        expect((await callback(id, 'platform-mismatch', '6438262242')).status).toBe(400);
        expect(await bonus()).toBe(0);
        expect((await deviceRequest('get', '/ads/sessions/' + id + '?deviceId=owner')).body.status).toBe('pending');
    });
    test('session status is owner-only and an unknown challenge cannot credit', async () => {
        const id = await session();
        expect((await deviceRequest('get', '/ads/sessions/' + id + '?deviceId=other', 'other')).status).toBe(404);
        expect((await request(app).get('/ads/sessions/' + id + '?deviceId=owner').set('X-Device-Secret', 'wrong')).status).toBe(403);
        const response = await callback('Z'.repeat(32), 'unknown-session');
        expect(response.status).toBe(200);
        expect(response.body.credited).toBe(false);
        expect(await bonus()).toBe(0);
    });
    test('a view timestamp outside the session window cannot redeem', async () => {
        const id = await session();
        const response = await callback(id, 'view-outside-window', '6438262242', Date.now() + 3 * 60 * 60 * 1000);
        expect(response.status).toBe(400);
        expect(await bonus()).toBe(0);
    });
});
