/**
 * Tests for the async app-bot gateway (option B — card_6d0f2746 / card_12e6d33b).
 *
 * The message is answered by an external EClaw inference ENTITY, not a server
 * LLM call. This suite verifies the job/callback/result contract:
 *   POST /api/app-bot/chat          — bound-device auth, quota gate, dispatch,
 *                                      returns { jobId, status:'pending' }
 *   POST /api/app-bot/chat/callback — inference-entity auth, completes job +
 *                                      burns quota exactly once (idempotent)
 *   GET  /api/app-bot/chat/result   — bound-device auth, own-job read
 *
 * The inference-entity config is frozen from env at require time, so the env
 * vars are set BEFORE requiring ../../index. db job/quota helpers are mocked and
 * the dispatch (module.exports._dispatchAppBotJob) is spied so no real delivery
 * fires and we can assert the side effects.
 */

// Inference entity config — must be set before requiring index/app-bots-config.
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

// ── Mock db: the app-bot quota + job helpers matter for these tests ──
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
    // App-Bot quota helpers (controlled per-test)
    getAppBotQuota: jest.fn().mockResolvedValue(null),
    incrementAppBotQuotaUsage: jest.fn().mockResolvedValue(true),
    addAppBotAdBonus: jest.fn().mockResolvedValue(true),
    // App-Bot async job helpers (controlled per-test)
    createAppBotJob: jest.fn().mockResolvedValue(true),
    getAppBotJob: jest.fn().mockResolvedValue(null),
    completeAppBotJob: jest.fn().mockResolvedValue(null),
    sweepTimedOutAppBotJobs: jest.fn().mockResolvedValue(0),
    pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

const request = require('supertest');
const app = require('../../index');
const db = require('../../db');

const DEVICE_ID = 'app-device-1';
const DEVICE_SECRET = 'app-device-secret-1';

// Seed a bound requesting device so safeEqual(deviceSecret) passes.
beforeAll(() => {
    app.devices[DEVICE_ID] = {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entities: {},
    };
});

