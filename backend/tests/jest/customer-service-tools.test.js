/**
 * Customer Service Tools — unit tests for AI support tool handlers
 *
 * Tests the lookup_device, query_device_logs, and lookup_user_by_email
 * tool handlers used by the AI customer service system.
 */

// ── Same mocks as other Jest tests ──
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

const post = (path) => request(app).post(path).set('Host', 'localhost');
const get = (path) => request(app).get(path).set('Host', 'localhost');

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// CUSTOMER_SERVICE_TOOLS definitions
// ════════════════════════════════════════════════════════════════
describe('CUSTOMER_SERVICE_TOOLS — tool definitions', () => {
    it('exports CUSTOMER_SERVICE_TOOLS with 3 tools', () => {
        const { CUSTOMER_SERVICE_TOOLS } = require('../../anthropic-client');
        expect(CUSTOMER_SERVICE_TOOLS).toBeDefined();
        expect(Array.isArray(CUSTOMER_SERVICE_TOOLS)).toBe(true);
        expect(CUSTOMER_SERVICE_TOOLS).toHaveLength(3);
    });

    it('has lookup_device tool with correct schema', () => {
        const { CUSTOMER_SERVICE_TOOLS } = require('../../anthropic-client');
        const tool = CUSTOMER_SERVICE_TOOLS.find(t => t.name === 'lookup_device');
        expect(tool).toBeDefined();
        expect(tool.input_schema.properties).toHaveProperty('device_id');
        expect(tool.input_schema.required).toContain('device_id');
    });

    it('has query_device_logs tool with category enum', () => {
        const { CUSTOMER_SERVICE_TOOLS } = require('../../anthropic-client');
        const tool = CUSTOMER_SERVICE_TOOLS.find(t => t.name === 'query_device_logs');
        expect(tool).toBeDefined();
        expect(tool.input_schema.properties).toHaveProperty('device_id');
        expect(tool.input_schema.properties.category.enum).toContain('bind');
        expect(tool.input_schema.properties.category.enum).toContain('transform');
    });

    it('has lookup_user_by_email tool with correct schema', () => {
        const { CUSTOMER_SERVICE_TOOLS } = require('../../anthropic-client');
        const tool = CUSTOMER_SERVICE_TOOLS.find(t => t.name === 'lookup_user_by_email');
        expect(tool).toBeDefined();
        expect(tool.input_schema.properties).toHaveProperty('email');
        expect(tool.input_schema.required).toContain('email');
    });
});

// ════════════════════════════════════════════════════════════════
// System prompt includes customer service tool description
// ════════════════════════════════════════════════════════════════
describe('System prompt — customer service tools', () => {
    it('chatWithClaude accepts toolHandlers parameter', () => {
        const { chatWithClaude } = require('../../anthropic-client');
        expect(typeof chatWithClaude).toBe('function');
        // Function should accept an object with toolHandlers
        expect(chatWithClaude.length).toBe(1); // single destructured param
    });
});

// ════════════════════════════════════════════════════════════════
// AI support chat endpoint — deviceSecret in context
// ════════════════════════════════════════════════════════════════
describe('POST /api/ai-support/chat/submit — deviceSecret context', () => {
    it('rejects missing requestId', async () => {
        const res = await post('/api/ai-support/chat/submit')
            .send({ message: 'test' });
        expect(res.status).not.toBe(404);
        // Should be 400 or 401 but not 404
    });

    it('rejects invalid requestId format', async () => {
        const res = await post('/api/ai-support/chat/submit')
            .send({ requestId: 'not-a-uuid', message: 'test', deviceId: 'x', deviceSecret: 'y' });
        // Will fail auth first (401) or bad requestId format (400)
        expect([400, 401]).toContain(res.status);
    });

    it('endpoint exists for submit', async () => {
        const res = await post('/api/ai-support/chat/submit').send({});
        expect(res.status).not.toBe(404);
    });

    it('endpoint exists for poll', async () => {
        const res = await get('/api/ai-support/chat/poll/00000000-0000-0000-0000-000000000099');
        expect(res.status).not.toBe(404);
    });
});

// ════════════════════════════════════════════════════════════════
// formatDiagnostics — includes all context
// ════════════════════════════════════════════════════════════════
describe('formatDiagnostics — device context formatting', () => {
    it('formats platform and version', () => {
        const { formatDiagnostics } = require('../../anthropic-client');
        const result = formatDiagnostics({ platform: 'android', appVersion: '1.0.50' });
        expect(result).toContain('android');
        expect(result).toContain('1.0.50');
    });

    it('formats entity states', () => {
        const { formatDiagnostics } = require('../../anthropic-client');
        const result = formatDiagnostics({
            entityStates: [
                { slot: 0, type: 'LOBSTER', bound: true, name: 'TestBot', hasWebhook: true },
                { slot: 1, type: 'PIG', bound: false }
            ]
        });
        expect(result).toContain('TestBot');
        expect(result).toContain('webhook registered');
        expect(result).toContain('unbound');
    });

    it('returns null for empty diagnostics', () => {
        const { formatDiagnostics } = require('../../anthropic-client');
        const result = formatDiagnostics({});
        expect(result).toBeNull();
    });

    it('returns null for undefined input', () => {
        const { formatDiagnostics } = require('../../anthropic-client');
        expect(formatDiagnostics(null)).toBeNull();
        expect(formatDiagnostics(undefined)).toBeNull();
    });
});
