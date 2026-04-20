/**
 * Regression: chat quote (reply) + photo attachment conflict
 *
 * Bug 1: reply context + photo-only (no text) → quote silently dropped
 * Bug 3: cross-device contacts cannot send photos via /api/client/cross-speak
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');

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
// client/speak accepts mediaType + mediaUrl alongside text (quote caption)
// ════════════════════════════════════════════════════════════════
describe('client/speak with media + quote text', () => {
    it('accepts photo with quote-prefix text (no user body text)', async () => {
        const deviceSecret = await registerDevice('test-quote-photo-1');
        await post('/api/bind').send({
            deviceId: 'test-quote-photo-1', entityId: 0,
            name: 'QuoteBot', character: '📎', webhook: ''
        });

        const quotePrefix = '↩ 📌 Kanban: Task title';
        const res = await post('/api/client/speak').send({
            deviceId: 'test-quote-photo-1',
            deviceSecret,
            entityId: 0,
            text: quotePrefix,
            source: 'web_chat',
            mediaType: 'photo',
            mediaUrl: 'https://example.com/photo.jpg'
        });

        expect([200, 201].includes(res.status)).toBe(true);
        if (res.body.success !== undefined) {
            expect(res.body.success).toBe(true);
        }
    });

    it('accepts photo with empty text (fallback label)', async () => {
        const deviceSecret = await registerDevice('test-quote-photo-2');
        await post('/api/bind').send({
            deviceId: 'test-quote-photo-2', entityId: 0,
            name: 'PhotoBot', character: '📷', webhook: ''
        });

        const res = await post('/api/client/speak').send({
            deviceId: 'test-quote-photo-2',
            deviceSecret,
            entityId: 0,
            text: '[Photo]',
            source: 'web_chat',
            mediaType: 'photo',
            mediaUrl: 'https://example.com/img.png'
        });

        expect([200, 201].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// client/cross-speak accepts mediaType + mediaUrl
// ════════════════════════════════════════════════════════════════
describe('client/cross-speak with media', () => {
    it('accepts mediaType and mediaUrl fields (owner mode)', async () => {
        await registerDevice('test-cross-media-1');

        const res = await post('/api/client/cross-speak').send({
            deviceId: 'test-cross-media-1',
            fromEntityId: -1,
            targetCode: 'NONEXIST',
            text: '↩ 📌 Note: summary',
            source: 'web_chat',
            mediaType: 'photo',
            mediaUrl: 'https://example.com/cross-photo.jpg'
        });

        // 404 = target not found (expected); NOT 400 (field rejection)
        expect(res.status).toBe(404);
    });

    it('sends text-only cross-speak without media fields (owner mode)', async () => {
        await registerDevice('test-cross-media-2');

        const res = await post('/api/client/cross-speak').send({
            deviceId: 'test-cross-media-2',
            fromEntityId: -1,
            targetCode: 'NONEXIST',
            text: 'Hello cross device',
            source: 'web_chat'
        });

        expect(res.status).toBe(404);
    });
});
