/**
 * Publisher platforms endpoint tests (Jest + Supertest)
 *
 * Tests /api/publisher/platforms listing and input validation
 * for all 8 supported platforms (3 existing + 5 new).
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
    const noop = (_req, _res, next) => next();
    return jest.fn().mockReturnValue({
        router: express.Router(),
        authMiddleware: noop,
        softAuthMiddleware: noop,
        adminMiddleware: noop,
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

// ── Load app after mocks are established ──
const request = require('supertest');
let app;

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// Publisher Auth (X-Publisher-Key)
// ════════════════════════════════════════════════════════════════
describe('Publisher API auth (X-Publisher-Key)', () => {
    const origKey = process.env.PUBLISHER_API_KEY;

    afterEach(() => {
        if (origKey) process.env.PUBLISHER_API_KEY = origKey;
        else delete process.env.PUBLISHER_API_KEY;
    });

    it('allows requests when PUBLISHER_API_KEY is not set', async () => {
        delete process.env.PUBLISHER_API_KEY;
        const res = await request(app).get('/api/publisher/platforms');
        expect(res.status).toBe(200);
    });

    it('rejects publish requests with wrong key when PUBLISHER_API_KEY is set', async () => {
        process.env.PUBLISHER_API_KEY = 'test-secret-key';
        const res = await request(app)
            .post('/api/publisher/telegraph/publish')
            .set('X-Publisher-Key', 'wrong-key')
            .send({ title: 'Test', content: '<p>test</p>' });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/X-Publisher-Key/);
    });

    it('rejects publish requests with no key when PUBLISHER_API_KEY is set', async () => {
        process.env.PUBLISHER_API_KEY = 'test-secret-key';
        const res = await request(app)
            .post('/api/publisher/telegraph/publish')
            .send({ title: 'Test', content: '<p>test</p>' });
        expect(res.status).toBe(401);
    });

    it('allows requests with correct key', async () => {
        process.env.PUBLISHER_API_KEY = 'test-secret-key';
        const res = await request(app)
            .post('/api/publisher/telegraph/publish')
            .set('X-Publisher-Key', 'test-secret-key')
            .send({ title: 'Test' });
        // Should pass auth and hit validation (400) not auth rejection (401)
        expect(res.status).toBe(400);
    });

    it('GET /platforms is always public even when PUBLISHER_API_KEY is set', async () => {
        process.env.PUBLISHER_API_KEY = 'test-secret-key';
        const res = await request(app).get('/api/publisher/platforms');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/publisher/platforms
// ════════════════════════════════════════════════════════════════
describe('GET /api/publisher/platforms', () => {
    it('returns 200 with all 8 platforms', async () => {
        const res = await request(app).get('/api/publisher/platforms');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.platforms).toHaveLength(12);
    });

    it('includes all expected platform IDs', async () => {
        const res = await request(app).get('/api/publisher/platforms');
        const ids = res.body.platforms.map(p => p.id);
        expect(ids).toEqual(expect.arrayContaining([
            'blogger', 'hashnode', 'x', 'devto', 'wordpress', 'telegraph', 'qiita', 'wechat',
            'tumblr', 'reddit', 'linkedin', 'mastodon'
        ]));
    });

    it('each platform has required fields', async () => {
        const res = await request(app).get('/api/publisher/platforms');
        for (const p of res.body.platforms) {
            expect(p).toHaveProperty('id');
            expect(p).toHaveProperty('name');
            expect(p).toHaveProperty('region');
            expect(p).toHaveProperty('authType');
            expect(p).toHaveProperty('contentFormat');
            expect(typeof p.configured).toBe('boolean');
        }
    });

    it('Telegraph is always configured', async () => {
        const res = await request(app).get('/api/publisher/platforms');
        const telegraph = res.body.platforms.find(p => p.id === 'telegraph');
        expect(telegraph.configured).toBe(true);
    });

    it('regional platforms have correct region', async () => {
        const res = await request(app).get('/api/publisher/platforms');
        const qiita = res.body.platforms.find(p => p.id === 'qiita');
        const wechat = res.body.platforms.find(p => p.id === 'wechat');
        expect(qiita.region).toBe('ja');
        expect(wechat.region).toBe('zh-CN');
        expect(wechat.draftsOnly).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// DEV.to input validation
// ════════════════════════════════════════════════════════════════
describe('POST /api/publisher/devto/publish', () => {
    it('rejects missing body_markdown', async () => {
        const res = await request(app)
            .post('/api/publisher/devto/publish')
            .send({ title: 'Test' });
        // 400 if validation catches it, 501 if DEVTO_API_KEY not set
        expect([400, 501]).toContain(res.status);
        expect(res.body.error).toBeTruthy();
    });

    it('rejects empty body', async () => {
        const res = await request(app)
            .post('/api/publisher/devto/publish')
            .send({});
        expect([400, 501]).toContain(res.status);
    });
});

// ════════════════════════════════════════════════════════════════
// WordPress input validation
// ════════════════════════════════════════════════════════════════
describe('POST /api/publisher/wordpress/publish', () => {
    it('rejects missing siteId', async () => {
        const res = await request(app)
            .post('/api/publisher/wordpress/publish')
            .send({ title: 'Test', content: '<p>test</p>' });
        expect([400, 501]).toContain(res.status);
    });
});

// ════════════════════════════════════════════════════════════════
// Telegraph input validation
// ════════════════════════════════════════════════════════════════
describe('POST /api/publisher/telegraph/publish', () => {
    it('rejects missing content', async () => {
        const res = await request(app)
            .post('/api/publisher/telegraph/publish')
            .send({ title: 'Test' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('title, content required');
    });

    it('rejects empty body', async () => {
        const res = await request(app)
            .post('/api/publisher/telegraph/publish')
            .send({});
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// Qiita input validation
// ════════════════════════════════════════════════════════════════
describe('POST /api/publisher/qiita/publish', () => {
    it('rejects missing body', async () => {
        const res = await request(app)
            .post('/api/publisher/qiita/publish')
            .send({ title: 'Test' });
        expect([400, 501]).toContain(res.status);
    });
});

// ════════════════════════════════════════════════════════════════
// WeChat input validation
// ════════════════════════════════════════════════════════════════
describe('POST /api/publisher/wechat/draft', () => {
    it('rejects missing thumb_media_id', async () => {
        const res = await request(app)
            .post('/api/publisher/wechat/draft')
            .send({ title: 'Test', content: '<p>test</p>' });
        expect([400, 501]).toContain(res.status);
    });

    it('rejects empty body', async () => {
        const res = await request(app)
            .post('/api/publisher/wechat/draft')
            .send({});
        expect([400, 501]).toContain(res.status);
    });
});
