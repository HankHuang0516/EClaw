// Tests for the "需要你" agent_action_requests API (card_edeb190b).
// Mocks pg so the module's Pool() is captured; uses supertest against the router.

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
const ANCHOR = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let app;

beforeAll(() => {
    app = express();
    app.use(express.json());
    const devices = {
        [deviceId]: {
            deviceSecret,
            entities: {
                2: { isBound: true, botSecret: 'bot-2' },
                6: { isBound: true, botSecret: 'bot-6' },
                3: { isBound: false, botSecret: null },
            },
        },
    };
    const mod = require('../../agent-action-requests')(devices, { serverLog: () => {} });
    app.use('/api/action-requests', mod.router);
});

afterEach(() => mockPoolQuery.mockClear());

const post = (p) => request(app).post(p);
const get = (p) => request(app).get(p);

function rowFixture(over = {}) {
    return {
        id: UUID, device_id: deviceId, from_entity_id: 2, anchor_message_id: null,
        type: 'decision', prompt: 'pick A or B', options: ['A', 'B'],
        status: 'pending', answer: null,
        created_at: new Date('2026-06-25T00:00:00Z'), resolved_at: null, ...over,
    };
}

describe('auth', () => {
    it('missing deviceId → 400', async () => {
        const res = await post('/api/action-requests').send({ type: 'decision', prompt: 'x' });
        expect(res.status).toBe(400);
    });
    it('bad deviceSecret → 401', async () => {
        const res = await get('/api/action-requests?deviceId=' + deviceId + '&deviceSecret=wrong');
        expect(res.status).toBe(401);
    });
    it('bad botSecret → 401', async () => {
        const res = await post('/api/action-requests').send({ deviceId, botSecret: 'nope', entityId: 2, type: 'decision', prompt: 'x' });
        expect(res.status).toBe(401);
    });
    it('unbound entity botSecret → 401', async () => {
        const res = await post('/api/action-requests').send({ deviceId, botSecret: 'bot-3', entityId: 3, type: 'decision', prompt: 'x' });
        expect(res.status).toBe(401);
    });
});

describe('POST / (emit)', () => {
    it('agent emits as itself (from_entity_id = authed entity)', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture()] });
        const res = await post('/api/action-requests').send({
            deviceId, botSecret: 'bot-2', entityId: 2,
            type: 'decision', prompt: 'pick A or B', options: ['A', 'B'], anchorMessageId: ANCHOR,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.request.fromEntityId).toBe(2);
        // INSERT params: from_entity_id is the authed entity (2), not from body
        const params = mockPoolQuery.mock.calls[0][1];
        expect(params[1]).toBe(2);
    });
    it('rejects invalid type', async () => {
        const res = await post('/api/action-requests').send({ deviceId, botSecret: 'bot-2', entityId: 2, type: 'bogus', prompt: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/type must be/);
    });
    it('rejects empty prompt', async () => {
        const res = await post('/api/action-requests').send({ deviceId, botSecret: 'bot-2', entityId: 2, type: 'approval', prompt: '' });
        expect(res.status).toBe(400);
    });
    it('rejects non-array options', async () => {
        const res = await post('/api/action-requests').send({ deviceId, botSecret: 'bot-2', entityId: 2, type: 'decision', prompt: 'x', options: 'A,B' });
        expect(res.status).toBe(400);
    });
    it('drops a non-UUID anchorMessageId to null', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ anchor_message_id: null })] });
        const res = await post('/api/action-requests').send({ deviceId, botSecret: 'bot-2', entityId: 2, type: 'clarify', prompt: 'which?', anchorMessageId: 'not-a-uuid' });
        expect(res.status).toBe(200);
        const params = mockPoolQuery.mock.calls[0][1];
        expect(params[2]).toBeNull(); // anchor param
    });
    it('user (deviceSecret) must name fromEntityId', async () => {
        const res = await post('/api/action-requests').send({ deviceId, deviceSecret, type: 'decision', prompt: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/fromEntityId/);
    });
});

describe('GET / (list)', () => {
    it('defaults to status=pending, scoped to device', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture(), rowFixture({ id: ANCHOR, from_entity_id: 6 })] });
        const res = await get('/api/action-requests?deviceId=' + deviceId + '&deviceSecret=' + deviceSecret);
        expect(res.status).toBe(200);
        expect(res.body.requests).toHaveLength(2);
        const [sql, params] = mockPoolQuery.mock.calls[0];
        expect(sql).toMatch(/device_id = \$1/);
        expect(sql).toMatch(/status = \$2/);
        expect(params).toEqual([deviceId, 'pending']);
    });
    it('rejects bad status filter', async () => {
        const res = await get('/api/action-requests?deviceId=' + deviceId + '&deviceSecret=' + deviceSecret + '&status=weird');
        expect(res.status).toBe(400);
    });
});

describe('POST /:id/resolve', () => {
    it('resolves a pending request by id+device, returns updated row', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ status: 'resolved', answer: 'A', resolved_at: new Date() })] });
        const res = await post(`/api/action-requests/${UUID}/resolve`).send({ deviceId, deviceSecret, answer: 'A' });
        expect(res.status).toBe(200);
        expect(res.body.request.status).toBe('resolved');
        const [sql, params] = mockPoolQuery.mock.calls[0];
        expect(sql).toMatch(/status = 'resolved'/);
        expect(sql).toMatch(/AND status = 'pending'/); // only resolves pending
        expect(params).toContain(UUID);
        expect(params).toContain(deviceId);
    });
    it('404 when nothing pending matches', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        const res = await post(`/api/action-requests/${UUID}/resolve`).send({ deviceId, deviceSecret, answer: 'A' });
        expect(res.status).toBe(404);
    });
    it('rejects non-UUID id', async () => {
        const res = await post('/api/action-requests/not-a-uuid/resolve').send({ deviceId, deviceSecret });
        expect(res.status).toBe(400);
    });
});

describe('POST /:id/dismiss', () => {
    it('dismisses a pending request', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ status: 'dismissed', resolved_at: new Date() })] });
        const res = await post(`/api/action-requests/${UUID}/dismiss`).send({ deviceId, deviceSecret });
        expect(res.status).toBe(200);
        expect(res.body.request.status).toBe('dismissed');
        const [sql] = mockPoolQuery.mock.calls[0];
        expect(sql).toMatch(/status = 'dismissed'/);
        expect(sql).toMatch(/AND status = 'pending'/);
    });
});
