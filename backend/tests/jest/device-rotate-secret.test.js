/**
 * Tests for POST /api/device/rotate-secret.
 *
 * Covered:
 *   - 400 when fields missing
 *   - 401 when deviceSecret doesn't match
 *   - 200 + fresh UUID when old secret matches
 *   - Old secret invalid on the NEXT call (device.status returns 403)
 *   - Accepts x-device-secret header as alternative to body field
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await request(app)
        .post('/api/device/register')
        .set('Host', 'localhost')
        .send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

describe('POST /api/device/rotate-secret', () => {
    it('400 when deviceId missing', async () => {
        const res = await request(app)
            .post('/api/device/rotate-secret')
            .set('Host', 'localhost')
            .send({ deviceSecret: 'x' });
        expect(res.status).toBe(400);
    });

    it('400 when deviceSecret missing', async () => {
        const res = await request(app)
            .post('/api/device/rotate-secret')
            .set('Host', 'localhost')
            .send({ deviceId: 'dev-a' });
        expect(res.status).toBe(400);
    });

    it('401 when device does not exist', async () => {
        const res = await request(app)
            .post('/api/device/rotate-secret')
            .set('Host', 'localhost')
            .send({ deviceId: 'ghost-device', deviceSecret: 'whatever' });
        expect(res.status).toBe(401);
    });

    it('401 when deviceSecret is wrong', async () => {
        const secret = await registerDevice('rotate-wrong');
        const res = await request(app)
            .post('/api/device/rotate-secret')
            .set('Host', 'localhost')
            .send({ deviceId: 'rotate-wrong', deviceSecret: secret + '-tampered' });
        expect(res.status).toBe(401);
    });

    it('200 returns a fresh UUID and invalidates the old secret', async () => {
        const oldSecret = await registerDevice('rotate-happy');

        const rotateRes = await request(app)
            .post('/api/device/rotate-secret')
            .set('Host', 'localhost')
            .send({ deviceId: 'rotate-happy', deviceSecret: oldSecret });
        expect(rotateRes.status).toBe(200);
        expect(rotateRes.body.success).toBe(true);
        expect(rotateRes.body.deviceId).toBe('rotate-happy');
        expect(rotateRes.body.newDeviceSecret).toMatch(/^[0-9a-f-]{36}$/i);
        expect(rotateRes.body.newDeviceSecret).not.toBe(oldSecret);
        expect(typeof rotateRes.body.rotatedAt).toBe('string');

        // Old secret must now fail against a device-auth endpoint.
        const statusOld = await request(app)
            .post('/api/device/status')
            .set('Host', 'localhost')
            .send({ deviceId: 'rotate-happy', deviceSecret: oldSecret, entityId: 0 });
        expect(statusOld.status).toBe(403);

        // New secret works.
        const statusNew = await request(app)
            .post('/api/device/status')
            .set('Host', 'localhost')
            .send({ deviceId: 'rotate-happy', deviceSecret: rotateRes.body.newDeviceSecret, entityId: 0 });
        expect(statusNew.status).toBe(200);
    });

    it('accepts x-device-secret header as alternative to body field', async () => {
        const oldSecret = await registerDevice('rotate-header');
        const res = await request(app)
            .post('/api/device/rotate-secret')
            .set('Host', 'localhost')
            .set('x-device-secret', oldSecret)
            .send({ deviceId: 'rotate-header' });
        expect(res.status).toBe(200);
        expect(res.body.newDeviceSecret).not.toBe(oldSecret);
    });

    it('rotating twice returns two different secrets and old one stays invalid', async () => {
        const s0 = await registerDevice('rotate-twice');

        const r1 = await request(app)
            .post('/api/device/rotate-secret')
            .set('Host', 'localhost')
            .send({ deviceId: 'rotate-twice', deviceSecret: s0 });
        expect(r1.status).toBe(200);
        const s1 = r1.body.newDeviceSecret;

        const r2 = await request(app)
            .post('/api/device/rotate-secret')
            .set('Host', 'localhost')
            .send({ deviceId: 'rotate-twice', deviceSecret: s1 });
        expect(r2.status).toBe(200);
        const s2 = r2.body.newDeviceSecret;

        expect(s0).not.toBe(s1);
        expect(s1).not.toBe(s2);

        // s0 and s1 must both fail; only s2 works.
        for (const bad of [s0, s1]) {
            const r = await request(app)
                .post('/api/device/rotate-secret')
                .set('Host', 'localhost')
                .send({ deviceId: 'rotate-twice', deviceSecret: bad });
            expect(r.status).toBe(401);
        }
    });
});
