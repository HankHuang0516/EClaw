/**
 * Publisher extended platform validation tests (Jest + Supertest)
 *
 * Tests input validation for publisher platforms NOT covered by publisher.test.js:
 * - Blogger (OAuth + publish + delete)
 * - Hashnode (publish + delete)
 * - X/Twitter (tweet + delete)
 * - Tumblr (publish + delete)
 * - Reddit (submit + delete)
 * - LinkedIn (publish + delete)
 * - Mastodon (publish + delete)
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

// Disable publisher auth for these tests
const origKey = process.env.PUBLISHER_API_KEY;
beforeAll(() => {
    delete process.env.PUBLISHER_API_KEY;
    app = require('../../index');
});

afterAll(async () => {
    if (origKey) process.env.PUBLISHER_API_KEY = origKey;
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

const post = (path) => request(app).post(path).set('Host', 'localhost');
const get = (path) => request(app).get(path).set('Host', 'localhost');
const del = (path) => request(app).delete(path).set('Host', 'localhost');

// ════════════════════════════════════════════════════════════════
// Blogger
// ════════════════════════════════════════════════════════════════
describe('POST /api/publisher/blogger/publish', () => {
    it('rejects missing title', async () => {
        const res = await post('/api/publisher/blogger/publish')
            .send({ content: '<p>test</p>', deviceId: 'dev-1' });
        expect([400, 501]).toContain(res.status);
    });

    it('rejects missing content', async () => {
        const res = await post('/api/publisher/blogger/publish')
            .send({ title: 'Test', deviceId: 'dev-1' });
        expect([400, 501]).toContain(res.status);
    });

    it('rejects empty body', async () => {
        const res = await post('/api/publisher/blogger/publish').send({});
        expect([400, 501]).toContain(res.status);
    });
});

describe('GET /api/publisher/blogger/status', () => {
    it('rejects missing deviceId', async () => {
        const res = await get('/api/publisher/blogger/status');
        expect([400, 501]).toContain(res.status);
    });
});

// ════════════════════════════════════════════════════════════════
// Hashnode
// ════════════════════════════════════════════════════════════════
describe('POST /api/publisher/hashnode/publish', () => {
    it('rejects missing title', async () => {
        const res = await post('/api/publisher/hashnode/publish')
            .send({ contentMarkdown: '# Test', publicationId: 'pub-1' });
        expect([400, 501]).toContain(res.status);
    });

    it('rejects missing contentMarkdown', async () => {
        const res = await post('/api/publisher/hashnode/publish')
            .send({ title: 'Test', publicationId: 'pub-1' });
        expect([400, 501]).toContain(res.status);
    });

    it('rejects empty body', async () => {
        const res = await post('/api/publisher/hashnode/publish').send({});
        expect([400, 501]).toContain(res.status);
    });
});

// ════════════════════════════════════════════════════════════════
// X/Twitter
// ════════════════════════════════════════════════════════════════
describe('POST /api/publisher/x/tweet', () => {
    it('rejects missing text', async () => {
        const res = await post('/api/publisher/x/tweet').send({});
        expect([400, 501]).toContain(res.status);
    });

    it('rejects empty text', async () => {
        const res = await post('/api/publisher/x/tweet').send({ text: '' });
        expect([400, 501]).toContain(res.status);
    });
});

// ════════════════════════════════════════════════════════════════
// Tumblr
// ════════════════════════════════════════════════════════════════
describe('POST /api/publisher/tumblr/publish', () => {
    it('rejects missing blogName', async () => {
        const res = await post('/api/publisher/tumblr/publish')
            .send({ title: 'Test', content: '<p>test</p>' });
        expect([400, 501]).toContain(res.status);
    });

    it('rejects missing content', async () => {
        const res = await post('/api/publisher/tumblr/publish')
            .send({ blogName: 'myblog', title: 'Test' });
        expect([400, 501]).toContain(res.status);
    });

    it('rejects empty body', async () => {
        const res = await post('/api/publisher/tumblr/publish').send({});
        expect([400, 501]).toContain(res.status);
    });
});

// ════════════════════════════════════════════════════════════════
// Reddit
// ════════════════════════════════════════════════════════════════
describe('POST /api/publisher/reddit/submit', () => {
    it('rejects missing subreddit', async () => {
        const res = await post('/api/publisher/reddit/submit')
            .send({ title: 'Test', text: 'content' });
        expect([400, 501]).toContain(res.status);
    });

    it('rejects missing title', async () => {
        const res = await post('/api/publisher/reddit/submit')
            .send({ subreddit: 'test', text: 'content' });
        expect([400, 501]).toContain(res.status);
    });

    it('rejects empty body', async () => {
        const res = await post('/api/publisher/reddit/submit').send({});
        expect([400, 501]).toContain(res.status);
    });
});

// ════════════════════════════════════════════════════════════════
// LinkedIn
// ════════════════════════════════════════════════════════════════
describe('POST /api/publisher/linkedin/publish', () => {
    it('rejects missing text', async () => {
        const res = await post('/api/publisher/linkedin/publish').send({});
        expect([400, 501]).toContain(res.status);
    });

    it('rejects empty text', async () => {
        const res = await post('/api/publisher/linkedin/publish')
            .send({ text: '' });
        expect([400, 501]).toContain(res.status);
    });
});

// ════════════════════════════════════════════════════════════════
// Mastodon
// ════════════════════════════════════════════════════════════════
describe('POST /api/publisher/mastodon/publish', () => {
    it('rejects missing status text', async () => {
        const res = await post('/api/publisher/mastodon/publish').send({});
        expect([400, 501]).toContain(res.status);
    });

    it('rejects empty status', async () => {
        const res = await post('/api/publisher/mastodon/publish')
            .send({ status: '' });
        expect([400, 501]).toContain(res.status);
    });
});

// ════════════════════════════════════════════════════════════════
// Delete endpoints — should require auth/params
// ════════════════════════════════════════════════════════════════
describe('Publisher delete endpoints', () => {
    it('DELETE /api/publisher/blogger/post/:id responds', async () => {
        const res = await del('/api/publisher/blogger/post/123');
        // Either 400 (missing deviceId), 501 (not configured), or 404
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('DELETE /api/publisher/hashnode/post/:id responds', async () => {
        const res = await del('/api/publisher/hashnode/post/123');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('DELETE /api/publisher/x/tweet/:id responds', async () => {
        const res = await del('/api/publisher/x/tweet/123');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('DELETE /api/publisher/tumblr/post/:id responds', async () => {
        const res = await del('/api/publisher/tumblr/post/123');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('DELETE /api/publisher/reddit/post/:id responds', async () => {
        const res = await del('/api/publisher/reddit/post/123');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('DELETE /api/publisher/linkedin/post/:urn responds', async () => {
        const res = await del('/api/publisher/linkedin/post/urn:li:share:123');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('DELETE /api/publisher/mastodon/post/:id responds', async () => {
        const res = await del('/api/publisher/mastodon/post/123');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// /me endpoints — should require platform config
// ════════════════════════════════════════════════════════════════
describe('Publisher /me endpoints', () => {
    it('GET /api/publisher/hashnode/me responds', async () => {
        const res = await get('/api/publisher/hashnode/me');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('GET /api/publisher/x/me responds', async () => {
        const res = await get('/api/publisher/x/me');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('GET /api/publisher/tumblr/me responds', async () => {
        const res = await get('/api/publisher/tumblr/me');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('GET /api/publisher/reddit/me responds', async () => {
        const res = await get('/api/publisher/reddit/me');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('GET /api/publisher/linkedin/me responds', async () => {
        const res = await get('/api/publisher/linkedin/me');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('GET /api/publisher/mastodon/me responds', async () => {
        const res = await get('/api/publisher/mastodon/me');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});
