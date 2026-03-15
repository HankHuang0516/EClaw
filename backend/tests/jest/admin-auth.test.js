/**
 * Admin endpoint authorization tests (Jest + Supertest)
 *
 * Verifies that admin-only endpoints reject unauthenticated requests.
 * This is a P1 security test — admin endpoints must not leak data to unauthorized users.
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
    initDatabase: jest.fn().mockResolvedValue(false),
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
    // Auth middleware that rejects (no cookie → 401)
    const authMiddleware = (req, res, next) => {
        const token = req.cookies && req.cookies.eclaw_session;
        if (!token) {
            return res.status(401).json({ success: false, error: 'Not authenticated' });
        }
        // Minimal decode: just check for admin flag
        req.user = { userId: 1 };
        next();
    };
    // Admin middleware that rejects non-admin users
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
const del = (path) => request(app).delete(path).set('Host', 'localhost');

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// Admin endpoints must reject unauthenticated requests
// ════════════════════════════════════════════════════════════════
describe('Admin endpoints — unauthenticated access blocked', () => {

    it('GET /api/admin/stats rejects without auth', async () => {
        const res = await get('/api/admin/stats');
        expect(res.status).toBe(401);
    });

    it('GET /api/admin/bindings rejects without auth', async () => {
        const res = await get('/api/admin/bindings');
        expect(res.status).toBe(401);
    });

    it('GET /api/admin/users rejects without auth', async () => {
        const res = await get('/api/admin/users');
        expect(res.status).toBe(401);
    });

    it('GET /api/admin/bots rejects without auth', async () => {
        const res = await get('/api/admin/bots');
        expect(res.status).toBe(401);
    });

    it('POST /api/admin/gatekeeper/reset rejects without auth', async () => {
        const res = await post('/api/admin/gatekeeper/reset')
            .send({ deviceId: 'test' });
        expect(res.status).toBe(401);
    });

    it('POST /api/admin/push-update rejects without auth', async () => {
        const res = await post('/api/admin/push-update')
            .send({ title: 'test', message: 'test' });
        expect(res.status).toBe(401);
    });

    it('POST /api/admin/bots/create rejects without auth', async () => {
        const res = await post('/api/admin/bots/create')
            .send({ botName: 'test' });
        expect(res.status).toBe(401);
    });

    it('DELETE /api/admin/official-bot/test rejects without auth', async () => {
        const res = await del('/api/admin/official-bot/test');
        expect(res.status).toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════
// Admin endpoints must reject non-admin authenticated users
// ════════════════════════════════════════════════════════════════
describe('Admin endpoints — non-admin access blocked', () => {
    // Set a fake session cookie (not admin)
    const cookie = 'eclaw_session=fake-non-admin-token';

    it('GET /api/admin/stats rejects non-admin', async () => {
        const res = await get('/api/admin/stats').set('Cookie', cookie);
        expect(res.status).toBe(403);
    });

    it('GET /api/admin/bindings rejects non-admin', async () => {
        const res = await get('/api/admin/bindings').set('Cookie', cookie);
        expect(res.status).toBe(403);
    });

    it('GET /api/admin/users rejects non-admin', async () => {
        const res = await get('/api/admin/users').set('Cookie', cookie);
        expect(res.status).toBe(403);
    });

    it('POST /api/admin/gatekeeper/reset rejects non-admin', async () => {
        const res = await post('/api/admin/gatekeeper/reset')
            .set('Cookie', cookie)
            .send({ deviceId: 'test' });
        expect(res.status).toBe(403);
    });

    it('POST /api/admin/bots/create rejects non-admin', async () => {
        const res = await post('/api/admin/bots/create')
            .set('Cookie', cookie)
            .send({ botName: 'test' });
        expect(res.status).toBe(403);
    });

    it('DELETE /api/admin/official-bot/test rejects non-admin', async () => {
        const res = await del('/api/admin/official-bot/test')
            .set('Cookie', cookie);
        expect(res.status).toBe(403);
    });
});

// ════════════════════════════════════════════════════════════════
// Audit logs — auth required
// ════════════════════════════════════════════════════════════════
describe('GET /api/audit-logs — auth required', () => {
    it('rejects without auth cookie', async () => {
        const res = await get('/api/audit-logs');
        expect(res.status).toBe(401);
    });

    it('rejects non-admin', async () => {
        const res = await get('/api/audit-logs')
            .set('Cookie', 'eclaw_session=fake-non-admin-token');
        expect(res.status).toBe(403);
    });
});
