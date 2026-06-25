// Hardening tests for the "需要你" agent_action_requests API — PR#3732 follow-up.
// Covers 5 LOW-severity findings from an adversarial multi-agent self-review:
//   A — idempotent, transactional aar_type_valid migration (skip when current;
//       DROP+ADD inside BEGIN/COMMIT when stale).
//   B — bot resolve/dismiss scoped to the bot's OWN emitted requests; the user
//       (deviceSecret) path stays unrestricted over the whole device inbox.
//   C — bound the options payload (max 50 items / 8KB).
//   D — user-path fromEntityId must be a real bound entity on the device.
//
// Same pg-mock + supertest style as action-request-consensus-realtime.test.js.

// ── pg mock: one shared query fn for pool.query AND client.query, plus a
//    pool.connect() that returns a client whose query is recorded too, so the
//    Fix-A transaction (BEGIN/lock/DROP/ADD/COMMIT) is observable. ──
const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockClientQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockClientRelease = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockPoolQuery,
        connect: mockConnect,
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const express = require('express');
const request = require('supertest');

const deviceId = 'test-dev';
const deviceSecret = 'dev-secret';
const UUID = '11111111-2222-3333-4444-555555555555';

let app;
let emitToRoom;

beforeAll(() => {
    app = express();
    app.use(express.json());
    const devices = {
        [deviceId]: {
            deviceSecret,
            entities: {
                2: { isBound: true, botSecret: 'bot-2' },
                3: { isBound: true, botSecret: 'bot-3' },
            },
        },
    };
    emitToRoom = jest.fn();
    const io = { to: jest.fn(() => ({ emit: emitToRoom })) };
    const mod = require('../../agent-action-requests')(devices, { serverLog: () => {}, io });
    app.use('/api/action-requests', mod.router);
});

afterEach(() => {
    mockPoolQuery.mockClear();
    mockClientQuery.mockClear();
    mockClientRelease.mockClear();
    mockConnect.mockClear();
    emitToRoom.mockClear();
});

const post = (p) => request(app).post(p);

function rowFixture(over = {}) {
    return {
        id: UUID, device_id: deviceId, from_entity_id: 2, anchor_message_id: null,
        type: 'consensus', prompt: 'p', options: null,
        status: 'pending', answer: null,
        created_at: new Date('2026-06-25T00:00:00Z'), resolved_at: null, ...over,
    };
}

// Find the resolve/dismiss UPDATE call among pool.query invocations.
function findUpdate(verb) {
    const calls = mockPoolQuery.mock.calls;
    const re = new RegExp(`status = '${verb}'`);
    return calls.find((c) => typeof c[0] === 'string' && re.test(c[0]));
}

