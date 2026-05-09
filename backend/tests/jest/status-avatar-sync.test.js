/**
 * Regression test: GET /api/status must include the `avatar` field.
 *
 * Polling clients (Android live wallpaper, widget, iOS native screens) hit
 * /api/status to refresh entity state. If the response omits `avatar`, those
 * surfaces never see avatar updates made on the dashboard, even though the
 * value is correctly persisted to PostgreSQL via PUT/POST entity/avatar.
 *
 * Sister endpoint /api/entities already returns `avatar` (index.js:5990).
 * /api/status was missing it; this test locks the parity.
 *
 * Spec source of truth: backend/openapi.yaml `/api/status` → Entity schema.
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const put = (path) => request(app).put(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');

async function registerDevice(deviceId) {
    const deviceSecret = `secret-${deviceId}`;
    await post('/api/device/register')
        .send({ deviceId, deviceSecret, entityId: 0 });
    return deviceSecret;
}

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise((resolve) => httpServer.close(resolve));
    jest.resetModules();
});

describe('GET /api/status — avatar sync regression', () => {
    it('returns the avatar field (null) for a freshly registered entity', async () => {
        const deviceId = 'status-avatar-test-fresh';
        const deviceSecret = await registerDevice(deviceId);

        const res = await get(
            `/api/status?deviceId=${deviceId}&deviceSecret=${deviceSecret}&entityId=0`
        );

        expect(res.status).toBe(200);
        // Regression lock: `avatar` MUST be in the response payload, even if null.
        expect(res.body).toHaveProperty('avatar');
        expect(res.body.avatar).toBeNull();
    });

    it('reflects an emoji avatar set via PUT /api/device/entity/avatar', async () => {
        const deviceId = 'status-avatar-test-emoji';
        const deviceSecret = await registerDevice(deviceId);

        const putRes = await put('/api/device/entity/avatar').send({
            deviceId,
            deviceSecret,
            entityId: 0,
            avatar: '🦞',
        });
        expect(putRes.status).toBe(200);

        const res = await get(
            `/api/status?deviceId=${deviceId}&deviceSecret=${deviceSecret}&entityId=0`
        );

        expect(res.status).toBe(200);
        expect(res.body.avatar).toBe('🦞');
    });

    it('reflects a Flickr-URL avatar set via PUT /api/device/entity/avatar', async () => {
        const deviceId = 'status-avatar-test-url';
        const deviceSecret = await registerDevice(deviceId);

        const flickrUrl = 'https://live.staticflickr.com/65535/00000000000_xxxxx_z.jpg';
        const putRes = await put('/api/device/entity/avatar').send({
            deviceId,
            deviceSecret,
            entityId: 0,
            avatar: flickrUrl,
        });
        expect(putRes.status).toBe(200);

        const res = await get(
            `/api/status?deviceId=${deviceId}&deviceSecret=${deviceSecret}&entityId=0`
        );

        expect(res.status).toBe(200);
        expect(res.body.avatar).toBe(flickrUrl);
    });

    it('keeps avatar in the response shape across the existing field set', async () => {
        // Schema-style assertion: any client (Android wallpaper / iOS / widget)
        // that destructures `avatar` from /api/status must keep working.
        const deviceId = 'status-avatar-test-shape';
        const deviceSecret = await registerDevice(deviceId);

        const res = await get(
            `/api/status?deviceId=${deviceId}&deviceSecret=${deviceSecret}&entityId=0`
        );

        expect(res.status).toBe(200);
        // Pre-existing fields stay in place
        expect(res.body).toHaveProperty('deviceId');
        expect(res.body).toHaveProperty('entityId');
        expect(res.body).toHaveProperty('state');
        expect(res.body).toHaveProperty('isBound');
        // New required field
        expect(res.body).toHaveProperty('avatar');
    });
});
