// Tests for the consensus type + real-time socket push on the "需要你"
// agent_action_requests API (card_8151054f).
//   1. emitting type 'consensus' succeeds (now a VALID_TYPE);
//   2. an unknown type still 400s;
//   3. emit/resolve/dismiss best-effort emit 'action_request:changed' to
//      device:<id> with the documented { kind, requestId, fromEntityId } payload.

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

let app;
let emitToRoom; // captures io.to(room).emit(...)
let lastRoom;

beforeAll(() => {
    app = express();
    app.use(express.json());
    const devices = {
        [deviceId]: {
            deviceSecret,
            entities: {
                2: { isBound: true, botSecret: 'bot-2' },
            },
        },
    };
    // Minimal io double: io.to(room) returns an object whose .emit is recorded.
    emitToRoom = jest.fn();
    const io = {
        to: jest.fn((room) => {
            lastRoom = room;
            return { emit: emitToRoom };
        }),
    };
    const mod = require('../../agent-action-requests')(devices, { serverLog: () => {}, io });
    app.use('/api/action-requests', mod.router);
});

afterEach(() => {
    mockPoolQuery.mockClear();
    emitToRoom.mockClear();
});

const post = (p) => request(app).post(p);

function rowFixture(over = {}) {
    return {
        id: UUID, device_id: deviceId, from_entity_id: 2, anchor_message_id: null,
        type: 'consensus', prompt: 'align with #1 #5 on rollout', options: null,
        status: 'pending', answer: null,
        created_at: new Date('2026-06-25T00:00:00Z'), resolved_at: null, ...over,
    };
}

describe('consensus type', () => {
    it('emitting type=consensus succeeds (now a valid type)', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture()] });
        const res = await post('/api/action-requests').send({
            deviceId, botSecret: 'bot-2', entityId: 2,
            type: 'consensus', prompt: 'align with #1 #5 on rollout',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.request.type).toBe('consensus');
        // INSERT received type 'consensus'
        const params = mockPoolQuery.mock.calls[0][1];
        expect(params[3]).toBe('consensus');
    });

    it('an unknown type still 400s', async () => {
        const res = await post('/api/action-requests').send({
            deviceId, botSecret: 'bot-2', entityId: 2, type: 'bogus', prompt: 'x',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/type must be/);
        // error message lists the new type so callers can discover it
        expect(res.body.error).toMatch(/consensus/);
    });
});

describe("real-time 'action_request:changed' socket push", () => {
    it('emit (POST /) pushes kind=emitted to device room', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture()] });
        await post('/api/action-requests').send({
            deviceId, botSecret: 'bot-2', entityId: 2, type: 'consensus', prompt: 'p',
        });
        expect(lastRoom).toBe(`device:${deviceId}`);
        expect(emitToRoom).toHaveBeenCalledTimes(1);
        const [event, payload] = emitToRoom.mock.calls[0];
        expect(event).toBe('action_request:changed');
        expect(payload).toEqual({ kind: 'emitted', requestId: UUID, fromEntityId: 2 });
    });

    it('resolve (POST /:id/resolve) pushes kind=resolved', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ status: 'resolved', answer: 'ok', resolved_at: new Date() })] });
        await post(`/api/action-requests/${UUID}/resolve`).send({ deviceId, deviceSecret, answer: 'ok' });
        expect(lastRoom).toBe(`device:${deviceId}`);
        expect(emitToRoom).toHaveBeenCalledTimes(1);
        const [event, payload] = emitToRoom.mock.calls[0];
        expect(event).toBe('action_request:changed');
        expect(payload).toEqual({ kind: 'resolved', requestId: UUID, fromEntityId: 2 });
    });

    it('dismiss (POST /:id/dismiss) pushes kind=dismissed', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ status: 'dismissed', resolved_at: new Date() })] });
        await post(`/api/action-requests/${UUID}/dismiss`).send({ deviceId, deviceSecret });
        expect(lastRoom).toBe(`device:${deviceId}`);
        expect(emitToRoom).toHaveBeenCalledTimes(1);
        const [event, payload] = emitToRoom.mock.calls[0];
        expect(event).toBe('action_request:changed');
        expect(payload).toEqual({ kind: 'dismissed', requestId: UUID, fromEntityId: 2 });
    });

    it('a 404 resolve (nothing pending matched) does NOT emit', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        const res = await post(`/api/action-requests/${UUID}/resolve`).send({ deviceId, deviceSecret });
        expect(res.status).toBe(404);
        expect(emitToRoom).not.toHaveBeenCalled();
    });
});

describe('resolveActionRequest helper (speak auto-resolve path) emits too', () => {
    it('the shared helper emits kind=resolved (so /api/client/speak gets it identically)', async () => {
        const devices = {
            [deviceId]: { deviceSecret, entities: { 2: { isBound: true, botSecret: 'bot-2' } } },
        };
        const helperEmit = jest.fn();
        const io = { to: jest.fn(() => ({ emit: helperEmit })) };
        const mod = require('../../agent-action-requests')(devices, { serverLog: () => {}, io });
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ status: 'resolved', answer: { text: 'hi' }, resolved_at: new Date() })] });
        const row = await mod.resolveActionRequest(deviceId, UUID, { text: 'hi' }, devices[deviceId]);
        expect(row).toBeTruthy();
        expect(io.to).toHaveBeenCalledWith(`device:${deviceId}`);
        expect(helperEmit).toHaveBeenCalledWith('action_request:changed', {
            kind: 'resolved', requestId: UUID, fromEntityId: 2,
        });
    });
});

describe('io absent → no crash (best-effort)', () => {
    it('module wired without io still emits cleanly (no throw)', async () => {
        const devices = {
            [deviceId]: { deviceSecret, entities: { 2: { isBound: true, botSecret: 'bot-2' } } },
        };
        const mod = require('../../agent-action-requests')(devices, { serverLog: () => {} }); // no io
        const noIoApp = express();
        noIoApp.use(express.json());
        noIoApp.use('/api/action-requests', mod.router);
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture()] });
        const res = await request(noIoApp).post('/api/action-requests').send({
            deviceId, botSecret: 'bot-2', entityId: 2, type: 'consensus', prompt: 'p',
        });
        expect(res.status).toBe(200);
    });
});
