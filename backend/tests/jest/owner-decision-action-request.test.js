// Owner-decision additions to the agent_action_requests module:
//   子1  decision_context create-validation + rowToApi emit + PUT edit
//   子3  shared createActionRequest()
//   子6a dismissActionRequestsForCard()
//   子6b timeout worker pins decision_context rows to 'keep'
//
// Mocks pg so the module's Pool() is captured (mirrors agent-action-requests.test.js).

const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockPoolQuery,
        connect: jest.fn().mockResolvedValue({ query: mockPoolQuery, release: jest.fn() }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const express = require('express');
const request = require('supertest');

const deviceId = 'test-dev';
const deviceSecret = 'dev-secret';
const UUID = '11111111-2222-3333-4444-555555555555';
const CARD = 'card_abc123';

let app;
let mod;
const devices = {
    [deviceId]: {
        deviceSecret,
        entities: { 2: { isBound: true, botSecret: 'bot-2' } },
    },
};

beforeAll(() => {
    app = express();
    app.use(express.json());
    // Inject getDevicePrefs so the timeout worker never touches device-preferences.
    // action_request_ratify_enabled:false isolates this suite from the (now
    // default-ON, card_c3d48c4607ee753b2c98e04b) ratify pass — this file tests the
    // timeout/owner-decision pinning path, whose positional query mocks assume the
    // ratify pass issues no SELECT.
    mod = require('../../agent-action-requests')(devices, {
        serverLog: () => {},
        getDevicePrefs: () => ({ action_request_timeout_policy: 'auto_dismiss', action_request_timeout_minutes: 1, action_request_ratify_enabled: false }),
    });
    app.use('/api/action-requests', mod.router);
});

afterEach(() => mockPoolQuery.mockReset());

const post = (p) => request(app).post(p);

function rowFixture(over = {}) {
    return {
        id: UUID, device_id: deviceId, from_entity_id: 2, anchor_message_id: null,
        type: 'decision', prompt: 'pick', options: ['A', 'B'],
        related_card_id: null, decision_context: null,
        status: 'pending', answer: null,
        created_at: new Date('2026-06-25T00:00:00Z'), resolved_at: null, ...over,
    };
}

describe('子1 decision_context — create validation + rowToApi', () => {
    it('accepts a decisionContext object and rowToApi emits decisionContext', async () => {
        const dc = { whatWasDone: 'merged PR', recommendation: 'approve', evidence: [], recommendedOptionIndex: 0 };
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ decision_context: dc })] }); // INSERT RETURNING *
        const res = await post('/api/action-requests').send({
            deviceId, deviceSecret, fromEntityId: 2, type: 'decision', prompt: 'decide', decisionContext: dc,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.request.decisionContext).toEqual(dc);
        // INSERT must include the decision_context column.
        const insert = mockPoolQuery.mock.calls.find(c => /INSERT INTO agent_action_requests/.test(c[0]));
        expect(insert[0]).toMatch(/decision_context/);
    });

    it('rejects a decisionContext whose JSON exceeds 8192 bytes → 400, no DB write', async () => {
        const dc = { whatWasDone: 'x'.repeat(9000) };
        const res = await post('/api/action-requests').send({
            deviceId, deviceSecret, fromEntityId: 2, type: 'decision', prompt: 'decide', decisionContext: dc,
        });
        expect(res.status).toBe(400);
        expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('rejects a non-object decisionContext → 400', async () => {
        const res = await post('/api/action-requests').send({
            deviceId, deviceSecret, fromEntityId: 2, type: 'decision', prompt: 'decide', decisionContext: 'not-an-object',
        });
        expect(res.status).toBe(400);
    });
});

describe('子3 createActionRequest() shared path', () => {
    it('inserts the row (with decision_context) and returns rowToApi shape', async () => {
        const dc = { whatWasDone: 'did X', recommendation: 'approve', evidence: [{ label: 'PR', url: 'u', kind: 'pr' }], recommendedOptionIndex: 0 };
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ decision_context: dc, related_card_id: CARD })] });
        const api = await mod.createActionRequest({
            deviceId, fromEntityId: 2, type: 'decision', prompt: 'decide', options: ['核可', '退回'], relatedCardId: CARD, decisionContext: dc,
        });
        expect(api.id).toBe(UUID);
        expect(api.decisionContext).toEqual(dc);
        expect(api.relatedCardId).toBe(CARD);
        const insert = mockPoolQuery.mock.calls.find(c => /INSERT INTO agent_action_requests/.test(c[0]));
        expect(insert[0]).toMatch(/decision_context/);
    });
});

describe('子6a dismissActionRequestsForCard()', () => {
    it('dismisses only pending owner-decision rows for the card (decision_context IS NOT NULL)', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ status: 'dismissed' })] }); // UPDATE RETURNING *
        const rows = await mod.dismissActionRequestsForCard(deviceId, CARD);
        expect(rows).toHaveLength(1);
        const upd = mockPoolQuery.mock.calls.find(c => /UPDATE agent_action_requests/.test(c[0]));
        expect(upd[0]).toMatch(/status = 'dismissed'/);
        expect(upd[0]).toMatch(/decision_context IS NOT NULL/);
        expect(upd[1]).toEqual([deviceId, CARD]);
    });

    it('is a no-op on missing args', async () => {
        const rows = await mod.dismissActionRequestsForCard(null, CARD);
        expect(rows).toEqual([]);
        expect(mockPoolQuery).not.toHaveBeenCalled();
    });
});

describe('子6b timeout worker pins owner-decision rows to keep', () => {
    it('never auto_dismisses a pending row whose decision_context is non-null', async () => {
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ device_id: deviceId }] })                       // SELECT DISTINCT device_id
            .mockResolvedValueOnce({ rows: [] })                                              // negotiation T2 advance SELECT (empty)
            .mockResolvedValueOnce({ rows: [] })                                              // negotiation T3b advance SELECT (empty)
            .mockResolvedValueOnce({ rows: [rowFixture({ decision_context: { whatWasDone: 'x' } })] }); // candidate SELECT
        await mod.enforceActionRequestTimeouts();
        // The per-row guard must have skipped it → NO UPDATE ... dismissed call.
        const dismissUpdate = mockPoolQuery.mock.calls.find(c => /UPDATE agent_action_requests/.test(c[0]) && /dismissed/.test(c[0]));
        expect(dismissUpdate).toBeUndefined();
    });

    it('still auto_dismisses an ordinary pending row (decision_context null)', async () => {
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ device_id: deviceId }] })          // SELECT DISTINCT device_id
            .mockResolvedValueOnce({ rows: [] })                                 // negotiation T2 advance SELECT (empty)
            .mockResolvedValueOnce({ rows: [] })                                 // negotiation T3b advance SELECT (empty)
            .mockResolvedValueOnce({ rows: [rowFixture({ decision_context: null })] }) // candidate SELECT
            .mockResolvedValueOnce({ rows: [rowFixture({ status: 'dismissed' })] });   // UPDATE ... dismissed RETURNING *
        await mod.enforceActionRequestTimeouts();
        const dismissUpdate = mockPoolQuery.mock.calls.find(c => /UPDATE agent_action_requests/.test(c[0]) && /dismissed/.test(c[0]));
        expect(dismissUpdate).toBeDefined();
    });
});
