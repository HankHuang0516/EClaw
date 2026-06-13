/**
 * card_36a regression — POST /api/community/publish must return a
 * structured AGENT_CARD_INCOMPLETE error with the missing field list
 * when the entity has no agent card or an incomplete one.
 *
 * Before this fix the route returned a single generic 400 with
 * "Entity must have an agent card before publishing", which the
 * dashboard surfaced as a red banner with no actionable info — the
 * user couldn't tell whether description, protocols, or tags was
 * the blocker.
 *
 * Naming-conflict context: the dashboard's "make public" toggle and
 * the rental marketplace's "上架出租" button were both labeled with
 * the verb 上架; the i18n changes paired with this server fix split
 * them into card_plaza_make_public (free showcase) vs dash_list_rental
 * + ¥ icon (paid rental).
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
    setEntityPublic: jest.fn().mockResolvedValue(true),
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

jest.mock('../../device-preferences', () => ({
    init: jest.fn(),
    initTable: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../org-chart', () => ({
    initTable: jest.fn().mockResolvedValue(undefined),
    getOrgChart: jest.fn().mockResolvedValue({ hierarchy: {}, options: {} }),
    updateOrgChart: jest.fn().mockResolvedValue({ success: true, orgChart: {} }),
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
const indexMod = require('../../index');
const app = indexMod;
const { devices } = indexMod;

const TEST_DEVICE_ID = 'plaza-test-device';
const TEST_DEVICE_SECRET = 'plaza-test-secret';

function seedDevice(agentCard) {
    devices[TEST_DEVICE_ID] = {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        entities: {
            0: {
                entityId: 0,
                isBound: true,
                botSecret: 'bot-s-0',
                publicCode: 'abc123',
                character: 'LOBSTER',
                agentCard,
                isPublic: false,
            },
        },
    };
}

afterEach(() => {
    delete devices[TEST_DEVICE_ID];
});

describe('POST /api/community/publish — card_36a (AGENT_CARD_INCOMPLETE)', () => {
    test('returns AGENT_CARD_INCOMPLETE with all three missing fields when no agent card', async () => {
        seedDevice(null);
        const res = await request(app)
            .post('/api/community/publish')
            .send({
                deviceId: TEST_DEVICE_ID,
                deviceSecret: TEST_DEVICE_SECRET,
                entityId: 0,
                public: true,
            });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('AGENT_CARD_INCOMPLETE');
        expect(res.body.missingFields).toEqual(
            expect.arrayContaining(['description', 'protocols', 'tags'])
        );
        // Error message must enumerate the missing fields (not the old abstract string)
        expect(res.body.error).toMatch(/description/);
        expect(res.body.error).toMatch(/protocols/);
        expect(res.body.error).toMatch(/tags/);
    });

    test('returns missingFields=[protocols, tags] when only description is set', async () => {
        seedDevice({ description: 'A test bot', protocols: [], tags: [] });
        const res = await request(app)
            .post('/api/community/publish')
            .send({
                deviceId: TEST_DEVICE_ID,
                deviceSecret: TEST_DEVICE_SECRET,
                entityId: 0,
                public: true,
            });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AGENT_CARD_INCOMPLETE');
        expect(res.body.missingFields).toEqual(['protocols', 'tags']);
    });

    test('returns missingFields=[description] when protocols/tags are present but description missing', async () => {
        seedDevice({ description: '   ', protocols: ['A2A'], tags: ['chat'] });
        const res = await request(app)
            .post('/api/community/publish')
            .send({
                deviceId: TEST_DEVICE_ID,
                deviceSecret: TEST_DEVICE_SECRET,
                entityId: 0,
                public: true,
            });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('AGENT_CARD_INCOMPLETE');
        expect(res.body.missingFields).toEqual(['description']);
    });

    test('succeeds with a complete agent card', async () => {
        seedDevice({
            description: 'A test bot',
            protocols: ['A2A', 'REST'],
            tags: ['chat', 'automation'],
        });
        const res = await request(app)
            .post('/api/community/publish')
            .send({
                deviceId: TEST_DEVICE_ID,
                deviceSecret: TEST_DEVICE_SECRET,
                entityId: 0,
                public: true,
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.public).toBe(true);
    });

    test('public:false (unpublish) bypasses the AGENT_CARD_INCOMPLETE check', async () => {
        // Users who toggled off must still be able to do so even if their card was wiped
        seedDevice(null);
        const res = await request(app)
            .post('/api/community/publish')
            .send({
                deviceId: TEST_DEVICE_ID,
                deviceSecret: TEST_DEVICE_SECRET,
                entityId: 0,
                public: false,
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.public).toBe(false);
    });
});

// ── Naming-conflict check: i18n keys + UI wiring ──
describe('card_36a naming-conflict — i18n keys + UI separation', () => {
    const fs = require('fs');
    const path = require('path');
    const i18nSrc = fs.readFileSync(
        path.join(__dirname, '../../public/shared/i18n.js'),
        'utf8'
    );
    const dashboardSrc = fs.readFileSync(
        path.join(__dirname, '../../public/portal/dashboard.html'),
        'utf8'
    );
    const cardHolderSrc = fs.readFileSync(
        path.join(__dirname, '../../public/portal/card-holder.html'),
        'utf8'
    );
    const editorSrc = fs.readFileSync(
        path.join(__dirname, '../../public/portal/shared/agent-card-editor.js'),
        'utf8'
    );

    test('EN block defines the new card_plaza_make_public key (toggle label)', () => {
        expect(i18nSrc).toMatch(/"card_plaza_make_public":\s*"Make public on Plaza/);
        expect(i18nSrc).toMatch(/"card_plaza_make_public_hint":/);
    });

    test('EN block defines the missingFields helper keys', () => {
        expect(i18nSrc).toMatch(/"dash_plaza_incomplete_title":/);
        expect(i18nSrc).toMatch(/"dash_plaza_missing_description":/);
        expect(i18nSrc).toMatch(/"dash_plaza_missing_protocols":/);
        expect(i18nSrc).toMatch(/"dash_plaza_missing_tags":/);
    });

    test('zh-TW block defines the new Chinese toggle label "公開到廣場（免費展示）"', () => {
        expect(i18nSrc).toMatch(/"card_plaza_make_public":\s*"公開到廣場（免費展示）"/);
    });

    test('dashboard.html toggle uses card_plaza_make_public (not the old dash_plaza_publish)', () => {
        // Locate the plaza-toggle-row block and assert it references the new key
        const toggleBlock = dashboardSrc.match(
            /plaza-toggle-row[\s\S]{0,600}plaza-label[\s\S]{0,600}toggle-switch/
        );
        expect(toggleBlock).toBeTruthy();
        expect(toggleBlock[0]).toMatch(/card_plaza_make_public/);
        expect(toggleBlock[0]).not.toMatch(/dash_plaza_publish'/);
    });

    test('card-holder.html toggle uses card_plaza_make_public (not the old dash_plaza_publish)', () => {
        const toggleBlock = cardHolderSrc.match(
            /plaza-toggle-row[\s\S]{0,600}plaza-label[\s\S]{0,600}toggle-switch/
        );
        expect(toggleBlock).toBeTruthy();
        expect(toggleBlock[0]).toMatch(/card_plaza_make_public/);
        expect(toggleBlock[0]).not.toMatch(/dash_plaza_publish'/);
    });

    test('dashboard.html togglePlaza handler surfaces missingFields with red highlight', () => {
        expect(dashboardSrc).toMatch(/AGENT_CARD_INCOMPLETE/);
        expect(dashboardSrc).toMatch(/highlightMissingFields/);
        expect(dashboardSrc).toMatch(/plaza-missing-field/);
    });

    test('card-holder.html togglePlazaCH handler surfaces missingFields with red highlight', () => {
        expect(cardHolderSrc).toMatch(/AGENT_CARD_INCOMPLETE/);
        expect(cardHolderSrc).toMatch(/highlightChMissing/);
        expect(cardHolderSrc).toMatch(/plaza-missing-field/);
    });

    test('agent-card-editor rental button carries ¥/💴 icon + paid-rental suffix', () => {
        // aceRentalBtn line should now include the 💴 icon AND the paid-rental i18n suffix
        const rentalBtn = editorSrc.match(/aceRentalBtn[\s\S]{0,300}<\/button>/);
        expect(rentalBtn).toBeTruthy();
        expect(rentalBtn[0]).toMatch(/💴/);
        expect(rentalBtn[0]).toMatch(/dash_list_rental_paid_suffix/);
    });
});
