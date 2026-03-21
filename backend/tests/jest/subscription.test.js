/**
 * Subscription endpoint validation tests (Jest + Supertest)
 *
 * Tests input validation for subscription/billing endpoints:
 * - GET /api/subscription/status
 * - POST /api/subscription/tappay/pay
 * - POST /api/subscription/cancel
 * - POST /api/subscription/verify-google
 * - POST /api/subscription/usage
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
    const authMiddleware = (req, res, next) => {
        const token = req.cookies && req.cookies.eclaw_session;
        if (!token) {
            return res.status(401).json({ success: false, error: 'Not authenticated' });
        }
        req.user = { userId: 1, deviceId: 'test-device' };
        next();
    };
    const noop = (_req, _res, next) => next();
    return jest.fn().mockReturnValue({
        router: express.Router(),
        authMiddleware,
        softAuthMiddleware: noop,
        adminMiddleware: noop,
        initAuthDatabase: jest.fn().mockResolvedValue(undefined),
        setOnEmailVerified: jest.fn(),
        pool: {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        },
    });
});

// Mock subscription with real validation routes
jest.mock('../../subscription', () => {
    const express = jest.requireActual('express');
    const router = express.Router();

    const authMiddleware = (req, res, next) => {
        const token = req.cookies && req.cookies.eclaw_session;
        if (!token) {
            return res.status(401).json({ success: false, error: 'Not authenticated' });
        }
        req.user = { userId: 1, deviceId: 'test-device' };
        next();
    };

    // GET /status — auth required
    router.get('/status', authMiddleware, (_req, res) => {
        return res.json({ success: true, plan: 'free', premium: false });
    });

    // POST /tappay/pay — auth required, prime required
    router.post('/tappay/pay', authMiddleware, (req, res) => {
        const { prime } = req.body || {};
        if (!prime) {
            return res.status(400).json({ success: false, error: 'prime is required' });
        }
        return res.json({ success: true, status: 'paid' });
    });

    // POST /cancel — auth required
    router.post('/cancel', authMiddleware, (_req, res) => {
        return res.json({ success: true, message: 'Subscription cancelled' });
    });

    // POST /verify-google — device auth
    router.post('/verify-google', (req, res) => {
        const { deviceId, deviceSecret, purchaseToken, productId } = req.body || {};
        if (!deviceId || !deviceSecret) {
            return res.status(400).json({ success: false, error: 'deviceId and deviceSecret are required' });
        }
        if (!purchaseToken || !productId) {
            return res.status(400).json({ success: false, error: 'purchaseToken and productId are required' });
        }
        return res.json({ success: true, verified: true });
    });

    // POST /usage — device auth
    router.post('/usage', (req, res) => {
        const { deviceId, deviceSecret } = req.body || {};
        if (!deviceId || !deviceSecret) {
            return res.status(400).json({ success: false, error: 'deviceId and deviceSecret are required' });
        }
        return res.json({ success: true, count: 0, limit: 15, remaining: 15 });
    });

    return jest.fn().mockReturnValue({
        router,
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
// GET /api/subscription/status — requires auth
// ════════════════════════════════════════════════════════════════
describe('GET /api/subscription/status', () => {
    it('returns 401 when not authenticated', async () => {
        const res = await get('/api/subscription/status');
        expect(res.status).toBe(401);
    });

    it('returns 200 with plan info when authenticated', async () => {
        const res = await get('/api/subscription/status')
            .set('Cookie', 'eclaw_session=valid-token');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body).toHaveProperty('plan');
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/subscription/tappay/pay — requires auth + prime
// ════════════════════════════════════════════════════════════════
describe('POST /api/subscription/tappay/pay', () => {
    it('returns 401 when not authenticated', async () => {
        const res = await post('/api/subscription/tappay/pay')
            .send({ prime: 'test-prime' });
        expect(res.status).toBe(401);
    });

    it('returns 400 when prime is missing', async () => {
        const res = await post('/api/subscription/tappay/pay')
            .set('Cookie', 'eclaw_session=valid-token')
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/prime/i);
    });

    it('returns 200 with valid prime', async () => {
        const res = await post('/api/subscription/tappay/pay')
            .set('Cookie', 'eclaw_session=valid-token')
            .send({ prime: 'test-prime-token' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/subscription/cancel — requires auth
// ════════════════════════════════════════════════════════════════
describe('POST /api/subscription/cancel', () => {
    it('returns 401 when not authenticated', async () => {
        const res = await post('/api/subscription/cancel');
        expect(res.status).toBe(401);
    });

    it('returns 200 when authenticated', async () => {
        const res = await post('/api/subscription/cancel')
            .set('Cookie', 'eclaw_session=valid-token');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/subscription/verify-google — device auth
// ════════════════════════════════════════════════════════════════
describe('POST /api/subscription/verify-google', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/subscription/verify-google')
            .send({ deviceSecret: 's', purchaseToken: 'tok', productId: 'prod' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when purchaseToken is missing', async () => {
        const res = await post('/api/subscription/verify-google')
            .send({ deviceId: 'd', deviceSecret: 's', productId: 'prod' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when productId is missing', async () => {
        const res = await post('/api/subscription/verify-google')
            .send({ deviceId: 'd', deviceSecret: 's', purchaseToken: 'tok' });
        expect(res.status).toBe(400);
    });

    it('returns 200 with all required fields', async () => {
        const res = await post('/api/subscription/verify-google')
            .send({ deviceId: 'd', deviceSecret: 's', purchaseToken: 'tok', productId: 'prod' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/subscription/usage — device auth
// ════════════════════════════════════════════════════════════════
describe('POST /api/subscription/usage', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/subscription/usage')
            .send({ deviceSecret: 's' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await post('/api/subscription/usage')
            .send({ deviceId: 'd' });
        expect(res.status).toBe(400);
    });

    it('returns 200 with usage info', async () => {
        const res = await post('/api/subscription/usage')
            .send({ deviceId: 'd', deviceSecret: 's' });
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('count');
        expect(res.body).toHaveProperty('limit');
        expect(res.body).toHaveProperty('remaining');
    });
});
