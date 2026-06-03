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

// ════════════════════════════════════════════════════════════════
// M1 mobile-use parity — gated commands + new screen-image endpoint
// docs/specs/mobile-use-integration.md §3
// ════════════════════════════════════════════════════════════════
describe('POST /api/device/control — M1 mobile-use commands (gated)', () => {
    const M1_ENV_KEY = 'ECLAW_MOBILE_USE_API_ENABLED';
    let originalEnv;
    beforeAll(() => { originalEnv = process.env[M1_ENV_KEY]; });
    afterAll(() => {
        if (originalEnv === undefined) delete process.env[M1_ENV_KEY];
        else process.env[M1_ENV_KEY] = originalEnv;
    });

    it.each(['swipe', 'long_press', 'launch_app', 'stop_app'])(
        'returns 403 feature-disabled when flag is off: %s',
        async (command) => {
            delete process.env[M1_ENV_KEY];
            const deviceId = `m1-off-${command}`;
            const secret = await registerDevice(deviceId);
            const res = await post('/api/device/control')
                .send({ deviceId, deviceSecret: secret, command, entityId: 0,
                        params: command === 'swipe' ? { startX:0, startY:0, endX:10, endY:10 }
                              : command === 'long_press' ? { x:5, y:5 }
                              : { packageName: 'com.example' } });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('feature-disabled');
        }
    );

    it('swipe accepts valid params with flag on', async () => {
        process.env[M1_ENV_KEY] = 'true';
        const deviceId = 'm1-swipe-ok';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/device/control')
            .send({ deviceId, deviceSecret: secret, command: 'swipe', entityId: 0,
                    params: { startX: 100, startY: 800, endX: 100, endY: 200, durationMs: 250 } });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('swipe rejects non-numeric coords (400)', async () => {
        process.env[M1_ENV_KEY] = 'true';
        const deviceId = 'm1-swipe-bad';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/device/control')
            .send({ deviceId, deviceSecret: secret, command: 'swipe', entityId: 0,
                    params: { startX: 'bad', startY: 0, endX: 10, endY: 10 } });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/swipe requires numeric/);
    });

    it('long_press accepts valid coords with flag on', async () => {
        process.env[M1_ENV_KEY] = 'true';
        const deviceId = 'm1-lp-ok';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/device/control')
            .send({ deviceId, deviceSecret: secret, command: 'long_press', entityId: 0,
                    params: { x: 50, y: 100, durationMs: 1000 } });
        expect(res.status).toBe(200);
    });

    it('long_press rejects missing coords (400)', async () => {
        process.env[M1_ENV_KEY] = 'true';
        const deviceId = 'm1-lp-bad';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/device/control')
            .send({ deviceId, deviceSecret: secret, command: 'long_press', entityId: 0, params: {} });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/long_press requires numeric/);
    });

    it('launch_app accepts packageName with flag on', async () => {
        process.env[M1_ENV_KEY] = 'true';
        const deviceId = 'm1-launch-ok';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/device/control')
            .send({ deviceId, deviceSecret: secret, command: 'launch_app', entityId: 0,
                    params: { packageName: 'com.android.settings' } });
        expect(res.status).toBe(200);
    });

    it('launch_app rejects empty params (400)', async () => {
        process.env[M1_ENV_KEY] = 'true';
        const deviceId = 'm1-launch-bad';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/device/control')
            .send({ deviceId, deviceSecret: secret, command: 'launch_app', entityId: 0, params: {} });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/packageName.*bundleId/);
    });

    it('stop_app accepts bundleId with flag on', async () => {
        process.env[M1_ENV_KEY] = 'true';
        const deviceId = 'm1-stop-ok';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/device/control')
            .send({ deviceId, deviceSecret: secret, command: 'stop_app', entityId: 0,
                    params: { bundleId: 'com.apple.Preferences' } });
        expect(res.status).toBe(200);
    });
});

describe('GET /api/device/screen-image — M1 mobile-use endpoint', () => {
    const M1_ENV_KEY = 'ECLAW_MOBILE_USE_API_ENABLED';
    let originalEnv;
    beforeAll(() => { originalEnv = process.env[M1_ENV_KEY]; });
    afterAll(() => {
        if (originalEnv === undefined) delete process.env[M1_ENV_KEY];
        else process.env[M1_ENV_KEY] = originalEnv;
    });

    it('returns 403 feature-disabled when flag is off', async () => {
        delete process.env[M1_ENV_KEY];
        const res = await request(app).get('/api/device/screen-image')
            .query({ deviceId: 'si-off', deviceSecret: 'sec' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('feature-disabled');
    });

    it('returns 400 when deviceId missing (flag on)', async () => {
        process.env[M1_ENV_KEY] = 'true';
        const res = await request(app).get('/api/device/screen-image')
            .query({ deviceSecret: 'sec' });
        expect(res.status).toBe(400);
    });

    it('returns 404 for unknown device (flag on)', async () => {
        process.env[M1_ENV_KEY] = 'true';
        const res = await request(app).get('/api/device/screen-image')
            .query({ deviceId: 'unknown-si', deviceSecret: 'sec' });
        expect(res.status).toBe(404);
    });

    it('returns 503 device_offline when device not connected via socket', async () => {
        process.env[M1_ENV_KEY] = 'true';
        const deviceId = 'si-offline';
        const secret = await registerDevice(deviceId);
        const res = await request(app).get('/api/device/screen-image')
            .query({ deviceId, deviceSecret: secret });
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('device_offline');
    });
});
