/**
 * Scheduled Messages endpoint tests (Jest + Supertest)
 *
 * Covers the user-action scheduled messages API at /api/scheduled-messages/*:
 *   POST   /        create
 *   GET    /        list pending
 *   PUT    /:id     update (pre-send)
 *   DELETE /:id     cancel (pre-send)
 *   pollAndFire()   background claim + dispatch
 */

// Mock pg so the module's Pool() call is captured. Default to empty-rows
// responses; individual tests override via mockPoolQuery per-case.
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

let app;
let smModule;
let mockSaveChat;
let mockPushToBot;
let mockUnifiedPush;

const deviceId = 'test-dev';
const deviceSecret = 'test-secret';

beforeAll(() => {
    app = express();
    app.use(express.json());

    const devices = {
        [deviceId]: {
            deviceSecret,
            entities: {
                0: { isBound: true,  botSecret: 'bot-0', webhook: { url: 'https://example.com/hook' }, bindingType: 'webhook' },
                1: { isBound: false, botSecret: null },
                2: { isBound: true,  botSecret: 'bot-2', bindingType: 'channel' },
            },
        },
    };

    mockSaveChat = jest.fn().mockResolvedValue('msg-id');
    mockPushToBot = jest.fn().mockResolvedValue({ pushed: true });
    mockUnifiedPush = jest.fn().mockResolvedValue({ pushed: true });

    smModule = require('../../scheduled-messages')(devices, {
        saveChatMessage: mockSaveChat,
        pushToBot: mockPushToBot,
        unifiedPush: mockUnifiedPush,
        serverLog: () => {},
    });
    app.use('/api/scheduled-messages', smModule.router);
});

afterEach(() => {
    mockPoolQuery.mockClear();
    mockSaveChat.mockClear();
    mockPushToBot.mockClear();
    mockUnifiedPush.mockClear();
});

afterAll(() => {
    // Guard against leaked intervals even though startPoller was never called here.
    if (smModule && smModule.stopPoller) smModule.stopPoller();
});

const post = (p) => request(app).post(p);
const get = (p) => request(app).get(p);
const put = (p) => request(app).put(p);
const del = (p) => request(app).delete(p);

const futureIso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const futureMs = (offsetMs) => Date.now() + offsetMs;

// ═══════════════════════════════════════════════════════════
// Auth
// ═══════════════════════════════════════════════════════════
describe('Auth', () => {
    it('POST without deviceId → 400', async () => {
        const res = await post('/api/scheduled-messages').send({});
        expect(res.status).toBe(400);
    });

    it('POST without deviceSecret → 400', async () => {
        const res = await post('/api/scheduled-messages').send({ deviceId });
        expect(res.status).toBe(400);
    });

    it('POST with wrong deviceSecret → 401', async () => {
        const res = await post('/api/scheduled-messages')
            .send({ deviceId, deviceSecret: 'WRONG', chatEntityId: 0, userEntityId: 0,
                    targetEntityIds: [0], content: 'hi', scheduledAt: futureIso(60_000) });
        expect(res.status).toBe(401);
    });

    it('GET with wrong deviceSecret → 401', async () => {
        const res = await get(`/api/scheduled-messages?deviceId=${deviceId}&deviceSecret=WRONG`);
        expect(res.status).toBe(401);
    });
});

