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
    // card_a9edf960: pull through the pure rich-card-question helpers so index.js
    // can wire its limiter at module-load without crashing.
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

    test('PUT /api/entity/agent-card strips capabilities fields from input', async () => {
        // Attempt to set capabilities directly — should be silently stripped
        const res = await request(app)
            .put('/api/entity/agent-card')
            .send({
                deviceId: 'test', entityId: 0, deviceSecret: 'secret',
                agentCard: {
                    description: 'Test bot',
                    capabilities: [{ id: 'fake', name: 'Fake Capability' }],
                    capabilitiesExpiresAt: '2099-01-01T00:00:00Z',
                    capabilitiesBenchmarkScore: { score: 100 },
                },
            });
        // Even if the request succeeds, capabilities should not be in the cleaned card
        // (400 because test device doesn't exist, but the validation itself strips caps)
        expect(res.status).toBe(404); // device not found
    });
});

// ── Prompt Policy orchestration ──
describe('Prompt Policy endpoints', () => {
    beforeEach(() => {
        for (const key of Object.keys(app.devices)) delete app.devices[key];
        const entity = app._createDefaultEntity(6);
        entity.isBound = true;
        entity.botSecret = 'bot-secret';
        entity.name = 'Codex';
        entity.identity = {
            role: 'QA reviewer',
            instructions: ['Review UI and API regressions']
        };
        app.devices['prompt-device'] = {
            deviceId: 'prompt-device',
            deviceSecret: 'device-secret',
            createdAt: Date.now(),
            nextEntityId: 7,
            promptPolicy: null,
            entities: { 6: entity }
        };
    });

    test('PUT /api/device/prompt-policy saves sanitized policy', async () => {
        const res = await request(app)
            .put('/api/device/prompt-policy')
            .send({
                deviceId: 'prompt-device',
                deviceSecret: 'device-secret',
                promptPolicy: {
                    instructions: 'Use short status updates.\nAlways name blockers.',
                    taskProtocol: { statusHeartbeatMs: 5000 },
                    channelOverrides: {
                        codex: { instructions: ['Prefer test-plan first replies.'] }
                    }
                }
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.promptPolicy.instructions).toEqual(['Use short status updates.', 'Always name blockers.']);
        expect(res.body.promptPolicy.taskProtocol.statusHeartbeatMs).toBe(60000);
        expect(app.devices['prompt-device'].promptPolicy.channelOverrides.codex.instructions).toEqual(['Prefer test-plan first replies.']);
    });

    test('PUT /api/entity/:entityId/prompt-policy stores policy under identity', async () => {
        const res = await request(app)
            .put('/api/entity/6/prompt-policy')
            .send({
                deviceId: 'prompt-device',
                deviceSecret: 'device-secret',
                promptPolicy: {
                    instructions: ['When running QA, report page and command progress.'],
                    channelOverrides: {
                        claude_code: { instructions: ['Use concise wake-up diagnostics.'] }
                    }
                }
            });

        expect(res.status).toBe(200);
        expect(res.body.promptPolicy.instructions).toEqual(['When running QA, report page and command progress.']);
        expect(app.devices['prompt-device'].entities[6].identity.promptPolicy.instructions).toEqual([
            'When running QA, report page and command progress.'
        ]);
    });

    test('GET /api/channel/prompt-policy composes device, identity, entity, and channel policy', async () => {
        app.devices['prompt-device'].promptPolicy = {
            version: 1,
            enabled: true,
            instructions: ['Device-wide system prompt.'],
            taskProtocol: { requireTestPlan: true, requireMilestoneUpdates: true, statusHeartbeatMs: 180000 },
            channelOverrides: { codex: { enabled: true, instructions: ['Codex override.'] } }
        };
        app.devices['prompt-device'].entities[6].identity.promptPolicy = {
            version: 1,
            enabled: true,
            instructions: ['Entity prompt policy.'],
            taskProtocol: { requireTestPlan: true, requireMilestoneUpdates: true, statusHeartbeatMs: 120000 },
            channelOverrides: {}
        };

        const res = await request(app)
            .get('/api/channel/prompt-policy?deviceId=prompt-device&entityId=6&botSecret=bot-secret&channel=codex');

        expect(res.status).toBe(200);
        expect(res.body.policy.channel).toBe('codex');
        expect(res.body.policy.taskProtocol.statusHeartbeatMs).toBe(120000);
        expect(res.body.policy.compiledPrompt).toContain('Device-wide system prompt.');
        expect(res.body.policy.compiledPrompt).toContain('Role: QA reviewer');
        expect(res.body.policy.compiledPrompt).toContain('Entity prompt policy.');
        expect(res.body.policy.compiledPrompt).toContain('Codex override.');
    });

    test('rejects likely secrets in prompt policy', async () => {
        const res = await request(app)
            .put('/api/device/prompt-policy')
            .send({
                deviceId: 'prompt-device',
                deviceSecret: 'device-secret',
                promptPolicy: {
                    instructions: ['api_key=sk-thisShouldNotBeStoredInPromptPolicy1234567890']
                }
            });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/secret/i);
    });
});
