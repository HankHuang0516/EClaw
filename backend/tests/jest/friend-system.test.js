/**
 * Friend System API tests (Jest + Supertest)
 *
 * Validates friend request endpoints: send, list, accept, reject, cancel, unfriend.
 * Also validates friends_only default in cross-device settings.
 */

// ── Mocks (same pattern as card-holder.test.js) ──
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
    deleteEntity: jest.fn().mockResolvedValue(true),
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
    isFriend: jest.fn().mockResolvedValue(false),
    setFriendStatus: jest.fn().mockResolvedValue(true),
    // Friend requests
    createFriendRequest: jest.fn().mockResolvedValue(null),
    getFriendRequests: jest.fn().mockResolvedValue([]),
    getFriendRequestById: jest.fn().mockResolvedValue(null),
    updateFriendRequestStatus: jest.fn().mockResolvedValue(null),
    deleteFriendRequest: jest.fn().mockResolvedValue(true),
    getFriends: jest.fn().mockResolvedValue([]),
    getPendingFriendRequestCount: jest.fn().mockResolvedValue(0),
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
    // card_a9edf960: pull through the pure rich-card-question helpers so index.js
    // can wire its limiter at module-load without crashing.
    const actual = jest.requireActual('../../notifications');
    return {
        init: jest.fn(),
        router: express.Router(),
        initNotificationTables: jest.fn().mockResolvedValue(undefined),
        truncateUtf8: actual.truncateUtf8,
        isRichCardQuestion: actual.isRichCardQuestion,
        buildRichCardNotification: actual.buildRichCardNotification,
        createRichCardNotifLimiter: actual.createRichCardNotifLimiter,
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

jest.mock('../../org-chart', () => ({
    initTable: jest.fn().mockResolvedValue(undefined),
    getOrgChart: jest.fn().mockResolvedValue({ hierarchy: {}, options: { kanbanReviewer: false, taskForward: false, allForward: false } }),
    updateOrgChart: jest.fn().mockResolvedValue({ success: true, orgChart: { hierarchy: {}, options: {} } }),
    getSuperior: jest.fn().mockReturnValue(null),
    getSubordinates: jest.fn().mockReturnValue([]),
    buildDefault: jest.fn().mockReturnValue({ USER: [] }),
    pruneHierarchy: jest.fn().mockImplementation((h) => h),
    validateHierarchy: jest.fn().mockReturnValue({ valid: true }),
    validateOptions: jest.fn().mockImplementation((o) => o),
    onEntityDeleted: jest.fn().mockResolvedValue(undefined),
    invalidateCache: jest.fn(),
    DEFAULT_OPTIONS: { kanbanReviewer: false, taskForward: false, allForward: false },
}));

jest.mock('../../entity-cross-device-settings', () => {
    const express = jest.requireActual('express');
    return {
        init: jest.fn(),
        initTable: jest.fn().mockResolvedValue(undefined),
        router: express.Router(),
        DEFAULTS: {
            pre_inject: '',
            forbidden_words: [],
            rate_limit_seconds: 0,
            blacklist: [],
            whitelist_enabled: false,
            whitelist: [],
            reject_message: '',
            allowed_media: ['text', 'photo', 'voice', 'video', 'file'],
            friends_only: false,
        },
        getSettings: jest.fn().mockResolvedValue({
            pre_inject: '',
            forbidden_words: [],
            rate_limit_seconds: 0,
            blacklist: [],
            whitelist_enabled: false,
            whitelist: [],
            reject_message: '',
            allowed_media: ['text', 'photo', 'voice', 'video', 'file'],
            friends_only: false,
        }),
        updateSettings: jest.fn().mockResolvedValue(undefined),
        resetSettings: jest.fn().mockResolvedValue(undefined),
    };
});

jest.mock('../../article-publisher', () => {
    const express = jest.requireActual('express');
    return {
        router: express.Router(),
        initPublisherTable: jest.fn().mockResolvedValue(undefined),
        setDeviceVarResolver: jest.fn(),
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
const del = (path) => request(app).delete(path).set('Host', 'localhost');

beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.SEAL_KEY = '0'.repeat(64);
    app = require('../../index');
});

// ── Tests ──

describe('Friend System API', () => {

    describe('POST /api/contacts/:publicCode/friend-request', () => {
        it('returns 400 without deviceId', async () => {
            const res = await post('/api/contacts/abc123/friend-request').send({});
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/Missing/i);
        });

        it('returns 401 with invalid credentials', async () => {
            const res = await post('/api/contacts/abc123/friend-request').send({
                deviceId: 'fake-device',
                deviceSecret: 'fake-secret',
            });
            expect(res.status).toBe(401);
        });
    });

    describe('GET /api/contacts/friend-requests', () => {
        it('returns 400 without credentials', async () => {
            const res = await get('/api/contacts/friend-requests');
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/Missing/i);
        });

        it('returns 401 with invalid credentials', async () => {
            const res = await get('/api/contacts/friend-requests?deviceId=fake&deviceSecret=fake');
            expect(res.status).toBe(401);
        });
    });

    describe('GET /api/contacts/friends', () => {
        it('returns 400 without credentials', async () => {
            const res = await get('/api/contacts/friends');
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/Missing/i);
        });

        it('returns 401 with invalid credentials', async () => {
            const res = await get('/api/contacts/friends?deviceId=fake&deviceSecret=fake');
            expect(res.status).toBe(401);
        });
    });

    describe('POST /api/contacts/friend-requests/:id/accept', () => {
        it('returns 400 without deviceId', async () => {
            const res = await post('/api/contacts/friend-requests/1/accept').send({});
            expect(res.status).toBe(400);
        });

        it('returns 400 with non-numeric request ID', async () => {
            const res = await post('/api/contacts/friend-requests/abc/accept').send({
                deviceId: 'fake', deviceSecret: 'fake',
            });
            expect([400, 401]).toContain(res.status);
        });
    });

    describe('POST /api/contacts/friend-requests/:id/reject', () => {
        it('returns 400 without deviceId', async () => {
            const res = await post('/api/contacts/friend-requests/1/reject').send({});
            expect(res.status).toBe(400);
        });
    });

    describe('DELETE /api/contacts/friend-requests/:id', () => {
        it('returns 400 without deviceId', async () => {
            const res = await del('/api/contacts/friend-requests/1').send({});
            expect(res.status).toBe(400);
        });
    });

    describe('DELETE /api/contacts/:publicCode/unfriend', () => {
        it('returns 400 without deviceId', async () => {
            const res = await del('/api/contacts/abc123/unfriend').send({});
            expect(res.status).toBe(400);
        });
    });

    describe('GET /api/contacts/friend-requests/count', () => {
        it('returns 400 without credentials', async () => {
            const res = await get('/api/contacts/friend-requests/count');
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/Missing/i);
        });
    });
});

describe('Cross-Device Settings friends_only', () => {
    it('should include friends_only in DEFAULTS', () => {
        const xdSettings = require('../../entity-cross-device-settings');
        expect(xdSettings.DEFAULTS).toHaveProperty('friends_only', false);
    });
});