// ═══════════════════════════════════════════════════════════
// POST /
// ═══════════════════════════════════════════════════════════
describe('POST /api/scheduled-messages', () => {
    const validBody = () => ({
        deviceId, deviceSecret,
        chatEntityId: 0,
        userEntityId: 0,
        targetEntityIds: [0],
        content: 'Hello future',
        scheduledAt: futureIso(5 * 60_000), // 5 minutes ahead
    });

    it('creates when body is valid', async () => {
        const scheduledIso = futureIso(60_000);
        mockPoolQuery.mockResolvedValueOnce({
            rows: [{ id: 'abc-123', scheduled_at: scheduledIso }],
        });
        const res = await post('/api/scheduled-messages').send(validBody());
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.id).toBe('abc-123');
        expect(typeof res.body.scheduledAt).toBe('number');
    });

    it('rejects past scheduledAt with 400', async () => {
        const res = await post('/api/scheduled-messages')
            .send({ ...validBody(), scheduledAt: new Date(Date.now() - 60_000).toISOString() });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/future/i);
    });

    it('rejects scheduledAt more than 7 days ahead with 400', async () => {
        const tooFar = Date.now() + 8 * 24 * 60 * 60 * 1000;
        const res = await post('/api/scheduled-messages')
            .send({ ...validBody(), scheduledAt: new Date(tooFar).toISOString() });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/7 days/i);
    });

    it('rejects content longer than 10000 chars with 400', async () => {
        const res = await post('/api/scheduled-messages')
            .send({ ...validBody(), content: 'x'.repeat(10001) });
        expect(res.status).toBe(400);
    });

    it('rejects empty content with 400', async () => {
        const res = await post('/api/scheduled-messages')
            .send({ ...validBody(), content: '' });
        expect(res.status).toBe(400);
    });

    it('rejects missing targetEntityIds with 400', async () => {
        const res = await post('/api/scheduled-messages')
            .send({ ...validBody(), targetEntityIds: [] });
        expect(res.status).toBe(400);
    });

    it('rejects target entity that does not exist on device with 400', async () => {
        const res = await post('/api/scheduled-messages')
            .send({ ...validBody(), targetEntityIds: [999] });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/999/);
    });

    it('accepts numeric scheduledAt (ms)', async () => {
        mockPoolQuery.mockResolvedValueOnce({
            rows: [{ id: 'xyz', scheduled_at: new Date(futureMs(60_000)).toISOString() }],
        });
        const res = await post('/api/scheduled-messages')
            .send({ ...validBody(), scheduledAt: futureMs(60_000) });
        expect(res.status).toBe(200);
    });
});

// ═══════════════════════════════════════════════════════════
// GET /
// ═══════════════════════════════════════════════════════════
describe('GET /api/scheduled-messages', () => {
    it('returns pending-only list', async () => {
        const rows = [
            {
                id: 'a', chat_entity_id: 0, user_entity_id: 0,
                target_entity_ids: [0], content: 'hi',
                scheduled_at: futureIso(60_000),
                created_at: new Date().toISOString(),
                sent_at: null, cancelled_at: null,
            },
        ];
        mockPoolQuery.mockResolvedValueOnce({ rows });
        const res = await get(`/api/scheduled-messages?deviceId=${deviceId}&deviceSecret=${deviceSecret}&chatEntityId=0`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.messages).toHaveLength(1);
        expect(res.body.messages[0].id).toBe('a');
        // Assert the SQL only requests unsent + uncancelled rows
        const sqlArg = mockPoolQuery.mock.calls[mockPoolQuery.mock.calls.length - 1][0];
        expect(sqlArg).toMatch(/sent_at IS NULL/);
        expect(sqlArg).toMatch(/cancelled_at IS NULL/);
    });
});

// ═══════════════════════════════════════════════════════════
// PUT /:id
// ═══════════════════════════════════════════════════════════
describe('PUT /api/scheduled-messages/:id', () => {
    it('updates scheduledAt', async () => {
        const newIso = futureIso(10 * 60_000);
        mockPoolQuery.mockResolvedValueOnce({
            rows: [{
                id: 'abc', chat_entity_id: 0, user_entity_id: 0,
                target_entity_ids: [0], content: 'hi',
                scheduled_at: newIso, created_at: new Date().toISOString(),
                sent_at: null, cancelled_at: null,
            }],
        });
        const res = await put('/api/scheduled-messages/abc')
            .send({ deviceId, deviceSecret, scheduledAt: newIso });
        expect(res.status).toBe(200);
        expect(res.body.message.id).toBe('abc');
    });

    it('rejects empty update payload with 400', async () => {
        const res = await put('/api/scheduled-messages/abc')
            .send({ deviceId, deviceSecret });
        expect(res.status).toBe(400);
    });

    it('returns 404 when row is already sent/cancelled', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // no row updated
        const res = await put('/api/scheduled-messages/abc')
            .send({ deviceId, deviceSecret, content: 'updated' });
        expect(res.status).toBe(404);
    });

    it('rejects past scheduledAt with 400', async () => {
        const res = await put('/api/scheduled-messages/abc')
            .send({ deviceId, deviceSecret, scheduledAt: new Date(Date.now() - 60_000).toISOString() });
        expect(res.status).toBe(400);
    });
});

