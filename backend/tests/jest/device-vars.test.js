/**
 * Device Variables API tests (Jest + Supertest)
 *
 * Validates POST/GET/DELETE /api/device-vars endpoints:
 * - POST: deviceSecret auth, stores encrypted vars
 * - GET: botSecret auth, returns decrypted vars
 * - DELETE: deviceSecret auth, clears all vars
 */

require('./helpers/mock-setup');
const request = require('supertest');
let app;
const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');
const del = (path) => request(app).delete(path).set('Host', 'localhost');

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register').send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

beforeAll(() => {
    process.env.SEAL_KEY = '0'.repeat(64);
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

// ── Tests ──

describe('POST /api/device-vars', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/device-vars').send({ deviceSecret: 'x', vars: {} });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/deviceId/i);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await post('/api/device-vars').send({ deviceId: 'dev1', vars: {} });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/deviceSecret/i);
    });

    it('returns 403 with wrong deviceSecret', async () => {
        const devId = `vars-post-auth-${Date.now()}`;
        await registerDevice(devId);
        const res = await post('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: 'wrong-secret',
            vars: { KEY: 'val' },
        });
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when vars is not an object', async () => {
        const devId = `vars-post-type-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await post('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
            vars: 'not-an-object',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/vars must be an object/i);
    });

    it('returns 200 and stores variables with valid request', async () => {
        const devId = `vars-post-ok-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await post('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
            vars: { API_URL: 'https://example.com', TOKEN: 'abc123' },
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.count).toBe(2);
    });

    it('returns 200 with empty vars object (stores zero variables)', async () => {
        const devId = `vars-post-empty-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await post('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
            vars: {},
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.count).toBe(0);
    });

    it('returns 200 with source field and includes mergedVars in response', async () => {
        const devId = `vars-post-src-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await post('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
            vars: { MY_VAR: 'hello' },
            source: 'web',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.mergedVars).toBeDefined();
        expect(res.body.sources).toBeDefined();
    });

    it('filters out non-string values from vars', async () => {
        const devId = `vars-post-filter-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await post('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
            vars: { GOOD: 'value', BAD_NUM: 123, BAD_BOOL: true },
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        // Only string values are kept
        expect(res.body.count).toBe(1);
    });
});

describe('GET /api/device-vars', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await get('/api/device-vars?botSecret=abc');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/deviceId/i);
    });

    it('returns 400 when botSecret is missing', async () => {
        const res = await get('/api/device-vars?deviceId=dev1');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/botSecret/i);
    });

    it('returns 404 for non-existent device', async () => {
        const res = await get('/api/device-vars?deviceId=nonexistent&botSecret=abc');
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });

    it('returns 403 with invalid botSecret (no bound entity)', async () => {
        const devId = `vars-get-auth-${Date.now()}`;
        await registerDevice(devId);
        const res = await get(`/api/device-vars?deviceId=${devId}&botSecret=wrong-secret`);
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/botSecret/i);
    });

    it('returns 200 with empty vars when entity is bound but no vars saved', async () => {
        const devId = `vars-get-ok-${Date.now()}`;
        const secret = await registerDevice(devId);

        // Register returns a binding code; use it to bind the entity
        const regRes = await post('/api/device/register').send({
            deviceId: devId, deviceSecret: secret, entityId: 0,
        });
        const bindingCode = regRes.body.bindingCode;

        const bindRes = await post('/api/bind').send({ code: bindingCode });
        expect(bindRes.status).toBe(200);
        const botSecret = bindRes.body.botSecret;
        expect(botSecret).toBeTruthy();

        // DB mock returns null for getDeviceVars → empty vars
        const res = await get(`/api/device-vars?deviceId=${devId}&botSecret=${botSecret}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.vars).toEqual({});
    });
});

describe('DELETE /api/device-vars', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await del('/api/device-vars').send({ deviceSecret: 'x' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/deviceId/i);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await del('/api/device-vars').send({ deviceId: 'dev1' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/deviceSecret/i);
    });

    it('returns 403 with wrong deviceSecret', async () => {
        const devId = `vars-del-auth-${Date.now()}`;
        await registerDevice(devId);
        const res = await del('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: 'wrong-secret',
        });
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
    });

    it('returns 200 when clearing vars with valid credentials', async () => {
        const devId = `vars-del-ok-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await del('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});
