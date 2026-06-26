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
const put = (p) => request(app).put(p);

// Queue the exact pg call sequence the transactional PUT /:id edit runs:
//   BEGIN → SELECT ... FOR UPDATE → UPDATE ... RETURNING * → INSERT audit → COMMIT
function queueEditTxn(before, after) {
    mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })        // BEGIN
        .mockResolvedValueOnce({ rows: [before] })  // SELECT ... FOR UPDATE
        .mockResolvedValueOnce({ rows: [after] })   // UPDATE ... RETURNING *
        .mockResolvedValueOnce({ rows: [] })        // INSERT agent_action_request_audit
        .mockResolvedValueOnce({ rows: [] });       // COMMIT
}
const auditCall = () => mockPoolQuery.mock.calls.find(c => /agent_action_request_audit/.test(c[0]));

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

// ════════════════════════════════════════
// PUT /:id — edit content (card_cd4f323c): opt1 edit prompt/options/type,
// opt2 cross-agent + mandatory audit.
// ════════════════════════════════════════
describe('PUT /:id (edit)', () => {
    it('(a) edits prompt + options + type, returns updated row + changed:true', async () => {
        const before = rowFixture(); // type=decision, prompt='pick A or B', options=['A','B'], from #2
        const after = rowFixture({ type: 'approval', prompt: 'pick A, B or C', options: ['A', 'B', 'C'] });
        queueEditTxn(before, after);
        const res = await put(`/api/action-requests/${UUID}`).send({
            deviceId, botSecret: 'bot-2', entityId: 2,
            type: 'approval', prompt: 'pick A, B or C', options: ['A', 'B', 'C'],
        });
        expect(res.status).toBe(200);
        expect(res.body.changed).toBe(true);
        expect(res.body.request.type).toBe('approval');
        expect(res.body.request.prompt).toBe('pick A, B or C');
        expect(res.body.request.options).toEqual(['A', 'B', 'C']);
        // The UPDATE writes all three columns.
        const updCall = mockPoolQuery.mock.calls.find(c => /UPDATE agent_action_requests SET/.test(c[0]));
        expect(updCall[0]).toMatch(/type = /);
        expect(updCall[0]).toMatch(/prompt = /);
        expect(updCall[0]).toMatch(/options = /);
    });

    it('(b) cross-agent: editor entity 6 edits a request created by entity 2 → 200 (no creator restriction)', async () => {
        const before = rowFixture({ from_entity_id: 2 });
        const after = rowFixture({ from_entity_id: 2, prompt: 'edited by #6' });
        queueEditTxn(before, after);
        const res = await put(`/api/action-requests/${UUID}`).send({
            deviceId, botSecret: 'bot-6', entityId: 6, prompt: 'edited by #6',
        });
        expect(res.status).toBe(200);
        expect(res.body.changed).toBe(true);
        // The row-lock SELECT is device-scoped but NOT restricted to from_entity_id.
        const selCall = mockPoolQuery.mock.calls.find(c => /FOR UPDATE/.test(c[0]));
        expect(selCall[0]).toMatch(/device_id = \$2/);
        expect(selCall[0]).not.toMatch(/from_entity_id/);
    });

    it('(c) writes an audit row with editorEntityId + correct old→new', async () => {
        const before = rowFixture({ from_entity_id: 2, prompt: 'pick A or B', options: ['A', 'B'], type: 'decision' });
        const after = rowFixture({ from_entity_id: 2, prompt: 'pick A, B or C', options: ['A', 'B', 'C'], type: 'approval' });
        queueEditTxn(before, after);
        const res = await put(`/api/action-requests/${UUID}`).send({
            deviceId, botSecret: 'bot-6', entityId: 6,
            prompt: 'pick A, B or C', options: ['A', 'B', 'C'], type: 'approval',
        });
        expect(res.status).toBe(200);
        const ac = auditCall();
        expect(ac).toBeTruthy();
        const params = ac[1]; // [request_id, device_id, editor_entity_id, changesJson]
        expect(params[0]).toBe(UUID);
        expect(params[1]).toBe(deviceId);
        expect(params[2]).toBe(6); // editor = the cross-agent editor, not the creator (#2)
        const changes = JSON.parse(params[3]);
        expect(changes.prompt).toEqual({ old: 'pick A or B', new: 'pick A, B or C' });
        expect(changes.options).toEqual({ old: ['A', 'B'], new: ['A', 'B', 'C'] });
        expect(changes.type).toEqual({ old: 'decision', new: 'approval' });
    });

    it('(c2) human (deviceSecret) edit records editorEntityId = null', async () => {
        const before = rowFixture({ prompt: 'old' });
        const after = rowFixture({ prompt: 'new' });
        queueEditTxn(before, after);
        const res = await put(`/api/action-requests/${UUID}`).send({ deviceId, deviceSecret, prompt: 'new' });
        expect(res.status).toBe(200);
        expect(auditCall()[1][2]).toBeNull();
    });

    it('(d) rejects invalid type with 400 (no DB write)', async () => {
        const res = await put(`/api/action-requests/${UUID}`).send({ deviceId, botSecret: 'bot-2', entityId: 2, type: 'bogus' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/type must be/);
        expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('(d) rejects empty prompt with 400', async () => {
        const res = await put(`/api/action-requests/${UUID}`).send({ deviceId, botSecret: 'bot-2', entityId: 2, prompt: '' });
        expect(res.status).toBe(400);
    });

    it('(d) rejects non-array options with 400', async () => {
        const res = await put(`/api/action-requests/${UUID}`).send({ deviceId, botSecret: 'bot-2', entityId: 2, options: 'A,B' });
        expect(res.status).toBe(400);
    });

    it('(d) rejects when no editable field supplied with 400', async () => {
        const res = await put(`/api/action-requests/${UUID}`).send({ deviceId, botSecret: 'bot-2', entityId: 2 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/at least one editable field/);
        expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('(d) rejects non-UUID id with 400', async () => {
        const res = await put('/api/action-requests/not-a-uuid').send({ deviceId, botSecret: 'bot-2', entityId: 2, prompt: 'x' });
        expect(res.status).toBe(400);
    });

    it('(d) editing an already-resolved request → 409, no audit row', async () => {
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [] })                                    // BEGIN
            .mockResolvedValueOnce({ rows: [rowFixture({ status: 'resolved' })] })  // SELECT FOR UPDATE
            .mockResolvedValueOnce({ rows: [] });                                   // ROLLBACK
        const res = await put(`/api/action-requests/${UUID}`).send({ deviceId, botSecret: 'bot-2', entityId: 2, prompt: 'x' });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/pending/);
        expect(auditCall()).toBeUndefined();
    });

    it('(d) editing a non-existent request → 404', async () => {
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [] })  // BEGIN
            .mockResolvedValueOnce({ rows: [] })  // SELECT FOR UPDATE (none)
            .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
        const res = await put(`/api/action-requests/${UUID}`).send({ deviceId, botSecret: 'bot-2', entityId: 2, prompt: 'x' });
        expect(res.status).toBe(404);
    });

    it('no-op edit (same values) → changed:false, no audit row', async () => {
        const before = rowFixture({ prompt: 'pick A or B', options: ['A', 'B'], type: 'decision' });
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [] })        // BEGIN
            .mockResolvedValueOnce({ rows: [before] })  // SELECT FOR UPDATE
            .mockResolvedValueOnce({ rows: [] });       // COMMIT (no UPDATE / no audit)
        const res = await put(`/api/action-requests/${UUID}`).send({
            deviceId, botSecret: 'bot-2', entityId: 2,
            prompt: 'pick A or B', options: ['A', 'B'], type: 'decision',
        });
        expect(res.status).toBe(200);
        expect(res.body.changed).toBe(false);
        expect(auditCall()).toBeUndefined();
    });
});
