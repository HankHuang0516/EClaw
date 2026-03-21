/**
 * Device Telemetry endpoint tests (Jest + Supertest)
 *
 * Tests: POST /api/device-telemetry, GET /api/device-telemetry,
 *        GET /api/device-telemetry/summary, DELETE /api/device-telemetry
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');
const del = (path) => request(app).delete(path).set('Host', 'localhost');

/** Register a device via the register endpoint */
async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register')
        .send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

beforeAll(() => {
    app = require('../../index');

    // Override appendEntries mock to return the shape the POST endpoint expects
    const telemetry = require('../../device-telemetry');
    telemetry.appendEntries.mockResolvedValue({ accepted: 5, dropped: 0, bufferUsed: 500 });
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

const DEVICE_ID = 'telemetry-test-device';
let deviceSecret;

beforeAll(async () => {
    deviceSecret = await registerDevice(DEVICE_ID);
});

// ════════════════════════════════════════════════════════════════
// POST /api/device-telemetry
// ════════════════════════════════════════════════════════════════
describe('POST /api/device-telemetry', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/device-telemetry')
            .send({ deviceSecret: 'x', entries: [{ type: 'page_view' }] });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await post('/api/device-telemetry')
            .send({ deviceId: DEVICE_ID, entries: [{ type: 'page_view' }] });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 401 for wrong deviceSecret', async () => {
        const res = await post('/api/device-telemetry')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'wrong', entries: [{ type: 'page_view' }] });
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when entries is missing', async () => {
        const res = await post('/api/device-telemetry')
            .send({ deviceId: DEVICE_ID, deviceSecret });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when entries is an empty array', async () => {
        const res = await post('/api/device-telemetry')
            .send({ deviceId: DEVICE_ID, deviceSecret, entries: [] });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when entries is not an array', async () => {
        const res = await post('/api/device-telemetry')
            .send({ deviceId: DEVICE_ID, deviceSecret, entries: 'not-array' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 200 with accepted/dropped/bufferUsed for valid request', async () => {
        const entries = [
            { type: 'page_view', page: 'dashboard', ts: Date.now() },
            { type: 'action', action: 'click_btn', ts: Date.now() },
        ];
        const res = await post('/api/device-telemetry')
            .send({ deviceId: DEVICE_ID, deviceSecret, entries });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.accepted).toBe(5);
        expect(res.body.dropped).toBe(0);
        expect(res.body.bufferUsed).toBe(500);
        expect(typeof res.body.maxBuffer).toBe('number');
    });

    it('accepts optional appVersion and platform fields', async () => {
        const res = await post('/api/device-telemetry')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret,
                entries: [{ type: 'page_view', page: 'settings' }],
                appVersion: '1.0.50',
                appVersionCode: 50,
                platform: 'android',
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/device-telemetry
// ════════════════════════════════════════════════════════════════
describe('GET /api/device-telemetry', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await get('/api/device-telemetry?deviceSecret=x');
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await get(`/api/device-telemetry?deviceId=${DEVICE_ID}`);
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 401 for wrong deviceSecret', async () => {
        const res = await get(`/api/device-telemetry?deviceId=${DEVICE_ID}&deviceSecret=wrong`);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('returns 200 with entries array for valid request', async () => {
        const res = await get(`/api/device-telemetry?deviceId=${DEVICE_ID}&deviceSecret=${deviceSecret}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.entries)).toBe(true);
        expect(typeof res.body.count).toBe('number');
    });

    it('passes filter query params through', async () => {
        const telemetry = require('../../device-telemetry');
        telemetry.getEntries.mockClear();

        await get(`/api/device-telemetry?deviceId=${DEVICE_ID}&deviceSecret=${deviceSecret}&type=page_view&limit=10`);

        expect(telemetry.getEntries).toHaveBeenCalledWith(
            expect.anything(),
            DEVICE_ID,
            expect.objectContaining({ type: 'page_view', limit: '10' })
        );
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/device-telemetry/summary
// ════════════════════════════════════════════════════════════════
describe('GET /api/device-telemetry/summary', () => {
    it('returns 400 when credentials are missing', async () => {
        const res = await get('/api/device-telemetry/summary');
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await get(`/api/device-telemetry/summary?deviceId=${DEVICE_ID}`);
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 401 for invalid credentials', async () => {
        const res = await get(`/api/device-telemetry/summary?deviceId=${DEVICE_ID}&deviceSecret=bad`);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('returns 200 with summary for valid request', async () => {
        const res = await get(`/api/device-telemetry/summary?deviceId=${DEVICE_ID}&deviceSecret=${deviceSecret}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/device-telemetry
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/device-telemetry', () => {
    it('returns 400 when credentials are missing', async () => {
        const res = await del('/api/device-telemetry').send({});
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await del('/api/device-telemetry').send({ deviceId: DEVICE_ID });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 401 for invalid credentials', async () => {
        const res = await del('/api/device-telemetry')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'wrong' });
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('returns 200 and clears buffer for valid request', async () => {
        const res = await del('/api/device-telemetry')
            .send({ deviceId: DEVICE_ID, deviceSecret });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toMatch(/cleared/i);
    });

    it('calls clearEntries with correct arguments', async () => {
        const telemetry = require('../../device-telemetry');
        telemetry.clearEntries.mockClear();

        await del('/api/device-telemetry')
            .send({ deviceId: DEVICE_ID, deviceSecret });

        expect(telemetry.clearEntries).toHaveBeenCalledWith(
            expect.anything(),
            DEVICE_ID
        );
    });
});
