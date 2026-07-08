/**
 * /api/monitoring/rental-health endpoint tests
 *
 * Verifies:
 *   - 401 when no auth provided
 *   - 401 when invalid creds
 *   - happy-path response shape with status="green"
 *   - DB-down → status="red"
 *   - publisher disconnect detection
 */

// Singleton mock query so tests can override behavior per case
jest.mock('pg', () => {
    const mockQuery = jest.fn().mockResolvedValue({ rows: [{}], rowCount: 0 });
    const mockPool = {
        query: mockQuery,
        connect: jest.fn().mockResolvedValue({
            query: mockQuery,
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    };
    return {
        Pool: jest.fn().mockImplementation(() => mockPool),
        __mockQuery: mockQuery,
    };
});

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
const { __mockQuery } = require('pg');

let app;

beforeAll(() => {
    process.env.MONITORING_KEY = 'test-monitoring-key-1234';
    process.env.ADMIN_DEVICE_IDS = 'admin-device-1,admin-device-2';
    app = require('../../index');
});

afterAll(async () => {
    delete process.env.MONITORING_KEY;
    delete process.env.ADMIN_DEVICE_IDS;
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

beforeEach(() => {
    __mockQuery.mockReset();
    // Default: SELECT 1 returns ok, aggregate query returns realistic counts
    __mockQuery.mockResolvedValue({
        rows: [{
            trash_total: 5,
            trash_24h: 1,
            trash_oldest_age_sec: 3600,
            listings_active: 12,
            contracts_active: 3,
        }],
        rowCount: 1,
    });
});

describe('GET /api/monitoring/rental-health auth', () => {
    it('rejects missing auth with 401', async () => {
        const res = await request(app).get('/api/monitoring/rental-health');
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('rejects wrong monitoring key with 401', async () => {
        const res = await request(app).get('/api/monitoring/rental-health?key=wrong-key');
        expect(res.status).toBe(401);
    });

    it('accepts valid monitoring key', async () => {
        const res = await request(app)
            .get('/api/monitoring/rental-health?key=test-monitoring-key-1234');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('accepts X-Monitoring-Key header', async () => {
        const res = await request(app)
            .get('/api/monitoring/rental-health')
            .set('X-Monitoring-Key', 'test-monitoring-key-1234');
        expect(res.status).toBe(200);
    });

    it('rejects non-admin deviceId with 403', async () => {
        // Admin gate: deviceId not in ADMIN_DEVICE_IDS → 403 (not 401)
        const res = await request(app)
            .get('/api/monitoring/rental-health?deviceId=not-an-admin&deviceSecret=whatever');
        expect(res.status).toBe(403);
    });

    it('rejects admin deviceId without any secret with 401', async () => {
        const res = await request(app)
            .get('/api/monitoring/rental-health?deviceId=admin-device-1');
        expect(res.status).toBe(401);
    });

    it('rejects admin deviceId with wrong deviceSecret with 401', async () => {
        // admin-device-1 is in allowlist but no such device exists in memory
        const res = await request(app)
            .get('/api/monitoring/rental-health?deviceId=admin-device-1&deviceSecret=wrong');
        expect(res.status).toBe(401);
    });
});

// card_bb9f0e5c: deviceId alone is NOT a credential. Every requireAdmin-gated
// endpoint must demand deviceSecret proof (constant-time) — allowlisted
// deviceId with a missing/wrong secret is a 401.
describe('GET /api/admin/ping', () => {
    const { devices } = require('../../index');

    beforeEach(() => {
        devices['admin-device-1'] = { deviceSecret: 'admin-secret-xyz', entities: {} };
        devices['admin-device-2'] = { deviceSecret: 'admin-secret-abc', entities: {} };
    });

    afterEach(() => {
        delete devices['admin-device-1'];
        delete devices['admin-device-2'];
    });

    it('rejects missing deviceId with 401', async () => {
        const res = await request(app).get('/api/admin/ping');
        expect(res.status).toBe(401);
    });

    it('rejects non-admin deviceId with 403', async () => {
        const res = await request(app).get('/api/admin/ping?deviceId=not-an-admin');
        expect(res.status).toBe(403);
    });

    it('rejects admin deviceId WITHOUT deviceSecret with 401 (deviceId is not a secret)', async () => {
        const res = await request(app).get('/api/admin/ping?deviceId=admin-device-1');
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('rejects admin deviceId with WRONG deviceSecret with 401', async () => {
        const res = await request(app)
            .get('/api/admin/ping?deviceId=admin-device-1&deviceSecret=wrong-secret');
        expect(res.status).toBe(401);
    });

    it('accepts admin deviceId + matching deviceSecret and echoes deviceId back', async () => {
        const res = await request(app)
            .get('/api/admin/ping?deviceId=admin-device-1&deviceSecret=admin-secret-xyz');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, admin: true, deviceId: 'admin-device-1' });
    });

    it('accepts credentials via x-device-id + x-device-secret headers', async () => {
        const res = await request(app)
            .get('/api/admin/ping')
            .set('X-Device-Id', 'admin-device-2')
            .set('X-Device-Secret', 'admin-secret-abc');
        expect(res.status).toBe(200);
        expect(res.body.deviceId).toBe('admin-device-2');
    });

    it('rejects x-device-id header without x-device-secret with 401', async () => {
        const res = await request(app).get('/api/admin/ping').set('X-Device-Id', 'admin-device-2');
        expect(res.status).toBe(401);
    });
});

describe('wishlist-matchmaking admin endpoints require deviceSecret proof (card_bb9f0e5c)', () => {
    const { devices } = require('../../index');

    beforeEach(() => {
        devices['admin-device-1'] = { deviceSecret: 'admin-secret-xyz', entities: {} };
    });

    afterEach(() => {
        delete devices['admin-device-1'];
    });

    it('GET /api/wishlist-matchmaking/metrics rejects admin deviceId without deviceSecret (401)', async () => {
        const res = await request(app)
            .get('/api/wishlist-matchmaking/metrics?deviceId=admin-device-1');
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('GET /api/wishlist-matchmaking/metrics rejects wrong deviceSecret (401)', async () => {
        const res = await request(app)
            .get('/api/wishlist-matchmaking/metrics?deviceId=admin-device-1&deviceSecret=wrong');
        expect(res.status).toBe(401);
    });

    it('GET /api/wishlist-matchmaking/metrics accepts matching deviceSecret (200)', async () => {
        const res = await request(app)
            .get('/api/wishlist-matchmaking/metrics?deviceId=admin-device-1&deviceSecret=admin-secret-xyz');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('POST /api/wishlist-matchmaking/offline/drain rejects admin deviceId without deviceSecret (401)', async () => {
        const res = await request(app)
            .post('/api/wishlist-matchmaking/offline/drain')
            .send({ deviceId: 'admin-device-1' });
        expect(res.status).toBe(401);
    });

    it('POST /api/wishlist-matchmaking/offline/drain accepts matching deviceSecret in body (200)', async () => {
        const res = await request(app)
            .post('/api/wishlist-matchmaking/offline/drain')
            .send({ deviceId: 'admin-device-1', deviceSecret: 'admin-secret-xyz' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

describe('classifyPublisher (threshold math)', () => {
    const { _classifyPublisher: classify } = require('../../index');

    it('configured platform with no error → connected', () => {
        expect(classify({ id: 'devto', configured: true })).toBe('connected');
    });

    it('configured but lastError → disconnected', () => {
        expect(classify({ id: 'devto', configured: true, error: 'token expired' })).toBe('disconnected');
    });

    it('configured but expiresAt in past → disconnected', () => {
        expect(classify({ id: 'devto', configured: true, expiresAt: Date.now() - 1000 })).toBe('disconnected');
    });

    it('configured with future expiresAt → connected', () => {
        expect(classify({ id: 'devto', configured: true, expiresAt: Date.now() + 1000 })).toBe('connected');
    });

    it('unconfigured platform with no setup trace → unconfigured', () => {
        expect(classify({ id: 'reddit', configured: false })).toBe('unconfigured');
    });

    // WordPress-specific classify branches removed 2026-04-20 along with
    // the platform itself. Special-case `classifyPublisher` no longer has a
    // wordpress branch; generic configured/unconfigured rules above cover it.
});

describe('GET /api/monitoring/rental-health threshold math (status)', () => {
    // Helper to fetch response with MONITORING_KEY (bypasses admin gate).
    const fetchHealth = () => request(app).get('/api/monitoring/rental-health?key=test-monitoring-key-1234');

    it('1 disconnected → yellow (was red, intentionally de-escalated)', async () => {
        // Mock one disconnected platform via getPlatformsStatus (matches the
        // pattern used by the 2-/3-disconnected tests below).
        const articlePublisher = require('../../article-publisher');
        const origFn = articlePublisher.getPlatformsStatus;
        articlePublisher.getPlatformsStatus = () => ([
            { id: 'blogger', name: 'Blogger', region: 'global', configured: true, error: 'token expired' },
            { id: 'telegraph', name: 'Telegraph', region: 'global', configured: true },
        ]);
        try {
            const res = await fetchHealth();
            expect(res.status).toBe(200);
            expect(res.body.thresholds.publisherCounts.disconnected).toBe(1);
            expect(res.body.thresholds.status).toBe('yellow');
        } finally {
            articlePublisher.getPlatformsStatus = origFn;
        }
    });

    it('unconfigured platforms alone → green (not red)', async () => {
        // No WP env set → WP becomes unconfigured, others unconfigured too.
        delete process.env.WORDPRESS_CLIENT_ID;
        delete process.env.WORDPRESS_CLIENT_SECRET;
        const res = await fetchHealth();
        expect(res.status).toBe(200);
        expect(res.body.thresholds.publisherCounts.disconnected).toBe(0);
        expect(res.body.thresholds.publisherCounts.unconfigured).toBeGreaterThan(0);
        expect(res.body.thresholds.status).toBe('green');
    });

    it('publisherCounts and state present on each publisher', async () => {
        const res = await fetchHealth();
        expect(res.body.thresholds.publisherCounts).toMatchObject({
            connected: expect.any(Number),
            disconnected: expect.any(Number),
            unconfigured: expect.any(Number),
        });
        expect(res.body.publishers[0].state).toMatch(/^(connected|disconnected|unconfigured)$/);
    });

    it('3+ disconnected → red (hits publisherDisconnectedRed boundary)', async () => {
        // Force 3 platforms into disconnected state by setting configured=true + error
        // on 3 of them. Easiest: reach into articlePublisher and mock getPlatformsStatus.
        const articlePublisher = require('../../article-publisher');
        const origFn = articlePublisher.getPlatformsStatus;
        articlePublisher.getPlatformsStatus = () => ([
            { id: 'blogger', name: 'Blogger', region: 'global', configured: true, error: 'token expired' },
            { id: 'qiita', name: 'Qiita', region: 'ja', configured: true, error: 'api quota exceeded' },
            { id: 'devto', name: 'DEV.to', region: 'global', configured: true, error: 'unauthorized' },
            { id: 'telegraph', name: 'Telegraph', region: 'global', configured: true },
        ]);
        try {
            const res = await fetchHealth();
            expect(res.status).toBe(200);
            expect(res.body.thresholds.publisherCounts.disconnected).toBe(3);
            expect(res.body.thresholds.status).toBe('red');
            expect(res.body.thresholds.issues.some(i => i.startsWith('publisher_multi_disconnected:3'))).toBe(true);
        } finally {
            articlePublisher.getPlatformsStatus = origFn;
        }
    });

    it('2 disconnected → yellow (not red — previous threshold was too aggressive)', async () => {
        const articlePublisher = require('../../article-publisher');
        const origFn = articlePublisher.getPlatformsStatus;
        articlePublisher.getPlatformsStatus = () => ([
            { id: 'blogger', name: 'Blogger', region: 'global', configured: true, error: 'token expired' },
            { id: 'qiita', name: 'Qiita', region: 'ja', configured: true, error: 'api quota exceeded' },
            { id: 'telegraph', name: 'Telegraph', region: 'global', configured: true },
            { id: 'reddit', name: 'Reddit', region: 'global', configured: false },
        ]);
        try {
            const res = await fetchHealth();
            expect(res.body.thresholds.publisherCounts.disconnected).toBe(2);
            expect(res.body.thresholds.publisherCounts.unconfigured).toBe(1);
            expect(res.body.thresholds.status).toBe('yellow');
        } finally {
            articlePublisher.getPlatformsStatus = origFn;
        }
    });
});

describe('GET /api/monitoring/rental-health admin-gate happy path', () => {
    it('admin deviceId + valid deviceSecret → 200 (full admin auth path)', async () => {
        // Inject a device into the in-memory store so admin auth can succeed.
        const { devices } = require('../../index');
        devices['admin-device-1'] = {
            deviceSecret: 'admin-secret-xyz',
            entities: {},
        };
        try {
            const res = await request(app)
                .get('/api/monitoring/rental-health?deviceId=admin-device-1&deviceSecret=admin-secret-xyz');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        } finally {
            delete devices['admin-device-1'];
        }
    });
});

describe('GET /api/monitoring/rental-health happy path', () => {
    it('returns expected top-level shape', async () => {
        const res = await request(app)
            .get('/api/monitoring/rental-health?key=test-monitoring-key-1234');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            uptime: expect.objectContaining({ seconds: expect.any(Number), startedAt: expect.any(String) }),
            db: expect.objectContaining({ status: 'up' }),
            rentalFleet: expect.objectContaining({ listingsActive: 12, contractsActive: 3 }),
            publicCodeTombstone: expect.objectContaining({ size: expect.any(Number) }),
            publishers: expect.any(Array),
            thresholds: expect.objectContaining({ status: expect.stringMatching(/green|yellow|red/), issues: expect.any(Array) }),
        });
    });

    it('returns aggregate trash counts from DB', async () => {
        const res = await request(app)
            .get('/api/monitoring/rental-health?key=test-monitoring-key-1234');
        // In test env publishers are mostly unconfigured so status is red,
        // but DB shape and counts must be present and correct.
        expect(res.body.db.status).toBe('up');
        expect(res.body.db.entityTrash.totalRows).toBe(5);
        expect(res.body.db.entityTrash.rowsLast24h).toBe(1);
        expect(res.body.db.entityTrash.oldestRowAgeSeconds).toBe(3600);
    });

    it('publishers list contains 9 platforms (mastodon retired 2026-04-15, wordpress 2026-04-20, hashnode 2026-05-27)', async () => {
        const res = await request(app)
            .get('/api/monitoring/rental-health?key=test-monitoring-key-1234');
        expect(res.body.publishers.length).toBe(9);
        const ids = res.body.publishers.map(p => p.id);
        expect(ids).not.toContain('mastodon');
        expect(ids).not.toContain('wordpress');
        expect(ids).not.toContain('hashnode');
        expect(res.body.publishers[0]).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            connected: expect.any(Boolean),
        });
    });
});

describe('GET /api/monitoring/rental-health DB failure', () => {
    it('returns red status when DB ping rejects', async () => {
        __mockQuery.mockReset();
        __mockQuery.mockRejectedValue(new Error('ECONNREFUSED'));
        const res = await request(app)
            .get('/api/monitoring/rental-health?key=test-monitoring-key-1234');
        expect(res.status).toBe(200);
        expect(res.body.db.status).toBe('down');
        expect(res.body.thresholds.status).toBe('red');
        expect(res.body.thresholds.issues.some(i => i.startsWith('db_disconnected'))).toBe(true);
    });

    it('still returns 200 with safe defaults when aggregate query fails', async () => {
        __mockQuery.mockReset();
        __mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 0 }); // SELECT 1 ok
        __mockQuery.mockRejectedValueOnce(new Error('relation does not exist')); // aggregate fails
        const res = await request(app)
            .get('/api/monitoring/rental-health?key=test-monitoring-key-1234');
        expect(res.status).toBe(200);
        expect(res.body.db.status).toBe('up');
        expect(res.body.thresholds.issues.some(i => i.startsWith('db_aggregate_failed'))).toBe(true);
    });
});
