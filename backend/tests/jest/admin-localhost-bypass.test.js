/**
 * Regression test for issue #2024:
 *   verifyAdmin() previously returned true unconditionally when req.ip was
 *   loopback (127.0.0.1 / ::1). Behind a trusted proxy (Railway/Cloudflare),
 *   internal request paths or misconfigured trust proxy could make req.ip
 *   appear loopback and bypass admin auth for endpoints like
 *   POST /api/admin/official-bot/register and GET /api/admin/official-bots.
 *
 * Fix: localhost bypass is now gated on NODE_ENV !== 'production' &&
 * !RAILWAY_ENVIRONMENT. Production always requires ADMIN_SECRET.
 */

// Simulate production before requiring the app.
process.env.RAILWAY_ENVIRONMENT = 'production';
delete process.env.ADMIN_SECRET;

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
    const authMiddleware = (req, res, next) => {
        const token = req.cookies && req.cookies.eclaw_session;
        if (!token) return res.status(401).json({ success: false, error: 'Not authenticated' });
        req.user = { userId: 1 };
        next();
    };
    const adminMiddleware = (req, res, next) => {
        if (!req.user || !req.user.isAdmin) {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        next();
    };
    return jest.fn().mockReturnValue({
        router: express.Router(),
        authMiddleware,
        softAuthMiddleware: (_req, _res, next) => next(),
        adminMiddleware,
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
    delete process.env.RAILWAY_ENVIRONMENT;
});

describe('Issue #2024 — verifyAdmin() production localhost bypass is disabled', () => {
    it('POST /api/admin/official-bot/register rejects loopback without token', async () => {
        // supertest binds to 127.0.0.1, so req.ip is ::ffff:127.0.0.1 / ::1.
        // With RAILWAY_ENVIRONMENT set (prod), the bypass MUST NOT fire.
        const res = await request(app)
            .post('/api/admin/official-bot/register')
            .send({ botId: 'evil', botType: 'free', webhookUrl: 'https://x.test', token: 't' });
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
    });

    it('GET /api/admin/official-bots rejects loopback without token', async () => {
        const res = await request(app).get('/api/admin/official-bots');
        expect(res.status).toBe(403);
    });

    it('POST /api/admin/official-bot/register accepts valid ADMIN_SECRET even in prod', async () => {
        process.env.ADMIN_SECRET = 'test-admin-secret';
        const res = await request(app)
            .post('/api/admin/official-bot/register')
            .set('x-admin-token', 'test-admin-secret')
            .send({ botId: 'ok-bot', botType: 'free', webhookUrl: 'https://x.test', token: 't' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        delete process.env.ADMIN_SECRET;
    });

    it('POST /api/admin/official-bot/register rejects wrong ADMIN_SECRET in prod', async () => {
        process.env.ADMIN_SECRET = 'correct-secret';
        const res = await request(app)
            .post('/api/admin/official-bot/register')
            .set('x-admin-token', 'wrong-secret')
            .send({ botId: 'bad', botType: 'free', webhookUrl: 'https://x.test', token: 't' });
        expect(res.status).toBe(403);
        delete process.env.ADMIN_SECRET;
    });
});
