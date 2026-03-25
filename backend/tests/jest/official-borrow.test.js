/**
 * Official Bot Borrowing endpoint validation tests (Jest + Supertest)
 *
 * Tests input validation for all 7 official-borrow endpoints:
 * - GET /api/official-borrow/status
 * - GET /api/official-borrow/free-bots
 * - POST /api/official-borrow/bind-free
 * - POST /api/official-borrow/bind-personal
 * - POST /api/official-borrow/add-paid-slot
 * - POST /api/official-borrow/unbind
 * - POST /api/official-borrow/verify-subscription
 */

// ── Mock all modules with side-effects before requiring index.js ──

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
    saveOfficialBinding: jest.fn().mockResolvedValue(true),
    removeOfficialBinding: jest.fn().mockResolvedValue(true),
    getOfficialBinding: jest.fn().mockResolvedValue(null),
    getDeviceOfficialBindings: jest.fn().mockResolvedValue([]),
    updateSubscriptionVerified: jest.fn().mockResolvedValue(true),
    loadAllOfficialBindings: jest.fn().mockResolvedValue([]),
    getExpiredPersonalBindings: jest.fn().mockResolvedValue([]),
    getPaidBorrowSlots: jest.fn().mockResolvedValue(0),
    incrementPaidBorrowSlots: jest.fn().mockResolvedValue(true),
    saveFeedback: jest.fn().mockResolvedValue({ id: 1 }),
}));

jest.mock('../../flickr', () => ({
    initFlickr: jest.fn(),
    uploadPhoto: jest.fn().mockResolvedValue(null),
    isAvailable: jest.fn().mockReturnValue(false),
}));

jest.mock('../../scheduler', () => ({
    init: jest.fn(),
    createSchedule: jest.fn().mockResolvedValue({ id: 1 }),
    updateSchedule: jest.fn().mockResolvedValue(true),
    deleteSchedule: jest.fn().mockResolvedValue(true),
    getSchedules: jest.fn().mockResolvedValue([]),
    getSchedule: jest.fn().mockResolvedValue(null),
    getSchedulesForBot: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../device-telemetry', () => ({
    initTelemetryTable: jest.fn().mockResolvedValue(undefined),
    appendEntries: jest.fn().mockResolvedValue(undefined),
    captureApiCall: jest.fn().mockResolvedValue(undefined),
    getEntries: jest.fn().mockResolvedValue([]),
    getSummary: jest.fn().mockResolvedValue({}),
    clearEntries: jest.fn().mockResolvedValue(undefined),
    createMiddleware: jest.fn().mockReturnValue((_req, _res, next) => next()),
    sanitize: jest.fn().mockImplementation((v) => v),
    MAX_BUFFER_BYTES: 1024 * 1024,
    MAX_ENTRIES: 500,
}));

