/**
 * Screen Control endpoint validation tests (Jest + Supertest)
 *
 * Tests input validation and auth for remote screen control endpoints:
 * - POST /api/device/screen-capture
 * - POST /api/device/screen-result
 * - POST /api/device/control
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

/** Register a device via the register endpoint */
async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register')
        .send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

beforeAll(() => {
    app = require('../../index');

    // Override device-preferences mock to enable remote control by default
    const devicePrefs = require('../../device-preferences');
    devicePrefs.getPrefs = jest.fn().mockResolvedValue({ remote_control_enabled: true });
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// ════════════════════════════════════════════════════════════════
// POST /api/device/screen-capture
// ════════════════════════════════════════════════════════════════
describe('POST /api/device/screen-capture', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/device/screen-capture')
            .send({ deviceSecret: 'some-secret' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when both botSecret and deviceSecret are missing', async () => {
        const res = await post('/api/device/screen-capture')
            .send({ deviceId: 'sc-dev-1' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/botSecret.*deviceSecret|required/i);
    });

    it('returns 404 for unknown device', async () => {
        const res = await post('/api/device/screen-capture')
            .send({ deviceId: 'nonexistent-sc', deviceSecret: 'sec' });
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });

    it('returns 403 for wrong deviceSecret', async () => {
        const deviceId = 'sc-auth-dev-1';
        await registerDevice(deviceId);

        const res = await post('/api/device/screen-capture')
            .send({ deviceId, deviceSecret: 'wrong-secret', entityId: 0 });
        // Without valid owner auth and no bound bot, falls through to bot auth check
        expect([400, 403]).toContain(res.status);
        expect(res.body.success).toBe(false);
    });

    it('returns 403 for wrong botSecret', async () => {
        const deviceId = 'sc-auth-dev-2';
        await registerDevice(deviceId);

        const res = await post('/api/device/screen-capture')
            .send({ deviceId, botSecret: 'wrong-bot-secret', entityId: 0 });
        // Entity not bound or wrong botSecret
        expect([400, 403]).toContain(res.status);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 for negative entityId', async () => {
        const deviceId = 'sc-entity-neg';
        const secret = await registerDevice(deviceId);

        const res = await post('/api/device/screen-capture')
            .send({ deviceId, deviceSecret: secret, entityId: -1 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid entityId/i);
    });

    it('returns 403 when remote_control_enabled is false', async () => {
        const deviceId = 'sc-pref-disabled';
        const secret = await registerDevice(deviceId);

        const devicePrefs = require('../../device-preferences');
        devicePrefs.getPrefs.mockResolvedValueOnce({ remote_control_enabled: false });

        const res = await post('/api/device/screen-capture')
            .send({ deviceId, deviceSecret: secret, entityId: 0 });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('remote_control_disabled');
    });

    it('returns 503 device_offline when no socket connection (device owner auth)', async () => {
        const deviceId = 'sc-offline-dev';
        const secret = await registerDevice(deviceId);

        const res = await post('/api/device/screen-capture')
            .send({ deviceId, deviceSecret: secret, entityId: 0 });
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('device_offline');
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/device/screen-result
// ════════════════════════════════════════════════════════════════
describe('POST /api/device/screen-result', () => {
    it('returns 401 when auth is missing', async () => {
        const res = await post('/api/device/screen-result')
            .send({ screen: 'main', elements: [] });
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('returns 401 for wrong deviceSecret', async () => {
        const deviceId = 'sr-auth-dev';
        await registerDevice(deviceId);

        const res = await post('/api/device/screen-result')
            .send({ deviceId, deviceSecret: 'wrong-secret', screen: 'main' });
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('returns 200 with "No pending request" when no capture is pending', async () => {
        const deviceId = 'sr-no-pending';
        const secret = await registerDevice(deviceId);

        const res = await post('/api/device/screen-result')
            .send({ deviceId, deviceSecret: secret, screen: 'main', elements: [] });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toMatch(/no pending/i);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/device/control
// ════════════════════════════════════════════════════════════════
describe('POST /api/device/control', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/device/control')
            .send({ command: 'tap', deviceSecret: 'sec' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when command is missing', async () => {
        const res = await post('/api/device/control')
            .send({ deviceId: 'ctrl-dev-1', deviceSecret: 'sec' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/command required/i);
    });

    it('returns 400 for invalid command', async () => {
        const deviceId = 'ctrl-invalid-cmd';
        const secret = await registerDevice(deviceId);

        const res = await post('/api/device/control')
            .send({ deviceId, deviceSecret: secret, command: 'hack' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid command/i);
    });

    it('returns 404 for unknown device', async () => {
        const res = await post('/api/device/control')
            .send({ deviceId: 'nonexistent-ctrl', deviceSecret: 'sec', command: 'tap' });
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });

    it('returns 403 for wrong botSecret', async () => {
        const deviceId = 'ctrl-auth-dev';
        await registerDevice(deviceId);

        const res = await post('/api/device/control')
            .send({ deviceId, botSecret: 'wrong-secret', command: 'tap', entityId: 0 });
        // Entity not bound or wrong botSecret
        expect([400, 403]).toContain(res.status);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 for negative entityId', async () => {
        const deviceId = 'ctrl-neg-entity';
        const secret = await registerDevice(deviceId);

        const res = await post('/api/device/control')
            .send({ deviceId, deviceSecret: secret, command: 'tap', entityId: -1 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid entityId/i);
    });

    it('returns 403 when remote_control_enabled is false', async () => {
        const deviceId = 'ctrl-pref-disabled';
        const secret = await registerDevice(deviceId);

        const devicePrefs = require('../../device-preferences');
        devicePrefs.getPrefs.mockResolvedValueOnce({ remote_control_enabled: false });

        const res = await post('/api/device/control')
            .send({ deviceId, deviceSecret: secret, command: 'tap', entityId: 0 });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('remote_control_disabled');
    });

    it('returns 200 for valid tap command with device owner auth', async () => {
        const deviceId = 'ctrl-valid-tap';
        const secret = await registerDevice(deviceId);

        const res = await post('/api/device/control')
            .send({ deviceId, deviceSecret: secret, command: 'tap', entityId: 0, params: { x: 100, y: 200 } });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toMatch(/tap.*sent/i);
    });

    it.each(['tap', 'type', 'scroll', 'back', 'home', 'ime_action'])(
        'accepts valid command: %s',
        async (command) => {
            const deviceId = `ctrl-cmd-${command}`;
            const secret = await registerDevice(deviceId);

            const res = await post('/api/device/control')
                .send({ deviceId, deviceSecret: secret, command, entityId: 0 });
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        }
    );
});
