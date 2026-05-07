'use strict';

/**
 * api_kanban_dependencies router tests (PR-DCB).
 *
 * Mounts the real router against a pg-mem-backed pool (shared MINIMAL_SCHEMA
 * fixture from kanban-dep-schema.js) and a stub `devices` map. No HTTP-level
 * mocks of pg — the SQL is executed.
 *
 * Mac_F sign-off 2026-05-07 hard gates:
 *   1. auth gate: missing creds → 400/401, never 200
 *   2. cross-device: cards in another device behave as 404 (no leak)
 *   3. self-edge → 400, never reaches INSERT
 *   4. cycle rejection: returns 400 + cycleDetected:true (PR-DCA helper)
 *   5. happy POST + idempotent re-POST: created:true → created:false
 *   6. DELETE returns {deleted:rowCount}
 *   7. graph endpoint device-scoped (cross-device returns empty)
 */

const express = require('express');
const request = require('supertest');
const { bootstrap, insertCard, insertEdge, reset } = require('./__fixtures__/kanban-dep-schema');

const DEVICE_A = 'dev-a';
const DEVICE_B = 'dev-b';
const ENTITY_ID = 7;
const BOT_SECRET = 'test-bot-secret';
const DEVICE_SECRET = 'test-device-secret';

function buildApp(pool) {
    const devices = {
        [DEVICE_A]: {
            deviceSecret: DEVICE_SECRET,
            entities: { [ENTITY_ID]: { botSecret: BOT_SECRET } },
        },
        [DEVICE_B]: {
            deviceSecret: 'other-device-secret',
            entities: { [ENTITY_ID]: { botSecret: 'other-bot-secret' } },
        },
    };
    const factory = require('../../api_kanban_dependencies');
    const { router } = factory(devices, { pool });
    const app = express();
    app.use(express.json());
    app.use('/api/mission', router);
    return app;
}

const auth = { deviceId: DEVICE_A, entityId: ENTITY_ID, botSecret: BOT_SECRET };
const authQS = `deviceId=${DEVICE_A}&entityId=${ENTITY_ID}&botSecret=${BOT_SECRET}`;

