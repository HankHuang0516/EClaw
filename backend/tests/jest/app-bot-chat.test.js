/**
 * Tests for POST /api/app-bot/chat — the async gateway contract (option B,
 * card_6d0f2746 / card_12e6d33b). The old synchronous callAnthropic behavior
 * was replaced: replies now come from an external EClaw inference entity, so
 * a valid request creates a job + dispatches (no server LLM call, no reply in
 * the response body). This file keeps the core validation + quota-guard
 * coverage; the full callback/result flow lives in app-bot-async.test.js.
 *
 * The inference config is frozen from env at require time → set before require.
 * db quota + job helpers are mocked; the dispatch is spied so nothing real fires.
 */

process.env.APP_BOT_INFERENCE_DEVICE_ID = 'inf-device';
process.env.APP_BOT_INFERENCE_ENTITY_ID = '2';
process.env.APP_BOT_INFERENCE_BOT_SECRET = 'inf-bot-secret';
process.env.APP_BOT_INFERENCE_PUBLIC_CODE = 'infpub';

// ── Standard pg mock (matches other Jest tests) ──
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

jest.mock('../../flickr', () => ({
    router: require('express').Router(),
    uploadToFlickr: jest.fn(),
}));

// ── Mock db: app-bot quota + job helpers ──
jest.mock('../../db', () => ({
    initDatabase: jest.fn().mockResolvedValue(true),
    saveDeviceData: jest.fn().mockResolvedValue(true),
    saveAllDevices: jest.fn().mockResolvedValue(true),
    loadAllDevices: jest.fn().mockResolvedValue({}),
    deleteDevice: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({}),
    closeDatabase: jest.fn().mockResolvedValue(undefined),
    saveOfficialBot: jest.fn().mockResolvedValue(true),
    loadOfficialBots: jest.fn().mockResolvedValue({}),
    deleteOfficialBot: jest.fn().mockResolvedValue(true),
    loadSubscriptions: jest.fn().mockResolvedValue({}),
    saveSubscription: jest.fn().mockResolvedValue(true),
    getAppBotQuota: jest.fn().mockResolvedValue(null),
    incrementAppBotQuotaUsage: jest.fn().mockResolvedValue(true),
    addAppBotAdBonus: jest.fn().mockResolvedValue(true),
    createAppBotJob: jest.fn().mockResolvedValue(true),
    getAppBotJob: jest.fn().mockResolvedValue(null),
    completeAppBotJob: jest.fn().mockResolvedValue(null),
    sweepTimedOutAppBotJobs: jest.fn().mockResolvedValue(0),
    pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

const request = require('supertest');
const app = require('../../index');
const db = require('../../db');

const DEVICE_ID = 'chat-device-1';
const DEVICE_SECRET = 'chat-device-secret-1';

beforeAll(() => {
    app.devices[DEVICE_ID] = {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entities: {},
    };
});

describe('POST /api/app-bot/chat', () => {
    let dispatchSpy;
    beforeEach(() => {
        jest.clearAllMocks();
        db.getAppBotQuota.mockResolvedValue(null);
        db.createAppBotJob.mockResolvedValue(true);
        db.incrementAppBotQuotaUsage.mockResolvedValue(true);
        dispatchSpy = jest.spyOn(app, '_dispatchAppBotJob').mockResolvedValue({ pushed: true });
    });
    afterEach(() => {
        dispatchSpy.mockRestore();
    });

    const validBody = (over = {}) => ({
        appId: 'nighthollow', personaId: 'default',
        deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, message: '今天好累',
        ...over,
    });

    it('missing appId → 400 (no dispatch)', async () => {
        const res = await request(app).post('/api/app-bot/chat')
            .send({ personaId: 'default', deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, message: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it('message too long (>2000) → 400', async () => {
        const res = await request(app).post('/api/app-bot/chat')
            .send(validBody({ message: 'x'.repeat(2001) }));
        expect(res.status).toBe(400);
        expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it('unknown app/persona → 403 (does not disclose which)', async () => {
        const res = await request(app).post('/api/app-bot/chat')
            .send(validBody({ appId: 'no-such-app' }));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('unknown_app_or_persona');
        expect(dispatchSpy).not.toHaveBeenCalled();

        const res2 = await request(app).post('/api/app-bot/chat')
            .send(validBody({ personaId: 'no-such-persona' }));
        expect(res2.status).toBe(403);
        expect(res2.body.error).toBe('unknown_app_or_persona');
    });

    it('valid request → 200 with jobId + pending, job created, dispatch once, quota NOT incremented', async () => {
        const res = await request(app).post('/api/app-bot/chat').send(validBody());
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(typeof res.body.jobId).toBe('string');
        expect(res.body.status).toBe('pending');
        expect(db.createAppBotJob).toHaveBeenCalledTimes(1);
        expect(dispatchSpy).toHaveBeenCalledTimes(1);
        // Persona (system prompt) is dispatched server-side, never in the body.
        expect(JSON.stringify(res.body)).not.toContain('深夜樹洞');
        // Quota is burned on the callback, not on dispatch.
        expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
    });

    it('quota exhausted → 429 needAd, dispatch NOT called, quota NOT incremented', async () => {
        // nighthollow dailyQuota is 8; simulate all 8 already used, no ad bonus.
        db.getAppBotQuota.mockResolvedValue({ messages_used: 8, bonus_from_ads: 0 });
        const res = await request(app).post('/api/app-bot/chat').send(validBody({ message: '再聊一句' }));
        expect(res.status).toBe(429);
        expect(res.body.needAd).toBe(true);
        expect(res.body.quotaRemaining).toBe(0);
        // The core invariants carried over from the old sync contract: no spend,
        // no quota mutation, and now also no job created on reject.
        expect(dispatchSpy).not.toHaveBeenCalled();
        expect(db.createAppBotJob).not.toHaveBeenCalled();
        expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
    });
});
