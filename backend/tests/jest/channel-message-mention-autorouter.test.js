/**
 * /api/channel/message — @-mention auto-router parity (PR #2300)
 *
 * Brings the in-text @-mention auto-fill from /api/transform (added in
 * #1619, 2026-04-06) onto the channel-bridge endpoint. Without this, LLM
 * channel bridges (claude / codex / hermes) would silently drop routing
 * intent embedded in their reply text.
 *
 * Repro of the production bug (his_6af72154-... 2026-05-03 08:38):
 *   Claude bridge POST /api/channel/message
 *     { message: "@#6 Codex 嗨, ..." }   ← no speakTo, no broadcast
 *   Pre-fix: chat row source = entity.name, no routing happened
 *   Post-fix: auto-router resolves @#6 → speakTo=[publicCode of #6]
 *             → real delivery to entity 6
 */

require('./helpers/mock-setup');

const db = require('../../db');
const apiKey = 'eck_mention_autorouter_test';
const account = { id: 1, channel_api_key: apiKey, channel_api_secret: 'ecs_test', deviceId: null, entityId: null };
db.getChannelAccountByKey = jest.fn().mockImplementation(async (key) => key === apiKey ? account : null);
db.getChannelAccountsByDevice = jest.fn().mockResolvedValue([]);
db.createChannelAccount = jest.fn().mockResolvedValue(account);
db.getChannelAccountById = jest.fn().mockResolvedValue(null);
db.deleteChannelAccount = jest.fn().mockResolvedValue(true);
db.updateChannelCallback = jest.fn().mockResolvedValue(true);
db.updateChannelE2eeCapable = jest.fn().mockResolvedValue(true);
db.clearChannelCallback = jest.fn().mockResolvedValue(true);
db.getChannelAccountByDevice = jest.fn().mockResolvedValue(null);

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

describe('POST /api/channel/message — @-mention auto-router (#2300)', () => {
    let deviceId, deviceSecret, botSecret2, entity1Code;

    beforeAll(async () => {
        deviceId = 'chmsg-mention';
        deviceSecret = await registerDevice(deviceId);
        await bindEntity(deviceId, deviceSecret, 0);
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        await bindEntity(deviceId, deviceSecret, 1);
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        botSecret2 = await bindEntity(deviceId, deviceSecret, 2);

        const { devices } = require('../../index');
        entity1Code = devices[deviceId].entities[1].publicCode;
        expect(entity1Code).toBeTruthy();
    });

    it('@#N at start of text, no explicit speakTo → auto-fills speakTo and routes to N', async () => {
        // card_488f05: first-token-only rule — mention must lead the message
        // for auto-promote to fire. Routing-intent messages from LLM bridges
        // conventionally lead with the target (`@#1 hi entity 1`).
        const tag = `CHMSG-AT-${Date.now()}`;
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `@#1 ${tag} hi entity 1`,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.delivery?.results?.[0]?.entityId).toBe(1);
        expect(res.body.mentions?.mentions?.[0]?.entityId).toBe(1);

        const rows = rowsForProbe(tag);
        // Single delivery row, source pointing to ->1 (the real target).
        // No phantom self-save, no `entity.name` fallback.
        expect(rows).toHaveLength(1);
        expect(rows[0].source).toMatch(/entity:2:[A-Z]+->1$/);
    });

    it('<@publicCode> at start of text → auto-fills speakTo with publicCode', async () => {
        const tag = `CHMSG-PC-${Date.now()}`;
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `<@${entity1Code}> ${tag} via publicCode form`,
        });
        expect(res.status).toBe(200);
        expect(res.body.delivery?.results?.[0]?.entityId).toBe(1);
        expect(res.body.delivery?.results?.[0]?.publicCode).toBe(entity1Code);
    });

    it('@all in text, no explicit broadcast → auto-sets broadcast=true', async () => {
        const tag = `CHMSG-ALL-${Date.now()}`;
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `${tag} @all heads up`,
        });
        expect(res.status).toBe(200);
        // Broadcast was set; delivery shape is broadcast-style
        expect(res.body.delivery?.broadcast).toBe(true);
        expect(res.body.mentions?.hasAll).toBe(true);
    });

    it('explicit speakTo wins over in-text @-mention (regardless of position)', async () => {
        // Explicit body.speakTo bypasses the first-token-only rule entirely —
        // it sets the precedence rule directly.
        const tag = `CHMSG-EXPLICIT-${Date.now()}`;
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `${tag} @#1 trying to redirect`,
            speakTo: [entity1Code], // explicit, same target — but sets the precedence rule
        });
        expect(res.status).toBe(200);
        // Auto-router observed mentions but did NOT fill speakTo because explicit was set
        expect(res.body.delivery?.results?.[0]?.entityId).toBe(1);
        expect(res.body.mentions?.mentions?.[0]?.entityId).toBe(1);
    });

    it('senderHint is lower precedence than in-text @-mention at start', async () => {
        // Mention at start qualifies for auto-promote and wins over senderHint.
        const tag = `CHMSG-PREC-${Date.now()}`;
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `@#1 ${tag} in-text wins`,
            senderHint: { kind: 'broadcast' }, // would otherwise broadcast
        });
        expect(res.status).toBe(200);
        // In-text @-mention won → delivery to entity 1, not broadcast
        expect(res.body.delivery?.results?.[0]?.entityId).toBe(1);
        // senderHint resolution reports it didn't fire
        expect(res.body.senderHintResolution.applied).toBe('none');
        expect(res.body.senderHintResolution.reason).toBe('explicit_won');
    });

    it('no @-mention, no speakTo, no senderHint → still saves a sender-only row (no fake routing arrow)', async () => {
        const tag = `CHMSG-PLAIN-${Date.now()}`;
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `${tag} pure status, no routing`,
        });
        expect(res.status).toBe(200);
        expect(res.body.mentions).toBeUndefined();

        const rows = rowsForProbe(tag);
        expect(rows).toHaveLength(1);
        // Source is plain entity name, NO `->X` arrow that would mislead the UI.
        expect(/->\d+$/.test(rows[0].source)).toBe(false);
    });
});