// ════════════════════════════════════════════════════════════════════
// Fix B — bot resolve/dismiss scoped to OWN requests; user unrestricted
// ════════════════════════════════════════════════════════════════════
describe('Fix B — bot resolve/dismiss scoped to own emitted requests', () => {
    describe('resolve', () => {
        it("botSecret resolve of ANOTHER entity's request → UPDATE carries from_entity_id predicate, 0 rows → 404, no emit", async () => {
            // entity 2 (bot-2) tries to resolve a request emitted by entity 3.
            // Scoping appends `AND from_entity_id = $4`; mock returns 0 rows.
            mockPoolQuery.mockResolvedValueOnce({ rows: [] });
            const res = await post(`/api/action-requests/${UUID}/resolve`).send({
                deviceId, botSecret: 'bot-2', entityId: 2, answer: 'x',
            });
            expect(res.status).toBe(404);
            const upd = findUpdate('resolved');
            expect(upd).toBeTruthy();
            expect(upd[0]).toMatch(/from_entity_id = \$\d+/);
            // the restriction param is the bot's own entityId (2)
            expect(upd[1]).toContain(2);
            expect(emitToRoom).not.toHaveBeenCalled();
        });

        it('botSecret resolve of its OWN request → 200 + emit', async () => {
            mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ status: 'resolved', from_entity_id: 2, answer: 'ok', resolved_at: new Date() })] });
            const res = await post(`/api/action-requests/${UUID}/resolve`).send({
                deviceId, botSecret: 'bot-2', entityId: 2, answer: 'ok',
            });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            const upd = findUpdate('resolved');
            expect(upd[0]).toMatch(/from_entity_id = \$\d+/);
            expect(emitToRoom).toHaveBeenCalledTimes(1);
        });

        it('deviceSecret (user) resolve → UPDATE has NO from_entity_id predicate → 200', async () => {
            mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ status: 'resolved', from_entity_id: 3, answer: 'ok', resolved_at: new Date() })] });
            const res = await post(`/api/action-requests/${UUID}/resolve`).send({
                deviceId, deviceSecret, answer: 'ok',
            });
            expect(res.status).toBe(200);
            const upd = findUpdate('resolved');
            expect(upd).toBeTruthy();
            expect(upd[0]).not.toMatch(/from_entity_id/);
            // params for the user path: [answerJson, id, deviceId] only (no entity restriction)
            expect(upd[1]).toHaveLength(3);
        });
    });

    describe('dismiss', () => {
        it("botSecret dismiss of ANOTHER entity's request → UPDATE carries from_entity_id predicate, 0 rows → 404, no emit", async () => {
            mockPoolQuery.mockResolvedValueOnce({ rows: [] });
            const res = await post(`/api/action-requests/${UUID}/dismiss`).send({
                deviceId, botSecret: 'bot-2', entityId: 2,
            });
            expect(res.status).toBe(404);
            const upd = findUpdate('dismissed');
            expect(upd).toBeTruthy();
            expect(upd[0]).toMatch(/from_entity_id = \$\d+/);
            expect(upd[1]).toContain(2);
            expect(emitToRoom).not.toHaveBeenCalled();
        });

        it('botSecret dismiss of its OWN request → 200 + emit', async () => {
            mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ status: 'dismissed', from_entity_id: 2, resolved_at: new Date() })] });
            const res = await post(`/api/action-requests/${UUID}/dismiss`).send({
                deviceId, botSecret: 'bot-2', entityId: 2,
            });
            expect(res.status).toBe(200);
            const upd = findUpdate('dismissed');
            expect(upd[0]).toMatch(/from_entity_id = \$\d+/);
            expect(emitToRoom).toHaveBeenCalledTimes(1);
        });

        it('deviceSecret (user) dismiss → UPDATE has NO from_entity_id predicate → 200', async () => {
            mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ status: 'dismissed', from_entity_id: 3, resolved_at: new Date() })] });
            const res = await post(`/api/action-requests/${UUID}/dismiss`).send({
                deviceId, deviceSecret,
            });
            expect(res.status).toBe(200);
            const upd = findUpdate('dismissed');
            expect(upd[0]).not.toMatch(/from_entity_id/);
            expect(upd[1]).toHaveLength(2); // [id, deviceId] only
        });
    });
});

