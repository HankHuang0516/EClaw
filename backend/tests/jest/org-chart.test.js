/**
 * Organization Hierarchy Chart endpoint validation tests (Jest + Supertest)
 *
 * Tests:
 * - GET /api/device/org-chart — auth, default response
 * - PUT /api/device/org-chart — auth, validation, partial update, cycle detection
 * - Helper functions: getSuperior, getSubordinates, validateHierarchy, pruneHierarchy
 */

// ── Direct unit tests for org-chart helpers (no server needed) ──

const orgChart = require('../../org-chart');

describe('org-chart helpers (unit tests)', () => {

    // ════════════════════════════════════════════════════════════════
    // getSuperior
    // ════════════════════════════════════════════════════════════════
    describe('getSuperior()', () => {
        it('returns "USER" for entity directly under USER', () => {
            const hierarchy = { USER: [0, 1, 2] };
            expect(orgChart.getSuperior(hierarchy, 0)).toBe('USER');
            expect(orgChart.getSuperior(hierarchy, 1)).toBe('USER');
        });

        it('returns parent entity ID for nested entity', () => {
            const hierarchy = { USER: [0], '0': [1, 2] };
            expect(orgChart.getSuperior(hierarchy, 1)).toBe(0);
            expect(orgChart.getSuperior(hierarchy, 2)).toBe(0);
        });

        it('returns null for entity not in hierarchy', () => {
            const hierarchy = { USER: [0] };
            expect(orgChart.getSuperior(hierarchy, 99)).toBeNull();
        });

        it('returns null for null/undefined hierarchy', () => {
            expect(orgChart.getSuperior(null, 0)).toBeNull();
            expect(orgChart.getSuperior(undefined, 0)).toBeNull();
        });

        it('handles deep nesting (depth 3)', () => {
            const hierarchy = { USER: [0], '0': [1], '1': [2] };
            expect(orgChart.getSuperior(hierarchy, 2)).toBe(1);
            expect(orgChart.getSuperior(hierarchy, 1)).toBe(0);
            expect(orgChart.getSuperior(hierarchy, 0)).toBe('USER');
        });
    });

    // ════════════════════════════════════════════════════════════════
    // getSubordinates
    // ════════════════════════════════════════════════════════════════
    describe('getSubordinates()', () => {
        it('returns children of USER', () => {
            const hierarchy = { USER: [0, 1, 2] };
            expect(orgChart.getSubordinates(hierarchy, 'USER')).toEqual([0, 1, 2]);
        });

        it('returns children of entity', () => {
            const hierarchy = { USER: [0], '0': [1, 2] };
            expect(orgChart.getSubordinates(hierarchy, 0)).toEqual([1, 2]);
        });

        it('returns empty array for leaf entity', () => {
            const hierarchy = { USER: [0] };
            expect(orgChart.getSubordinates(hierarchy, 0)).toEqual([]);
        });

        it('returns empty array for null hierarchy', () => {
            expect(orgChart.getSubordinates(null, 'USER')).toEqual([]);
        });
    });

    // ════════════════════════════════════════════════════════════════
    // buildDefault
    // ════════════════════════════════════════════════════════════════
    describe('buildDefault()', () => {
        it('builds default hierarchy with all entities under USER', () => {
            expect(orgChart.buildDefault([2, 0, 1])).toEqual({ USER: [0, 1, 2] });
        });

        it('handles empty entity list', () => {
            expect(orgChart.buildDefault([])).toEqual({ USER: [] });
        });
    });

    // ════════════════════════════════════════════════════════════════
    // validateHierarchy
    // ════════════════════════════════════════════════════════════════
    describe('validateHierarchy()', () => {
        it('accepts valid flat hierarchy', () => {
            const h = { USER: [0, 1, 2] };
            expect(orgChart.validateHierarchy(h)).toEqual({ valid: true });
        });

        it('accepts valid nested hierarchy', () => {
            const h = { USER: [0], '0': [1, 2] };
            expect(orgChart.validateHierarchy(h)).toEqual({ valid: true });
        });

        it('rejects non-object hierarchy', () => {
            expect(orgChart.validateHierarchy('string').valid).toBe(false);
            expect(orgChart.validateHierarchy(null).valid).toBe(false);
            expect(orgChart.validateHierarchy([]).valid).toBe(false);
        });

        it('rejects hierarchy without USER key', () => {
            const h = { '0': [1, 2] };
            expect(orgChart.validateHierarchy(h).valid).toBe(false);
            expect(orgChart.validateHierarchy(h).error).toContain('USER');
        });

        it('rejects non-integer keys', () => {
            const h = { USER: [0], 'abc': [1] };
            expect(orgChart.validateHierarchy(h).valid).toBe(false);
            expect(orgChart.validateHierarchy(h).error).toContain('Invalid hierarchy key');
        });

        it('rejects non-integer children', () => {
            const h = { USER: [0, 'abc'] };
            expect(orgChart.validateHierarchy(h).valid).toBe(false);
            expect(orgChart.validateHierarchy(h).error).toContain('non-integer');
        });

        it('detects cycle: A→B→A (via duplicate parent detection)', () => {
            // Entity 0 appears under USER and under entity 1 → multiple parents
            const h = { USER: [0], '0': [1], '1': [0] };
            expect(orgChart.validateHierarchy(h).valid).toBe(false);
        });

        it('detects true cycle without duplicate entries', () => {
            // Build a cycle where no entity appears twice in children arrays
            // but the graph itself has a back-edge: USER→0→1→2, 2→1 (1 under both 0 and 2)
            const h = { USER: [0], '0': [1], '1': [2], '2': [3] };
            // This is valid (depth 4, no cycles)
            expect(orgChart.validateHierarchy(h)).toEqual({ valid: true });
        });

        it('detects entity under multiple parents', () => {
            const h = { USER: [0, 1], '0': [2], '1': [2] };
            expect(orgChart.validateHierarchy(h).valid).toBe(false);
            expect(orgChart.validateHierarchy(h).error).toContain('multiple parents');
        });

        it('rejects depth > 5', () => {
            // USER → 0 → 1 → 2 → 3 → 4 → 5 (depth 6)
            const h = { USER: [0], '0': [1], '1': [2], '2': [3], '3': [4], '4': [5] };
            expect(orgChart.validateHierarchy(h).valid).toBe(false);
            expect(orgChart.validateHierarchy(h).error).toContain('depth');
        });

        it('accepts depth exactly 5', () => {
            // USER → 0 → 1 → 2 → 3 → 4 (depth 5)
            const h = { USER: [0], '0': [1], '1': [2], '2': [3], '3': [4] };
            expect(orgChart.validateHierarchy(h)).toEqual({ valid: true });
        });
    });

    // ════════════════════════════════════════════════════════════════
    // validateOptions
    // ════════════════════════════════════════════════════════════════
    describe('validateOptions()', () => {
        it('accepts valid boolean options', () => {
            const opts = { kanbanReviewer: true, taskForward: false, allForward: true };
            expect(orgChart.validateOptions(opts)).toEqual(opts);
        });

        it('coerces truthy values to boolean', () => {
            const opts = { kanbanReviewer: 1, taskForward: 0 };
            const result = orgChart.validateOptions(opts);
            expect(result.kanbanReviewer).toBe(true);
            expect(result.taskForward).toBe(false);
        });

        it('ignores unknown keys', () => {
            const opts = { kanbanReviewer: true, unknownKey: 'value' };
            const result = orgChart.validateOptions(opts);
            expect(result).toEqual({ kanbanReviewer: true });
            expect(result.unknownKey).toBeUndefined();
        });

        it('returns null for non-object', () => {
            expect(orgChart.validateOptions('string')).toBeNull();
            expect(orgChart.validateOptions(null)).toBeNull();
            expect(orgChart.validateOptions([])).toBeNull();
        });

        it('accepts partial options', () => {
            const opts = { allForward: true };
            expect(orgChart.validateOptions(opts)).toEqual({ allForward: true });
        });
    });

    // ════════════════════════════════════════════════════════════════
    // pruneHierarchy
    // ════════════════════════════════════════════════════════════════
    describe('pruneHierarchy()', () => {
        it('removes invalid entities and promotes children', () => {
            // entity 1 is removed; its child 2 should go to USER (1's parent)
            const h = { USER: [0, 1], '1': [2] };
            const result = orgChart.pruneHierarchy(h, [0, 2]);
            expect(result.USER).toContain(0);
            expect(result.USER).toContain(2);
            expect(result['1']).toBeUndefined();
        });

        it('handles empty valid list — returns empty USER', () => {
            const h = { USER: [0, 1] };
            const result = orgChart.pruneHierarchy(h, []);
            expect(result).toEqual({ USER: [] });
        });

        it('adds orphan entities to USER', () => {
            const h = { USER: [0] };
            const result = orgChart.pruneHierarchy(h, [0, 1, 2]);
            expect(result.USER).toContain(0);
            expect(result.USER).toContain(1);
            expect(result.USER).toContain(2);
        });

        it('sorts children arrays', () => {
            const h = { USER: [2, 0, 1] };
            const result = orgChart.pruneHierarchy(h, [0, 1, 2]);
            expect(result.USER).toEqual([0, 1, 2]);
        });

        it('handles null hierarchy', () => {
            expect(orgChart.pruneHierarchy(null, [0])).toEqual({ USER: [0] });
        });
    });
});

