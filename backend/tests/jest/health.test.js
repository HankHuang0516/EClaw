/**
 * Backend health & version endpoint tests (Jest + Supertest)
 *
 * Mocks all DB/external-service dependencies so tests run in CI
 * without a live PostgreSQL instance.
 */

// ── Mock all modules with side-effects before requiring index.js ──

// Prevent pg from opening real connections
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

// ── Load app after mocks are established ──
const request = require('supertest');
let app;
const originalRailwayEnvironment = process.env.RAILWAY_ENVIRONMENT;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(() => {
    process.env.RAILWAY_ENVIRONMENT = 'production';
    process.env.DATABASE_URL = 'postgresql://user:pass@postgres-pgvector.railway.internal:5432/railway';
    // jest.mock calls above ensure mocked modules are used when index.js loads
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    if (originalRailwayEnvironment === undefined) {
        delete process.env.RAILWAY_ENVIRONMENT;
    } else {
        process.env.RAILWAY_ENVIRONMENT = originalRailwayEnvironment;
    }
    if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
    } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
    }
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// /api/health
// ════════════════════════════════════════════════════════════════
describe('GET /api/health', () => {
    it('returns HTTP 200', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
    });

    it('returns { status: "ok" }', async () => {
        const res = await request(app).get('/api/health');
        expect(res.body.status).toBe('ok');
    });

    it('includes a timestamp in the response', async () => {
        const before = Date.now();
        const res = await request(app).get('/api/health');
        expect(res.body.timestamp).toBeGreaterThanOrEqual(before);
        expect(res.body.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it('includes a dynamic build tag with date', async () => {
        const res = await request(app).get('/api/health');
        expect(res.body.build).toMatch(/^v5\.6-\d{8}$/);
    });

    it('includes startedAt as a valid ISO timestamp', async () => {
        const res = await request(app).get('/api/health');
        expect(res.body.startedAt).toBeDefined();
        const parsed = new Date(res.body.startedAt);
        expect(parsed.getTime()).not.toBeNaN();
    });

    it('includes uptime as a positive number', async () => {
        const res = await request(app).get('/api/health');
        expect(typeof res.body.uptime).toBe('number');
        expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    });

    it('requires PostgreSQL persistence on Railway when DATABASE_URL is configured', async () => {
        const res = await request(app).get('/api/health');
        expect(res.body.persistence.productionRequiresPostgresql).toBe(true);
        expect(res.body.persistence.mode).toBe('postgresql');
    });
});

// ════════════════════════════════════════════════════════════════
// /api/version
// ════════════════════════════════════════════════════════════════
describe('GET /api/version', () => {
    it('returns HTTP 200', async () => {
        const res = await request(app).get('/api/version');
        expect(res.status).toBe(200);
    });

    it('includes api, portal, android version fields', async () => {
        const res = await request(app).get('/api/version');
        expect(res.body).toHaveProperty('api');
        expect(res.body).toHaveProperty('portal');
        expect(res.body).toHaveProperty('android');
    });

    it('returns feature lists for both platforms', async () => {
        const res = await request(app).get('/api/version');
        expect(Array.isArray(res.body.features.portal)).toBe(true);
        expect(Array.isArray(res.body.features.android)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// / (root)
// ════════════════════════════════════════════════════════════════
describe('GET /', () => {
    it('serves landing page', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.text).toContain('EClawbot');
    });
});

describe('Portal static cache headers', () => {
    it('sets Cache-Control with short max-age on portal JS files', async () => {
        const res = await request(app).get('/portal/shared/entity-utils.js');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toMatch(/max-age=60/);
        expect(res.headers['cache-control']).toMatch(/must-revalidate/);
    });

    it('sets Cache-Control: no-cache on portal HTML files', async () => {
        const res = await request(app).get('/portal/index.html');
        expect(res.status).toBe(200);
        // HTML: no-cache ensures CDN revalidates on every request (ETag/304)
        expect(res.headers['cache-control']).toMatch(/no-cache/);
    });
});

// ════════════════════════════════════════════════════════════════
// /api/platform-stats — Regression #2809
// ════════════════════════════════════════════════════════════════
describe('GET /api/platform-stats', () => {
    it('requires deviceId and deviceSecret', async () => {
        const res = await request(app).get('/api/platform-stats');
        expect(res.status).toBe(400);
    });

    it('rejects invalid credentials', async () => {
        const res = await request(app)
            .get('/api/platform-stats?deviceId=fake&deviceSecret=fake');
        expect(res.status).toBe(401);
    });

    it('does not 500 when called with valid device (template counts from in-memory)', async () => {
        // Register a device so it exists in the in-memory map
        const did = 'platform-stats-test-device';
        const dsec = 'platform-stats-test-secret';
        await request(app).post('/api/device/register').send({
            deviceId: did, deviceSecret: dsec, entityId: 0,
        });

        const res = await request(app)
            .get(`/api/platform-stats?deviceId=${did}&deviceSecret=${dsec}`);
        // Must not be 500 (the bug was querying non-existent DB tables)
        expect(res.status).not.toBe(500);
        if (res.status === 200) {
            expect(res.body.success).toBe(true);
            expect(typeof res.body.templates.soul).toBe('number');
            expect(typeof res.body.templates.rule).toBe('number');
            expect(typeof res.body.templates.skill).toBe('number');
        }
    });

    // card_49b8190 — locks /api/skill-doc section 174 contract: device-auth
    // required, aggregate-only response (users, boundEntities, activeDevices,
    // templates {soul, rule, skill}); no device-private fields leak.
    it('credentialed call returns the documented aggregate contract', async () => {
        const did = 'platform-stats-contract-device';
        const dsec = 'platform-stats-contract-secret';
        await request(app).post('/api/device/register').send({
            deviceId: did, deviceSecret: dsec, entityId: 0,
        });

        const res = await request(app)
            .get(`/api/platform-stats?deviceId=${did}&deviceSecret=${dsec}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(typeof res.body.users).toBe('number');
        expect(typeof res.body.boundEntities).toBe('number');
        expect(typeof res.body.activeDevices).toBe('number');
        expect(res.body.templates).toEqual(expect.objectContaining({
            soul: expect.any(Number),
            rule: expect.any(Number),
            skill: expect.any(Number),
        }));
        // No device-scoped fields must appear in the aggregate payload.
        const forbidden = ['deviceId', 'deviceSecret', 'entities', 'entityId', 'botSecret', 'identity'];
        for (const key of forbidden) {
            expect(res.body[key]).toBeUndefined();
        }
    });
});

// ════════════════════════════════════════════════════════════════
// /api/entity/lookup — Regression #2810
// ════════════════════════════════════════════════════════════════
describe('GET /api/entity/lookup', () => {
    it('requires code query parameter', async () => {
        const res = await request(app).get('/api/entity/lookup');
        expect(res.status).toBe(400);
    });

    it('accepts publicCode as alias for code (#2810)', async () => {
        const res = await request(app).get('/api/entity/lookup?publicCode=nonexistent');
        // Should be 404 (not found) not 400 (missing param)
        expect(res.status).toBe(404);
    });

    it('accepts code parameter', async () => {
        const res = await request(app).get('/api/entity/lookup?code=nonexistent');
        expect(res.status).toBe(404);
    });
});