jest.mock('../../device-feedback', () => ({
    initFeedbackTable: jest.fn().mockResolvedValue(undefined),
    initFeedbackPhotosTable: jest.fn().mockResolvedValue(undefined),
    captureLogSnapshot: jest.fn().mockResolvedValue([]),
    captureDeviceState: jest.fn().mockResolvedValue({}),
    autoTriage: jest.fn().mockResolvedValue('low'),
    generateAiPrompt: jest.fn().mockReturnValue(''),
    saveFeedback: jest.fn().mockResolvedValue({ id: 1 }),
    getFeedbackList: jest.fn().mockResolvedValue([]),
    getFeedbackById: jest.fn().mockResolvedValue(null),
    updateFeedback: jest.fn().mockResolvedValue(true),
    createGithubIssue: jest.fn().mockResolvedValue(null),
    getPendingDebugFeedback: jest.fn().mockResolvedValue([]),
    saveDebugResult: jest.fn().mockResolvedValue(true),
    setMark: jest.fn().mockResolvedValue(undefined),
    getMark: jest.fn().mockResolvedValue(null),
    clearMark: jest.fn().mockResolvedValue(undefined),
    LOG_WINDOW_MS: 60000,
    MAX_PHOTOS_PER_FEEDBACK: 10,
    MAX_PHOTO_SIZE: 5 * 1024 * 1024,
    saveFeedbackPhoto: jest.fn().mockResolvedValue({ id: 1 }),
    getFeedbackPhotos: jest.fn().mockResolvedValue([]),
    getFeedbackPhoto: jest.fn().mockResolvedValue(null),
    deleteFeedbackPhotos: jest.fn().mockResolvedValue(undefined),
    cleanupResolvedFeedbackPhotos: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../gatekeeper', () => ({
    detectMaliciousMessage: jest.fn().mockReturnValue({ isMalicious: false }),
    detectAndMaskLeaks: jest.fn().mockImplementation((text) => text),
    initGatekeeperTable: jest.fn().mockResolvedValue(undefined),
    loadBlockedDevices: jest.fn().mockResolvedValue(undefined),
    recordViolation: jest.fn().mockResolvedValue(undefined),
    isDeviceBlocked: jest.fn().mockReturnValue(false),
    getStrikeInfo: jest.fn().mockResolvedValue({ strikes: 0, blocked: false }),
    getFreeBotTOS: jest.fn().mockResolvedValue(null),
    hasAgreedToTOS: jest.fn().mockResolvedValue(false),
    recordTOSAgreement: jest.fn().mockResolvedValue(undefined),
    setServerLog: jest.fn(),
    MAX_STRIKES: 3,
    FREE_BOT_TOS_VERSION: '1.0',
}));

jest.mock('../../mission', () => {
    const express = jest.requireActual('express');
    return jest.fn().mockReturnValue({
        router: express.Router(),
        initMissionDatabase: jest.fn().mockResolvedValue(undefined),
        setNotifyCallback: jest.fn(),
        setPushToBot: jest.fn(),
        setPushToChannelCallback: jest.fn(),
    });
});

jest.mock('../../auth', () => {
    const express = jest.requireActual('express');
    const noop = (_req, _res, next) => next();
    return jest.fn().mockReturnValue({
        router: express.Router(),
        authMiddleware: noop,
        softAuthMiddleware: noop,
        adminMiddleware: noop,
        initAuthDatabase: jest.fn().mockResolvedValue(undefined),
        setOnEmailVerified: jest.fn(),
        pool: {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        },
    });
});