// ═══════════════════════════════════════════════════════════
// DELETE /:id
// ═══════════════════════════════════════════════════════════
describe('DELETE /api/scheduled-messages/:id', () => {
    it('cancels a pending message (sets cancelled_at)', async () => {
        const cancelIso = new Date().toISOString();
        mockPoolQuery.mockResolvedValueOnce({
            rows: [{ id: 'abc', cancelled_at: cancelIso }],
        });
        const res = await del('/api/scheduled-messages/abc')
            .send({ deviceId, deviceSecret });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.id).toBe('abc');
        expect(typeof res.body.cancelledAt).toBe('number');
        // UPDATE must guard against already-sent/cancelled rows
        const sqlArg = mockPoolQuery.mock.calls[mockPoolQuery.mock.calls.length - 1][0];
        expect(sqlArg).toMatch(/sent_at IS NULL/);
        expect(sqlArg).toMatch(/cancelled_at IS NULL/);
    });

    it('returns 404 when row is already sent', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        const res = await del('/api/scheduled-messages/abc')
            .send({ deviceId, deviceSecret });
        expect(res.status).toBe(404);
    });
});

// ═══════════════════════════════════════════════════════════
// pollAndFire() smoke
// ═══════════════════════════════════════════════════════════
describe('pollAndFire() background dispatch', () => {
    it('claims due rows and dispatches via saveChatMessage + pushToBot', async () => {
        // The poller runs a single UPDATE ... RETURNING query that claims
        // all due rows and flips their sent_at in one atomic step.
        mockPoolQuery.mockResolvedValueOnce({
            rows: [{
                id: 'claim-1',
                device_id: deviceId,
                chat_entity_id: 0,
                user_entity_id: 0,
                target_entity_ids: [0, 2],
                content: 'scheduled hello',
                scheduled_at: new Date(Date.now() - 1000).toISOString(),
                sent_at: new Date().toISOString(),
            }],
        });

        const result = await smModule.pollAndFire();
        expect(result.claimed).toBe(1);
        expect(result.dispatched).toBe(1);

        // saveChatMessage called once per target entity (2 targets)
        expect(mockSaveChat).toHaveBeenCalledTimes(2);
        expect(mockSaveChat).toHaveBeenCalledWith(
            deviceId, 0, 'scheduled hello', 'scheduled', true, false,
            null, null, null, 'scheduled'
        );

        // Entity 0 has webhook → pushToBot called
        expect(mockPushToBot).toHaveBeenCalledTimes(1);
        // Entity 2 is channel-bound → unifiedPush called
        expect(mockUnifiedPush).toHaveBeenCalledTimes(1);
    });

    it('returns {claimed: 0} when no rows are due', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        const result = await smModule.pollAndFire();
        expect(result.claimed).toBe(0);
        expect(result.dispatched).toBe(0);
        expect(mockSaveChat).not.toHaveBeenCalled();
    });

    it('tolerates device not present (does not throw)', async () => {
        mockPoolQuery.mockResolvedValueOnce({
            rows: [{
                id: 'claim-2',
                device_id: 'ghost-device',
                chat_entity_id: 0,
                user_entity_id: 0,
                target_entity_ids: [0],
                content: 'for ghost',
                scheduled_at: new Date().toISOString(),
                sent_at: new Date().toISOString(),
            }],
        });
        // The second call is the last_error UPDATE inside dispatchRow
        mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const result = await smModule.pollAndFire();
        expect(result.claimed).toBe(1);
        expect(result.dispatched).toBe(1);
        expect(mockSaveChat).not.toHaveBeenCalled();
    });
});
