/**
 * org-chart botSecret READ regression (card_dfdd58f2, Hank 2026-07-09)
 *
 * Defect: GET /api/device/org-chart was hard-bound to the owner deviceSecret
 * (authDevice), so a bound bot could not READ the org hierarchy/roster it needs
 * to resolve its superior/subordinates for routing — it got 401 Unauthorized.
 *
 * Fix: the GET (read) now ALSO accepts a bound entity's botSecret+entityId via
 * the shared authDeviceRead() idiom (same as /api/suppression-log,
 * /api/b2b-status). The deviceSecret path is unchanged, and the PUT (write /
 * mutate hierarchy) STILL requires deviceSecret — the read is broadened, the
 * write is not.
 *
 * These tests exercise the REAL app + route table (supertest) with a real bound
 * entity's botSecret (obtained via register→bind), so they fail on origin/main
 * (botSecret GET → 401) and pass with the fix (→ 200 + hierarchy body).
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');
const get = (path) => request(app).get(path).set('Host', 'localhost');
const put = (path) => request(app).put(path).set('Host', 'localhost');

// Register + bind a single entity, returning its botSecret.
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

describe('GET /api/device/org-chart — botSecret read (card_dfdd58f2)', () => {
    const deviceId = 'orgchart-botread-dev';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret;
    // A DIFFERENT device's validly-bound bot — proves a foreign botSecret cannot
    // read THIS device's org-chart (confused-deputy negative). authDeviceRead is
    // SHARED by /api/suppression-log + /api/b2b-status, so pinning cross-device
    // scoping here guards the whole helper against an unguarded global-resolve
    // refactor, not just this endpoint.
    const foreignDeviceId = 'orgchart-foreign-dev';
    const foreignDeviceSecret = `secret-${foreignDeviceId}`;
    let foreignBotSecret;

    beforeAll(async () => {
        botSecret = await bindEntity(deviceId, deviceSecret, 0);
        foreignBotSecret = await bindEntity(foreignDeviceId, foreignDeviceSecret, 0);
    });

    it('binds an entity and yields a botSecret (harness sanity)', () => {
        expect(typeof botSecret).toBe('string');
        expect(botSecret.length).toBeGreaterThan(0);
    });

    it('returns 200 + org hierarchy with a bound entity botSecret+entityId (was 401 before fix)', async () => {
        const res = await get(`/api/device/org-chart?deviceId=${deviceId}&botSecret=${botSecret}&entityId=0`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.orgChart).toBeDefined();
        // roster/hierarchy is the read surface — who reports to whom.
        // A fresh device has an empty hierarchy {} + default options.
        expect(typeof res.body.orgChart.hierarchy).toBe('object');
        expect(res.body.orgChart.options).toBeDefined();
    });

    it('still returns 200 + org hierarchy with the owner deviceSecret (unchanged)', async () => {
        const res = await get(`/api/device/org-chart?deviceId=${deviceId}&deviceSecret=${deviceSecret}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.orgChart).toBeDefined();
        expect(typeof res.body.orgChart.hierarchy).toBe('object');
    });

    it('rejects an invalid botSecret (still Unauthorized)', async () => {
        const res = await get(`/api/device/org-chart?deviceId=${deviceId}&botSecret=wrong-secret&entityId=0`);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('rejects when only deviceId is provided (no secret → Unauthorized)', async () => {
        const res = await get(`/api/device/org-chart?deviceId=${deviceId}`);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('rejects botSecret WITHOUT entityId (cannot bind to an entity → Unauthorized)', async () => {
        const res = await get(`/api/device/org-chart?deviceId=${deviceId}&botSecret=${botSecret}`);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it("rejects a DIFFERENT device's botSecret against this device (confused-deputy → Unauthorized)", async () => {
        // foreignBotSecret is a valid secret for foreignDeviceId, but must NOT
        // read THIS device's hierarchy: authDeviceRead resolves the bot via
        // devices[queriedDeviceId].entities[eId] and safeEqual's against THAT
        // device's stored secret, so a cross-device secret never matches → 401.
        const res = await get(`/api/device/org-chart?deviceId=${deviceId}&botSecret=${foreignBotSecret}&entityId=0`);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });
});

describe('PUT /api/device/org-chart — write STILL requires deviceSecret (card_dfdd58f2)', () => {
    const deviceId = 'orgchart-botwrite-dev';
    const deviceSecret = `secret-${deviceId}`;
    let botSecret;

    beforeAll(async () => {
        botSecret = await bindEntity(deviceId, deviceSecret, 0);
    });

    it('rejects a PUT authenticated with botSecret only (write NOT broadened → 401)', async () => {
        const res = await put('/api/device/org-chart')
            .send({ deviceId, botSecret, entityId: 0, hierarchy: { USER: [0] } });
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('rejects a PUT with botSecret in the QUERY string (write-lock covers the query channel too → 401)', async () => {
        // Tripwire for the exact regression this PR's GET fix demonstrates:
        // swapping authDevice → authDeviceRead(req.query). If a future author
        // mirrors that on the PUT, a query-string botSecret would silently gain
        // write access. Pin it: the write path must reject botSecret via the
        // query channel as well as the body channel.
        const res = await put(`/api/device/org-chart?deviceId=${deviceId}&botSecret=${botSecret}&entityId=0`)
            .send({ hierarchy: { USER: [0] } });
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    it('accepts a PUT authenticated with the owner deviceSecret (write path unchanged)', async () => {
        const res = await put('/api/device/org-chart')
            .send({ deviceId, deviceSecret, hierarchy: { USER: [0] } });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.orgChart).toBeDefined();
    });
});
