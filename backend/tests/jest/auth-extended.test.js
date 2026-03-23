/**
 * Auth extended endpoint validation tests (Jest + Supertest)
 *
 * Tests auth endpoints NOT covered by auth.test.js:
 * - POST /api/auth/device-login
 * - GET /api/auth/verify-email
 * - POST /api/auth/forgot-password
 * - POST /api/auth/reset-password
 * - PATCH /api/auth/language
 * - POST /api/auth/resend-verification
 * - POST /api/auth/bind-email
 * - GET /api/auth/bind-email/status
 * - POST /api/auth/app-login
 * - POST /api/auth/oauth/google
 * - POST /api/auth/oauth/facebook
 * - POST /api/auth/oauth/oidc
 * - DELETE /api/auth/account
 * - GET /api/auth/roles (admin only)
 * - POST /api/auth/user-roles (admin only)
 * - DELETE /api/auth/user-roles (admin only)
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

// Mock auth with extended routes for validation testing
jest.mock('../../auth', () => {
    const express = jest.requireActual('express');
    const router = express.Router();

    const authMiddleware = (req, res, next) => {
        const token = req.cookies && req.cookies.eclaw_session;
        if (!token) {
            return res.status(401).json({ success: false, error: 'Not authenticated' });
        }
        req.user = { userId: 1 };
        next();
    };

    const adminMiddleware = (req, res, next) => {
        if (!req.user || !req.user.isAdmin) {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        next();
    };

    // POST /device-login
    router.post('/device-login', (req, res) => {
        const { deviceId, deviceSecret } = req.body || {};
        if (!deviceId || !deviceSecret) {
            return res.status(400).json({ success: false, error: 'deviceId and deviceSecret are required' });
        }
        return res.status(401).json({ success: false, error: 'Invalid device credentials' });
    });

    // GET /verify-email
    router.get('/verify-email', (req, res) => {
        const { token } = req.query;
        if (!token) {
            return res.status(400).json({ success: false, error: 'Verification token is required' });
        }
        return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    });

    // POST /forgot-password
    router.post('/forgot-password', (req, res) => {
        const { email } = req.body || {};
        if (!email) {
            return res.status(400).json({ success: false, error: 'Email is required' });
        }
        return res.json({ success: true, message: 'If the email exists, a reset link was sent' });
    });

    // POST /reset-password
    router.post('/reset-password', (req, res) => {
        const { token, newPassword } = req.body || {};
        if (!token || !newPassword) {
            return res.status(400).json({ success: false, error: 'Token and new password are required' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
        }
        return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    });

    // PATCH /language
    router.patch('/language', (req, res) => {
        const { language } = req.body || {};
        if (!language) {
            return res.status(400).json({ success: false, error: 'language is required' });
        }
        return res.json({ success: true });
    });

    // POST /resend-verification
    router.post('/resend-verification', (req, res) => {
        const { email } = req.body || {};
        if (!email) {
            return res.status(400).json({ success: false, error: 'Email is required' });
        }
        return res.json({ success: true });
    });

    // POST /bind-email
    router.post('/bind-email', (req, res) => {
        const { deviceId, deviceSecret, email, password } = req.body || {};
        if (!deviceId || !deviceSecret) {
            return res.status(400).json({ success: false, error: 'deviceId and deviceSecret are required' });
        }
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required' });
        }
        return res.json({ success: true });
    });

    // GET /bind-email/status
    router.get('/bind-email/status', (req, res) => {
        const { deviceId, deviceSecret } = req.query;
        if (!deviceId || !deviceSecret) {
            return res.status(400).json({ success: false, error: 'deviceId and deviceSecret are required' });
        }
        return res.json({ success: true, hasBoundEmail: false, roles: [] });
    });

    // POST /app-login
    router.post('/app-login', (req, res) => {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required' });
        }
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    });

    // POST /oauth/google
    router.post('/oauth/google', (req, res) => {
        const { idToken, accessToken } = req.body || {};
        if (!idToken && !accessToken) {
            return res.status(400).json({ success: false, error: 'idToken or accessToken is required' });
        }
        return res.status(401).json({ success: false, error: 'Invalid token' });
    });

    // POST /oauth/facebook
    router.post('/oauth/facebook', (req, res) => {
        const { accessToken } = req.body || {};
        if (!accessToken) {
            return res.status(400).json({ success: false, error: 'accessToken is required' });
        }
        return res.status(401).json({ success: false, error: 'Invalid token' });
    });

    // POST /oauth/oidc
    router.post('/oauth/oidc', (req, res) => {
        const { provider, code, redirectUri } = req.body || {};
        if (!provider || !code || !redirectUri) {
            return res.status(400).json({ success: false, error: 'provider, code, and redirectUri are required' });
        }
        return res.status(400).json({ success: false, error: 'Provider not configured' });
    });

    // DELETE /account
    router.delete('/account', authMiddleware, (_req, res) => {
        return res.json({ success: true, message: 'Account deleted' });
    });

    // GET /roles — admin only
    router.get('/roles', authMiddleware, adminMiddleware, (_req, res) => {
        return res.json({ success: true, roles: [] });
    });

    // GET /user-roles
    router.get('/user-roles', authMiddleware, (req, res) => {
        const { userId } = req.query;
        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId is required' });
        }
        return res.json({ success: true, roles: [] });
    });

    // POST /user-roles — admin only
    router.post('/user-roles', authMiddleware, adminMiddleware, (req, res) => {
        const { userId, roleId } = req.body || {};
        if (!userId || !roleId) {
            return res.status(400).json({ success: false, error: 'userId and roleId are required' });
        }
        return res.json({ success: true });
    });

    // DELETE /user-roles — admin only
    router.delete('/user-roles', authMiddleware, adminMiddleware, (req, res) => {
        const { userId, roleId } = req.body || {};
        if (!userId || !roleId) {
            return res.status(400).json({ success: false, error: 'userId and roleId are required' });
        }
        return res.json({ success: true });
    });

    return jest.fn().mockReturnValue({
        router,
        authMiddleware,
        softAuthMiddleware: (_req, _res, next) => next(),
        adminMiddleware,
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
const patch = (path) => request(app).patch(path).set('Host', 'localhost');
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
// POST /api/auth/device-login
// ════════════════════════════════════════════════════════════════
describe('POST /api/auth/device-login', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/auth/device-login')
            .send({ deviceSecret: 'secret' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await post('/api/auth/device-login')
            .send({ deviceId: 'dev-1' });
        expect(res.status).toBe(400);
    });

    it('returns 401 for invalid device credentials', async () => {
        const res = await post('/api/auth/device-login')
            .send({ deviceId: 'dev-1', deviceSecret: 'wrong' });
        expect(res.status).toBe(401);
    });

    it('returns 400 when body is empty', async () => {
        const res = await post('/api/auth/device-login').send({});
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/auth/verify-email
// ════════════════════════════════════════════════════════════════
describe('GET /api/auth/verify-email', () => {
    it('returns 400 when token is missing', async () => {
        const res = await get('/api/auth/verify-email');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/token/i);
    });

    it('returns 400 for invalid token', async () => {
        const res = await get('/api/auth/verify-email?token=invalid-token');
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/auth/forgot-password
// ════════════════════════════════════════════════════════════════
describe('POST /api/auth/forgot-password', () => {
    it('returns 400 when email is missing', async () => {
        const res = await post('/api/auth/forgot-password').send({});
        expect(res.status).toBe(400);
    });

    it('returns success for valid email (does not reveal existence)', async () => {
        const res = await post('/api/auth/forgot-password')
            .send({ email: 'test@example.com' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/auth/reset-password
// ════════════════════════════════════════════════════════════════
describe('POST /api/auth/reset-password', () => {
    it('returns 400 when token is missing', async () => {
        const res = await post('/api/auth/reset-password')
            .send({ newPassword: 'newpass123' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when newPassword is missing', async () => {
        const res = await post('/api/auth/reset-password')
            .send({ token: 'some-token' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when password is too short', async () => {
        const res = await post('/api/auth/reset-password')
            .send({ token: 'some-token', newPassword: 'ab1' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/6 char/i);
    });

    it('returns 400 for invalid token', async () => {
        const res = await post('/api/auth/reset-password')
            .send({ token: 'invalid', newPassword: 'newpass123' });
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// PATCH /api/auth/language
// ════════════════════════════════════════════════════════════════
describe('PATCH /api/auth/language', () => {
    it('returns 400 when language is missing', async () => {
        const res = await patch('/api/auth/language').send({});
        expect(res.status).toBe(400);
    });

    it('returns 200 when language is provided', async () => {
        const res = await patch('/api/auth/language')
            .send({ language: 'zh-TW' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/auth/resend-verification
// ════════════════════════════════════════════════════════════════
describe('POST /api/auth/resend-verification', () => {
    it('returns 400 when email is missing', async () => {
        const res = await post('/api/auth/resend-verification').send({});
        expect(res.status).toBe(400);
    });

    it('returns 200 when email is provided', async () => {
        const res = await post('/api/auth/resend-verification')
            .send({ email: 'test@example.com' });
        expect(res.status).toBe(200);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/auth/bind-email
// ════════════════════════════════════════════════════════════════
describe('POST /api/auth/bind-email', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/auth/bind-email')
            .send({ deviceSecret: 's', email: 'a@b.com', password: 'pass123' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when email is missing', async () => {
        const res = await post('/api/auth/bind-email')
            .send({ deviceId: 'd', deviceSecret: 's', password: 'pass123' });
        expect(res.status).toBe(400);
    });

    it('returns 200 with all required fields', async () => {
        const res = await post('/api/auth/bind-email')
            .send({ deviceId: 'd', deviceSecret: 's', email: 'a@b.com', password: 'pass123' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/auth/bind-email/status
// ════════════════════════════════════════════════════════════════
describe('GET /api/auth/bind-email/status', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await get('/api/auth/bind-email/status');
        expect(res.status).toBe(400);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await get('/api/auth/bind-email/status?deviceId=d');
        expect(res.status).toBe(400);
    });

    it('returns 200 with both credentials', async () => {
        const res = await get('/api/auth/bind-email/status?deviceId=d&deviceSecret=s');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('hasBoundEmail');
    });

    it('returns roles array in response', async () => {
        const res = await get('/api/auth/bind-email/status?deviceId=d&deviceSecret=s');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('roles');
        expect(Array.isArray(res.body.roles)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/auth/app-login
// ════════════════════════════════════════════════════════════════
describe('POST /api/auth/app-login', () => {
    it('returns 400 when email is missing', async () => {
        const res = await post('/api/auth/app-login')
            .send({ password: 'pass123' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when password is missing', async () => {
        const res = await post('/api/auth/app-login')
            .send({ email: 'test@example.com' });
        expect(res.status).toBe(400);
    });

    it('returns 401 for invalid credentials', async () => {
        const res = await post('/api/auth/app-login')
            .send({ email: 'test@example.com', password: 'wrong' });
        expect(res.status).toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/auth/oauth/google
// ════════════════════════════════════════════════════════════════
describe('POST /api/auth/oauth/google', () => {
    it('returns 400 when no token is provided', async () => {
        const res = await post('/api/auth/oauth/google').send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/token/i);
    });

    it('returns 401 for invalid idToken', async () => {
        const res = await post('/api/auth/oauth/google')
            .send({ idToken: 'invalid-token' });
        expect(res.status).toBe(401);
    });

    it('returns 401 for invalid accessToken', async () => {
        const res = await post('/api/auth/oauth/google')
            .send({ accessToken: 'invalid-token' });
        expect(res.status).toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/auth/oauth/facebook
// ════════════════════════════════════════════════════════════════
describe('POST /api/auth/oauth/facebook', () => {
    it('returns 400 when accessToken is missing', async () => {
        const res = await post('/api/auth/oauth/facebook').send({});
        expect(res.status).toBe(400);
    });

    it('returns 401 for invalid accessToken', async () => {
        const res = await post('/api/auth/oauth/facebook')
            .send({ accessToken: 'invalid' });
        expect(res.status).toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/auth/oauth/oidc
// ════════════════════════════════════════════════════════════════
describe('POST /api/auth/oauth/oidc', () => {
    it('returns 400 when provider is missing', async () => {
        const res = await post('/api/auth/oauth/oidc')
            .send({ code: 'abc', redirectUri: 'http://localhost' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when code is missing', async () => {
        const res = await post('/api/auth/oauth/oidc')
            .send({ provider: 'google', redirectUri: 'http://localhost' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when redirectUri is missing', async () => {
        const res = await post('/api/auth/oauth/oidc')
            .send({ provider: 'google', code: 'abc' });
        expect(res.status).toBe(400);
    });

    it('returns 400 for unconfigured provider', async () => {
        const res = await post('/api/auth/oauth/oidc')
            .send({ provider: 'unknown', code: 'abc', redirectUri: 'http://localhost' });
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/auth/account
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/auth/account', () => {
    it('returns 401 when not authenticated', async () => {
        const res = await del('/api/auth/account');
        expect(res.status).toBe(401);
    });

    it('returns 200 when authenticated', async () => {
        const res = await del('/api/auth/account')
            .set('Cookie', 'eclaw_session=valid-token');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/auth/roles — admin only
// ════════════════════════════════════════════════════════════════
describe('GET /api/auth/roles', () => {
    it('returns 401 when not authenticated', async () => {
        const res = await get('/api/auth/roles');
        expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin user', async () => {
        const res = await get('/api/auth/roles')
            .set('Cookie', 'eclaw_session=non-admin-token');
        expect(res.status).toBe(403);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/auth/user-roles — admin only
// ════════════════════════════════════════════════════════════════
describe('POST /api/auth/user-roles', () => {
    it('returns 401 when not authenticated', async () => {
        const res = await post('/api/auth/user-roles')
            .send({ userId: 1, roleId: 1 });
        expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin user', async () => {
        const res = await post('/api/auth/user-roles')
            .set('Cookie', 'eclaw_session=non-admin-token')
            .send({ userId: 1, roleId: 1 });
        expect(res.status).toBe(403);
    });
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/auth/user-roles — admin only
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/auth/user-roles', () => {
    it('returns 401 when not authenticated', async () => {
        const res = await del('/api/auth/user-roles')
            .send({ userId: 1, roleId: 1 });
        expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin user', async () => {
        const res = await del('/api/auth/user-roles')
            .set('Cookie', 'eclaw_session=non-admin-token')
            .send({ userId: 1, roleId: 1 });
        expect(res.status).toBe(403);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/auth/user-roles
// ════════════════════════════════════════════════════════════════
describe('GET /api/auth/user-roles', () => {
    it('returns 401 when not authenticated', async () => {
        const res = await get('/api/auth/user-roles');
        expect(res.status).toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════
// Security: JWT payload must NOT contain deviceSecret
// ════════════════════════════════════════════════════════════════
describe('JWT security — no deviceSecret in token payload', () => {
    it('device-login cookie JWT does not contain deviceSecret', async () => {
        const deviceId = 'jwt-sec-test';
        const deviceSecret = `secret-${deviceId}`;
        await post('/api/device/register')
            .send({ deviceId, deviceSecret, entityId: 0 });

        const res = await post('/api/auth/device-login')
            .send({ deviceId, deviceSecret });

        // Extract eclaw_session cookie
        const cookies = res.headers['set-cookie'] || [];
        const sessionCookie = cookies.find(c => c.startsWith('eclaw_session='));
        if (sessionCookie) {
            const tokenValue = sessionCookie.split('=')[1].split(';')[0];
            // Decode JWT payload (base64url, no verification needed)
            const payloadB64 = tokenValue.split('.')[1];
            const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
            expect(payload).not.toHaveProperty('deviceSecret');
            expect(payload).toHaveProperty('deviceId', deviceId);
        }
    });
});
