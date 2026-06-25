/**
 * Smart-quote → auto-resolve loop (card_b51598b7).
 *
 * Closes the "需要你" HITL inbox loop: a freeform quoted reply to a pending
 * action-request, sent via POST /api/client/speak, must mark that request
 * resolved (answer = the reply text), device-scoped + pending-only, best-effort.
 *
 * Two layers:
 *   1. Unit — resolveActionRequest() helper extracted from agent-action-requests.js
 *      (the load-bearing UPDATE + guards), mocked pg.
 *   2. Integration — /api/client/speak against the real index.js: a body carrying
 *      actionRequest.requestId triggers the resolve; a body WITHOUT it does not.
 */

require('./helpers/mock-setup');

const request = require('supertest');

// ──────────────────────────────────────────────────────────────────────────
// Layer 1: resolveActionRequest() helper, unit-tested directly
// ──────────────────────────────────────────────────────────────────────────
describe('resolveActionRequest() helper', () => {
    const deviceId = 'dev-helper';
    const UUID = '11111111-2222-3333-4444-555555555555';

    // agent-action-requests.js creates ONE module-scope pool (new Pool() at load).
    // The pg mock from mock-setup gives that pool its own query fn; grab it via
    // the factory's _pool (same singleton on every invocation).
    const mod = require('../../agent-action-requests')({}, { serverLog: () => {} });
    const poolQuery = mod._pool.query;

    function rowFixture(over = {}) {
        return {
            id: UUID, device_id: deviceId, from_entity_id: 2, anchor_message_id: null,
            type: 'clarify', prompt: 'which one?', options: null,
            status: 'resolved', answer: { text: 'option B' },
            created_at: new Date('2026-06-25T00:00:00Z'), resolved_at: new Date(), ...over,
        };
    }

    afterEach(() => poolQuery.mockReset());

    it('runs a device-scoped, pending-only UPDATE with the answer and returns the row', async () => {
        poolQuery.mockResolvedValueOnce({ rows: [rowFixture()] });
        const row = await mod.resolveActionRequest(deviceId, UUID, { text: 'option B' }, { entities: {} });
        expect(row).not.toBeNull();
        expect(row.status).toBe('resolved');
        const [sql, params] = poolQuery.mock.calls[0];
        expect(sql).toMatch(/status = 'resolved'/);
        expect(sql).toMatch(/AND status = 'pending'/);   // pending-only
        expect(sql).toMatch(/device_id = \$3/);          // device-scoped
        expect(params[0]).toBe(JSON.stringify({ text: 'option B' })); // answer jsonb
        expect(params[1]).toBe(UUID);
        expect(params[2]).toBe(deviceId);
    });

    it('returns null (no throw) when nothing pending matches', async () => {
        poolQuery.mockResolvedValueOnce({ rows: [] });
        const row = await mod.resolveActionRequest(deviceId, UUID, { text: 'x' }, { entities: {} });
        expect(row).toBeNull();
    });

    it('skips a malformed requestId without touching the DB', async () => {
        const row = await mod.resolveActionRequest(deviceId, 'not-a-uuid', { text: 'x' }, { entities: {} });
        expect(row).toBeNull();
        expect(poolQuery).not.toHaveBeenCalled();
    });

    it('skips a missing deviceId without touching the DB', async () => {
        const row = await mod.resolveActionRequest(null, UUID, { text: 'x' }, { entities: {} });
        expect(row).toBeNull();
        expect(poolQuery).not.toHaveBeenCalled();
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Layer 2: /api/client/speak auto-resolve, integration against index.js
// ──────────────────────────────────────────────────────────────────────────
describe('POST /api/client/speak — smart-quote auto-resolve', () => {
    let app;
    let arPool;
    const UUID = '99999999-8888-7777-6666-555555555555';
    const post = (p) => request(app).post(p).set('Host', 'localhost');
    const get = (p) => request(app).get(p).set('Host', 'localhost');

    async function registerDevice(id) {
        const secret = `secret-${id}`;
        await post('/api/device/register').send({ deviceId: id, deviceSecret: secret, entityId: 0 });
        return secret;
    }

    beforeAll(async () => {
        app = require('../../index');
        // Same module-scope singleton pool the speak handler resolves against.
        arPool = require('../../agent-action-requests')({}, {})._pool;
    });

    afterAll(async () => {
        const { httpServer } = require('../../index');
        await new Promise((resolve) => httpServer.close(resolve));
    });

    beforeEach(() => {
        // Default: resolve UPDATE matches nothing (rows:[]); individual tests override.
        arPool.query.mockReset();
        arPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    });

    function lastResolveCall() {
        // The auto-resolve UPDATE is the only call the speak path makes through
        // the agent-action-requests pool. Find it by its SQL signature.
        return arPool.query.mock.calls.find(
            ([sql]) => typeof sql === 'string' && /UPDATE agent_action_requests/.test(sql) && /status = 'resolved'/.test(sql)
        );
    }

    it('body WITH actionRequest.requestId triggers a device-scoped, pending-only resolve (answer = reply text)', async () => {
        const deviceId = 'speak-ar-yes';
        const secret = await registerDevice(deviceId);
        await post('/api/bind').send({ deviceId, entityId: 0, name: 'Bot', character: '🤖', webhook: '' });

        arPool.query.mockResolvedValueOnce({
            rows: [{
                id: UUID, device_id: deviceId, from_entity_id: 0, anchor_message_id: null,
                prompt: 'pick one', status: 'resolved', answer: { text: 'my freeform answer' },
                created_at: new Date(), resolved_at: new Date(),
            }],
        });

        const res = await post('/api/client/speak').send({
            deviceId, deviceSecret: secret, entityId: 0, source: 'web_chat',
            text: 'my freeform answer',
            actionRequest: { requestId: UUID, anchorMessageId: null },
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const call = lastResolveCall();
        expect(call).toBeDefined();
        const [sql, params] = call;
        expect(sql).toMatch(/AND status = 'pending'/);   // pending-only
        expect(sql).toMatch(/device_id = \$3/);          // device-scoped
        expect(params[1]).toBe(UUID);                    // the requestId
        expect(params[2]).toBe(deviceId);                // the SAME device
        // answer = the user's freeform reply text, wrapped { text }
        expect(JSON.parse(params[0])).toEqual({ text: 'my freeform answer' });
        // Response surfaces the resolved request id
        expect(res.body.actionRequestResolved).toEqual({ requestId: UUID });
    });

    it('body WITHOUT actionRequest does NOT resolve anything', async () => {
        const deviceId = 'speak-ar-no';
        const secret = await registerDevice(deviceId);
        await post('/api/bind').send({ deviceId, entityId: 0, name: 'Bot', character: '🤖', webhook: '' });

        const res = await post('/api/client/speak').send({
            deviceId, deviceSecret: secret, entityId: 0, source: 'web_chat',
            text: 'just a normal message',
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(lastResolveCall()).toBeUndefined();           // no resolve UPDATE fired
        expect(res.body.actionRequestResolved).toBeUndefined();
    });

    it('a resolve failure (DB throw) never breaks the speak response', async () => {
        const deviceId = 'speak-ar-throws';
        const secret = await registerDevice(deviceId);
        await post('/api/bind').send({ deviceId, entityId: 0, name: 'Bot', character: '🤖', webhook: '' });

        arPool.query.mockRejectedValueOnce(new Error('boom'));

        const res = await post('/api/client/speak').send({
            deviceId, deviceSecret: secret, entityId: 0, source: 'web_chat',
            text: 'reply that will fail to resolve',
            actionRequest: { requestId: UUID },
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.actionRequestResolved).toBeUndefined();
    });
});
