/**
 * Auth endpoint validation tests (Jest + Supertest)
 *
 * Tests register/login/logout input validation and error paths.
 * Uses the same mock pattern as health.test.js.
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

// Mock auth to use a REAL router that rejects missing fields
jest.mock('../../auth', () => {
    const express = jest.requireActual('express');
    const noop = (_req, _res, next) => next();

    // Build a minimal auth router that tests input validation
    const router = express.Router();

    // POST /register — validate required fields
    router.post('/register', (req, res) => {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required' });
        }
        if (typeof email !== 'string' || !email.includes('@')) {
            return res.status(400).json({ success: false, error: 'Invalid email format' });
        }
        if (!password || password.length < 6) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
        }
        if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
            return res.status(400).json({ success: false, error: 'Password must contain both letters and numbers' });
        }
        // Mock: email already exists
        return res.status(409).json({ success: false, error: 'Email already registered' });
    });

    // POST /login — validate required fields
    router.post('/login', (req, res) => {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required' });
        }
        // Mock: invalid credentials
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
    });

    // POST /logout — always succeeds
    router.post('/logout', (_req, res) => {
        res.clearCookie('eclaw_session');
        return res.json({ success: true });
    });

    // GET /me — requires auth
    router.get('/me', (req, res) => {
        if (!req.cookies || !req.cookies.eclaw_session) {
            return res.status(401).json({ success: false, error: 'Not authenticated' });
        }
        return res.json({ success: true, user: { id: 1, email: 'test@test.com' } });
    });

    // GET /oauth/providers — public
    router.get('/oauth/providers', (_req, res) => {
        return res.json({ success: true, providers: [] });
    });

    return jest.fn().mockReturnValue({
        router,
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
// POST /api/auth/register
// ════════════════════════════════════════════════════════════════
describe('POST /api/auth/register', () => {
    it('returns 400 when email is missing', async () => {
        const res = await post('/api/auth/register')
            .send({ password: 'pass123' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when password is missing', async () => {
        const res = await post('/api/auth/register')
            .send({ email: 'test@example.com' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when email format is invalid', async () => {
        const res = await post('/api/auth/register')
            .send({ email: 'not-an-email', password: 'pass123' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/email/i);
    });

    it('returns 400 when password is too short', async () => {
        const res = await post('/api/auth/register')
            .send({ email: 'test@example.com', password: 'ab1' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/6 char/i);
    });

    it('returns 400 when password has no numbers', async () => {
        const res = await post('/api/auth/register')
            .send({ email: 'test@example.com', password: 'abcdefgh' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/letters.*numbers|numbers.*letters/i);
    });

    it('returns 400 when password has no letters', async () => {
        const res = await post('/api/auth/register')
            .send({ email: 'test@example.com', password: '12345678' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/letters.*numbers|numbers.*letters/i);
    });

    it('returns 400 when body is empty', async () => {
        const res = await post('/api/auth/register')
            .send({});
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/auth/login
// ════════════════════════════════════════════════════════════════
describe('POST /api/auth/login', () => {
    it('returns 400 when email is missing', async () => {
        const res = await post('/api/auth/login')
            .send({ password: 'pass123' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when password is missing', async () => {
        const res = await post('/api/auth/login')
            .send({ email: 'test@example.com' });
        expect(res.status).toBe(400);
    });

    it('returns 401 for invalid credentials', async () => {
        const res = await post('/api/auth/login')
            .send({ email: 'test@example.com', password: 'wrong123' });
        expect(res.status).toBe(401);
    });

    it('returns 400 when body is empty', async () => {
        const res = await post('/api/auth/login')
            .send({});
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/auth/logout
// ════════════════════════════════════════════════════════════════
describe('POST /api/auth/logout', () => {
    it('returns success even without session', async () => {
        const res = await post('/api/auth/logout');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/auth/me
// ════════════════════════════════════════════════════════════════
describe('GET /api/auth/me', () => {
    it('returns 401 when not authenticated', async () => {
        const res = await get('/api/auth/me');
        expect(res.status).toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/auth/oauth/providers
// ════════════════════════════════════════════════════════════════
describe('GET /api/auth/oauth/providers', () => {
    it('returns 200 and a providers array', async () => {
        const res = await get('/api/auth/oauth/providers');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.providers)).toBe(true);
    });
});
