/**
 * /api/entity/walk-config — self-sovereign wallpaper walk config (Jest + Supertest)
 * card_31f828967b38f61b2043c808 (App wallpaper "entity walking", part 2).
 *
 * Each entity self-configures WEIGHTS for its neutral stop-actions and may opt
 * IN to NEGATIVE actions (fail/sad/sick/angry). Auth = botSecret OWNERSHIP,
 * mirroring GET /api/device-vars/value (card_keyref): an entity may only set
 * ITS OWN config; a valid botSecret for entity A cannot write entity B's config.
 *
 * Persistence: entity-walk-config.js is pool-backed like
 * entity-cross-device-settings.js. The shared jest pg mock returns empty rows
 * (no state), so this suite injects a tiny in-memory pool into the module via
 * initTable() AFTER loading index.js — the same module instance the endpoints
 * use (require cache) — so weights/allowNegative genuinely persist round-trip.
 */

require('./helpers/mock-setup');
const request = require('supertest');
let app;
const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');
const put = (path) => request(app).put(path).set('Host', 'localhost');

const walkConfig = require('../../entity-walk-config');

// Minimal in-memory pool implementing only the two queries the module runs
// (SELECT config … / INSERT … ON CONFLICT DO UPDATE). Keyed by device|entity.
function makeMemoryPool() {
    const store = new Map();
    const key = (d, e) => `${d}|${e}`;
    return {
        _store: store,
        async query(sql, params) {
            const s = String(sql);
            if (s.includes('CREATE TABLE')) return { rows: [], rowCount: 0 };
            if (s.startsWith('SELECT')) {
                const [deviceId, entityId] = params;
                const row = store.get(key(deviceId, entityId));
                return row ? { rows: [{ config: row }], rowCount: 1 } : { rows: [], rowCount: 0 };
            }
            if (s.includes('INSERT INTO entity_walk_config')) {
                const [deviceId, entityId, config] = params;
                store.set(key(deviceId, entityId), typeof config === 'string' ? JSON.parse(config) : config);
                return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        },
    };
}

// Register + bind entity 0 on a fresh device; returns its creds.
async function registerAndBind(deviceId) {
    const deviceSecret = `secret-${deviceId}`;
    const regRes = await post('/api/device/register').send({ deviceId, deviceSecret, entityId: 0 });
    const bindRes = await post('/api/bind').send({ code: regRes.body.bindingCode });
    return { deviceSecret, entityId: bindRes.body.entityId, botSecret: bindRes.body.botSecret };
}

// Add a SECOND entity slot to an existing device and bind it.
async function addAndBindSecond(deviceId, deviceSecret) {
    const addRes = await post('/api/device/add-entity').send({ deviceId, deviceSecret });
    const newEid = addRes.body.entityId;
    const regRes = await post('/api/device/register').send({ deviceId, deviceSecret, entityId: newEid });
    const bindRes = await post('/api/bind').send({ code: regRes.body.bindingCode });
    return { entityId: bindRes.body.entityId, botSecret: bindRes.body.botSecret };
}

beforeAll(() => {
    app = require('../../index');
    // Inject a real (in-memory) pool so config actually persists round-trip.
    walkConfig.initTable(makeMemoryPool());
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

describe('PUT /api/entity/walk-config — validation', () => {
    it('400 when deviceId/botSecret missing', async () => {
        const res = await put('/api/entity/walk-config').send({ entityId: 0 });
        expect(res.status).toBe(400);
    });

    it('404 for an unknown device', async () => {
        const res = await put('/api/entity/walk-config').send({ deviceId: 'nope', botSecret: 'x', entityId: 0 });
        expect(res.status).toBe(404);
    });

    it('400 for a non-numeric entityId', async () => {
        const devId = `wc-badeid-${Date.now()}`;
        const { botSecret } = await registerAndBind(devId);
        const res = await put('/api/entity/walk-config').send({ deviceId: devId, botSecret, entityId: 'abc' });
        expect(res.status).toBe(400);
    });
});

describe('PUT /api/entity/walk-config — self-sovereign auth', () => {
    it('sets config with the entity OWN botSecret', async () => {
        const devId = `wc-self-${Date.now()}`;
        const { botSecret, entityId } = await registerAndBind(devId);
        const res = await put('/api/entity/walk-config').send({
            deviceId: devId, botSecret, entityId,
            weights: { idle: 3, walk: 1 }, allowNegative: true,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.entityId).toBe(entityId);
        expect(res.body.weights).toEqual({ idle: 3, walk: 1 });
        expect(res.body.allowNegative).toBe(true);
    });

    it('REJECTS a write for a DIFFERENT entity (cross-entity)', async () => {
        const devId = `wc-cross-${Date.now()}`;
        const first = await registerAndBind(devId);
        const second = await addAndBindSecond(devId, first.deviceSecret);
        // entity-1 tries to write entity-0's config using its OWN (valid) botSecret.
        const res = await put('/api/entity/walk-config').send({
            deviceId: devId, botSecret: second.botSecret, entityId: first.entityId,
            weights: { walk: 9 }, allowNegative: true,
        });
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        // And entity-0's config must be UNCHANGED (still fail-safe defaults).
        const check = await get(`/api/entity/walk-config?deviceId=${devId}&botSecret=${first.botSecret}&entityId=${first.entityId}`);
        expect(check.body.allowNegative).toBe(false);
        expect(check.body.weights).toEqual({});
    });

    it('REJECTS a wrong/garbage botSecret', async () => {
        const devId = `wc-wrongsecret-${Date.now()}`;
        const { entityId } = await registerAndBind(devId);
        const res = await put('/api/entity/walk-config').send({
            deviceId: devId, botSecret: 'totally-wrong', entityId,
            weights: {}, allowNegative: true,
        });
        expect(res.status).toBe(403);
    });
});

describe('GET /api/entity/walk-config — defaults + persistence', () => {
    it('returns fail-safe DEFAULTS (allowNegative=false, weights={}) when unset', async () => {
        const devId = `wc-defaults-${Date.now()}`;
        const { botSecret, entityId } = await registerAndBind(devId);
        const res = await get(`/api/entity/walk-config?deviceId=${devId}&botSecret=${botSecret}&entityId=${entityId}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.allowNegative).toBe(false);
        expect(res.body.weights).toEqual({});
        // Canonical negative-action list is echoed so the App/gate agree.
        expect(res.body.negativeActions).toEqual(expect.arrayContaining(['fail', 'sad', 'sick', 'angry']));
    });

    it('403 without a valid botSecret', async () => {
        const devId = `wc-get-auth-${Date.now()}`;
        await registerAndBind(devId);
        const res = await get(`/api/entity/walk-config?deviceId=${devId}&botSecret=nope&entityId=0`);
        expect(res.status).toBe(403);
    });

    it('allowNegative + weights PERSIST across PUT → GET', async () => {
        const devId = `wc-persist-${Date.now()}`;
        const { botSecret, entityId } = await registerAndBind(devId);
        await put('/api/entity/walk-config').send({
            deviceId: devId, botSecret, entityId,
            weights: { sit: 5, look: 2 }, allowNegative: true,
        });
        const res = await get(`/api/entity/walk-config?deviceId=${devId}&botSecret=${botSecret}&entityId=${entityId}`);
        expect(res.status).toBe(200);
        expect(res.body.allowNegative).toBe(true);
        expect(res.body.weights).toEqual({ sit: 5, look: 2 });
    });

    it('a later PUT with allowNegative:false turns opt-in back OFF (fail-safe)', async () => {
        const devId = `wc-toggle-${Date.now()}`;
        const { botSecret, entityId } = await registerAndBind(devId);
        await put('/api/entity/walk-config').send({ deviceId: devId, botSecret, entityId, weights: {}, allowNegative: true });
        await put('/api/entity/walk-config').send({ deviceId: devId, botSecret, entityId, weights: {}, allowNegative: false });
        const res = await get(`/api/entity/walk-config?deviceId=${devId}&botSecret=${botSecret}&entityId=${entityId}`);
        expect(res.body.allowNegative).toBe(false);
    });
});

describe('PUT /api/entity/walk-config — weight sanitization + fail-safe', () => {
    it('drops negative / non-finite weights and caps huge ones', async () => {
        const devId = `wc-sanitize-${Date.now()}`;
        const { botSecret, entityId } = await registerAndBind(devId);
        const res = await put('/api/entity/walk-config').send({
            deviceId: devId, botSecret, entityId,
            weights: { good: 2, neg: -5, nan: 'xyz', huge: 999999, zero: 0 },
            allowNegative: true,
        });
        expect(res.status).toBe(200);
        expect(res.body.weights.good).toBe(2);
        expect(res.body.weights.zero).toBe(0);
        expect(res.body.weights).not.toHaveProperty('neg');
        expect(res.body.weights).not.toHaveProperty('nan');
        expect(res.body.weights.huge).toBe(walkConfig.MAX_WEIGHT);
    });

    it('non-object weights → {} (equal-weight fail-safe), allowNegative missing → false', async () => {
        const devId = `wc-noweights-${Date.now()}`;
        const { botSecret, entityId } = await registerAndBind(devId);
        const res = await put('/api/entity/walk-config').send({
            deviceId: devId, botSecret, entityId, weights: 'not-an-object',
        });
        expect(res.status).toBe(200);
        expect(res.body.weights).toEqual({});
        expect(res.body.allowNegative).toBe(false);
    });

    it('allowNegative coerces truthy-but-not-true (e.g. "yes") to false (fail-safe)', async () => {
        const devId = `wc-coerce-${Date.now()}`;
        const { botSecret, entityId } = await registerAndBind(devId);
        const res = await put('/api/entity/walk-config').send({
            deviceId: devId, botSecret, entityId, weights: {}, allowNegative: 'yes',
        });
        expect(res.status).toBe(200);
        expect(res.body.allowNegative).toBe(false);
    });
});