describe('POST /api/app-bot/chat (async dispatch)', () => {
    let dispatchSpy;
    beforeEach(() => {
        jest.clearAllMocks();
        db.getAppBotQuota.mockResolvedValue(null);
        db.createAppBotJob.mockResolvedValue(true);
        db.incrementAppBotQuotaUsage.mockResolvedValue(true);
        // Spy the dispatch so no real delivery fires; resolves successfully by default.
        dispatchSpy = jest.spyOn(app, '_dispatchAppBotJob').mockResolvedValue({ pushed: true });
    });
    afterEach(() => {
        dispatchSpy.mockRestore();
    });

    const validBody = (over = {}) => ({
        appId: 'nighthollow',
        personaId: 'default',
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        message: '今天好累',
        ...over,
    });

    it('missing fields → 400 (no dispatch, no job)', async () => {
        const res = await request(app).post('/api/app-bot/chat')
            .send({ personaId: 'default', deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, message: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(dispatchSpy).not.toHaveBeenCalled();
        expect(db.createAppBotJob).not.toHaveBeenCalled();
    });

    it('message too long (>2000) → 400', async () => {
        const res = await request(app).post('/api/app-bot/chat')
            .send(validBody({ message: 'x'.repeat(2001) }));
        expect(res.status).toBe(400);
        expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it('bad deviceSecret → 403 invalid_device', async () => {
        const res = await request(app).post('/api/app-bot/chat')
            .send(validBody({ deviceSecret: 'wrong-secret' }));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('invalid_device');
        expect(dispatchSpy).not.toHaveBeenCalled();
        expect(db.createAppBotJob).not.toHaveBeenCalled();
    });

    it('unknown app/persona → 403 (does not disclose which)', async () => {
        const res = await request(app).post('/api/app-bot/chat')
            .send(validBody({ appId: 'no-such-app' }));
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('unknown_app_or_persona');
        expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it('inference not configured → 503', async () => {
        // isInferenceConfigured() reads APP_BOT_INFERENCE.publicCode live at call
        // time, and index.js holds the SAME object reference — so clearing it here
        // flips the gate (the destructured isInferenceConfigured binding still
        // reads the shared mutable config object).
        const cfg = require('../../app-bots-config');
        const savedCode = cfg.APP_BOT_INFERENCE.publicCode;
        cfg.APP_BOT_INFERENCE.publicCode = null;
        try {
            const res = await request(app).post('/api/app-bot/chat').send(validBody());
            expect(res.status).toBe(503);
            expect(res.body.error).toBe('inference_unavailable');
            expect(dispatchSpy).not.toHaveBeenCalled();
            expect(db.createAppBotJob).not.toHaveBeenCalled();
        } finally {
            cfg.APP_BOT_INFERENCE.publicCode = savedCode;
        }
    });

    it('quota exhausted → 429 needAd, dispatch NOT called, job NOT created', async () => {
        // nighthollow dailyQuota is 8; simulate all 8 used, no ad bonus.
        db.getAppBotQuota.mockResolvedValue({ messages_used: 8, bonus_from_ads: 0 });
        const res = await request(app).post('/api/app-bot/chat').send(validBody());
        expect(res.status).toBe(429);
        expect(res.body.needAd).toBe(true);
        expect(res.body.quotaRemaining).toBe(0);
        expect(dispatchSpy).not.toHaveBeenCalled();
        expect(db.createAppBotJob).not.toHaveBeenCalled();
        expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
    });

    it('valid → 200 with jobId, job created, dispatch called once, quota NOT incremented', async () => {
        const res = await request(app).post('/api/app-bot/chat').send(validBody());
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(typeof res.body.jobId).toBe('string');
        expect(res.body.status).toBe('pending');
        expect(db.createAppBotJob).toHaveBeenCalledTimes(1);
        expect(dispatchSpy).toHaveBeenCalledTimes(1);
        // Persona prompt never leaks back to the app.
        expect(JSON.stringify(res.body)).not.toContain('深夜樹洞');
        // Quota is burned on callback, not here.
        expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
    });

    it('dispatch throws → 503 dispatch_failed, job marked failed', async () => {
        dispatchSpy.mockRejectedValue(new Error('inference_entity_not_bound'));
        const res = await request(app).post('/api/app-bot/chat').send(validBody());
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('dispatch_failed');
        expect(db.createAppBotJob).toHaveBeenCalledTimes(1);
        // completeAppBotJob(jobId, null) marks it terminal.
        expect(db.completeAppBotJob).toHaveBeenCalledTimes(1);
        expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
    });
});

describe('POST /api/app-bot/chat/callback', () => {
    const JOB_ID = '11111111-1111-1111-1111-111111111111';
    const goodAuth = {
        deviceId: 'inf-device',
        entityId: 2,
        botSecret: 'inf-bot-secret',
    };

    beforeEach(() => {
        jest.clearAllMocks();
        db.getAppBotJob.mockResolvedValue({
            job_id: JOB_ID, app_id: 'nighthollow', persona_id: 'default',
            device_id: DEVICE_ID, message: '今天好累', reply: null,
            status: 'pending', deadline_ms: Date.now() + 45000,
        });
        // completeAppBotJob transitions on the FIRST call, returns null after.
        db.completeAppBotJob.mockResolvedValueOnce({
            job_id: JOB_ID, app_id: 'nighthollow', device_id: DEVICE_ID,
            status: 'completed', reply: '嗨,我在聽。',
        }).mockResolvedValue(null);
        db.incrementAppBotQuotaUsage.mockResolvedValue(true);
    });

    it('wrong secret → 403 not_inference_entity', async () => {
        const res = await request(app).post('/api/app-bot/chat/callback')
            .send({ ...goodAuth, botSecret: 'nope', jobId: JOB_ID, reply: 'hi' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('not_inference_entity');
        expect(db.completeAppBotJob).not.toHaveBeenCalled();
        expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
    });

    it('wrong entityId → 403 not_inference_entity', async () => {
        const res = await request(app).post('/api/app-bot/chat/callback')
            .send({ ...goodAuth, entityId: 3, jobId: JOB_ID, reply: 'hi' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('not_inference_entity');
    });

    it('valid → completes job + increments quota exactly once', async () => {
        const res = await request(app).post('/api/app-bot/chat/callback')
            .send({ ...goodAuth, jobId: JOB_ID, reply: '嗨,我在聽。' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(db.completeAppBotJob).toHaveBeenCalledTimes(1);
        expect(db.completeAppBotJob).toHaveBeenCalledWith(JOB_ID, '嗨,我在聽。');
        expect(db.incrementAppBotQuotaUsage).toHaveBeenCalledTimes(1);
        expect(db.incrementAppBotQuotaUsage).toHaveBeenCalledWith('nighthollow', DEVICE_ID, expect.any(String), 1);
    });

    it('second callback for same job → idempotent (no double increment)', async () => {
        // First callback: job pending → completes + burns quota.
        await request(app).post('/api/app-bot/chat/callback')
            .send({ ...goodAuth, jobId: JOB_ID, reply: '嗨,我在聽。' });
        // Second callback: getAppBotJob now returns a non-pending (already completed) row.
        db.getAppBotJob.mockResolvedValue({
            job_id: JOB_ID, app_id: 'nighthollow', device_id: DEVICE_ID,
            status: 'completed', reply: '嗨,我在聽。', deadline_ms: Date.now() + 45000,
        });
        const res2 = await request(app).post('/api/app-bot/chat/callback')
            .send({ ...goodAuth, jobId: JOB_ID, reply: '嗨,我在聽。' });
        expect(res2.status).toBe(200);
        expect(res2.body.alreadyResolved).toBe(true);
        // Quota incremented exactly once across both callbacks.
        expect(db.incrementAppBotQuotaUsage).toHaveBeenCalledTimes(1);
    });

    it('unknown jobId → 404', async () => {
        db.getAppBotJob.mockResolvedValue(null);
        const res = await request(app).post('/api/app-bot/chat/callback')
            .send({ ...goodAuth, jobId: JOB_ID, reply: 'hi' });
        expect(res.status).toBe(404);
        expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
    });
});

describe('GET /api/app-bot/chat/result', () => {
    const JOB_ID = '22222222-2222-2222-2222-222222222222';

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('wrong device → 403 invalid_device', async () => {
        db.getAppBotJob.mockResolvedValue({
            job_id: JOB_ID, device_id: DEVICE_ID, status: 'pending', reply: null,
        });
        const res = await request(app).get('/api/app-bot/chat/result')
            .query({ jobId: JOB_ID, deviceId: DEVICE_ID, deviceSecret: 'wrong' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('invalid_device');
    });

    it("another device's job → 403 not_your_job", async () => {
        db.getAppBotJob.mockResolvedValue({
            job_id: JOB_ID, device_id: 'someone-else', status: 'completed', reply: 'secret',
        });
        const res = await request(app).get('/api/app-bot/chat/result')
            .query({ jobId: JOB_ID, deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('not_your_job');
    });

    it('pending → status pending (no reply)', async () => {
        db.getAppBotJob.mockResolvedValue({
            job_id: JOB_ID, device_id: DEVICE_ID, status: 'pending', reply: null,
        });
        const res = await request(app).get('/api/app-bot/chat/result')
            .query({ jobId: JOB_ID, deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending');
        expect(res.body.reply).toBeUndefined();
    });

    it('after callback → completed with the reply', async () => {
        db.getAppBotJob.mockResolvedValue({
            job_id: JOB_ID, device_id: DEVICE_ID, status: 'completed', reply: '嗨,我在聽。',
        });
        const res = await request(app).get('/api/app-bot/chat/result')
            .query({ jobId: JOB_ID, deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('completed');
        expect(res.body.reply).toBe('嗨,我在聽。');
    });

    it('unknown jobId → 404', async () => {
        db.getAppBotJob.mockResolvedValue(null);
        const res = await request(app).get('/api/app-bot/chat/result')
            .query({ jobId: JOB_ID, deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(404);
    });
});