// ════════════════════════════════════════════════════════════════════
// Fix C — bound the options payload
// ════════════════════════════════════════════════════════════════════
describe('Fix C — options payload bound (max 50 items / 8KB)', () => {
    it('options with 51 elements → 400', async () => {
        const options = Array.from({ length: 51 }, (_, i) => `o${i}`);
        const res = await post('/api/action-requests').send({
            deviceId, botSecret: 'bot-2', entityId: 2, type: 'decision', prompt: 'p', options,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/options too large/);
    });

    it('options whose JSON exceeds 8KB → 400', async () => {
        // 10 items, each ~1KB → > 8192 bytes serialized, but only 10 items (< 50)
        const options = Array.from({ length: 10 }, () => 'x'.repeat(1000));
        expect(options.length).toBeLessThanOrEqual(50);
        expect(JSON.stringify(options).length).toBeGreaterThan(8192);
        const res = await post('/api/action-requests').send({
            deviceId, botSecret: 'bot-2', entityId: 2, type: 'decision', prompt: 'p', options,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/options too large/);
    });

    it('a small options array → 200 (not rejected)', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ options: ['a', 'b'] })] });
        const res = await post('/api/action-requests').send({
            deviceId, botSecret: 'bot-2', entityId: 2, type: 'decision', prompt: 'p', options: ['a', 'b'],
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════
// Fix D — user-path fromEntityId validated against device.entities
// ════════════════════════════════════════════════════════════════════
describe('Fix D — user-path fromEntityId validated against device.entities', () => {
    it('user (deviceSecret) emit with fromEntityId NOT on device → 400', async () => {
        const res = await post('/api/action-requests').send({
            deviceId, deviceSecret, fromEntityId: 99, type: 'decision', prompt: 'p',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not a known entity on this device/);
    });

    it('user (deviceSecret) emit with a valid bound entity → 200', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ from_entity_id: 3 })] });
        const res = await post('/api/action-requests').send({
            deviceId, deviceSecret, fromEntityId: 3, type: 'decision', prompt: 'p',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        // INSERT received from_entity_id = 3
        const insert = mockPoolQuery.mock.calls.find((c) => /INSERT INTO agent_action_requests/.test(c[0]));
        expect(insert[1][1]).toBe(3);
    });

    it('bot (botSecret) emit still works — uses its own vetted entityId, no device.entities check', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ from_entity_id: 2 })] });
        const res = await post('/api/action-requests').send({
            deviceId, botSecret: 'bot-2', entityId: 2, type: 'decision', prompt: 'p',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════
// Fix A — idempotent, transactional aar_type_valid migration
// ════════════════════════════════════════════════════════════════════
describe('Fix A — idempotent transactional constraint migration', () => {
    // initDatabase reads schema.sql then runs the guarded migration. We drive the
    // pg mock to control what the `pg_get_constraintdef` SELECT returns. The
    // schema.sql statements + the SELECT all go through pool.query; the DROP/ADD
    // (only when stale) go through a connected client (pool.connect → client.query).
    const { initAgentActionRequestsDatabase } = require('../../agent-action-requests');

    function constraintDefSelectMock(def) {
        // Make pool.query resolve schema statements as no-ops, but return the
        // given constraint def for the pg_get_constraintdef SELECT.
        mockPoolQuery.mockImplementation((sql) => {
            if (typeof sql === 'string' && /pg_get_constraintdef/.test(sql)) {
                return Promise.resolve({ rows: def === null ? [] : [{ def }] });
            }
            return Promise.resolve({ rows: [], rowCount: 0 });
        });
    }

    afterEach(() => {
        mockPoolQuery.mockReset();
        mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
        mockClientQuery.mockReset();
        mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    });

    it('def already contains consensus → migration SKIPPED (no client connect, no ADD CONSTRAINT)', async () => {
        constraintDefSelectMock("CHECK ((type)::text = ANY (ARRAY['decision','approval','input','credential','review','clarify','consensus']))");
        await expect(initAgentActionRequestsDatabase()).resolves.toBeUndefined();
        // No transaction client opened, no ADD CONSTRAINT issued anywhere.
        expect(mockConnect).not.toHaveBeenCalled();
        const addOnPool = mockPoolQuery.mock.calls.find((c) => /ADD CONSTRAINT aar_type_valid/.test(c[0]));
        const addOnClient = mockClientQuery.mock.calls.find((c) => /ADD CONSTRAINT aar_type_valid/.test(c[0]));
        expect(addOnPool).toBeUndefined();
        expect(addOnClient).toBeUndefined();
    });

    it('def lacks consensus → DROP+ADD run inside BEGIN/COMMIT on a pooled client', async () => {
        constraintDefSelectMock("CHECK ((type)::text = ANY (ARRAY['decision','approval','input','credential','review','clarify']))");
        await expect(initAgentActionRequestsDatabase()).resolves.toBeUndefined();
        expect(mockConnect).toHaveBeenCalledTimes(1);
        const clientSql = mockClientQuery.mock.calls.map((c) => c[0]);
        const joined = clientSql.join('\n');
        expect(joined).toMatch(/BEGIN/);
        expect(joined).toMatch(/DROP CONSTRAINT IF EXISTS aar_type_valid/);
        expect(joined).toMatch(/ADD CONSTRAINT\s+aar_type_valid/);
        expect(joined).toMatch(/COMMIT/);
        // DROP+ADD must be committed (no bare-constraint window): COMMIT comes after both.
        const iDrop = clientSql.findIndex((s) => /DROP CONSTRAINT/.test(s));
        const iAdd = clientSql.findIndex((s) => /ADD CONSTRAINT/.test(s));
        const iCommit = clientSql.findIndex((s) => /COMMIT/.test(s));
        expect(iDrop).toBeGreaterThanOrEqual(0);
        expect(iAdd).toBeGreaterThan(iDrop);
        expect(iCommit).toBeGreaterThan(iAdd);
        // released back to the pool
        expect(mockClientRelease).toHaveBeenCalled();
    });

    it('no existing constraint row (fresh table) → DROP+ADD still run transactionally', async () => {
        constraintDefSelectMock(null); // SELECT returns 0 rows
        await expect(initAgentActionRequestsDatabase()).resolves.toBeUndefined();
        expect(mockConnect).toHaveBeenCalledTimes(1);
        const joined = mockClientQuery.mock.calls.map((c) => c[0]).join('\n');
        expect(joined).toMatch(/ADD CONSTRAINT\s+aar_type_valid/);
        expect(joined).toMatch(/COMMIT/);
    });

    it('init never throws even if the migration SELECT rejects', async () => {
        mockPoolQuery.mockImplementation((sql) => {
            if (typeof sql === 'string' && /pg_get_constraintdef/.test(sql)) {
                return Promise.reject(new Error('boom'));
            }
            return Promise.resolve({ rows: [], rowCount: 0 });
        });
        await expect(initAgentActionRequestsDatabase()).resolves.toBeUndefined();
    });
});
