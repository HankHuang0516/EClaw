/**
 * Channel self-repair endpoint validation tests (Jest + Supertest)
 *
 * Tests: POST /api/channel/self-repair — the dashboard 重新綁定 trigger that invokes a
 * bound channel's version-aware self-repair program (with /restart fallback).
 * Covers the auth + binding validation gates (no live channel webhook required).
 */

require('./helpers/mock-setup');

const db = require('../../db');
db.getChannelAccountById = jest.fn().mockResolvedValue(null);

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register').send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

describe('POST /api/channel/self-repair', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/channel/self-repair').send({ deviceSecret: 'x', entityId: 1 });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when deviceSecret is missing', async () => {
        const res = await post('/api/channel/self-repair').send({ deviceId: 'sr-dev', entityId: 1 });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 on invalid entityId', async () => {
        const secret = await registerDevice('sr-dev-1');
        const res = await post('/api/channel/self-repair')
            .send({ deviceId: 'sr-dev-1', deviceSecret: secret, entityId: -5 });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 403 on invalid device credentials', async () => {
        await registerDevice('sr-dev-2');
        const res = await post('/api/channel/self-repair')
            .send({ deviceId: 'sr-dev-2', deviceSecret: 'wrong-secret', entityId: 0 });
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when the entity is not a channel binding', async () => {
        const secret = await registerDevice('sr-dev-3');
        // entity 0 is the default (non-channel) entity → must be rejected before any webhook call
        const res = await post('/api/channel/self-repair')
            .send({ deviceId: 'sr-dev-3', deviceSecret: secret, entityId: 0 });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });
});
