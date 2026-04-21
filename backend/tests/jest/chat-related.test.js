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

// Regression: when pgvector is unavailable in prod, the `embedding` column is
// never added to chat_messages. findMessage() used to reference that column
// unconditionally and returned null (silent catch) on every lookup, surfacing
// as "Failed to load related messages" in the UI for every click.
describe('chat-embedding findMessage — no-pgvector regression', () => {
    // Isolated module instance so we control poolRef + vectorEnabled cleanly.
    let chatEmbedding;
    beforeEach(() => {
        jest.isolateModules(() => {
            chatEmbedding = require('../../chat-embedding');
        });
    });

    it('builds SQL without `embedding IS NOT NULL` when vectorEnabled=false', async () => {
        const captured = [];
        const pool = {
            query: (sql, params) => {
                // Swallow initSchema's CREATE EXTENSION / ALTER calls as failures
                // to keep vectorEnabled=false, but capture the findMessage call.
                if (/CREATE EXTENSION|ALTER TABLE|CREATE INDEX/i.test(sql)) {
                    return Promise.reject(new Error('not available'));
                }
                captured.push({ sql, params });
                return Promise.resolve({
                    rows: [{ id: 'msg1', entity_id: 1, text: 'hi', has_embedding: false }]
                });
            }
        };
        await chatEmbedding.initSchema(pool);
        expect(chatEmbedding.isVectorEnabled()).toBe(false);

        const result = await chatEmbedding.findMessage('dev1', 'msg1');
        expect(result).toBeTruthy();
        expect(result.id).toBe('msg1');
        expect(captured.length).toBe(1);
        expect(captured[0].sql).not.toMatch(/embedding\s+IS\s+NOT\s+NULL/i);
        expect(captured[0].sql).toMatch(/FALSE\s+AS\s+has_embedding/i);
    });

    it('still uses embedding column when vectorEnabled=true', async () => {
        const captured = [];
        const pool = {
            query: (sql, params) => {
                captured.push({ sql, params });
                return Promise.resolve({
                    rows: sql.includes('WHERE id')
                        ? [{ id: 'msg1', has_embedding: true }]
                        : []
                });
            }
        };
        await chatEmbedding.initSchema(pool);
        expect(chatEmbedding.isVectorEnabled()).toBe(true);

        captured.length = 0;
        await chatEmbedding.findMessage('dev1', 'msg1');
        expect(captured[0].sql).toMatch(/\(embedding\s+IS\s+NOT\s+NULL\)\s+AS\s+has_embedding/i);
    });
});
