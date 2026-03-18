/**
 * Jest test: Avatar upload and update endpoints
 * Tests PUT /api/device/entity/avatar (relaxed validation)
 * Tests POST /api/device/entity/avatar/upload (multipart upload)
 */

// ── Same mocks as health.test.js ──
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
    uploadPhoto: jest.fn().mockResolvedValue({
        success: true,
        url: 'https://live.staticflickr.com/65535/12345_abc_b.jpg',
        photoId: '12345',
    }),
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

describe('PUT /api/device/entity/avatar', () => {
    test('rejects missing credentials', async () => {
        const res = await request(app)
            .put('/api/device/entity/avatar')
            .send({ entityId: 0, avatar: '🦞' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('rejects missing avatar', async () => {
        const res = await request(app)
            .put('/api/device/entity/avatar')
            .send({ deviceId: 'test', deviceSecret: 'test', entityId: 0 });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('rejects invalid entityId', async () => {
        const res = await request(app)
            .put('/api/device/entity/avatar')
            .send({ deviceId: 'test', deviceSecret: 'test', entityId: -1, avatar: '🦞' });
        expect(res.status).toBe(400);
    });

    test('rejects emoji longer than 8 chars', async () => {
        const res = await request(app)
            .put('/api/device/entity/avatar')
            .send({ deviceId: 'test', deviceSecret: 'test', entityId: 0, avatar: '123456789' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/emoji/i);
    });

    test('accepts valid https:// URL as avatar', async () => {
        const res = await request(app)
            .put('/api/device/entity/avatar')
            .send({
                deviceId: 'test', deviceSecret: 'test', entityId: 0,
                avatar: 'https://live.staticflickr.com/65535/12345_abc_b.jpg'
            });
        // Will be 404 (device not found) but NOT 400 (validation passed)
        expect(res.status).toBe(404);
    });

    test('rejects URL longer than 500 chars', async () => {
        const longUrl = 'https://' + 'a'.repeat(500);
        const res = await request(app)
            .put('/api/device/entity/avatar')
            .send({ deviceId: 'test', deviceSecret: 'test', entityId: 0, avatar: longUrl });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/too long/i);
    });
});

describe('POST /api/device/entity/avatar/upload', () => {
    test('rejects missing credentials', async () => {
        const res = await request(app)
            .post('/api/device/entity/avatar/upload')
            .field('entityId', '0')
            .attach('file', Buffer.from('fake-image'), {
                filename: 'avatar.jpg',
                contentType: 'image/jpeg',
            });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('rejects missing file', async () => {
        const res = await request(app)
            .post('/api/device/entity/avatar/upload')
            .field('deviceId', 'test')
            .field('deviceSecret', 'test')
            .field('entityId', '0');
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/no image/i);
    });

    test('rejects invalid entityId', async () => {
        const res = await request(app)
            .post('/api/device/entity/avatar/upload')
            .field('deviceId', 'test')
            .field('deviceSecret', 'test')
            .field('entityId', '-1')
            .attach('file', Buffer.from('fake-image'), {
                filename: 'avatar.jpg',
                contentType: 'image/jpeg',
            });
        expect(res.status).toBe(400);
    });

    test('rejects non-image file type', async () => {
        const res = await request(app)
            .post('/api/device/entity/avatar/upload')
            .field('deviceId', 'test')
            .field('deviceSecret', 'test')
            .field('entityId', '0')
            .attach('file', Buffer.from('not-an-image'), {
                filename: 'test.txt',
                contentType: 'text/plain',
            });
        // multer fileFilter rejects non-image types
        expect([400, 404, 500]).toContain(res.status);
        expect(res.body.success).not.toBe(true);
    });

    test('rejects unknown device', async () => {
        const res = await request(app)
            .post('/api/device/entity/avatar/upload')
            .field('deviceId', 'nonexistent')
            .field('deviceSecret', 'wrong')
            .field('entityId', '0')
            .attach('file', Buffer.from('fake-image'), {
                filename: 'avatar.jpg',
                contentType: 'image/jpeg',
            });
        expect(res.status).toBe(404);
    });
});
