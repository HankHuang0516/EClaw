/**
 * Scheduler endpoint validation tests (Jest + Supertest)
 *
 * Tests input validation for schedule CRUD endpoints.
 * Coverage: GET/POST /api/schedules, PUT/DELETE /api/schedules/:id,
 *           PATCH /api/schedules/:id/toggle, GET /api/schedule-executions
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
    togglePause: jest.fn().mockResolvedValue({ id: 1, is_paused: true }),
    getExecutions: jest.fn().mockResolvedValue([]),
    getExecutionContext: jest.fn().mockResolvedValue(null),
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

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');
const put = (path) => request(app).put(path).set('Host', 'localhost');
const del = (path) => request(app).delete(path).set('Host', 'localhost');
const patch = (path) => request(app).patch(path).set('Host', 'localhost');

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// GET /api/schedules — list schedules
// ════════════════════════════════════════════════════════════════
describe('GET /api/schedules', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await get('/api/schedules');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects when deviceSecret is missing', async () => {
        const res = await get('/api/schedules?deviceId=dev-1');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await get('/api/schedules?deviceId=nonexistent&deviceSecret=wrong');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/schedules — deprecated (→ Kanban)
// ════════════════════════════════════════════════════════════════
describe('POST /api/schedules', () => {
    it('returns 410 deprecated', async () => {
        const res = await post('/api/schedules')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec', entityId: 0, message: 'test' });
        expect(res.status).toBe(410);
        expect(res.body.deprecated).toBe(true);
        expect(res.body.redirect).toBe('kanban');
    });
});

// ════════════════════════════════════════════════════════════════
// PUT /api/schedules/:id — update schedule
// ════════════════════════════════════════════════════════════════
describe('PUT /api/schedules/:id', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await put('/api/schedules/1')
            .send({ message: 'updated' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await put('/api/schedules/1')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong', message: 'updated' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/schedules/:id — delete schedule
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/schedules/:id', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await del('/api/schedules/1');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await del('/api/schedules/1')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// PATCH /api/schedules/:id/toggle — toggle pause
// ════════════════════════════════════════════════════════════════
describe('PATCH /api/schedules/:id/toggle', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await patch('/api/schedules/1/toggle');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await patch('/api/schedules/1/toggle')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/schedule-executions — execution history
// ════════════════════════════════════════════════════════════════
describe('GET /api/schedule-executions', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await get('/api/schedule-executions');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await get('/api/schedule-executions?deviceId=nonexistent&deviceSecret=wrong');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/schedule-executions/:id/context — execution context
// ════════════════════════════════════════════════════════════════
describe('GET /api/schedule-executions/:id/context', () => {
    it('rejects when deviceId is missing', async () => {
        const res = await get('/api/schedule-executions/1/context');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await get('/api/schedule-executions/1/context?deviceId=nonexistent&deviceSecret=wrong');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// Bot schedule endpoints — /api/bot/schedules
// ════════════════════════════════════════════════════════════════
describe('GET /api/bot/schedules', () => {
    it('rejects when no auth credentials provided', async () => {
        const res = await get('/api/bot/schedules');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

describe('POST /api/bot/schedules', () => {
    it('returns 410 deprecated', async () => {
        const res = await post('/api/bot/schedules')
            .send({ deviceId: 'dev-1', entityId: 0, botSecret: 'sec', message: 'test' });
        expect(res.status).toBe(410);
        expect(res.body.deprecated).toBe(true);
        expect(res.body.redirect).toBe('kanban');
    });
});

describe('DELETE /api/bot/schedules/:id', () => {
    it('rejects when no auth credentials provided', async () => {
        const res = await del('/api/bot/schedules/1');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});
