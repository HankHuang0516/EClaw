/**
 * Feedback CRUD endpoint validation tests (Jest + Supertest)
 *
 * Tests input validation for feedback listing, details, update, photos,
 * debug results, and GitHub issue creation endpoints.
 * (POST /api/feedback basic validation is in mutations.test.js)
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
    generateAiPrompt: jest.fn().mockReturnValue('mock AI prompt'),
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
    deleteFeedback: jest.fn().mockResolvedValue(true),
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
// GET /api/feedback — list feedback
// ════════════════════════════════════════════════════════════════
describe('GET /api/feedback', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await get('/api/feedback');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects when deviceSecret is missing', async () => {
        const res = await get('/api/feedback?deviceId=dev-1');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await get('/api/feedback?deviceId=nonexistent&deviceSecret=wrong');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/feedback/:id — feedback detail
// ════════════════════════════════════════════════════════════════
describe('GET /api/feedback/:id', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await get('/api/feedback/1');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await get('/api/feedback/1?deviceId=nonexistent&deviceSecret=wrong');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// PATCH /api/feedback/:id — update feedback status
// ════════════════════════════════════════════════════════════════
describe('PATCH /api/feedback/:id', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await patch('/api/feedback/1')
            .send({ status: 'resolved' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await patch('/api/feedback/1')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong', status: 'resolved' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/feedback/:id/ai-prompt — AI diagnostic prompt
// ════════════════════════════════════════════════════════════════
describe('GET /api/feedback/:id/ai-prompt', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await get('/api/feedback/1/ai-prompt');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await get('/api/feedback/1/ai-prompt?deviceId=nonexistent&deviceSecret=wrong');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/feedback/:id/create-issue — GitHub issue creation
// ════════════════════════════════════════════════════════════════
describe('POST /api/feedback/:id/create-issue', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await post('/api/feedback/1/create-issue')
            .send({});
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await post('/api/feedback/1/create-issue')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/feedback/:id/debug-result — debug result submission
// ════════════════════════════════════════════════════════════════
describe('POST /api/feedback/:id/debug-result', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await post('/api/feedback/1/debug-result')
            .send({ debugStatus: 'analyzed', debugResult: 'test result' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await post('/api/feedback/1/debug-result')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong', debugStatus: 'analyzed', debugResult: 'result' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/feedback/pending-debug — pending debug items
// ════════════════════════════════════════════════════════════════
describe('GET /api/feedback/pending-debug', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await get('/api/feedback/pending-debug');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await get('/api/feedback/pending-debug?deviceId=nonexistent&deviceSecret=wrong');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/feedback/mark — mark feedback window
// ════════════════════════════════════════════════════════════════
describe('POST /api/feedback/mark', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await post('/api/feedback/mark')
            .send({});
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/feedback/:id/photos — list feedback photos
// ════════════════════════════════════════════════════════════════
describe('GET /api/feedback/:id/photos', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await get('/api/feedback/1/photos');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await get('/api/feedback/1/photos?deviceId=nonexistent&deviceSecret=wrong');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/feedback/:id — delete feedback
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/feedback/:id', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await del('/api/feedback/1').send({});
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await del('/api/feedback/1')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});
