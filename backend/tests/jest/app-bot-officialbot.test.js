/**
 * Tests for POST /api/app-bot/chat — the bound-free-MiniMax-bot relay model
 * (owner-chosen + prod-validated, card_6d0f2746 / card_12e6d33b).
 *
 * There is NO async job/callback and NO server-side LLM call. Each install
 * binds a free official bot to its OWN device (slot 1); the gateway builds a
 * server-side persona pre-prompt and RELAYS the user's message to that slot-1
 * bot by reusing the internal client-speak delivery. The bot replies `toUser`
 * and the app reads it via GET /api/client/pending.
 *
 * db quota helpers are mocked and the internal dispatch
 * (app._dispatchAppBotMessage) is spied so no real delivery fires and we can
 * assert whether it was called and with what relayed text. `devices` is mocked
 * per-test to set up a bound slot-1 bot.
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

const DEVICE_ID = 'app-device-1';
const DEVICE_SECRET = 'app-device-secret-1';
// nighthollow persona systemPrompt fragment (server-side config).
const PERSONA_FRAGMENT = '深夜樹洞';

// Seed a bound requesting device WITH a bound slot-1 free bot.
function seedBoundDevice() {
    app.devices[DEVICE_ID] = {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entities: {
            1: {
                entityId: 1,
                isBound: true,
                botSecret: 'slot1-bot-secret',
                webhook: { type: 'openclaw', url: 'https://bot.example/hook' },
            },
        },
    };
}

describe('POST /api/app-bot/chat (bound free-bot relay)', () => {
    let dispatchSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        seedBoundDevice();
        db.getAppBotQuota.mockResolvedValue(null);
        db.incrementAppBotQuotaUsage.mockResolvedValue(true);
        // Spy the internal relay so no real delivery fires; resolves OK by default.
        dispatchSpy = jest.spyOn(app, '_dispatchAppBotMessage').mockResolvedValue({ pushed: true });
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

    it('missing fields → 400 (no dispatch, no quota burn)', async () => {
        const res = await request(app).post('/api/app-bot/chat')
            .send({ personaId: 'default', deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, message: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(dispatchSpy).not.toHaveBeenCalled();
        expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
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
        expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
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

    it('device with NO bound slot-1 bot → 409 bot_not_bound', async () => {
        // Unbind the slot-1 bot for this device.
        app.devices[DEVICE_ID].entities = {};
        const res = await request(app).post('/api/app-bot/chat').send(validBody());
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('bot_not_bound');
        expect(res.body.hint).toEqual(expect.any(String));
        expect(dispatchSpy).not.toHaveBeenCalled();
        expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
    });

    it('slot-1 bot bound but no webhook → 409 bot_not_bound', async () => {
        app.devices[DEVICE_ID].entities[1].webhook = null;
        const res = await request(app).post('/api/app-bot/chat').send(validBody());
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('bot_not_bound');
        expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it('quota exhausted → 429 needAd, dispatch NOT called, quota NOT incremented', async () => {
        // nighthollow dailyQuota is 8; simulate all 8 used, no ad bonus.
        db.getAppBotQuota.mockResolvedValue({ messages_used: 8, bonus_from_ads: 0 });
        const res = await request(app).post('/api/app-bot/chat').send(validBody({ message: '再聊一句' }));
        expect(res.status).toBe(429);
        expect(res.body.error).toBe('daily_quota_exceeded');
        expect(res.body.needAd).toBe(true);
        expect(res.body.quotaRemaining).toBe(0);
        // Cost guard: no relay, no quota mutation.
        expect(dispatchSpy).not.toHaveBeenCalled();
        expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
    });

    it('valid → 200, relays persona pre-prompt + user msg once, burns quota once', async () => {
        const res = await request(app).post('/api/app-bot/chat').send(validBody());
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(typeof res.body.quotaRemaining).toBe('number');
        // nighthollow quota 8, none used → 8-1 = 7 remaining after burn.
        expect(res.body.quotaRemaining).toBe(7);
        expect(res.body.poll).toBe('/api/client/pending');

        // Dispatch called exactly once, with the persona pre-prompt wrapping the
        // user's message.
        expect(dispatchSpy).toHaveBeenCalledTimes(1);
        const arg = dispatchSpy.mock.calls[0][0];
        expect(arg.deviceId).toBe(DEVICE_ID);
        expect(arg.prePrompt).toContain(PERSONA_FRAGMENT); // persona systemPrompt
        expect(arg.prePrompt).toContain('今天好累');        // user message
        // relayed to the slot-1 bound bot
        expect(arg.bot).toBe(app.devices[DEVICE_ID].entities[1]);

        // Quota burned exactly once, after a successful dispatch.
        expect(db.incrementAppBotQuotaUsage).toHaveBeenCalledTimes(1);
        expect(db.incrementAppBotQuotaUsage).toHaveBeenCalledWith('nighthollow', DEVICE_ID, expect.any(String), 1);

        // Persona system prompt must NEVER leak back to the client.
        expect(JSON.stringify(res.body)).not.toContain(PERSONA_FRAGMENT);
    });

    it('Dream Buddy → injects its persona into the existing slot-0 bot', async () => {
        app.devices[DEVICE_ID].entities[0] = {
            entityId: 0,
            isBound: true,
            botSecret: 'slot0-bot-secret',
            webhook: { type: 'openclaw', url: 'https://bot.example/hook' },
        };

        const res = await request(app).post('/api/app-bot/chat').send(validBody({
            appId: 'dream-buddy',
            personaId: 'dream-buddy',
            message: '我夢見一隻會飛的鯨魚',
        }));

        expect(res.status).toBe(200);
        expect(dispatchSpy).toHaveBeenCalledTimes(1);
        const arg = dispatchSpy.mock.calls[0][0];
        expect(arg.entityId).toBe(0);
        expect(arg.bot).toBe(app.devices[DEVICE_ID].entities[0]);
        expect(arg.prePrompt).toContain('夢話夥伴');
        expect(arg.prePrompt).toContain('半夢半醒');
        expect(arg.prePrompt).toContain('我夢見一隻會飛的鯨魚');
        expect(JSON.stringify(res.body)).not.toContain('半夢半醒');
    });

    it('dispatch throws → 503 dispatch_failed, quota NOT incremented', async () => {
        dispatchSpy.mockRejectedValue(new Error('push failed'));
        const res = await request(app).post('/api/app-bot/chat').send(validBody());
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('dispatch_failed');
        expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
    });
});
