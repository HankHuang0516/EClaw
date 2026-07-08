/**
 * /api/transform self-save phantom-row regression (PR #2290 / fixes #2282)
 *
 * Repro: bot calls /api/transform with `@#N` in the message text but no
 * explicit `speakTo`. Pre-fix, the transform handler ran the self-save
 * BEFORE the @-mention auto-router populated speakTo, so:
 *   1. hasDelivery=false (speakTo not yet set)
 *   2. Self-save fired with chatSource based on `pendingA2A.fromEntityId`
 *      → phantom row `entity:N:CHAR->X delivered=false`
 *   3. Auto-router populated speakTo from `@#N`
 *   4. Delivery loop saved the real `entity:N:CHAR->target delivered=true` row
 *
 * Net result: every such call wrote TWO chat rows when it should have
 * written ONE.
 *
 * Post-fix: routing resolution runs before hasDelivery, so the self-save
 * correctly skips and only the delivery row is written.
 *
 * Verification strategy: the pg Pool is mocked, so /api/chat/history won't
 * return rows. Instead we spy on every INSERT INTO chat_messages call,
 * filter by the per-probe tag, and assert the row count + source format.
 */

require('./helpers/mock-setup');

const request = require('supertest');
const pg = require('pg');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

/** Captured INSERT INTO chat_messages calls (globally, across the chat pool). */
let chatInserts = [];

/**
 * The pg mock in mock-setup.js installs a fresh `query: jest.fn()` per Pool
 * instance. We override the Pool constructor BEFORE require()-ing the index
 * module so the chatPool's `query` is one we control and records inserts.
 */
beforeAll(() => {
    const originalPool = pg.Pool;
    pg.Pool = jest.fn().mockImplementation(() => ({
        query: jest.fn().mockImplementation(async (sql, params) => {
            const sqlStr = typeof sql === 'string' ? sql : (sql && sql.text) || '';
            if (/^\s*INSERT INTO chat_messages/i.test(sqlStr)) {
                chatInserts.push({
                    deviceId: params?.[0],
                    entityId: params?.[1],
                    text: params?.[2],
                    source: params?.[3],
                    isFromUser: params?.[4],
                    isFromBot: params?.[5],
                });
                return { rows: [{ id: `mock-${chatInserts.length}` }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }),
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    }));

    app = require('../../index');
    // Restore for any later require() in unrelated test files.
    pg.Pool = originalPool;
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

beforeEach(() => {
    chatInserts = [];
});

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register').send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

async function bindEntity(deviceId, deviceSecret, entityId = 0) {
    const regRes = await post('/api/device/register').send({ deviceId, deviceSecret, entityId });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;
    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
}

describe('POST /api/transform — self-save phantom-row regression (#2282)', () => {
    let deviceId, deviceSecret, botSecret2, entity1Code;

    beforeAll(async () => {
        deviceId = 'phantom-repro';
        deviceSecret = await registerDevice(deviceId);
        await bindEntity(deviceId, deviceSecret, 0);
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        await bindEntity(deviceId, deviceSecret, 1);
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        botSecret2 = await bindEntity(deviceId, deviceSecret, 2);
        expect(botSecret2).toBeTruthy();

        const { devices } = require('../../index');
        entity1Code = devices[deviceId].entities[1].publicCode;
        expect(entity1Code).toBeTruthy();

        // Inject a pendingA2A entry into entity 2's messageQueue so the
        // pre-fix code path would resolve `pendingA2A.fromEntityId` to entity
        // 0 and write a phantom `entity:2:LOBSTER->0 delivered=false` row in
        // addition to the real `->1` delivery row.
        devices[deviceId].entities[2].messageQueue.push({
            text: 'priming entry — bot sees this as if from entity 0',
            from: 'entity:0:LOBSTER',
            fromEntityId: 0,
            timestamp: Date.now(),
            crossDevice: false,
        });
    });

    /** Inserts whose text matches the per-probe tag. */
    function rowsForProbe(tag) {
        return chatInserts.filter(r => (r.text || '').includes(tag));
    }

    it('@#N in text, no explicit speakTo → ONE chat row only (the real delivery)', async () => {
        const tag = `PROBE-A-${Date.now()}`;
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 2,
            botSecret: botSecret2,
            state: 'IDLE',
            // card_2ee0afbb defect 2: /api/transform now auto-promotes an
            // in-text @-mention to speakTo only when it is the FIRST token
            // (parity with /api/channel). Lead with @#1 so this phantom-row
            // regression keeps exercising the real-delivery path it targets.
            message: `@#1 ${tag} hello`,
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        // Auto-router resolved @#1 to entity 1's publicCode
        expect(res.body.delivery?.results?.[0]?.publicCode).toBe(entity1Code);

        const rows = rowsForProbe(tag);
        // Pre-fix expected: 2 rows (phantom ->0 + real ->1)
        // Post-fix expected: 1 row (real ->1)
        expect(rows).toHaveLength(1);
        // Same-device delivery uses entityId in the source (not publicCode).
        expect(rows[0].source).toMatch(/entity:2:[A-Z]+->1$/);
    });

    it('explicit speakTo, no @-mention → ONE chat row (always was clean)', async () => {
        const tag = `PROBE-B-${Date.now()}`;
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 2,
            botSecret: botSecret2,
            state: 'IDLE',
            message: `${tag} explicit speakTo, no token`,
            speakTo: [entity1Code],
        });

        expect(res.status).toBe(200);
        const rows = rowsForProbe(tag);
        expect(rows).toHaveLength(1);
        // Same-device delivery uses entityId in the source (not publicCode).
        expect(rows[0].source).toMatch(/entity:2:[A-Z]+->1$/);
    });

    it('no speakTo and no @-mention → ONE self-status row (no phantom anchor)', async () => {
        const tag = `PROBE-C-${Date.now()}`;
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 2,
            botSecret: botSecret2,
            state: 'IDLE',
            message: `${tag} status update only`,
        });

        expect(res.status).toBe(200);
        const rows = rowsForProbe(tag);
        // No routing resolved → exactly one self-save row (no duplicate).
        expect(rows).toHaveLength(1);
        // Post-PR-#2292: chatSource is plain entity name (no `->X` arrow).
        // The pendingA2A presence is logged via [A2A_BOT_REPLY] but does not
        // pollute the chat row's source field with a fake routing target.
        expect(/->\d+$/.test(rows[0].source)).toBe(false);
    });

    it('@all in text → broadcast resolved before self-save → no phantom', async () => {
        const tag = `PROBE-D-${Date.now()}`;
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 2,
            botSecret: botSecret2,
            state: 'IDLE',
            message: `${tag} @all heads up`,
        });

        expect(res.status).toBe(200);
        // Auto-router lifts @all to broadcast=true; the broadcast path
        // saves a single sender-side row tagged `entity:2:CHAR->id1,id2,...`.
        const rows = rowsForProbe(tag);
        expect(rows).toHaveLength(1);
        // Broadcast source format: `entity:N:CHAR->id1,id2,...`
        expect(rows[0].source).toMatch(/entity:2:[A-Z]+->\d+(?:,\d+)*$/);
    });
});