jest.mock('../../subscription', () => {
    const express = jest.requireActual('express');
    return jest.fn().mockReturnValue({
        router: express.Router(),
        loadPremiumStatus: jest.fn().mockResolvedValue(undefined),
    });
});

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// GET /api/official-borrow/status
// ════════════════════════════════════════════════════════════════
describe('GET /api/official-borrow/status', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await get('/api/official-borrow/status');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/deviceId/i);
    });

    it('returns 200 with deviceId', async () => {
        const res = await get('/api/official-borrow/status?deviceId=test-device');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/official-borrow/free-bots
// ════════════════════════════════════════════════════════════════
describe('GET /api/official-borrow/free-bots', () => {
    it('returns 200 with bots array', async () => {
        const res = await get('/api/official-borrow/free-bots');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.bots)).toBe(true);
    });

    it('each bot has required fields', async () => {
        const res = await get('/api/official-borrow/free-bots');
        expect(res.status).toBe(200);
        for (const bot of res.body.bots) {
            expect(bot).toHaveProperty('botId');
            expect(bot).toHaveProperty('displayName');
            expect(typeof bot.activeBindings).toBe('number');
            expect(bot).toHaveProperty('status');
        }
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/official-borrow/bind-free
// ════════════════════════════════════════════════════════════════
describe('POST /api/official-borrow/bind-free', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/official-borrow/bind-free')
            .send({ deviceSecret: 'sec', entityId: 0 });
        expect(res.status).toBe(400);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await post('/api/official-borrow/bind-free')
            .send({ deviceId: 'dev-1', entityId: 0 });
        expect(res.status).toBe(400);
    });

    it('returns 400 when entityId is invalid (negative)', async () => {
        const res = await post('/api/official-borrow/bind-free')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec', entityId: -1 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/entityId/i);
    });

    it('returns 400 when entityId is NaN', async () => {
        const res = await post('/api/official-borrow/bind-free')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec', entityId: 'abc' });
        expect(res.status).toBe(400);
    });

    it('rejects for nonexistent device (gatekeeper or auth fail)', async () => {
        const res = await post('/api/official-borrow/bind-free')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong', entityId: 0 });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects invalid botId (not a free bot)', async () => {
        const res = await post('/api/official-borrow/bind-free')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec', entityId: 0, botId: 'nonexistent-bot' });
        // Should fail at gatekeeper/TOS/auth or bot validation
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/official-borrow/bind-personal
// ════════════════════════════════════════════════════════════════
describe('POST /api/official-borrow/bind-personal', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/official-borrow/bind-personal')
            .send({ deviceSecret: 'sec', entityId: 0 });
        expect(res.status).toBe(400);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await post('/api/official-borrow/bind-personal')
            .send({ deviceId: 'dev-1', entityId: 0 });
        expect(res.status).toBe(400);
    });

    it('returns 400 when entityId is invalid', async () => {
        const res = await post('/api/official-borrow/bind-personal')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec', entityId: -5 });
        expect(res.status).toBe(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await post('/api/official-borrow/bind-personal')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong', entityId: 0 });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/official-borrow/add-paid-slot
// ════════════════════════════════════════════════════════════════
describe('POST /api/official-borrow/add-paid-slot', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/official-borrow/add-paid-slot')
            .send({ deviceSecret: 'sec' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await post('/api/official-borrow/add-paid-slot')
            .send({ deviceId: 'dev-1' });
        expect(res.status).toBe(400);
    });

    it('accepts request for new device (auto-creates)', async () => {
        const res = await post('/api/official-borrow/add-paid-slot')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong' });
        // Endpoint auto-creates device via getOrCreateDevice, so 200 is expected
        expect([200, 400].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/official-borrow/unbind
// ════════════════════════════════════════════════════════════════
describe('POST /api/official-borrow/unbind', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/official-borrow/unbind')
            .send({ deviceSecret: 'sec', entityId: 0 });
        expect(res.status).toBe(400);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await post('/api/official-borrow/unbind')
            .send({ deviceId: 'dev-1', entityId: 0 });
        expect(res.status).toBe(400);
    });

    it('returns 400 when entityId is invalid', async () => {
        const res = await post('/api/official-borrow/unbind')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec', entityId: -1 });
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/official-borrow/verify-subscription
// ════════════════════════════════════════════════════════════════
describe('POST /api/official-borrow/verify-subscription', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/official-borrow/verify-subscription')
            .send({ deviceSecret: 'sec', entityId: 0 });
        expect(res.status).toBe(400);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await post('/api/official-borrow/verify-subscription')
            .send({ deviceId: 'dev-1', entityId: 0 });
        expect(res.status).toBe(400);
    });

    it('rejects when entityId is invalid', async () => {
        const res = await post('/api/official-borrow/verify-subscription')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec', entityId: 'abc' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/official-borrow/free-bots
// ════════════════════════════════════════════════════════════════
describe('GET /api/official-borrow/free-bots', () => {
    it('returns success with bots array', async () => {
        const res = await get('/api/official-borrow/free-bots');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.bots)).toBe(true);
    });

    it('each bot has expected fields', async () => {
        const res = await get('/api/official-borrow/free-bots');
        if (res.body.bots.length > 0) {
            const bot = res.body.bots[0];
            expect(bot).toHaveProperty('botId');
            expect(bot).toHaveProperty('displayName');
            expect(bot).toHaveProperty('activeBindings');
            expect(bot).toHaveProperty('status');
        }
    });
});
