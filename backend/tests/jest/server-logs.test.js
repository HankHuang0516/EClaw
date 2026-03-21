/**
 * Server logs and audit logs endpoint tests (Jest + Supertest)
 *
 * GET /api/logs — Device-authenticated server log query
 * GET /api/audit-logs — Admin-only audit log query (Issue #177)
 *
 * Both endpoints use chatPool.query() which resolves to { rows: [], rowCount: 0 }
 * via the mocked pg module.
 */

require('./helpers/mock-setup');
const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register').send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

beforeAll(() => { app = require('../../index'); });
afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

// ════════════════════════════════════════════════════════════════
// GET /api/logs — server log query (device auth)
// ════════════════════════════════════════════════════════════════
describe('GET /api/logs', () => {

    describe('validation — missing parameters', () => {
        it('400 when deviceId is missing', async () => {
            const res = await get('/api/logs')
                .query({ deviceSecret: 'some-secret' });
            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toMatch(/deviceId/i);
        });

        it('400 when deviceSecret is missing', async () => {
            const res = await get('/api/logs')
                .query({ deviceId: 'some-device' });
            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toMatch(/deviceSecret/i);
        });

        it('400 when both deviceId and deviceSecret are missing', async () => {
            const res = await get('/api/logs');
            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        });
    });

    describe('authentication — invalid credentials', () => {
        it('401 for unregistered device', async () => {
            const res = await get('/api/logs')
                .query({ deviceId: 'nonexistent-device', deviceSecret: 'wrong-secret' });
            expect(res.status).toBe(401);
            expect(res.body.success).toBe(false);
            expect(res.body.error).toMatch(/invalid credentials/i);
        });

        it('401 when deviceSecret does not match', async () => {
            const deviceId = 'logs-auth-test';
            await registerDevice(deviceId);
            const res = await get('/api/logs')
                .query({ deviceId, deviceSecret: 'wrong-secret' });
            expect(res.status).toBe(401);
            expect(res.body.success).toBe(false);
        });
    });

    describe('success — valid request', () => {
        const deviceId = 'logs-success-test';
        let deviceSecret;

        beforeAll(async () => {
            deviceSecret = await registerDevice(deviceId);
        });

        it('200 with empty logs array for valid credentials', async () => {
            const res = await get('/api/logs')
                .query({ deviceId, deviceSecret });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.count).toBe(0);
            expect(Array.isArray(res.body.logs)).toBe(true);
        });

        it('200 with category filter', async () => {
            const res = await get('/api/logs')
                .query({ deviceId, deviceSecret, category: 'broadcast' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.logs)).toBe(true);
        });

        it('200 with level filter', async () => {
            const res = await get('/api/logs')
                .query({ deviceId, deviceSecret, level: 'error' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('200 with since filter', async () => {
            const since = Date.now() - 3600000; // 1 hour ago
            const res = await get('/api/logs')
                .query({ deviceId, deviceSecret, since: String(since) });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('200 with filterDevice parameter', async () => {
            const res = await get('/api/logs')
                .query({ deviceId, deviceSecret, filterDevice: 'other-device' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('200 with custom limit', async () => {
            const res = await get('/api/logs')
                .query({ deviceId, deviceSecret, limit: '50' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('limit is capped at 500', async () => {
            const res = await get('/api/logs')
                .query({ deviceId, deviceSecret, limit: '9999' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            // The endpoint should clamp to 500 — no way to verify directly
            // from response (mock returns []), but we confirm it does not error
        });

        it('200 with all filters combined', async () => {
            const res = await get('/api/logs')
                .query({
                    deviceId,
                    deviceSecret,
                    category: 'bind',
                    level: 'info',
                    since: String(Date.now() - 86400000),
                    filterDevice: deviceId,
                    limit: '25',
                });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.count).toBe(0);
            expect(Array.isArray(res.body.logs)).toBe(true);
        });
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/audit-logs — admin-only audit log query
// ════════════════════════════════════════════════════════════════
describe('GET /api/audit-logs', () => {

    // In mock-setup, adminAuth (authMiddleware) and adminCheck (adminMiddleware)
    // are both noops, so the endpoint is accessible without auth.

    describe('success — returns logs', () => {
        it('200 with empty logs array (no filters)', async () => {
            const res = await get('/api/audit-logs');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.count).toBe(0);
            expect(Array.isArray(res.body.logs)).toBe(true);
        });

        it('200 with userId filter', async () => {
            const res = await get('/api/audit-logs')
                .query({ userId: '42' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('200 with action filter', async () => {
            const res = await get('/api/audit-logs')
                .query({ action: 'login' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('200 with category filter', async () => {
            const res = await get('/api/audit-logs')
                .query({ category: 'auth' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('200 with since filter', async () => {
            const res = await get('/api/audit-logs')
                .query({ since: String(Date.now() - 3600000) });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('200 with until filter', async () => {
            const res = await get('/api/audit-logs')
                .query({ until: String(Date.now()) });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('200 with custom limit', async () => {
            const res = await get('/api/audit-logs')
                .query({ limit: '50' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('limit is capped at 500', async () => {
            const res = await get('/api/audit-logs')
                .query({ limit: '9999' });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('200 with all filters combined', async () => {
            const res = await get('/api/audit-logs')
                .query({
                    userId: '1',
                    action: 'register',
                    category: 'auth',
                    since: String(Date.now() - 86400000),
                    until: String(Date.now()),
                    limit: '25',
                });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.count).toBe(0);
            expect(Array.isArray(res.body.logs)).toBe(true);
        });
    });
});
