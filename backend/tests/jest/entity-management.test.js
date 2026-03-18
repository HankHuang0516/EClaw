/**
 * Entity Management endpoint tests (Jest + Supertest)
 *
 * Tests: POST /api/device/add-entity, DELETE /api/device/entity/:id/permanent,
 *        POST /api/device/reorder-entities, PUT /api/device/entity/name,
 *        POST /api/entity/refresh, POST /api/bind
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');
const put = (path) => request(app).put(path).set('Host', 'localhost');
const del = (path) => request(app).delete(path).set('Host', 'localhost');

/** Register a device with getOrCreateDevice */
async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register')
        .send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// POST /api/device/add-entity
// ════════════════════════════════════════════════════════════════
describe('POST /api/device/add-entity', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/device/add-entity')
            .send({ deviceSecret: 'sec' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await post('/api/device/add-entity')
            .send({ deviceId: 'dev-1' });
        expect(res.status).toBe(400);
    });

    it('returns 403 for invalid credentials', async () => {
        await registerDevice('ent-add-dev');
        const res = await post('/api/device/add-entity')
            .send({ deviceId: 'ent-add-dev', deviceSecret: 'wrong-secret' });
        expect(res.status).toBe(403);
    });

    it('adds entity to a registered device', async () => {
        const secret = await registerDevice('ent-add-ok');
        const res = await post('/api/device/add-entity')
            .send({ deviceId: 'ent-add-ok', deviceSecret: secret });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body).toHaveProperty('entityId');
        expect(res.body).toHaveProperty('totalEntities');
    });
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/device/entity/:entityId/permanent
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/device/entity/:entityId/permanent', () => {
    it('returns 400 when credentials missing', async () => {
        const res = await del('/api/device/entity/0/permanent').send({});
        expect(res.status).toBe(400);
    });

    it('returns 400 for invalid entityId (NaN)', async () => {
        const res = await del('/api/device/entity/abc/permanent')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec' });
        expect(res.status).toBe(400);
    });

    it('returns 400 for negative entityId', async () => {
        const res = await del('/api/device/entity/-1/permanent')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec' });
        expect(res.status).toBe(400);
    });

    it('returns 403 for invalid device credentials', async () => {
        await registerDevice('ent-del-auth');
        const res = await del('/api/device/entity/0/permanent')
            .send({ deviceId: 'ent-del-auth', deviceSecret: 'wrong' });
        expect(res.status).toBe(403);
    });

    it('returns 400 when trying to delete the last entity', async () => {
        const secret = await registerDevice('ent-del-last');
        const res = await del('/api/device/entity/0/permanent')
            .send({ deviceId: 'ent-del-last', deviceSecret: secret });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/last entity/i);
    });

    it('deletes an entity when multiple exist', async () => {
        const secret = await registerDevice('ent-del-multi');
        await post('/api/device/add-entity')
            .send({ deviceId: 'ent-del-multi', deviceSecret: secret });

        const res = await del('/api/device/entity/1/permanent')
            .send({ deviceId: 'ent-del-multi', deviceSecret: secret });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/device/reorder-entities
// ════════════════════════════════════════════════════════════════
describe('POST /api/device/reorder-entities', () => {
    it('returns 400 when credentials missing', async () => {
        const res = await post('/api/device/reorder-entities').send({ order: [0, 1] });
        expect(res.status).toBe(400);
    });

    it('returns 403 for invalid credentials', async () => {
        await registerDevice('ent-reorder-auth');
        const res = await post('/api/device/reorder-entities')
            .send({ deviceId: 'ent-reorder-auth', deviceSecret: 'wrong', order: [0] });
        expect(res.status).toBe(403);
    });

    it('returns 400 when order is not an array', async () => {
        const secret = await registerDevice('ent-reorder-arr');
        const res = await post('/api/device/reorder-entities')
            .send({ deviceId: 'ent-reorder-arr', deviceSecret: secret, order: 'bad' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when order has wrong length', async () => {
        const secret = await registerDevice('ent-reorder-len');
        const res = await post('/api/device/reorder-entities')
            .send({ deviceId: 'ent-reorder-len', deviceSecret: secret, order: [0, 1, 2] });
        expect(res.status).toBe(400);
    });

    it('returns 400 when order is not a valid permutation', async () => {
        const secret = await registerDevice('ent-reorder-perm');
        await post('/api/device/add-entity')
            .send({ deviceId: 'ent-reorder-perm', deviceSecret: secret });

        const res = await post('/api/device/reorder-entities')
            .send({ deviceId: 'ent-reorder-perm', deviceSecret: secret, order: [0, 5] });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/permutation/i);
    });

    it('accepts valid reorder', async () => {
        const secret = await registerDevice('ent-reorder-ok');
        await post('/api/device/add-entity')
            .send({ deviceId: 'ent-reorder-ok', deviceSecret: secret });

        const res = await post('/api/device/reorder-entities')
            .send({ deviceId: 'ent-reorder-ok', deviceSecret: secret, order: [1, 0] });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// PUT /api/device/entity/name
// ════════════════════════════════════════════════════════════════
describe('PUT /api/device/entity/name', () => {
    it('returns 400 when credentials missing', async () => {
        const res = await put('/api/device/entity/name')
            .send({ entityId: 0, name: 'test' });
        expect(res.status).toBe(400);
    });

    it('returns 400 for invalid entityId', async () => {
        const secret = await registerDevice('ent-rename-eid');
        const res = await put('/api/device/entity/name')
            .send({ deviceId: 'ent-rename-eid', deviceSecret: secret, entityId: 'abc', name: 'x' });
        expect(res.status).toBe(400);
    });

    it('returns 400 when name exceeds 20 characters', async () => {
        const secret = await registerDevice('ent-rename-long');
        const res = await put('/api/device/entity/name')
            .send({ deviceId: 'ent-rename-long', deviceSecret: secret, entityId: 0, name: 'a'.repeat(21) });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/20 characters/i);
    });

    it('returns 400 when entity is not bound', async () => {
        const secret = await registerDevice('ent-rename-unbound');
        const res = await put('/api/device/entity/name')
            .send({ deviceId: 'ent-rename-unbound', deviceSecret: secret, entityId: 0, name: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/not bound/i);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/entity/refresh
// ════════════════════════════════════════════════════════════════
describe('POST /api/entity/refresh', () => {
    it('returns 400 when credentials missing', async () => {
        const res = await post('/api/entity/refresh').send({ entityId: 0 });
        expect(res.status).toBe(400);
    });

    it('returns 400 for invalid entityId', async () => {
        const res = await post('/api/entity/refresh')
            .send({ deviceId: 'dev-1', deviceSecret: 'sec', entityId: 'abc' });
        expect(res.status).toBe(400);
    });

    it('returns 403 for invalid device credentials', async () => {
        await registerDevice('ent-refresh-auth');
        const res = await post('/api/entity/refresh')
            .send({ deviceId: 'ent-refresh-auth', deviceSecret: 'wrong', entityId: 0 });
        expect(res.status).toBe(403);
    });

    it('returns 400 when entity is not bound', async () => {
        const secret = await registerDevice('ent-refresh-unbound');
        const res = await post('/api/entity/refresh')
            .send({ deviceId: 'ent-refresh-unbound', deviceSecret: secret, entityId: 0 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/not bound/i);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/bind
// ════════════════════════════════════════════════════════════════
describe('POST /api/bind', () => {
    it('returns 400 when code is missing', async () => {
        const res = await post('/api/bind').send({});
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/code/i);
    });

    it('returns 400 when code is invalid or expired', async () => {
        const res = await post('/api/bind').send({ code: 'invalid-code' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/invalid|expired/i);
    });

    it('returns 400 when name exceeds 20 characters', async () => {
        const res = await post('/api/bind')
            .send({ code: 'some-code', name: 'a'.repeat(21) });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/20 characters/i);
    });
});
