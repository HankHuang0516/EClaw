'use strict';

const express = require('express');
const request = require('supertest');
const { bootstrap, insertCard, insertTag, reset } = require('./__fixtures__/kanban-dep-schema');

const DEVICE_A = 'dev-a';
const DEVICE_B = 'dev-b';
const ENTITY_ID = 7;
const BOT_SECRET = 'test-bot-secret';
const DEVICE_SECRET = 'test-device-secret';

function devices() {
    return {
        [DEVICE_A]: {
            deviceSecret: DEVICE_SECRET,
            entities: { [ENTITY_ID]: { botSecret: BOT_SECRET } },
        },
        [DEVICE_B]: {
            deviceSecret: 'other-device-secret',
            entities: { [ENTITY_ID]: { botSecret: 'other-bot-secret' } },
        },
    };
}

function buildTagApp(pool) {
    const factory = require('../../api_kanban_tags');
    const { router } = factory(devices(), { pool });
    const app = express();
    app.use(express.json());
    app.use('/api/mission', router);
    return app;
}

function buildKanbanAppWithMockedPool(pool) {
    jest.resetModules();
    jest.doMock('pg', () => ({ Pool: jest.fn(() => pool) }));
    jest.doMock('@aws-sdk/client-s3', () => ({
        S3Client: jest.fn(),
        GetObjectCommand: jest.fn(),
    }));
    jest.doMock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
    const factory = require('../../kanban');
    const { router } = factory(devices(), {});
    const app = express();
    app.use(express.json());
    app.use('/api/mission', router);
    return app;
}

const botAuth = { deviceId: DEVICE_A, entityId: ENTITY_ID, botSecret: BOT_SECRET };
const deviceAuthQS = `deviceId=${DEVICE_A}&deviceSecret=${DEVICE_SECRET}`;

describe('Kanban tags API and board filtering', () => {
    let pool;
    let tagApp;

    beforeAll(async () => {
        ({ pool } = await bootstrap());
        tagApp = buildTagApp(pool);
    });

    beforeEach(async () => {
        await reset(pool);
        await insertCard(pool, 'A', DEVICE_A, 'A task');
        await insertCard(pool, 'B', DEVICE_A, 'B task');
        await insertCard(pool, 'A', DEVICE_B, 'B-side A');
    });

    afterEach(() => {
        jest.dontMock('pg');
        jest.dontMock('@aws-sdk/client-s3');
        jest.dontMock('@aws-sdk/s3-request-presigner');
    });

    test('POST normalizes duplicate tag input and GET lists one card tag', async () => {
        const first = await request(tagApp)
            .post('/api/mission/card/A/tag')
            .send({ ...botAuth, tag: '  UI Polish  ' });
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ success: true, createdTag: true, attached: true });
        expect(first.body.tag.slug).toBe('ui-polish');

        const second = await request(tagApp)
            .post('/api/mission/card/A/tag')
            .send({ ...botAuth, tag: 'ui-polish' });
        expect(second.status).toBe(200);
        expect(second.body).toMatchObject({ success: true, createdTag: false, attached: false });
        expect(second.body.tags).toHaveLength(1);

        const list = await request(tagApp).get(`/api/mission/card/A/tags?deviceId=${DEVICE_A}&entityId=${ENTITY_ID}&botSecret=${BOT_SECRET}`);
        expect(list.status).toBe(200);
        expect(list.body.tags.map(t => t.slug)).toEqual(['ui-polish']);
    });

    test('DELETE removes a tag from only the requested card', async () => {
        await insertTag(pool, DEVICE_A, 'A', 'ui', 'UI');
        await insertTag(pool, DEVICE_A, 'B', 'ui', 'UI');

        const del = await request(tagApp)
            .delete('/api/mission/card/A/tag/ui')
            .send(botAuth);
        expect(del.status).toBe(200);
        expect(del.body).toMatchObject({ success: true, deleted: 1 });
        expect(del.body.tags).toEqual([]);

        const b = await request(tagApp).get(`/api/mission/card/B/tags?deviceId=${DEVICE_A}&entityId=${ENTITY_ID}&botSecret=${BOT_SECRET}`);
        expect(b.body.tags.map(t => t.slug)).toEqual(['ui']);
    });

    test('device isolation prevents cross-device card/tag visibility', async () => {
        await insertTag(pool, DEVICE_A, 'A', 'ui', 'UI');
        await insertTag(pool, DEVICE_B, 'A', 'secret', 'Secret');

        const visible = await request(tagApp).get(`/api/mission/card/A/tags?deviceId=${DEVICE_A}&entityId=${ENTITY_ID}&botSecret=${BOT_SECRET}`);
        expect(visible.status).toBe(200);
        expect(visible.body.tags.map(t => t.slug)).toEqual(['ui']);

        const crossAuth = { deviceId: DEVICE_A, entityId: ENTITY_ID, botSecret: 'other-bot-secret', tag: 'x' };
        const forbidden = await request(tagApp).post('/api/mission/card/A/tag').send(crossAuth);
        expect(forbidden.status).toBe(401);
    });

    test('GET /cards?tag filters the board to tagged cards', async () => {
        await insertTag(pool, DEVICE_A, 'A', 'ui', 'UI');
        await insertTag(pool, DEVICE_A, 'B', 'backend', 'Backend');
        await insertTag(pool, DEVICE_B, 'A', 'ui', 'Other UI');

        const app = buildKanbanAppWithMockedPool(pool);
        const res = await request(app).get(`/api/mission/cards?${deviceAuthQS}&tag=ui&automation=all`);
        expect(res.status).toBe(200);
        expect(res.body.cards.map(c => c.id)).toEqual(['A']);
        expect(res.body.cards[0].tags.map(t => t.slug)).toEqual(['ui']);
    });
});
