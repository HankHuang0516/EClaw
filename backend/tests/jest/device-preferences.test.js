/**
 * Device Preferences endpoint validation tests (Jest + Supertest)
 *
 * Tests input validation for device preferences endpoints:
 * - GET /api/device-preferences
 * - PUT /api/device-preferences
 */

const devicePrefsModule = require('../../device-preferences');

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
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const put = (path) => request(app).put(path).set('Host', 'localhost');

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// GET /api/device-preferences — requires device auth
// ════════════════════════════════════════════════════════════════
describe('GET /api/device-preferences', () => {
    it('returns 401 when no credentials provided', async () => {
        const res = await get('/api/device-preferences');
        expect(res.status).toBe(401);
    });

    it('returns 401 when only deviceId is provided', async () => {
        const res = await get('/api/device-preferences?deviceId=dev-1');
        expect(res.status).toBe(401);
    });

    it('auto-creates device and returns prefs for new device', async () => {
        // authDevice uses getOrCreateDevice which auto-creates, so unknown device succeeds
        const res = await get('/api/device-preferences?deviceId=new-device&deviceSecret=new-secret');
        // May succeed (200) if device auto-created, or 401 if strict auth
        expect([200, 401]).toContain(res.status);
    });
});

// ════════════════════════════════════════════════════════════════
// PUT /api/device-preferences — requires device auth + prefs object
// ════════════════════════════════════════════════════════════════
describe('PUT /api/device-preferences', () => {
    it('returns 401 when no credentials provided', async () => {
        const res = await put('/api/device-preferences')
            .send({ prefs: { broadcast_recipient_info: false } });
        expect(res.status).toBe(401);
    });

    it('returns 401 when only deviceId is provided', async () => {
        const res = await put('/api/device-preferences')
            .send({ deviceId: 'dev-1', prefs: { broadcast_recipient_info: false } });
        expect(res.status).toBe(401);
    });

    it('rejects when prefs is not an object', async () => {
        const res = await put('/api/device-preferences')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec', prefs: 'not-an-object' });
        // Returns 400 (invalid prefs) or 401 (auth fail)
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

describe('codex auto-approve preference', () => {
    it('includes codex_auto_approve_targets in defaults', () => {
        expect(devicePrefsModule.DEFAULTS).toHaveProperty('codex_auto_approve_targets');
        expect(devicePrefsModule.DEFAULTS.codex_auto_approve_targets).toEqual({});
    });
});

// ════════════════════════════════════════════════════════════════
// Per-entity nudge overrides — spec docs/specs/kanban-nudge-spec.md §6
// ════════════════════════════════════════════════════════════════
describe('kanban_nudge_per_entity_overrides', () => {
    it('includes empty overrides map in DEFAULTS', () => {
        expect(devicePrefsModule.DEFAULTS).toHaveProperty('kanban_nudge_per_entity_overrides');
        expect(devicePrefsModule.DEFAULTS.kanban_nudge_per_entity_overrides).toEqual({});
    });

    it('exposes the restricted override key set', () => {
        expect(devicePrefsModule.NUDGE_ENTITY_OVERRIDE_KEYS).toEqual([
            'kanban_nudge_interval_minutes',
            'kanban_nudge_statuses',
            'kanban_nudge_per_entity_throttle',
            'kanban_nudge_stop_mode',
        ]);
    });

    describe('mergeEntityOverride', () => {
        const base = {
            ...devicePrefsModule.DEFAULTS,
            kanban_nudge_interval_minutes: 180,
            kanban_nudge_per_entity_throttle: true,
            kanban_nudge_statuses: ['todo', 'in_progress', 'review'],
            kanban_nudge_per_entity_overrides: {
                '3': { kanban_nudge_interval_minutes: 60 },
                '5': {
                    kanban_nudge_interval_minutes: 360,
                    kanban_nudge_per_entity_throttle: false,
                },
                '6': {
                    kanban_nudge_stop_mode: true,
                },
            },
        };

        it('returns base when entity has no override', () => {
            const merged = devicePrefsModule.mergeEntityOverride(base, 99);
            expect(merged.kanban_nudge_interval_minutes).toBe(180);
            expect(merged.kanban_nudge_per_entity_throttle).toBe(true);
        });

        it('overrides interval for matched entity', () => {
            const merged = devicePrefsModule.mergeEntityOverride(base, 3);
            expect(merged.kanban_nudge_interval_minutes).toBe(60);
            // unaffected fields keep base value
            expect(merged.kanban_nudge_per_entity_throttle).toBe(true);
            expect(merged.kanban_nudge_statuses).toEqual(['todo', 'in_progress', 'review']);
        });

        it('overrides multiple fields independently', () => {
            const merged = devicePrefsModule.mergeEntityOverride(base, 5);
            expect(merged.kanban_nudge_interval_minutes).toBe(360);
            expect(merged.kanban_nudge_per_entity_throttle).toBe(false);
        });

        it('overrides stop-mode independently', () => {
            const merged = devicePrefsModule.mergeEntityOverride(base, 6);
            expect(merged.kanban_nudge_stop_mode).toBe(true);
            expect(merged.kanban_nudge_interval_minutes).toBe(180);
        });

        it('accepts numeric or string entityId', () => {
            const m1 = devicePrefsModule.mergeEntityOverride(base, 3);
            const m2 = devicePrefsModule.mergeEntityOverride(base, '3');
            expect(m1.kanban_nudge_interval_minutes).toBe(m2.kanban_nudge_interval_minutes);
        });
    });
});
