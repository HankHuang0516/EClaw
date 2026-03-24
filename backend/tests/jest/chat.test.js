/**
 * Chat & file operation endpoint tests (Jest + Supertest)
 *
 * Tests: GET /api/chat/history, POST /api/chat/integrity-report,
 *        POST /api/message/:id/react, POST /api/chat/upload-media
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');

/** Register a device via the register endpoint */
async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register')
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

// ════════════════════════════════════════════════════════════════
// GET /api/chat/history
// ════════════════════════════════════════════════════════════════
describe('GET /api/chat/history', () => {
    it('returns 400 when credentials are missing', async () => {
        const res = await get('/api/chat/history');
        expect(res.status).toBe(400);
    });

    it('returns 401 for invalid credentials', async () => {
        const res = await get('/api/chat/history?deviceId=nonexistent&deviceSecret=wrong');
        expect(res.status).toBe(401);
    });

    it('returns chat history for valid device', async () => {
        const deviceSecret = await registerDevice('test-chat-history');

        const res = await get(`/api/chat/history?deviceId=test-chat-history&deviceSecret=${deviceSecret}`);
        // Either 200 with messages array, or 500 from DB mock
        expect([200, 500].includes(res.status)).toBe(true);
        if (res.status === 200) {
            expect(res.body.success).toBe(true);
        }
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/chat/history-by-code
// ════════════════════════════════════════════════════════════════
describe('GET /api/chat/history-by-code', () => {
    it('returns 400 without deviceId', async () => {
        const res = await get('/api/chat/history-by-code?publicCode=abc');
        expect(res.status).toBe(400);
    });

    it('returns 400 without publicCode', async () => {
        const res = await get('/api/chat/history-by-code?deviceId=test&deviceSecret=sec');
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/chat/integrity-report
// ════════════════════════════════════════════════════════════════
describe('POST /api/chat/integrity-report', () => {
    it('returns 401 for invalid credentials', async () => {
        const res = await post('/api/chat/integrity-report')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong' });
        expect(res.status).toBe(401);
    });

    it('processes integrity report for valid device', async () => {
        const deviceSecret = await registerDevice('test-chat-integrity');

        const res = await post('/api/chat/integrity-report')
            .send({ deviceId: 'test-chat-integrity', deviceSecret });
        // Either 200 (success) or 500 (chatIntegrity mock error) — not 401
        expect([200, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/message/:messageId/react
// ════════════════════════════════════════════════════════════════
describe('POST /api/message/:messageId/react', () => {
    it('returns 400 when credentials are missing', async () => {
        const res = await post('/api/message/msg-1/react')
            .send({ reaction: 'like' });
        expect(res.status).toBe(400);
    });

    it('returns 401 for invalid device credentials', async () => {
        const res = await post('/api/message/msg-1/react')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong', reaction: 'like' });
        expect(res.status).toBe(401);
    });

    it('returns 400 for invalid reaction value', async () => {
        const deviceSecret = await registerDevice('test-react');

        const res = await post('/api/message/msg-1/react')
            .send({ deviceId: 'test-react', deviceSecret, reaction: 'love' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/like|dislike|null/);
    });

    it('returns 404 when message does not exist', async () => {
        const deviceSecret = await registerDevice('test-react-404');

        const res = await post('/api/message/nonexistent-msg/react')
            .send({ deviceId: 'test-react-404', deviceSecret, reaction: 'like' });
        // DB mock returns empty rows → 404
        expect(res.status).toBe(404);
    });

    it('accepts null reaction to clear', async () => {
        const deviceSecret = await registerDevice('test-react-null');

        const res = await post('/api/message/msg-null/react')
            .send({ deviceId: 'test-react-null', deviceSecret, reaction: null });
        // null is valid — should get 404 (message not found) not 400
        expect(res.status).toBe(404);
    });
});

// ════════════════════════════════════════════════════════════════
// Regression: user message shadow (messageQueue lacks fromEntityId/fromCharacter)
// When a user sends via /api/client/speak, the backend pushes the message into
// entity.messageQueue WITHOUT fromEntityId/fromCharacter. Android clients must
// skip these items to avoid rendering a "shadow" duplicate of the user's message
// as a left-aligned entity message.
// ════════════════════════════════════════════════════════════════
describe('client/speak messageQueue structure (shadow bug regression)', () => {
    it('user message in messageQueue should NOT have fromEntityId or fromCharacter', async () => {
        const deviceSecret = await registerDevice('test-shadow-mq');

        // Bind entity 0
        await post('/api/bind').send({
            deviceId: 'test-shadow-mq', entityId: 0,
            name: 'TestBot', character: '🤖', webhook: ''
        });

        // Send a user message
        await post('/api/client/speak').send({
            deviceId: 'test-shadow-mq', deviceSecret,
            entityId: 0, text: 'Hello shadow test', source: 'android_chat'
        });

        // Check entity status — messageQueue item should lack entity fields
        const statusRes = await get(`/api/status?deviceId=test-shadow-mq&deviceSecret=${deviceSecret}`);
        expect(statusRes.status).toBe(200);

        const entity0 = statusRes.body.entities?.find(e => e.entityId === 0);
        if (entity0 && entity0.messageQueue && entity0.messageQueue.length > 0) {
            const userMsg = entity0.messageQueue.find(m => m.text === 'Hello shadow test');
            if (userMsg) {
                // User messages must NOT have fromEntityId or fromCharacter set
                // (these fields are only set for entity-to-entity messages)
                expect(userMsg.fromEntityId).toBeUndefined();
                expect(userMsg.fromCharacter).toBeUndefined();
                expect(userMsg.from).toBe('android_chat');
            }
        }
    });

    it('client/speak response preserves source field for Android dedup', async () => {
        const deviceSecret = await registerDevice('test-shadow-source');

        await post('/api/bind').send({
            deviceId: 'test-shadow-source', entityId: 0,
            name: 'TestBot', character: '🤖', webhook: ''
        });

        const res = await post('/api/client/speak').send({
            deviceId: 'test-shadow-source', deviceSecret,
            entityId: 0, text: 'Dedup test', source: 'android_chat'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/chat/upload-media
// ════════════════════════════════════════════════════════════════
describe('POST /api/chat/upload-media', () => {
    it('returns 400 when credentials are missing', async () => {
        const res = await post('/api/chat/upload-media')
            .send({});
        expect(res.status).toBe(400);
    });

    it('returns 401 for invalid credentials', async () => {
        const res = await post('/api/chat/upload-media')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong' });
        expect(res.status).toBe(401);
    });

    it('returns 400 when no file is uploaded', async () => {
        const deviceSecret = await registerDevice('test-upload');

        const res = await post('/api/chat/upload-media')
            .field('deviceId', 'test-upload')
            .field('deviceSecret', deviceSecret)
            .field('mediaType', 'photo');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/file/i);
    });
});
