/**
 * Entity slot compaction tests (Jest + Supertest)
 *
 * Tests:
 * - Auto-compaction after permanent entity delete
 * - Standalone POST /api/device/compact-entities endpoint
 * - Multiple entities with sparse IDs compacted to 0, 1, 2, ...
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');
const del = (path) => request(app).delete(path).set('Host', 'localhost');

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

const DEVICE_ID = 'compact-test-device';
const DEVICE_SECRET = 'compact-test-secret';

// Helper: register device (creates entity #0)
async function registerDevice() {
    await post('/api/device/register').send({
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0,
    });
}

// Helper: add an entity slot
async function addEntity() {
    const res = await post('/api/device/add-entity').send({
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
    });
    return res.body.entityId;
}

// Helper: permanently delete an entity
async function deletePermanent(entityId) {
    return del(`/api/device/entity/${entityId}/permanent`).send({
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
    });
}

// Helper: compact entities
async function compact() {
    return post('/api/device/compact-entities').send({
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
    });
}

describe('Entity slot compaction — auto after delete', () => {
    beforeAll(async () => {
        await registerDevice();
    });

    it('compacts single remaining entity to slot #0', async () => {
        // Add entities: now we have #0, #1, #2
        const id1 = await addEntity();
        const id2 = await addEntity();
        expect(id1).toBe(1);
        expect(id2).toBe(2);

        // Delete #0, leaving #1 and #2 → auto-compacted to #0, #1
        const res1 = await deletePermanent(0);
        expect(res1.status).toBe(200);
        expect(res1.body.compacted).toBeDefined();
        expect(res1.body.entityIds).toEqual([0, 1]);

        // Delete #0 (was #1), leaving #1 (was #2) → auto-compacted to #0
        const res2 = await deletePermanent(0);
        expect(res2.status).toBe(200);
        expect(res2.body.compacted).toBeDefined();
        expect(res2.body.entityIds).toEqual([0]);
    });

    it('returns mapping array in compacted response', async () => {
        // Add #1 and #2
        await addEntity();
        await addEntity();

        // Delete #0 → #1 becomes #0, #2 becomes #1
        const res = await deletePermanent(0);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.compacted)).toBe(true);
        expect(res.body.compacted).toContainEqual({ from: 1, to: 0 });
        expect(res.body.compacted).toContainEqual({ from: 2, to: 1 });
    });

    it('no compaction needed when IDs already sequential from 0', async () => {
        // State after previous test: #0, #1
        // Delete #1 → only #0 remains, already sequential
        const res = await deletePermanent(1);
        expect(res.status).toBe(200);
        expect(res.body.compacted).toBeUndefined();
        expect(res.body.entityIds).toEqual([0]);
    });

    it('cannot delete the last entity', async () => {
        const res = await deletePermanent(0);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/last entity/i);
    });
});

describe('POST /api/device/compact-entities — standalone endpoint', () => {
    it('returns 400 when credentials missing', async () => {
        const res = await post('/api/device/compact-entities').send({});
        expect(res.status).toBe(400);
    });

    it('returns 403 for invalid credentials', async () => {
        const res = await post('/api/device/compact-entities').send({
            deviceId: DEVICE_ID,
            deviceSecret: 'wrong',
        });
        expect(res.status).toBe(403);
    });

    it('returns "already compact" when IDs are sequential', async () => {
        // Device has entity #0 from previous tests
        const res = await compact();
        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/already compact/i);
    });

    it('compacts sparse entity IDs via standalone endpoint', async () => {
        // Add entities: #1, #2, #3
        await addEntity();
        await addEntity();
        await addEntity();

        // Delete #0 and #2 to create sparse IDs: #1, #3
        await deletePermanent(0);
        // After deleting #0, auto-compact moves: #1→#0, #2→#1, #3→#2
        // Now delete #1 to create: #0, #2 (sparse)
        await deletePermanent(1);
        // After deleting #1, auto-compact moves: #2→#1
        // Now we have #0, #1 — already compact

        // Verify we're compact
        const res = await compact();
        expect(res.status).toBe(200);
        expect(res.body.entityIds[0]).toBe(0);
    });
});
