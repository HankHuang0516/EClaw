/**
 * Card Holder API tests (Jest + Supertest)
 *
 * Validates card holder endpoints: PATCH, refresh, search, GET detail.
 * Also validates input validation for existing endpoints with new card holder fields.
 */

// ── Mocks (same pattern as mutations.test.js) ──
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
    // Card holder
    getCardHolder: jest.fn().mockResolvedValue([]),
    addCard: jest.fn().mockResolvedValue(null),
    updateCard: jest.fn().mockResolvedValue(null),
    refreshCardSnapshot: jest.fn().mockResolvedValue(null),
    searchCards: jest.fn().mockResolvedValue([]),
    getCardByCode: jest.fn().mockResolvedValue(null),
    removeCard: jest.fn().mockResolvedValue(true),
    getCardCount: jest.fn().mockResolvedValue(0),
    incrementInteraction: jest.fn().mockResolvedValue(undefined),
    getRecentInteractions: jest.fn().mockResolvedValue([]),
    upsertRecentInteraction: jest.fn().mockResolvedValue(null),
    isBlocked: jest.fn().mockResolvedValue(false),
    // Legacy aliases
    getContacts: jest.fn().mockResolvedValue([]),
    addContact: jest.fn().mockResolvedValue(null),
    removeContact: jest.fn().mockResolvedValue(true),
    getContactCount: jest.fn().mockResolvedValue(0),
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

jest.mock('../../notifications', () => {
    const express = jest.requireActual('express');
    return {
        init: jest.fn(),
        router: express.Router(),
        initNotificationTables: jest.fn().mockResolvedValue(undefined),
    };
});

jest.mock('../../chat-integrity', () => ({
    init: jest.fn().mockReturnValue({
        verify: jest.fn().mockReturnValue({ valid: true }),
        sign: jest.fn().mockReturnValue('sig'),
    }),
    initIntegrityTable: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../device-preferences', () => ({
    init: jest.fn(),
    initTable: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../entity-cross-device-settings', () => {
    const express = jest.requireActual('express');
    return {
        init: jest.fn(),
        initTable: jest.fn().mockResolvedValue(undefined),
        router: express.Router(),
    };
});

jest.mock('../../article-publisher', () => {
    const express = jest.requireActual('express');
    return {
        router: express.Router(),
        initPublisherTable: jest.fn().mockResolvedValue(undefined),
    };
});

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
    process.env.JWT_SECRET = 'test-secret';
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.SEAL_KEY = '0'.repeat(64);
    app = require('../../index');
});

// ── Tests ──

describe('Card Holder API', () => {

    describe('GET /api/contacts', () => {
        it('returns 400 without deviceId', async () => {
            const res = await get('/api/contacts');
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/deviceId/i);
        });
    });

    describe('POST /api/contacts', () => {
        it('returns 400 without publicCode', async () => {
            const res = await post('/api/contacts').send({ deviceId: 'test' });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/publicCode/i);
        });

        it('returns 401 with invalid credentials before format check', async () => {
            const res = await post('/api/contacts').send({
                deviceId: 'test',
                deviceSecret: 'test-secret',
                publicCode: '!!invalid!!'
            });
            // Device auth fails before format validation (device doesn't exist)
            expect(res.status).toBe(401);
        });
    });

    describe('DELETE /api/contacts', () => {
        it('returns 400 without publicCode', async () => {
            const res = await del('/api/contacts').send({ deviceId: 'test' });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/publicCode/i);
        });
    });

    describe('GET /api/contacts/search', () => {
        it('returns 400 without deviceId', async () => {
            const res = await get('/api/contacts/search?q=test');
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/deviceId/i);
        });

        it('returns 400 without search query', async () => {
            const res = await get('/api/contacts/search?deviceId=test');
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/query/i);
        });

        it('returns 400 with query too long', async () => {
            const longQ = 'a'.repeat(101);
            const res = await get(`/api/contacts/search?deviceId=test&q=${longQ}`);
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/long/i);
        });
    });

    describe('GET /api/contacts/:publicCode', () => {
        it('returns 400 without deviceId', async () => {
            const res = await get('/api/contacts/abc123');
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/deviceId/i);
        });

        it('returns 404 for non-existent card', async () => {
            const res = await get('/api/contacts/abc123?deviceId=test');
            expect(res.status).toBe(404);
        });
    });

    describe('PATCH /api/contacts/:publicCode', () => {
        it('returns 400 without deviceId', async () => {
            const res = await patch('/api/contacts/abc123').send({ notes: 'test' });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/deviceId/i);
        });

        it('returns 401 with invalid credentials before field check', async () => {
            const res = await patch('/api/contacts/abc123').send({
                deviceId: 'test',
                deviceSecret: 'test-secret',
            });
            // Device auth fails before field validation (device doesn't exist)
            expect(res.status).toBe(401);
        });
    });

    describe('POST /api/contacts/:publicCode/refresh', () => {
        it('returns 400 without deviceId', async () => {
            const res = await post('/api/contacts/abc123/refresh').send({});
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/deviceId/i);
        });
    });

    // ── New APIs (Card Holder Redesign) ──

    describe('GET /api/contacts/my-cards', () => {
        it('returns 400 without credentials', async () => {
            const res = await get('/api/contacts/my-cards');
            expect(res.status).toBe(400);
            expect(res.body.error).toBeTruthy();
        });

        it('returns 401 with invalid credentials', async () => {
            const res = await get('/api/contacts/my-cards?deviceId=test&deviceSecret=wrong');
            expect(res.status).toBe(401);
        });
    });

    describe('GET /api/contacts/recent', () => {
        it('returns 400 without credentials', async () => {
            const res = await get('/api/contacts/recent');
            expect(res.status).toBe(400);
            expect(res.body.error).toBeTruthy();
        });

        it('returns 401 with invalid credentials', async () => {
            const res = await get('/api/contacts/recent?deviceId=test&deviceSecret=wrong');
            expect(res.status).toBe(401);
        });
    });

    describe('GET /api/chat/history-by-code', () => {
        it('returns 400 without deviceId', async () => {
            const res = await get('/api/chat/history-by-code?publicCode=abc123');
            expect(res.status).toBe(400);
        });

        it('returns 400 without publicCode', async () => {
            const res = await get('/api/chat/history-by-code?deviceId=test&deviceSecret=test');
            expect(res.status).toBe(400);
        });
    });

    describe('PATCH /api/contacts/:publicCode (blocked field)', () => {
        it('returns 401 when setting blocked without valid credentials', async () => {
            const res = await patch('/api/contacts/abc123').send({
                deviceId: 'test',
                deviceSecret: 'wrong',
                blocked: true,
            });
            expect(res.status).toBe(401);
        });
    });
});