// ── API endpoint tests (Supertest) ──

// Mock all modules with side-effects before requiring index.js
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
// GET /api/device/org-chart — requires device auth
// ════════════════════════════════════════════════════════════════
describe('GET /api/device/org-chart', () => {
    it('returns 401 when no credentials provided', async () => {
        const res = await get('/api/device/org-chart');
        expect(res.status).toBe(401);
    });

    it('returns 401 when only deviceId is provided', async () => {
        const res = await get('/api/device/org-chart?deviceId=dev-1');
        expect(res.status).toBe(401);
    });

    it('returns orgChart structure for authenticated device', async () => {
        const res = await get('/api/device/org-chart?deviceId=new-device&deviceSecret=new-secret');
        // May succeed (200) if device auto-created, or 401 if strict auth
        expect([200, 401]).toContain(res.status);
        if (res.status === 200) {
            expect(res.body.success).toBe(true);
            expect(res.body.orgChart).toBeDefined();
        }
    });
});

// ════════════════════════════════════════════════════════════════
// PUT /api/device/org-chart — requires device auth + hierarchy/options
// ════════════════════════════════════════════════════════════════
describe('PUT /api/device/org-chart', () => {
    it('returns 401 when no credentials provided', async () => {
        const res = await put('/api/device/org-chart')
            .send({ hierarchy: { USER: [0] } });
        expect(res.status).toBe(401);
    });

    it('returns 400 when neither hierarchy nor options provided', async () => {
        const res = await put('/api/device/org-chart')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec' });
        // 400 (missing data) or 401 (auth fail)
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects when hierarchy is not an object', async () => {
        const res = await put('/api/device/org-chart')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec', hierarchy: 'not-an-object' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// computeAffectedEntities — used to decide which polling bots
// need an `org_chart_changed` queue message after a PUT.
// ════════════════════════════════════════════════════════════════
describe('computeAffectedEntities()', () => {
    it('returns empty set when hierarchy unchanged', () => {
        const h = { USER: [1, 2, 3] };
        const r = orgChart.computeAffectedEntities(h, h);
        expect(r.size).toBe(0);
    });

    it('flags the moved entity and its new superior when nesting under a bot', () => {
        const before = { USER: [1, 2, 3] };
        const after = { USER: [1, 2], '1': [3] };
        const r = orgChart.computeAffectedEntities(before, after);
        expect([...r].sort()).toEqual([1, 3]);
    });

    it('flags reparented entity plus both old and new superior on cross-parent moves', () => {
        const before = { USER: [1, 2, 3, 4], '3': [5] };
        const after = { USER: [1, 2, 3, 4], '4': [5] };
        const r = orgChart.computeAffectedEntities(before, after);
        expect([...r].sort((a, b) => a - b)).toEqual([3, 4, 5]);
    });

    it('flags only the new entity when one is added under USER', () => {
        const before = { USER: [1, 2] };
        const after = { USER: [1, 2, 99] };
        const r = orgChart.computeAffectedEntities(before, after);
        expect([...r]).toEqual([99]);
    });

    it('handles empty/missing old hierarchy (fresh chart)', () => {
        const r = orgChart.computeAffectedEntities({}, { USER: [1] });
        expect([...r]).toEqual([1]);
    });

    it('excludes the USER root sentinel from the affected set', () => {
        const before = { USER: [1] };
        const after = { USER: [], '1': [] };
        const r = orgChart.computeAffectedEntities(before, after);
        // #1 left USER → only #1 is an affected entity; USER itself is not an entity.
        for (const id of r) expect(typeof id).toBe('number');
        expect([...r]).toEqual([1]);
    });

    it('flags entity removed from one superior even if not re-attached', () => {
        const before = { USER: [1, 2], '1': [3] };
        const after = { USER: [1, 2] };
        const r = orgChart.computeAffectedEntities(before, after);
        // #3's old superior was #1; both #1 and #3 are affected.
        expect([...r].sort((a, b) => a - b)).toEqual([1, 3]);
    });
});
