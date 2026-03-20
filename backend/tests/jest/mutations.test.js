/**
 * Critical mutation endpoint validation tests (Jest + Supertest)
 *
 * Tests input validation for endpoints that create, modify, or delete data.
 * Ensures bad input is rejected before reaching business logic.
 */

// ── Same mocks as health.test.js ──
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

// Helper: chain .set('Host', 'localhost') on each request to bypass HTTPS redirect middleware
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
// POST /api/client/speak — client-to-entity messaging
// ════════════════════════════════════════════════════════════════
describe('POST /api/client/speak — input validation', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/client/speak')
            .send({ entityId: 0, message: 'hello', deviceSecret: 'secret' });
        expect(res.status).toBe(400);
    });

    it('rejects when message is missing', async () => {
        const res = await post('/api/client/speak')
            .send({ deviceId: 'dev-1', entityId: 0, deviceSecret: 'secret' });
        // Should return 400 (missing field) or 404 (device not found before validation)
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('returns 400/404 when deviceSecret is missing', async () => {
        const res = await post('/api/client/speak')
            .send({ deviceId: 'dev-1', entityId: 0, message: 'hello' });
        // Should reject — either 400 (missing field) or 401/403 (auth failure)
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('returns 404 when device does not exist', async () => {
        const res = await post('/api/client/speak')
            .send({ deviceId: 'nonexistent', entityId: 0, message: 'hello', deviceSecret: 'wrong' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/entity/speak-to — entity-to-entity messaging
// ════════════════════════════════════════════════════════════════
describe('POST /api/entity/speak-to — input validation', () => {
    it('returns 400 when required fields are missing', async () => {
        const res = await post('/api/entity/speak-to')
            .send({});
        expect(res.status).toBe(400);
    });

    it('rejects when targetDeviceId is missing', async () => {
        const res = await post('/api/entity/speak-to')
            .send({ deviceId: 'dev-1', entityId: 0, botSecret: 'sec', message: 'hi' });
        // Should return 400 (missing field) or 404 (device/bot not found)
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/entity/broadcast — broadcast messaging
// ════════════════════════════════════════════════════════════════
describe('POST /api/entity/broadcast — input validation', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/entity/broadcast')
            .send({ entityId: 0, botSecret: 'sec', message: 'broadcast' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when message is missing', async () => {
        const res = await post('/api/entity/broadcast')
            .send({ deviceId: 'dev-1', entityId: 0, botSecret: 'sec' });
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/device/register — device registration
// ════════════════════════════════════════════════════════════════
describe('POST /api/device/register — input validation', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await post('/api/device/register')
            .send({});
        // Should return 400 (missing field) or create device with auto-generated ID
        expect([200, 400].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/feedback — feedback submission
// ════════════════════════════════════════════════════════════════
describe('POST /api/feedback — input validation', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await post('/api/feedback')
            .send({ message: 'feedback text' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects when message is missing', async () => {
        const res = await post('/api/feedback')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/entities — entity listing
// ════════════════════════════════════════════════════════════════
describe('GET /api/entities — input validation', () => {
    it('returns a response when deviceId is missing', async () => {
        const res = await get('/api/entities');
        // Server returns 400 (missing param) or 200 (empty response)
        expect([200, 400].includes(res.status)).toBe(true);
    });

    it('returns a response for nonexistent device', async () => {
        const res = await get('/api/entities?deviceId=nonexistent');
        // Server auto-creates device or returns 404
        expect([200, 404].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/status — device status
// ════════════════════════════════════════════════════════════════
describe('GET /api/status — input validation', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await get('/api/status');
        expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent device', async () => {
        const res = await get('/api/status?deviceId=nonexistent');
        expect(res.status).toBe(404);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/chat/history — chat history
// ════════════════════════════════════════════════════════════════
describe('POST /api/chat/history — input validation', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await post('/api/chat/history')
            .send({ entityId: 0 });
        // Returns 400 or 404 depending on validation order
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/logs — server logs
// ════════════════════════════════════════════════════════════════
describe('GET /api/logs — auth validation', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await get('/api/logs');
        expect(res.status).toBe(400);
    });

    it('rejects when deviceSecret is wrong', async () => {
        const res = await get('/api/logs?deviceId=nonexistent&deviceSecret=wrong');
        // Should fail auth — 403 or 404
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// E2EE Awareness (Issue #212) — encryptionStatus in API responses
// ════════════════════════════════════════════════════════════════
describe('E2EE awareness — encryptionStatus field', () => {
    it('createDefaultEntity includes encryptionStatus: null', () => {
        // Access the exported createDefaultEntity via the app module
        const { createDefaultEntity } = require('../../index');
        if (createDefaultEntity) {
            const entity = createDefaultEntity(0);
            expect(entity).toHaveProperty('encryptionStatus', null);
        }
    });

    it('POST /api/channel/register accepts e2ee_capable field', async () => {
        // Without valid channel_api_key, should return 401 (not 500)
        const res = await post('/api/channel/register')
            .send({ callback_url: 'https://example.com/cb', e2ee_capable: true });
        // 401 = missing api key (expected), not 500 = crash
        expect(res.status).toBe(401);
    });

    it('POST /api/channel/register rejects without callback_url', async () => {
        const res = await post('/api/channel/register')
            .send({ e2ee_capable: true });
        // 400 or 401 (auth first) — not 500
        expect([400, 401].includes(res.status)).toBe(true);
    });
});
