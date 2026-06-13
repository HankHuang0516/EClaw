/**
 * Universal self-repair directive endpoint tests (Jest + Supertest)
 *
 * Covers the auth + bound/channel guard chain on POST /api/channel/self-repair,
 * which gates the universal ECLAW_SELF_REPAIR directive fallback. Mirrors the
 * mock-preamble + real-index.js loading style of mutations.test.js so the route
 * runs against the actual handler without a live DB. We exercise only the
 * synchronous rejection paths (missing creds / wrong secret / invalid+unbound
 * entity / non-channel binding) — the directive dispatch itself is verified
 * async by passive-health, not here.
 */

// ── Mocks mirror mutations.test.js so index.js loads without a live DB ──
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
    // self-repair reads the bound channel account; default to none so the
    // (already auth-rejected) tests never reach a live channel push.
    getChannelAccountById: jest.fn().mockResolvedValue(null),
    getChannelAccountByDevice: jest.fn().mockResolvedValue(null),
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

const request = require('supertest');
let app;
let devices;

const DEVICE_ID = 'selfrepair-dev-1';
const DEVICE_SECRET = 'selfrepair-secret-1';

const post = (path) => request(app).post(path).set('Host', 'localhost');

beforeAll(() => {
    app = require('../../index');
    devices = require('../../index').devices;
    const createDefaultEntity = require('../../index')._createDefaultEntity;

    // Entity 0: a channel-bound entity (the happy auth path target).
    // Entity 1: bound via webhook (not a channel) — exercises the non-channel reject.
    // Entity 2: an unbound default slot — exercises the not-bound reject.
    const ent0 = createDefaultEntity(0);
    ent0.isBound = true;
    ent0.bindingType = 'channel';
    ent0.channelAccountId = 'chan-acct-1';

    const ent1 = createDefaultEntity(1);
    ent1.isBound = true;
    ent1.bindingType = 'webhook';
    ent1.webhook = 'https://example.com/webhook';

    const ent2 = createDefaultEntity(2);

    devices[DEVICE_ID] = {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        nextEntityId: 3,
        entities: { 0: ent0, 1: ent1, 2: ent2 },
    };
});

afterAll(async () => {
    delete devices[DEVICE_ID];
    const { httpServer } = require('../../index');
    await new Promise((resolve) => httpServer.close(resolve));
    jest.resetModules();
});

describe('POST /api/channel/self-repair — auth rejection', () => {
    it('400 when deviceId + deviceSecret are missing', async () => {
        const res = await post('/api/channel/self-repair').send({ entityId: 0 });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/deviceId and deviceSecret/i);
    });

    it('400 when deviceSecret is missing', async () => {
        const res = await post('/api/channel/self-repair')
            .send({ deviceId: DEVICE_ID, entityId: 0 });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('403 on wrong deviceSecret', async () => {
        const res = await post('/api/channel/self-repair')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'WRONG', entityId: 0 });
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Invalid device credentials/i);
    });

    it('403 on unknown device', async () => {
        const res = await post('/api/channel/self-repair')
            .send({ deviceId: 'nope', deviceSecret: 'whatever', entityId: 0 });
        expect(res.status).toBe(403);
    });
});

describe('POST /api/channel/self-repair — entity rejection', () => {
    const auth = { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET };

    it('400 on non-integer entityId', async () => {
        const res = await post('/api/channel/self-repair')
            .send({ ...auth, entityId: 'abc' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Invalid entityId/i);
    });

    it('400 on out-of-range / unbound entity slot', async () => {
        // Entity 99 does not exist in the device entity map.
        const res = await post('/api/channel/self-repair')
            .send({ ...auth, entityId: 99 });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('400 when the entity exists but is not bound', async () => {
        const res = await post('/api/channel/self-repair')
            .send({ ...auth, entityId: 2 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not bound/i);
    });

    it('400 when the entity is bound but not a channel binding', async () => {
        const res = await post('/api/channel/self-repair')
            .send({ ...auth, entityId: 1 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not a channel binding/i);
    });
});
