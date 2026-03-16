/**
 * Bot Tools endpoint tests (Jest + Supertest)
 *
 * Tests POST /api/bot/github-issue and POST /api/bot/audit-log
 * input validation, rate limiting, and response format.
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
    initDatabase: jest.fn().mockResolvedValue(false),
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

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// POST /api/bot/github-issue
// ════════════════════════════════════════════════════════════════
describe('POST /api/bot/github-issue', () => {
    it('rejects missing auth', async () => {
        const res = await post('/api/bot/github-issue')
            .send({ title: 'Test issue' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/deviceId/);
    });

    it('rejects missing title', async () => {
        const res = await post('/api/bot/github-issue')
            .send({ deviceId: 'test', deviceSecret: 'secret' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/title/);
    });

    it('rejects empty title', async () => {
        const res = await post('/api/bot/github-issue')
            .send({ deviceId: 'test', deviceSecret: 'secret', title: '   ' });
        expect(res.status).toBe(400);
    });

    it('rejects title over 256 chars', async () => {
        const res = await post('/api/bot/github-issue')
            .send({ deviceId: 'test', deviceSecret: 'secret', title: 'x'.repeat(257) });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/256/);
    });

    it('rejects body over 10000 chars', async () => {
        const res = await post('/api/bot/github-issue')
            .send({ deviceId: 'test', deviceSecret: 'secret', title: 'Test', body: 'x'.repeat(10001) });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/10000/);
    });

    it('returns 501 when GITHUB_TOKEN not set', async () => {
        const origToken = process.env.GITHUB_TOKEN;
        const origRepo = process.env.GITHUB_REPO;
        delete process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_REPO;

        const res = await post('/api/bot/github-issue')
            .send({ deviceId: 'test', deviceSecret: 'secret', title: 'Test issue', body: 'Details' });
        expect(res.status).toBe(501);
        expect(res.body.error).toMatch(/GitHub/);

        if (origToken) process.env.GITHUB_TOKEN = origToken;
        if (origRepo) process.env.GITHUB_REPO = origRepo;
    });

    it('accepts botSecret auth', async () => {
        const res = await post('/api/bot/github-issue')
            .send({ deviceId: 'test', botSecret: 'secret', title: 'Test' });
        // Should pass auth (400 won't happen since title is present, so 501 from missing GH config)
        expect(res.status).not.toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/bot/audit-log
// ════════════════════════════════════════════════════════════════
describe('POST /api/bot/audit-log', () => {
    it('rejects missing auth', async () => {
        const res = await post('/api/bot/audit-log')
            .send({ type: 'api-health', findings: [] });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/deviceId/);
    });

    it('rejects missing type', async () => {
        const res = await post('/api/bot/audit-log')
            .send({ deviceId: 'test', deviceSecret: 'secret', findings: [] });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/type/);
    });

    it('rejects invalid type', async () => {
        const res = await post('/api/bot/audit-log')
            .send({ deviceId: 'test', deviceSecret: 'secret', type: 'invalid-type', findings: [] });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/type/);
    });

    it('rejects missing findings', async () => {
        const res = await post('/api/bot/audit-log')
            .send({ deviceId: 'test', deviceSecret: 'secret', type: 'api-health' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/findings/);
    });

    it('rejects findings without item field', async () => {
        const res = await post('/api/bot/audit-log')
            .send({
                deviceId: 'test', deviceSecret: 'secret',
                type: 'api-health',
                findings: [{ status: 'ok' }]
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/item/);
    });

    it('rejects findings with invalid status', async () => {
        const res = await post('/api/bot/audit-log')
            .send({
                deviceId: 'test', deviceSecret: 'secret',
                type: 'api-health',
                findings: [{ item: '/api/health', status: 'good' }]
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/status/);
    });

    it('rejects more than 20 findings', async () => {
        const findings = Array.from({ length: 21 }, (_, i) => ({
            item: `/api/test-${i}`, status: 'ok'
        }));
        const res = await post('/api/bot/audit-log')
            .send({ deviceId: 'test', deviceSecret: 'secret', type: 'api-health', findings });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/20/);
    });

    it('returns structured audit result for valid input', async () => {
        const res = await post('/api/bot/audit-log')
            .send({
                deviceId: 'test', deviceSecret: 'secret',
                type: 'api-health',
                severity: 'warning',
                summary: 'Two endpoints slow',
                findings: [
                    { item: '/api/health', status: 'ok', detail: '120ms' },
                    { item: '/api/version', status: 'ok', detail: '80ms' },
                    { item: '/api/skill-templates', status: 'warning', detail: '3200ms', suggestion: 'Add caching' },
                ]
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.audit).toBeDefined();
        expect(res.body.audit.type).toBe('api-health');
        expect(res.body.audit.severity).toBe('warning');
        expect(res.body.audit.totalChecked).toBe(3);
        expect(res.body.audit.issuesFound).toBe(1);
        expect(res.body.audit.noteTitle).toMatch(/\[AUDIT\] api-health/);
        expect(res.body.audit.noteContent).toContain('skill-templates');
        expect(res.body.audit.noteContent).toContain('Add caching');
        expect(res.body.audit.storageHint).toContain('/api/mission/note/add');
    });

    it('handles all-ok findings', async () => {
        const res = await post('/api/bot/audit-log')
            .send({
                deviceId: 'test', deviceSecret: 'secret',
                type: 'url-validation',
                findings: [
                    { item: 'https://github.com/foo/bar', status: 'ok' },
                    { item: 'https://github.com/baz/qux', status: 'ok' },
                ]
            });
        expect(res.status).toBe(200);
        expect(res.body.audit.issuesFound).toBe(0);
        expect(res.body.audit.severity).toBe('info');
    });

    it('handles dead and stale findings', async () => {
        const res = await post('/api/bot/audit-log')
            .send({
                deviceId: 'test', deviceSecret: 'secret',
                type: 'url-validation',
                severity: 'critical',
                findings: [
                    { item: 'https://github.com/old/repo', status: 'dead', detail: '404' },
                    { item: 'https://github.com/stale/repo', status: 'stale', detail: 'last updated 2024-01' },
                ]
            });
        expect(res.status).toBe(200);
        expect(res.body.audit.issuesFound).toBe(2);
        expect(res.body.audit.noteContent).toContain('❌');
        expect(res.body.audit.noteContent).toContain('⚠️');
    });

    it('accepts all valid types', async () => {
        const types = [
            'url-validation', 'api-health', 'openapi-audit',
            'parity-audit', 'community-engagement', 'agent-card',
            'template-quality', 'general'
        ];
        for (const type of types) {
            const res = await post('/api/bot/audit-log')
                .send({
                    deviceId: 'test', deviceSecret: 'secret',
                    type,
                    findings: [{ item: 'test', status: 'ok' }]
                });
            expect(res.status).toBe(200);
        }
    });
});
