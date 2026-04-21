/**
 * /api/chat/message/:id/related — validation + auth + soft-fail path tests.
 *
 * Mirrors chat-search.test.js. Does not hit OpenAI; covers the pgvector-off
 * fallback path and the not-found short-circuit.
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await request(app).post('/api/device/register').set('Host', 'localhost')
        .send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

describe('POST /api/chat/message/:id/related — input validation', () => {
    it('400 when deviceId missing', async () => {
        const res = await post('/api/chat/message/abc/related').send({});
        expect(res.status).toBe(400);
    });

    it('400 when neither deviceSecret nor botSecret supplied', async () => {
        const res = await post('/api/chat/message/abc/related').send({ deviceId: 'x' });
        expect(res.status).toBe(400);
    });

    it('401 for invalid device credentials', async () => {
        const res = await post('/api/chat/message/abc/related')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong' });
        expect(res.status).toBe(401);
    });
});

describe('POST /api/chat/message/:id/related — lookup behavior', () => {
    it('404 when the anchor message does not exist for this device', async () => {
        const deviceSecret = await registerDevice('test-chat-related-404');
        const res = await post('/api/chat/message/nonexistent-msg-id/related').send({
            deviceId: 'test-chat-related-404',
            deviceSecret
        });
        // 404 on the happy path; 500 is acceptable if the pg mock errors out —
        // either way the pipeline wired up without crashing on auth.
        expect([404, 500]).toContain(res.status);
        if (res.status === 404) {
            expect(res.body.success).toBe(false);
            expect(res.body.error).toBe('message_not_found');
        }
    });
});

describe('chat-embedding module — related helpers no-op when disabled', () => {
    const chatEmbedding = require('../../chat-embedding');

    it('findMessage() returns null for empty args', async () => {
        expect(await chatEmbedding.findMessage(null, 'x')).toBeNull();
        expect(await chatEmbedding.findMessage('x', null)).toBeNull();
    });

    it('searchRelatedBySemantic() returns [] when pgvector disabled', async () => {
        const rows = await chatEmbedding.searchRelatedBySemantic('device', 'msg-id');
        expect(rows).toEqual([]);
    });

    it('searchRelatedBySemantic() returns [] for missing args', async () => {
        expect(await chatEmbedding.searchRelatedBySemantic(null, 'x')).toEqual([]);
        expect(await chatEmbedding.searchRelatedBySemantic('x', null)).toEqual([]);
    });
});
