/**
 * Jest test: Bot Identity Layer endpoints
 * Tests PUT/GET/DELETE /api/entity/identity
 * Tests backward compatibility with /api/entity/agent-card
 */

// ── Same mocks as other test files ──
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
    uploadPhoto: jest.fn().mockResolvedValue({ success: true, url: 'https://example.com/photo.jpg', photoId: '1' }),
    isAvailable: jest.fn().mockReturnValue(true),
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

const request = require('supertest');
const app = require('../../index');

// ── PUT /api/entity/identity ──
describe('PUT /api/entity/identity', () => {
    test('rejects missing deviceId', async () => {
        const res = await request(app)
            .put('/api/entity/identity')
            .send({ entityId: 0, identity: { role: 'test' } });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('rejects missing identity object', async () => {
        const res = await request(app)
            .put('/api/entity/identity')
            .send({ deviceId: 'test', deviceSecret: 'test', entityId: 0 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/identity/i);
    });

    test('rejects missing auth', async () => {
        const res = await request(app)
            .put('/api/entity/identity')
            .send({ deviceId: 'test', entityId: 0, identity: { role: 'test' } });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/secret/i);
    });

    test('rejects invalid deviceSecret', async () => {
        const res = await request(app)
            .put('/api/entity/identity')
            .send({ deviceId: 'test', deviceSecret: 'wrong', entityId: 0, identity: { role: 'test' } });
        expect([403, 404]).toContain(res.status);
    });

    test('rejects nonexistent device', async () => {
        const res = await request(app)
            .put('/api/entity/identity')
            .send({ deviceId: 'nonexistent', deviceSecret: 'test', entityId: 0, identity: { instructions: 'not-array' } });
        expect(res.status).toBe(404);
    });
});

// ── GET /api/entity/identity ──
describe('GET /api/entity/identity', () => {
    test('rejects missing deviceId', async () => {
        const res = await request(app)
            .get('/api/entity/identity?entityId=0');
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('rejects missing auth', async () => {
        const res = await request(app)
            .get('/api/entity/identity?deviceId=test&entityId=0');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/secret/i);
    });

    test('rejects invalid device', async () => {
        const res = await request(app)
            .get('/api/entity/identity?deviceId=nonexistent&deviceSecret=wrong&entityId=0');
        expect(res.status).toBe(404);
    });
});

// ── DELETE /api/entity/identity ──
describe('DELETE /api/entity/identity', () => {
    test('rejects missing deviceId', async () => {
        const res = await request(app)
            .delete('/api/entity/identity')
            .send({ entityId: 0 });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('rejects missing auth', async () => {
        const res = await request(app)
            .delete('/api/entity/identity')
            .send({ deviceId: 'test', entityId: 0 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/secret/i);
    });

    test('rejects invalid device', async () => {
        const res = await request(app)
            .delete('/api/entity/identity')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong', entityId: 0 });
        expect(res.status).toBe(404);
    });
});

// ── Backward compat: Agent Card endpoints still work ──
describe('Agent Card backward compatibility', () => {
    test('PUT /api/entity/agent-card rejects missing fields', async () => {
        const res = await request(app)
            .put('/api/entity/agent-card')
            .send({ entityId: 0 });
        expect(res.status).toBe(400);
    });

    test('GET /api/entity/agent-card rejects missing auth', async () => {
        const res = await request(app)
            .get('/api/entity/agent-card?deviceId=test&entityId=0');
        expect(res.status).toBe(400);
    });

    test('DELETE /api/entity/agent-card rejects missing auth', async () => {
        const res = await request(app)
            .delete('/api/entity/agent-card')
            .send({ deviceId: 'test', entityId: 0 });
        expect(res.status).toBe(400);
    });
});
