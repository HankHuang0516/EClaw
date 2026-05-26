/**
 * Regression coverage for official free-bot bindings that share a pool bot.
 *
 * Free bots can serve multiple devices at once. /api/whoami must therefore
 * honor deviceId when supplied, and bind-free must issue per-binding entity
 * secrets instead of reusing the free-bot pool credential for every renter.
 */

require('./helpers/mock-setup');

const fs = require('fs');
const request = require('supertest');

let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');

const DEVICE_A = 'whoami-freebot-device-a';
const DEVICE_B = 'whoami-freebot-device-b';
const SHARED_SECRET = 'shared-freebot-pool-secret';

function installSharedSecretFixtures() {
    const exported = require('../../index');
    const { devices, _createDefaultEntity } = exported;

    devices[DEVICE_A] = {
        deviceSecret: 'secret-a',
        entities: {
            0: {
                ..._createDefaultEntity(0),
                isBound: true,
                botSecret: SHARED_SECRET,
                name: 'Free Bot A',
                publicCode: 'aaaaaa',
            },
        },
    };
    devices[DEVICE_B] = {
        deviceSecret: 'secret-b',
        entities: {
            0: {
                ..._createDefaultEntity(0),
                isBound: true,
                botSecret: SHARED_SECRET,
                name: 'Free Bot B',
                publicCode: 'bbbbbb',
            },
        },
    };
}

beforeAll(() => {
    app = require('../../index');
});

afterEach(() => {
    const { devices } = require('../../index');
    delete devices[DEVICE_A];
    delete devices[DEVICE_B];
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

describe('GET /api/whoami device-scoped botSecret lookup', () => {
    it('returns the entity on the requested device when a free-bot secret is shared', async () => {
        installSharedSecretFixtures();

        const res = await get(`/api/whoami?deviceId=${DEVICE_B}&entityId=0&botSecret=${SHARED_SECRET}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.deviceId).toBe(DEVICE_B);
        expect(res.body.entityId).toBe(0);
        expect(res.body.name).toBe('Free Bot B');
        expect(res.body.publicCode).toBe('bbbbbb');
    });

    it('does not fall back to another device when deviceId is supplied', async () => {
        installSharedSecretFixtures();

        const res = await get(`/api/whoami?deviceId=missing-device&entityId=0&botSecret=${SHARED_SECRET}`);

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });
});

describe('bind-free secret isolation', () => {
    const src = fs.readFileSync(require.resolve('../../index'), 'utf8');
    const bindFreeStart = src.indexOf("app.post('/api/official-borrow/bind-free'");
    const bindPersonalStart = src.indexOf("app.post('/api/official-borrow/bind-personal'");
    const bindFreeHandler = src.slice(bindFreeStart, bindPersonalStart);

    it('mints a per-binding botSecret for free-bot rental entities', () => {
        expect(bindFreeStart).toBeGreaterThan(-1);
        expect(bindPersonalStart).toBeGreaterThan(bindFreeStart);
        expect(bindFreeHandler).toMatch(/const botSecret\s*=\s*generateBotSecret\(\);/);
        expect(bindFreeHandler).not.toMatch(/const botSecret\s*=\s*freeBot\.bot_secret/);
    });
});
