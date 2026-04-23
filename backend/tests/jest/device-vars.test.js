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

describe('POST /api/device-vars — legacy empty-wipe guard', () => {
    // 2026-04-23 incident: legacy mode {vars:{}} with no `source` wiped 17
    // live keys. Guard refuses empty legacy replacement against a non-empty
    // vault unless caller passes confirm:"REPLACE_ALL_EMPTY".
    const db = require('../../db');

    afterEach(() => {
        db.getDeviceVars.mockResolvedValue(null);
    });

    it('refuses legacy {vars:{}} when vault has existing keys (no confirm, no source)', async () => {
        const devId = `vars-post-wipeguard-${Date.now()}`;
        const secret = await registerDevice(devId);
        db.getDeviceVars.mockResolvedValueOnce({
            vars: { EXISTING: 'value' },
            var_keys: ['EXISTING'],
        });
        const res = await post('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
            vars: {},
        });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('refuse_empty_legacy_wipe');
        expect(res.body.message).toMatch(/Refusing to replace 1 existing keys/);
    });

    it('allows legacy {vars:{}} on an empty vault (nothing to lose)', async () => {
        const devId = `vars-post-emptyvault-${Date.now()}`;
        const secret = await registerDevice(devId);
        // Default mock returns null (no row) → no existing keys
        const res = await post('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
            vars: {},
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('allows legacy {vars:{}} with confirm:"REPLACE_ALL_EMPTY" (explicit intent)', async () => {
        const devId = `vars-post-confirm-${Date.now()}`;
        const secret = await registerDevice(devId);
        db.getDeviceVars.mockResolvedValueOnce({
            vars: { EXISTING: 'value' },
            var_keys: ['EXISTING'],
        });
        const res = await post('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
            vars: {},
            confirm: 'REPLACE_ALL_EMPTY',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('does NOT guard merge-mode source:"web" with empty vars (merge is safe)', async () => {
        const devId = `vars-post-mergeempty-${Date.now()}`;
        const secret = await registerDevice(devId);
        db.getDeviceVars.mockResolvedValueOnce({
            vars: { EXISTING: 'value' },
            var_keys: ['EXISTING'],
        });
        const res = await post('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
            vars: {},
            source: 'web',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
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

describe('DELETE /api/device-vars — confirm-guard for non-empty vault', () => {
    // 2026-04-23 follow-up to legacy-wipe incident: DELETE endpoint is the
    // other vector that can wipe the vault in one call. Refuse unless caller
    // passes confirm:"YES_DELETE_ALL_VAULT" when existing keys are present.
    const db = require('../../db');

    afterEach(() => {
        db.getDeviceVars.mockResolvedValue(null);
    });

    it('refuses DELETE when vault has keys and no confirm is passed', async () => {
        const devId = `vars-del-guard-${Date.now()}`;
        const secret = await registerDevice(devId);
        db.getDeviceVars.mockResolvedValueOnce({
            vars: { EXISTING: 'value' },
            var_keys: ['EXISTING'],
        });
        const res = await del('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
        });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('refuse_delete_without_confirm');
        expect(res.body.message).toMatch(/Refusing to delete 1 existing keys/);
    });

    it('allows DELETE on non-empty vault with confirm:"YES_DELETE_ALL_VAULT"', async () => {
        const devId = `vars-del-confirm-${Date.now()}`;
        const secret = await registerDevice(devId);
        db.getDeviceVars.mockResolvedValueOnce({
            vars: { A: '1', B: '2', C: '3' },
            var_keys: ['A', 'B', 'C'],
        });
        const res = await del('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
            confirm: 'YES_DELETE_ALL_VAULT',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.deletedKeyCount).toBe(3);
    });

    it('allows DELETE on empty vault without confirm (nothing to lose)', async () => {
        const devId = `vars-del-emptyvault-${Date.now()}`;
        const secret = await registerDevice(devId);
        // Default mock returns null → existingKeyCount = 0 → bypass guard
        const res = await del('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.deletedKeyCount).toBe(0);
    });

    it('rejects an incorrect confirm string', async () => {
        const devId = `vars-del-wrongconfirm-${Date.now()}`;
        const secret = await registerDevice(devId);
        db.getDeviceVars.mockResolvedValueOnce({
            vars: { EXISTING: 'value' },
            var_keys: ['EXISTING'],
        });
        const res = await del('/api/device-vars').send({
            deviceId: devId,
            deviceSecret: secret,
            confirm: 'yes_delete_all_vault', // wrong case
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('refuse_delete_without_confirm');
    });
});

describe('DELETE /api/device-vars/:key', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await del('/api/device-vars/MY_KEY').send({ deviceSecret: 'x' });
        expect(res.status).toBe(400);
    });

    it('returns 403 with invalid deviceSecret', async () => {
        const devId = `vars-delkey-auth-${Date.now()}`;
        await registerDevice(devId);
        const res = await del('/api/device-vars/MY_KEY').send({
            deviceId: devId,
            deviceSecret: 'wrong-secret',
        });
        expect(res.status).toBe(403);
    });

    it('returns 404 when no vars stored', async () => {
        const devId = `vars-delkey-novars-${Date.now()}`;
        const secret = await registerDevice(devId);
        const res = await del('/api/device-vars/MY_KEY').send({
            deviceId: devId,
            deviceSecret: secret,
        });
        expect(res.status).toBe(404);
    });

    it('returns 404 when key does not exist in stored vars', async () => {
        const devId = `vars-delkey-nokey-${Date.now()}`;
        const secret = await registerDevice(devId);
        // Mock DB returns null (no vars stored), so should get 404
        const res = await del('/api/device-vars/NONEXISTENT').send({
            deviceId: devId,
            deviceSecret: secret,
        });
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });
});
