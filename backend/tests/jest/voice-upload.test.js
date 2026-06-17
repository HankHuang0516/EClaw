/**
 * Jest test: Voice / audio upload via POST /api/chat/upload-media
 *
 * Regression coverage for Bug #160 (GH#2861) "語音訊息發送失敗".
 *
 * Root cause: the multer fileFilter only accepted a short list of *bare* audio
 * mimes (audio/webm, audio/ogg, ...). Real recorders tag the blob with a
 * codec-suffixed mime ("audio/webm;codecs=opus", "audio/ogg;codecs=opus") and
 * Android MediaRecorder can emit audio/3gpp / audio/x-m4a, all of which were
 * rejected. The rejection Error escaped multer and hit Express's default HTML
 * 500 handler, so the app received a non-JSON body -> opaque "send failed" with
 * no diagnostic on the server side.
 *
 * Fixes asserted here:
 *  1. codec-suffixed audio mimes are accepted (base-type normalization),
 *  2. a genuinely unsupported audio mime is rejected with a clean JSON body
 *     (success:false) rather than an HTML 500 — i.e. no silent drop.
 */

// ── Same mocks as avatar-upload.test.js ──
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [{ id: 'fake-uuid' }], rowCount: 1 }),
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
    uploadPhoto: jest.fn().mockResolvedValue({ success: true, url: 'https://x/y.jpg', photoId: '1' }),
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

const request = require('supertest');
const app = require('../../index');

const AUDIO = Buffer.from('fake-audio-bytes');

describe('POST /api/chat/upload-media — voice (Bug #160)', () => {
    test('rejects missing credentials with JSON body (not HTML)', async () => {
        const res = await request(app)
            .post('/api/chat/upload-media')
            .field('mediaType', 'voice')
            .attach('file', AUDIO, { filename: 'voice.webm', contentType: 'audio/webm' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    // Core regression: codec-suffixed mimes from real recorders must be ACCEPTED
    // by the fileFilter (i.e. they must pass validation and reach auth/handler,
    // which returns 401 for the unknown device — NOT a 400 "unsupported" reject).
    const acceptedMimes = [
        ['audio/webm;codecs=opus', 'voice.webm'],
        ['audio/ogg;codecs=opus', 'voice.ogg'],
        ['audio/mp4', 'voice.m4a'],
        ['audio/3gpp', 'voice.3gp'],
        ['audio/x-m4a', 'voice.m4a'],
    ];
    test.each(acceptedMimes)('accepts real-recorder mime %s past the fileFilter', async (mime, name) => {
        const res = await request(app)
            .post('/api/chat/upload-media')
            // text fields BEFORE the file so req.body.mediaType is parsed first
            .field('deviceId', 'nonexistent-device')
            .field('deviceSecret', 'wrong')
            .field('mediaType', 'voice')
            .attach('file', AUDIO, { filename: name, contentType: mime });
        // Passed the filter -> failed auth (unknown device) = 401. The bug would
        // have produced a 400/500 "Unsupported audio type" instead.
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    // No silent drop: a genuinely unsupported audio mime is rejected with a
    // clean JSON body (success:false), never an HTML 500 from Express default.
    test('rejects unsupported audio mime with clean JSON (no silent drop)', async () => {
        const res = await request(app)
            .post('/api/chat/upload-media')
            .field('deviceId', 'nonexistent-device')
            .field('deviceSecret', 'wrong')
            .field('mediaType', 'voice')
            .attach('file', AUDIO, { filename: 'voice.txt', contentType: 'text/plain' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('upload_rejected');
        expect(typeof res.body.message).toBe('string');
        // Response must be JSON, not an HTML error page.
        expect(res.headers['content-type']).toMatch(/application\/json/);
    });
});
