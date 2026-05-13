'use strict';

const express = require('express');
const request = require('supertest');
const { bootstrap, insertCard, insertLink, reset } = require('./__fixtures__/kanban-dep-schema');

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
    const factory = require('../../api_kanban_card_links');
    const { router } = factory(devices, { pool });
    const app = express();
    app.use(express.json());
    app.use('/api/mission', router);
    return app;
}

const auth = { deviceId: DEVICE_A, entityId: ENTITY_ID, botSecret: BOT_SECRET };
const authQS = `deviceId=${DEVICE_A}&entityId=${ENTITY_ID}&botSecret=${BOT_SECRET}`;

describe('api_kanban_card_links router', () => {
    let pool;
    let app;

    beforeAll(async () => {
        ({ pool } = await bootstrap());
        app = buildApp(pool);
    });

    beforeEach(async () => {
        await reset(pool);
        for (const id of ['A', 'B', 'C']) await insertCard(pool, id, DEVICE_A);
        await insertCard(pool, 'A', DEVICE_B, 'B-side A');
        await insertCard(pool, 'X', DEVICE_B, 'B-side X');
    });

    test('POST creates link and repeated POST is idempotent', async () => {
        const first = await request(app)
            .post('/api/mission/card/A/link')
            .send({ ...auth, targetCardId: 'B', relationType: 'references' });
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ success: true, created: true });
        expect(first.body.link).toMatchObject({ sourceCardId: 'A', targetCardId: 'B', relationType: 'references' });

        const second = await request(app)
            .post('/api/mission/card/A/link')
            .send({ ...auth, targetCardId: 'B', relationType: 'references' });
        expect(second.status).toBe(200);
        expect(second.body).toMatchObject({ success: true, created: false });
    });

    test('validates relation type, self-link, missing target, and cross-device target', async () => {
        const invalid = await request(app)
            .post('/api/mission/card/A/link')
            .send({ ...auth, targetCardId: 'B', relationType: 'owns' });
        expect(invalid.status).toBe(400);

        const self = await request(app)
            .post('/api/mission/card/A/link')
            .send({ ...auth, targetCardId: 'A' });
        expect(self.status).toBe(400);
        expect(self.body.error).toMatch(/itself/i);

        const missing = await request(app)
            .post('/api/mission/card/A/link')
            .send({ ...auth, targetCardId: 'NOPE' });
        expect(missing.status).toBe(404);

        const crossDevice = await request(app)
            .post('/api/mission/card/A/link')
            .send({ ...auth, targetCardId: 'X' });
        expect(crossDevice.status).toBe(404);
    });

    test('GET /card/:cardId/links returns incoming and outgoing with card metadata', async () => {
        await insertLink(pool, DEVICE_A, 'A', 'B', 'related');
        await insertLink(pool, DEVICE_A, 'C', 'A', 'duplicates');
        await insertLink(pool, DEVICE_B, 'A', 'X', 'related');

        const res = await request(app).get(`/api/mission/card/A/links?${authQS}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.outgoing).toHaveLength(1);
        expect(res.body.incoming).toHaveLength(1);
        expect(res.body.outgoing[0]).toMatchObject({ targetCardId: 'B', relationType: 'related', targetTitle: 'card B' });
        expect(res.body.incoming[0]).toMatchObject({ sourceCardId: 'C', relationType: 'duplicates', sourceTitle: 'card C' });
    });

    test('DELETE removes only the requested relation type', async () => {
        await insertLink(pool, DEVICE_A, 'A', 'B', 'related');
        await insertLink(pool, DEVICE_A, 'A', 'B', 'references');

        const res = await request(app)
            .delete('/api/mission/card/A/link/B?relationType=references')
            .send(auth);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, deleted: 1 });

        const list = await request(app).get(`/api/mission/card/A/links?${authQS}`);
        expect(list.body.outgoing.map(l => l.relationType)).toEqual(['related']);
    });

    test('GET /card-links/graph is device scoped', async () => {
        await insertLink(pool, DEVICE_A, 'A', 'B', 'references');
        await insertLink(pool, DEVICE_B, 'A', 'X', 'related');

        const res = await request(app).get(`/api/mission/card-links/graph?${authQS}`);
        expect(res.status).toBe(200);
        expect(res.body.graph.nodes.map(n => n.id).sort()).toEqual(['A', 'B']);
        expect(res.body.graph.edges).toEqual(expect.arrayContaining([
            expect.objectContaining({ from: 'A', to: 'B', type: 'references' }),
        ]));
    });
});
