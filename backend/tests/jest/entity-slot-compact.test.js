/**
 * Entity slot compaction tests (Jest + Supertest)
 *
 * Contract (post-#314-revert):
 *  - DELETE /api/device/entity/:entityId/permanent does NOT auto-compact.
 *    Remaining slots stay sparse so the "new IDs never reuse deleted IDs"
 *    invariant holds (chat_messages.entity_id FK, publicCodeIndex, analytics,
 *    bookmarked URLs). Tested by `test-dynamic-entities.js` tests 15-19.
 *  - POST /api/device/compact-entities is the explicit, user-initiated
 *    renumbering path. These tests cover that manual path.
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

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

async function registerDevice() {
    await post('/api/device/register').send({
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 0,
    });
}

async function addEntity() {
    const res = await post('/api/device/add-entity').send({
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
    });
    return res.body.entityId;
}

async function deletePermanent(entityId) {
    return del(`/api/device/entity/${entityId}/permanent`).send({
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
    });
}

async function compact() {
    return post('/api/device/compact-entities').send({
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
    });
}

describe('DELETE /api/device/entity/:entityId/permanent — never-reuse invariant', () => {
    beforeAll(async () => {
        await registerDevice();
    });

    it('leaves remaining slots sparse (no auto-compact)', async () => {
        // Add entities: now we have #0, #1, #2
        const id1 = await addEntity();
        const id2 = await addEntity();
        expect(id1).toBe(1);
        expect(id2).toBe(2);

        // Delete #0 → remaining IDs stay at [1, 2] (sparse)
        const res1 = await deletePermanent(0);
        expect(res1.status).toBe(200);
        expect(res1.body.compacted).toBeUndefined();
        expect(res1.body.entityIds).toEqual([1, 2]);

        // Delete #1 → only #2 remains (sparse)
        const res2 = await deletePermanent(1);
        expect(res2.status).toBe(200);
        expect(res2.body.compacted).toBeUndefined();
        expect(res2.body.entityIds).toEqual([2]);
    });

    it('new add-entity IDs never reuse deleted IDs', async () => {
        // State: only #2 remains. nextEntityId counter should be > 2.
        const newId = await addEntity();
        expect(newId).toBeGreaterThan(2);

        // Delete the freshly added slot and add again — new ID should
        // still be strictly greater, never reusing.
        const previousId = newId;
        await deletePermanent(newId);
        const nextId = await addEntity();
        expect(nextId).toBeGreaterThan(previousId);
    });

    it('deleting the last entity auto-creates a new default entity without resetting the counter', async () => {
        // Drain to a single entity, then delete it.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const listRes = await post('/api/device/compact-entities').send({}).then(() => null).catch(() => null); // noop
            void listRes;
            const statusRes = await request(app)
                .get(`/api/entities?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`)
                .set('Host', 'localhost');
            const ids = statusRes.body.entityIds || [];
            if (ids.length <= 1) break;
            // Delete the lowest ID each iteration until only one remains
            const r = await deletePermanent(ids[0]);
            if (r.status !== 200) break;
        }

        // Capture counter before deletion of the last entity
        const beforeStatus = await request(app)
            .get(`/api/entities?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`)
            .set('Host', 'localhost');
        const lastId = (beforeStatus.body.entityIds || [])[0];

        const res = await deletePermanent(lastId);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.autoCreatedEntityId).toBe(0);
        expect(res.body.remainingEntities).toBe(1);
        expect(res.body.entityIds).toEqual([0]);

        // Counter must not have been reset — adding after this point must
        // yield a strictly-increasing ID that does not collide with any
        // previously-seen (and since-deleted) ID.
        const newId = await addEntity();
        expect(newId).toBeGreaterThan(lastId);
    });
});

describe('POST /api/device/compact-entities — manual renumbering endpoint', () => {
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

    it('compacts sparse entity IDs when explicitly requested', async () => {
        // Add a few entities so we have at least one sparse gap to close.
        await addEntity();
        await addEntity();
        await addEntity();

        // Fetch the current state and delete an interior slot so IDs are sparse
        const before = await request(app)
            .get(`/api/entities?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`)
            .set('Host', 'localhost');
        const beforeIds = (before.body.entityIds || []).slice().sort((a, b) => a - b);
        // Only delete if we have at least 2 entities (otherwise protection kicks in)
        if (beforeIds.length >= 2) {
            await deletePermanent(beforeIds[0]);
        }

        // Now run manual compaction — IDs should become 0..N-1
        const res = await compact();
        expect(res.status).toBe(200);
        const resultIds = (res.body.entityIds || []).slice().sort((a, b) => a - b);
        if (resultIds.length > 0) {
            expect(resultIds[0]).toBe(0);
            // Sequential
            for (let i = 0; i < resultIds.length; i++) {
                expect(resultIds[i]).toBe(i);
            }
        }
    });
});
