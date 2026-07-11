/**
 * Tests for POST /api/app-bot/chat (情緒價值 App pipeline — card I2).
 *
 * Verifies the server-side app-bot gateway:
 *  - input validation (missing appId → 400, over-long message → 400)
 *  - unknown app/persona → 403
 *  - happy path → 200 with reply + numeric quotaRemaining, quota incremented once
 *  - quota exhausted → 429 with needAd, AND the LLM is NOT called (cost guard)
 *
 * anthropic-client.callAnthropic and the two db quota helpers are mocked so we
 * control the response + quota state per-test and assert the side effects.
 */

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

// ── Mock the Anthropic client so no real network / API key is used ──
jest.mock('../../anthropic-client', () => ({
    callAnthropic: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: '嗨,我在聽。' }],
    }),
}));

// ── Mock db: only the app-bot quota helpers matter for these tests ──
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
    pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

const request = require('supertest');
const app = require('../../index');
const db = require('../../db');
const { callAnthropic } = require('../../anthropic-client');

describe('POST /api/app-bot/chat', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: no prior usage today (getAppBotQuota returns null → treated as fresh)
        db.getAppBotQuota.mockResolvedValue(null);
        db.incrementAppBotQuotaUsage.mockResolvedValue(true);
        callAnthropic.mockResolvedValue({ content: [{ type: 'text', text: '嗨,我在聽。' }] });
    });

    it('missing appId → 400', async () => {
        const res = await request(app)
            .post('/api/app-bot/chat')
            .send({ personaId: 'default', deviceId: 'dev-1', message: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(callAnthropic).not.toHaveBeenCalled();
    });

    it('message too long (>2000) → 400', async () => {
        const res = await request(app)
            .post('/api/app-bot/chat')
            .send({ appId: 'nighthollow', personaId: 'default', deviceId: 'dev-1', message: 'x'.repeat(2001) });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(callAnthropic).not.toHaveBeenCalled();
    });

    it('unknown app/persona → 403 (does not disclose which)', async () => {
        const res = await request(app)
            .post('/api/app-bot/chat')
            .send({ appId: 'no-such-app', personaId: 'default', deviceId: 'dev-1', message: 'hi' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('unknown_app_or_persona');
        expect(callAnthropic).not.toHaveBeenCalled();

        // Also an unknown persona on a valid app → same 403.
        const res2 = await request(app)
            .post('/api/app-bot/chat')
            .send({ appId: 'nighthollow', personaId: 'no-such-persona', deviceId: 'dev-1', message: 'hi' });
        expect(res2.status).toBe(403);
        expect(res2.body.error).toBe('unknown_app_or_persona');
    });

    it('valid request → 200 with reply, numeric quotaRemaining, quota incremented once', async () => {
        const res = await request(app)
            .post('/api/app-bot/chat')
            .send({ appId: 'nighthollow', personaId: 'default', deviceId: 'dev-1', message: '今天好累' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.reply).toBe('嗨,我在聽。');
        expect(typeof res.body.quotaRemaining).toBe('number');
        expect(callAnthropic).toHaveBeenCalledTimes(1);
        // System prompt (persona) is passed server-side, never exposed in body.
        expect(JSON.stringify(res.body)).not.toContain('深夜樹洞');
        expect(db.incrementAppBotQuotaUsage).toHaveBeenCalledTimes(1);
    });

    it('quota exhausted → 429 needAd, LLM NOT called, quota NOT incremented', async () => {
        // nighthollow dailyQuota is 8; simulate all 8 already used, no ad bonus.
        db.getAppBotQuota.mockResolvedValue({ messages_used: 8, bonus_from_ads: 0 });

        const res = await request(app)
            .post('/api/app-bot/chat')
            .send({ appId: 'nighthollow', personaId: 'default', deviceId: 'dev-1', message: '再聊一句' });

        expect(res.status).toBe(429);
        expect(res.body.needAd).toBe(true);
        expect(res.body.quotaRemaining).toBe(0);
        // The most important invariants: no LLM spend, no quota mutation on reject.
        expect(callAnthropic).not.toHaveBeenCalled();
        expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
    });
});
