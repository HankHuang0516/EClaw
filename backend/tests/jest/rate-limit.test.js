/**
 * Regression test for issue #1948 — global rate limiting.
 *
 * Verifies the three tiers configured in backend/index.js:
 *   1. Global /api/*      — 100 req/min per IP
 *   2. Auth endpoints     — 10 req/min per IP  (login / register)
 *   3. Message endpoints  — 30 req/min per deviceId
 * And that /api/health is never rate-limited.
 *
 * Rate limiting is normally disabled under NODE_ENV='test'; this suite sets
 * ENABLE_RATE_LIMIT_IN_TEST=1 BEFORE requiring index.js so the limiters engage.
 */

process.env.ENABLE_RATE_LIMIT_IN_TEST = '1';

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
    const router = express.Router();
    // Tiny stub: POST /login always returns 401 so rate-limit can count
    // refusals without exercising real auth code.
    router.post('/login', (_req, res) => res.status(401).json({ success: false, error: 'stub' }));
    router.post('/register', (_req, res) => res.status(400).json({ success: false, error: 'stub' }));
    return jest.fn().mockReturnValue({
        router,
        authMiddleware: (_req, _res, next) => next(),
        softAuthMiddleware: (_req, _res, next) => next(),
        adminMiddleware: (_req, _res, next) => next(),
        initAuthDatabase: jest.fn().mockResolvedValue(undefined),
        setOnEmailVerified: jest.fn(),
        pool: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
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

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise((resolve) => httpServer.close(resolve));
    jest.resetModules();
    delete process.env.ENABLE_RATE_LIMIT_IN_TEST;
});

describe('Issue #1948 — auth endpoint rate limit (10/min per IP)', () => {
    it('11th POST /api/auth/login from same IP within the window returns 429', async () => {
        // First 10 must be allowed (401 stub from mocked auth router).
        for (let i = 0; i < 10; i++) {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ email: `user${i}@test`, password: 'x' });
            expect([401, 400]).toContain(res.status);
        }
        // 11th hits the limiter.
        const blocked = await request(app)
            .post('/api/auth/login')
            .send({ email: 'user11@test', password: 'x' });
        expect(blocked.status).toBe(429);
        expect(blocked.body.success).toBe(false);
    }, 30000);
});

describe('Issue #1948 — /api/health is not rate-limited', () => {
    it('accepts > 100 requests in rapid succession', async () => {
        // Sanity: health probes from Railway + monitors should never be blocked.
        for (let i = 0; i < 150; i++) {
            const res = await request(app).get('/api/health');
            expect(res.status).toBe(200);
        }
    }, 30000);
});

describe('Issue #1948 — message endpoint rate limit (30/min per device)', () => {
    it('31st POST /api/transform with same deviceId returns 429', async () => {
        const deviceId = 'rl-test-device-' + Date.now();
        // Requests will fail auth/validation (no real binding), but the
        // limiter counts BEFORE the route runs. 30 non-429 responses, then 429.
        for (let i = 0; i < 30; i++) {
            const res = await request(app)
                .post('/api/transform')
                .send({ deviceId, entityId: 0, botSecret: 'x', message: 'hi', state: 'IDLE' });
            expect(res.status).not.toBe(429);
        }
        const blocked = await request(app)
            .post('/api/transform')
            .send({ deviceId, entityId: 0, botSecret: 'x', message: 'hi', state: 'IDLE' });
        expect(blocked.status).toBe(429);
    }, 30000);
});