describe('api_kanban_dependencies router (PR-DCB)', () => {
    let pool;
    let app;

    beforeAll(async () => {
        ({ pool } = await bootstrap());
        app = buildApp(pool);
    });

    beforeEach(async () => {
        await reset(pool);
        for (const id of ['A', 'B', 'C', 'D']) {
            await insertCard(pool, id, DEVICE_A);
        }
        // device B has its own card 'A' to verify isolation
        await insertCard(pool, 'A', DEVICE_B, 'B-side card A');
        await insertCard(pool, 'X', DEVICE_B, 'B-side card X');
    });

    describe('auth gate', () => {
        test('POST without creds → 400 missing deviceId', async () => {
            const res = await request(app).post('/api/mission/card/A/dependency').send({});
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/deviceId/i);
        });

        test('POST with deviceId only → 400 missing secrets', async () => {
            const res = await request(app)
                .post('/api/mission/card/A/dependency')
                .send({ deviceId: DEVICE_A });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/Secret/i);
        });

        test('POST with wrong botSecret → 401', async () => {
            const res = await request(app)
                .post('/api/mission/card/A/dependency')
                .send({ ...auth, botSecret: 'wrong', dependsOnCardId: 'B' });
            expect(res.status).toBe(401);
        });

        test('GET without creds → 400', async () => {
            const res = await request(app).get('/api/mission/card/A/dependencies');
            expect(res.status).toBe(400);
        });
    });

    describe('POST /card/:cardId/dependency', () => {
        test('happy path → success:true, created:true', async () => {
            const res = await request(app)
                .post('/api/mission/card/A/dependency')
                .send({ ...auth, dependsOnCardId: 'B' });
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ success: true, created: true, cardId: 'A', dependsOnCardId: 'B', dependencyType: 'blocks' });
        });

        test('idempotent re-POST → created:false (no double-insert)', async () => {
            await request(app)
                .post('/api/mission/card/A/dependency')
                .send({ ...auth, dependsOnCardId: 'B' });
            const res = await request(app)
                .post('/api/mission/card/A/dependency')
                .send({ ...auth, dependsOnCardId: 'B' });
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ success: true, created: false });
        });

        test('self-edge (A→A) → 400, never reaches INSERT', async () => {
            const res = await request(app)
                .post('/api/mission/card/A/dependency')
                .send({ ...auth, dependsOnCardId: 'A' });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/itself/i);
        });

        test('missing source card → 404', async () => {
            const res = await request(app)
                .post('/api/mission/card/NOPE/dependency')
                .send({ ...auth, dependsOnCardId: 'B' });
            expect(res.status).toBe(404);
            expect(res.body.error).toMatch(/Card not found/i);
        });

        test('missing dependency card → 404', async () => {
            const res = await request(app)
                .post('/api/mission/card/A/dependency')
                .send({ ...auth, dependsOnCardId: 'NOPE' });
            expect(res.status).toBe(404);
            expect(res.body.error).toMatch(/Dependency card not found/i);
        });

        test('cross-device: card in DEVICE_B is invisible to DEVICE_A → 404', async () => {
            const res = await request(app)
                .post('/api/mission/card/A/dependency')
                .send({ ...auth, dependsOnCardId: 'X' });
            expect(res.status).toBe(404);
        });

        test('cycle rejection (A→B exists; adding B→A) → 400 cycleDetected', async () => {
            await insertEdge(pool, DEVICE_A, 'A', 'B');
            const res = await request(app)
                .post('/api/mission/card/B/dependency')
                .send({ ...auth, dependsOnCardId: 'A' });
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ success: false, cycleDetected: true });
        });

        test('invalid dependencyType → 400', async () => {
            const res = await request(app)
                .post('/api/mission/card/A/dependency')
                .send({ ...auth, dependsOnCardId: 'B', dependencyType: 'pwns' });
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/Invalid dependencyType/i);
        });
    });

    describe('DELETE /card/:cardId/dependency/:dependsOnCardId', () => {
        test('removes existing edge → success, deleted:1', async () => {
            await insertEdge(pool, DEVICE_A, 'A', 'B');
            const res = await request(app)
                .delete('/api/mission/card/A/dependency/B')
                .send(auth);
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ success: true, deleted: 1 });
        });

        test('non-existent edge → success, deleted:0', async () => {
            const res = await request(app)
                .delete('/api/mission/card/A/dependency/B')
                .send(auth);
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ success: true, deleted: 0 });
        });
    });

    describe('GET /card/:cardId/dependencies', () => {
        test('returns dependsOn list with title + status JOINs', async () => {
            await insertEdge(pool, DEVICE_A, 'A', 'B');
            await insertEdge(pool, DEVICE_A, 'A', 'C');
            const res = await request(app).get(`/api/mission/card/A/dependencies?${authQS}`);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.cardId).toBe('A');
            const ids = res.body.dependencies.map(d => d.cardId).sort();
            expect(ids).toEqual(['B', 'C']);
            expect(res.body.dependencies[0]).toHaveProperty('title');
            expect(res.body.dependencies[0]).toHaveProperty('status');
            expect(res.body.dependencies[0]).toHaveProperty('type', 'blocks');
        });

        test('cross-device card → 404 (no leak)', async () => {
            const res = await request(app).get(`/api/mission/card/X/dependencies?${authQS}`);
            expect(res.status).toBe(404);
        });
    });

    describe('GET /card/:cardId/dependents', () => {
        test('returns reverse-direction list', async () => {
            await insertEdge(pool, DEVICE_A, 'B', 'A');
            await insertEdge(pool, DEVICE_A, 'C', 'A');
            const res = await request(app).get(`/api/mission/card/A/dependents?${authQS}`);
            expect(res.status).toBe(200);
            const ids = res.body.dependents.map(d => d.cardId).sort();
            expect(ids).toEqual(['B', 'C']);
        });
    });

    describe('GET /dependencies/graph', () => {
        test('device-scoped nodes + edges', async () => {
            await insertEdge(pool, DEVICE_A, 'A', 'B');
            await insertEdge(pool, DEVICE_A, 'B', 'C');
            const res = await request(app).get(`/api/mission/dependencies/graph?${authQS}`);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            const nodeIds = res.body.graph.nodes.map(n => n.id).sort();
            expect(nodeIds).toEqual(['A', 'B', 'C']);
            expect(res.body.graph.edges).toHaveLength(2);
            expect(res.body.graph.edges[0]).toHaveProperty('from');
            expect(res.body.graph.edges[0]).toHaveProperty('to');
            expect(res.body.graph.edges[0]).toHaveProperty('type');
        });

        test('cross-device isolation: edges in DEVICE_B do not leak into DEVICE_A graph', async () => {
            await insertEdge(pool, DEVICE_B, 'A', 'X');
            const res = await request(app).get(`/api/mission/dependencies/graph?${authQS}`);
            expect(res.status).toBe(200);
            expect(res.body.graph.nodes).toEqual([]);
            expect(res.body.graph.edges).toEqual([]);
        });
    });
});
