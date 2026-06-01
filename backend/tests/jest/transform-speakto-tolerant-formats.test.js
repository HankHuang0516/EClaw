/**
 * /api/transform speakTo tolerant formats + fallback-anchor regression
 * (PR #2291)
 *
 * Two related fixes:
 *
 * 1. resolveSpeakToTarget now accepts decorated forms like `#6`, `@#6`,
 *    `<#6>`, `@abc123`, `<@abc123>` in the speakTo array — strips the
 *    decorator and falls back to publicCode / numeric-entityId lookup.
 *    Claude / LLM bots routinely confuse the in-text @-mention syntax
 *    with the speakTo array contract, sending `speakTo: ["#6"]` when
 *    they mean "deliver to entity 6". Server now does the right thing.
 *
 * 2. When delivery requested but every target fails to resolve, the
 *    fallback save no longer borrows `pendingA2A.fromEntityId` as a
 *    chatSource arrow. That produced misleading rows like
 *    `entity:2:LOBSTER->3 delivered=false` for a message that was
 *    never sent to entity 3. We now save with `entity.name` so chat
 *    UI clearly renders it as a sender-only row.
 */

require('./helpers/mock-setup');

const request = require('supertest');
const pg = require('pg');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

let chatInserts = [];

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
                });
                return { rows: [{ id: `mock-${chatInserts.length}` }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }),
        connect: jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }),
        end: jest.fn().mockResolvedValue(undefined),
    }));
    app = require('../../index');
    pg.Pool = originalPool;
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

beforeEach(() => { chatInserts = []; });

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

function rowsForProbe(tag) {
    return chatInserts.filter(r => (r.text || '').includes(tag));
}

describe('POST /api/transform — speakTo tolerant formats (#2291)', () => {
    let deviceId, deviceSecret, botSecret2, entity1Code;

    beforeAll(async () => {
        deviceId = 'speakto-tolerant';
        deviceSecret = await registerDevice(deviceId);
        await bindEntity(deviceId, deviceSecret, 0);
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        await bindEntity(deviceId, deviceSecret, 1);
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        botSecret2 = await bindEntity(deviceId, deviceSecret, 2);

        const { devices } = require('../../index');
        entity1Code = devices[deviceId].entities[1].publicCode;

        // pendingA2A entry from entity 0 — pre-fix, the fallback would have
        // anchored chatSource to ->0 even though delivery target was #1.
        devices[deviceId].entities[2].messageQueue.push({
            text: 'priming',
            from: 'entity:0:LOBSTER',
            fromEntityId: 0,
            timestamp: Date.now(),
            crossDevice: false,
        });
    });

    test.each([
        ['#1',           'hash + numeric'],
        ['@#1',          '@-prefixed hash'],
        ['<#1>',         'bracketed hash'],
    ])('speakTo: ["%s"] → resolves to entity 1 (%s)', async (speakToCode) => {
        const tag = `TOL-${speakToCode}-${Date.now()}`;
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 2,
            botSecret: botSecret2,
            state: 'IDLE',
            message: tag,
            speakTo: [speakToCode],
        });

        expect(res.status).toBe(200);
        // Resolved: delivery routed to entity 1 (not "not_found")
        expect(res.body.delivery?.results?.[0]?.success).toBe(true);
        expect(res.body.delivery?.results?.[0]?.entityId).toBe(1);

        const rows = rowsForProbe(tag);
        // Single delivery row, source pointing to ->1 (the real target)
        expect(rows.some(r => r.source && r.source.endsWith('->1'))).toBe(true);
        // No misleading ->0 phantom from the pendingA2A anchor
        expect(rows.some(r => r.source && /->0$/.test(r.source))).toBe(false);
    });

    test('speakTo: ["@<publicCode>"] strips @ and resolves', async () => {
        const tag = `TOL-AT-PUB-${Date.now()}`;
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 2,
            botSecret: botSecret2,
            state: 'IDLE',
            message: tag,
            speakTo: [`@${entity1Code}`],
        });

        expect(res.status).toBe(200);
        expect(res.body.delivery?.results?.[0]?.success).toBe(true);
        expect(res.body.delivery?.results?.[0]?.entityId).toBe(1);
    });

    test('speakTo: ["<@publicCode>"] strips < > and @ and resolves', async () => {
        const tag = `TOL-LT-PUB-${Date.now()}`;
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 2,
            botSecret: botSecret2,
            state: 'IDLE',
            message: tag,
            speakTo: [`<@${entity1Code}>`],
        });

        expect(res.status).toBe(200);
        expect(res.body.delivery?.results?.[0]?.success).toBe(true);
        expect(res.body.delivery?.results?.[0]?.entityId).toBe(1);
    });

    test('speakTo: ["notreal"] (unparseable format) → 400 speakTo_invalid_format', async () => {
        const tag = `TOL-FMT-${Date.now()}`;
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 2,
            botSecret: botSecret2,
            state: 'IDLE',
            message: tag,
            speakTo: ['notreal'],
        });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('speakTo_invalid_format');
        expect(res.body.got).toBe('notreal');
        // Gate fires before delivery — no chat row should have been saved
        const rows = rowsForProbe(tag);
        expect(rows).toHaveLength(0);
    });

    test.each([
        ['Lobster',     'mixed-case word (likely entity name)'],
        ['team-2',      'with hyphen'],
        ['abc',         'too short'],
        ['ABCDEF',      'uppercase 6-char'],
        ['  ',          'whitespace only'],
        ['',            'empty string'],
        ['@@abc123',    'double-@ junk'],
        ['hello world', 'with space'],
    ])('speakTo: [%j] (%s) → 400 speakTo_invalid_format', async (badEntry) => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 2,
            botSecret: botSecret2,
            state: 'IDLE',
            message: `BAD-${Date.now()}`,
            speakTo: [badEntry],
        });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('speakTo_invalid_format');
        expect(res.body.got).toBe(badEntry);
    });

    test('speakTo: "abc123" (non-array container) → 400 speakTo_invalid_format', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 2,
            botSecret: botSecret2,
            state: 'IDLE',
            message: `BAD-CONTAINER-${Date.now()}`,
            speakTo: 'abc123',
        });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('speakTo_invalid_format');
        expect(res.body.expected).toMatch(/array/);
    });

    test('speakTo: ["#999"] (numeric but invalid entity) → not_found, no phantom anchor', async () => {
        const tag = `TOL-INV-NUM-${Date.now()}`;
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 2,
            botSecret: botSecret2,
            state: 'IDLE',
            message: tag,
            speakTo: ['#999'],
        });

        expect(res.status).toBe(200);
        expect(res.body.delivery?.results?.[0]?.success).toBe(false);

        const rows = rowsForProbe(tag);
        expect(rows).toHaveLength(1);
        // No misleading routing arrow
        expect(/->\d+$/.test(rows[0].source)).toBe(false);
    });
});
