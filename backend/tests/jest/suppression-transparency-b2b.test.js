/**
 * Suppression-transparency + b2b quota countdown (card_59f41e5b).
 *
 * Covers the backend contract the front-end (#6) builds against:
 *   - recordSuppressedForward() ring buffer (cap 50, oldest dropped)
 *   - getBotToBotNextRegenMs() countdown semantics
 *   - GET /api/suppression-log   (auth + shape)
 *   - GET /api/b2b-status        (auth + shape)
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app, indexModule;

const post = (path) => request(app).post(path).set('Host', 'localhost');
const get = (path) => request(app).get(path).set('Host', 'localhost');

async function bindEntity(deviceId, deviceSecret, entityId = 0) {
    if (entityId > 0) {
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
    }
    const regRes = await post('/api/device/register').send({ deviceId, deviceSecret, entityId });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;
    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
}

beforeAll(() => {
    indexModule = require('../../index');
    app = indexModule;
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

describe('recordSuppressedForward() ring buffer', () => {
    const recordSuppressedForward = () => indexModule._recordSuppressedForward;
    const suppressionLog = () => indexModule._suppressionLog;
    const CAP = () => indexModule._SUPPRESSION_LOG_CAP;
    const deviceId = 'supp-ring-dev';

    beforeEach(() => { delete suppressionLog()[deviceId]; });

    it('records {ts, fromEntityId, reason, snippet} and clamps snippet to 80 chars', () => {
        const long = 'x'.repeat(200);
        const rec = recordSuppressedForward()(deviceId, { fromEntityId: 5, reason: 'ack', snippet: long });
        expect(rec).toMatchObject({ fromEntityId: 5, reason: 'ack' });
        expect(typeof rec.ts).toBe('number');
        expect(rec.snippet.length).toBe(80);
        expect(suppressionLog()[deviceId]).toHaveLength(1);
    });

    it('defaults reason to "low_signal" and fromEntityId to null', () => {
        const rec = recordSuppressedForward()(deviceId, { snippet: 'hi' });
        expect(rec.reason).toBe('low_signal');
        expect(rec.fromEntityId).toBeNull();
    });

    it('caps the per-device buffer at SUPPRESSION_LOG_CAP, dropping oldest (oldest-first order)', () => {
        const cap = CAP();
        for (let i = 0; i < cap + 10; i++) {
            recordSuppressedForward()(deviceId, { fromEntityId: 1, reason: 'ack', snippet: `m${i}` });
        }
        const arr = suppressionLog()[deviceId];
        expect(arr).toHaveLength(cap);
        // Oldest (m0..m9) dropped; first surviving is m10, last is the newest.
        expect(arr[0].snippet).toBe('m10');
        expect(arr[arr.length - 1].snippet).toBe(`m${cap + 9}`);
    });

    it('returns null (no record) when deviceId is missing', () => {
        expect(recordSuppressedForward()(null, { reason: 'ack', snippet: 'x' })).toBeNull();
    });
});

describe('getBotToBotNextRegenMs()', () => {
    const checkRL = () => indexModule._checkBotToBotRateLimit;
    const nextRegen = () => indexModule._getBotToBotNextRegenMs;
    const remaining = () => indexModule._getBotToBotRemaining;
    const MAX = () => indexModule._BOT2BOT_MAX_MESSAGES;
    const INTERVAL = () => indexModule._BOT2BOT_REGEN_INTERVAL_MS;
    const deviceId = 'supp-b2b-dev';
    const entityId = 7;

    it('returns 0 when no bucket exists (nothing pending to regen)', () => {
        expect(nextRegen()(deviceId, 999)).toBe(0);
        expect(remaining()(deviceId, 999)).toBe(MAX());
    });

    it('returns a positive countdown <= REGEN_INTERVAL once a token is consumed', () => {
        const before = Date.now();
        expect(checkRL()(deviceId, entityId)).toBe(true); // consume 1 token -> count=1
        const ms = nextRegen()(deviceId, entityId);
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(INTERVAL());
        // remaining dropped by exactly 1
        expect(remaining()(deviceId, entityId)).toBe(MAX() - 1);
        // sanity: countdown is consistent with just-now lastRegenAt
        expect(ms).toBeGreaterThan(INTERVAL() - (Date.now() - before) - 2000);
    });
});

describe('GET /api/suppression-log', () => {
    const deviceId = 'supp-ep-dev';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret;

    beforeAll(async () => {
        botSecret = await bindEntity(deviceId, deviceSecret, 0);
        // seed two suppressed records
        indexModule._recordSuppressedForward(deviceId, { fromEntityId: 0, reason: 'ack', snippet: '收到 🦞' });
        indexModule._recordSuppressedForward(deviceId, { fromEntityId: 1, reason: 'heartbeat', snippet: '收到，#6 仍在跑' });
    });

    it('rejects missing deviceId (400)', async () => {
        const res = await get('/api/suppression-log');
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('rejects bad credentials (403)', async () => {
        const res = await get(`/api/suppression-log?deviceId=${deviceId}&deviceSecret=wrong`);
        expect(res.status).toBe(403);
    });

    it('returns the device ring buffer with deviceSecret auth (oldest-first)', async () => {
        const res = await get(`/api/suppression-log?deviceId=${deviceId}&deviceSecret=${deviceSecret}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.count).toBe(res.body.items.length);
        expect(res.body.count).toBeGreaterThanOrEqual(2);
        const last = res.body.items[res.body.items.length - 1];
        expect(last).toMatchObject({ reason: 'heartbeat', fromEntityId: 1 });
        expect(typeof last.ts).toBe('number');
    });

    it('returns the device ring buffer with botSecret+entityId auth', async () => {
        const res = await get(`/api/suppression-log?deviceId=${deviceId}&botSecret=${botSecret}&entityId=0`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.items)).toBe(true);
    });
});

describe('GET /api/b2b-status', () => {
    const deviceId = 'supp-b2bstatus-dev';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret;

    beforeAll(async () => {
        botSecret = await bindEntity(deviceId, deviceSecret, 0);
    });

    it('rejects bad credentials (403)', async () => {
        const res = await get(`/api/b2b-status?deviceId=${deviceId}&deviceSecret=wrong`);
        expect(res.status).toBe(403);
    });

    it('returns per-entity quota + countdown with deviceSecret auth', async () => {
        const res = await get(`/api/b2b-status?deviceId=${deviceId}&deviceSecret=${deviceSecret}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.max).toBe(indexModule._BOT2BOT_MAX_MESSAGES);
        expect(Array.isArray(res.body.entities)).toBe(true);
        expect(res.body.entities.length).toBeGreaterThanOrEqual(1);
        const e = res.body.entities[0];
        expect(e).toHaveProperty('entityId');
        expect(e).toHaveProperty('remaining');
        expect(e).toHaveProperty('max');
        expect(e).toHaveProperty('nextRegenMs');
        expect(e.max).toBe(indexModule._BOT2BOT_MAX_MESSAGES);
        // fresh entity: full quota, no pending regen
        expect(e.remaining).toBe(indexModule._BOT2BOT_MAX_MESSAGES);
        expect(e.nextRegenMs).toBe(0);
    });

    it('scopes to a single entity when entityId is provided (bot self-view)', async () => {
        const res = await get(`/api/b2b-status?deviceId=${deviceId}&botSecret=${botSecret}&entityId=0`);
        expect(res.status).toBe(200);
        expect(res.body.entities).toHaveLength(1);
        expect(res.body.entities[0].entityId).toBe(0);
    });
});
