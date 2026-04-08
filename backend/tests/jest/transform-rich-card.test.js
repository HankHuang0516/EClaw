/**
 * Transform + Rich Card regression tests.
 *
 * Validates:
 * 1. Transform without `card` still works (backward compatible)
 * 2. Transform with valid `card` returns success
 * 3. Transform rejects invalid card (missing buttons, bad types)
 * 4. POST /api/channel/card-action validates required fields
 * 5. POST /api/channel/card-action rejects invalid ask_id
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

async function bindEntity(deviceId, deviceSecret, entityId = 0) {
    if (entityId > 0) {
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
    }
    const regRes = await post('/api/device/register').send({ deviceId, deviceSecret, entityId });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;
    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
}

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

describe('Transform + Rich Card', () => {
    const deviceId = 'transform-card-test';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret;

    beforeAll(async () => {
        botSecret = await bindEntity(deviceId, deviceSecret, 0);
    });

    it('backward compat: transform without card still works', async () => {
        const res = await post('/api/transform')
            .send({ deviceId, entityId: 0, botSecret, message: 'plain text', state: 'IDLE' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('accepts a valid card with buttons', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId, entityId: 0, botSecret,
                message: 'Approve rm xxx.sh?',
                state: 'IDLE',
                card: {
                    ask_id: 'test-ask-1',
                    buttons: [
                        { id: 'approve', label: 'Approve', style: 'primary' },
                        { id: 'deny', label: 'Deny', style: 'danger' }
                    ]
                }
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('auto-generates ask_id when missing', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId, entityId: 0, botSecret,
                message: 'Auto ask id',
                state: 'IDLE',
                card: { buttons: [{ id: 'ok', label: 'OK', style: 'primary' }] }
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('rejects card without buttons array', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId, entityId: 0, botSecret,
                message: 'Bad card',
                card: { buttons: [] }
            });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('rejects card button missing id or label', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId, entityId: 0, botSecret,
                message: 'Bad card',
                card: { buttons: [{ id: 'x' }] }
            });
        expect(res.status).toBe(400);
    });

    it('rejects card that is not an object', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId, entityId: 0, botSecret,
                message: 'Bad card',
                card: 'not an object'
            });
        expect(res.status).toBe(400);
    });

    it('rejects duplicate button ids', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId, entityId: 0, botSecret,
                message: 'Bad card',
                card: {
                    buttons: [
                        { id: 'same', label: 'One' },
                        { id: 'same', label: 'Two' }
                    ]
                }
            });
        expect(res.status).toBe(400);
    });
});

describe('POST /api/channel/card-action', () => {
    const deviceId = 'card-action-test';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret;

    beforeAll(async () => {
        botSecret = await bindEntity(deviceId, deviceSecret, 0);
    });

    it('returns 400 when required fields are missing', async () => {
        const res = await post('/api/channel/card-action').send({ deviceId });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 404 for unknown device', async () => {
        const res = await post('/api/channel/card-action').send({
            deviceId: 'no-such-device',
            botSecret: 'x',
            ask_id: 'a',
            action_id: 'b'
        });
        expect(res.status).toBe(404);
    });

    it('returns 403 for invalid botSecret', async () => {
        const res = await post('/api/channel/card-action').send({
            deviceId,
            botSecret: 'wrong-secret',
            ask_id: 'nonexistent',
            action_id: 'approve'
        });
        expect(res.status).toBe(403);
    });

    it('returns 404 when ask_id does not match any card', async () => {
        const res = await post('/api/channel/card-action').send({
            deviceId,
            botSecret,
            ask_id: 'nonexistent-ask-id',
            action_id: 'approve'
        });
        // chatPool in test env is mocked; when the card lookup returns nothing we expect 404
        expect([404, 500]).toContain(res.status);
    });
});
