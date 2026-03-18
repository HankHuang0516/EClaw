/**
 * AI Support extended tests (Jest + Supertest)
 *
 * Tests happy-path patterns: POST /api/ai-support/chat/submit,
 * GET /api/ai-support/chat/poll/:requestId, session management
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
// POST /api/ai-support/chat/submit — validation
// ════════════════════════════════════════════════════════════════
describe('POST /api/ai-support/chat/submit', () => {
    it('returns 401 without any authentication', async () => {
        const res = await post('/api/ai-support/chat/submit')
            .send({ requestId: '550e8400-e29b-41d4-a716-446655440000', message: 'hello' });
        expect(res.status).toBe(401);
    });

    it('returns 401 with invalid device credentials', async () => {
        const res = await post('/api/ai-support/chat/submit')
            .send({
                deviceId: 'nonexistent',
                deviceSecret: 'wrong',
                requestId: '550e8400-e29b-41d4-a716-446655440000',
                message: 'hello',
            });
        expect(res.status).toBe(401);
    });

    it('returns 400 when requestId is not a valid UUID', async () => {
        const deviceSecret = await registerDevice('test-ai-submit');

        const res = await post('/api/ai-support/chat/submit')
            .send({
                deviceId: 'test-ai-submit',
                deviceSecret,
                requestId: 'not-a-uuid',
                message: 'hello',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/requestId|UUID/i);
    });

    it('returns 400 when message is missing', async () => {
        const deviceSecret = await registerDevice('test-ai-submit-msg');

        const res = await post('/api/ai-support/chat/submit')
            .send({
                deviceId: 'test-ai-submit-msg',
                deviceSecret,
                requestId: '550e8400-e29b-41d4-a716-446655440000',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/message/i);
    });

    it('returns 400 when message is empty string', async () => {
        const deviceSecret = await registerDevice('test-ai-submit-empty');

        const res = await post('/api/ai-support/chat/submit')
            .send({
                deviceId: 'test-ai-submit-empty',
                deviceSecret,
                requestId: '550e8400-e29b-41d4-a716-446655440001',
                message: '   ',
            });
        expect(res.status).toBe(400);
    });

    it('accepts valid submit request (may fail at DB)', async () => {
        const deviceSecret = await registerDevice('test-ai-submit-ok');

        const res = await post('/api/ai-support/chat/submit')
            .send({
                deviceId: 'test-ai-submit-ok',
                deviceSecret,
                requestId: '550e8400-e29b-41d4-a716-446655440002',
                message: 'How do I bind a bot?',
            });
        // 200 (accepted) or 500 (DB mock) — not 400/401
        expect([200, 201, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/ai-support/chat/poll/:requestId — polling
// ════════════════════════════════════════════════════════════════
describe('GET /api/ai-support/chat/poll/:requestId', () => {
    it('returns 401 without authentication', async () => {
        const res = await get('/api/ai-support/chat/poll/550e8400-e29b-41d4-a716-446655440000');
        expect(res.status).toBe(401);
    });

    it('returns 401 with invalid credentials', async () => {
        const res = await get('/api/ai-support/chat/poll/550e8400-e29b-41d4-a716-446655440000?deviceId=bad&deviceSecret=wrong');
        expect(res.status).toBe(401);
    });

    it('returns 404 for nonexistent request', async () => {
        const deviceSecret = await registerDevice('test-ai-poll');

        const res = await get(
            `/api/ai-support/chat/poll/550e8400-e29b-41d4-a716-446655440099?deviceId=test-ai-poll&deviceSecret=${deviceSecret}`
        );
        // DB mock returns empty rows → 404
        expect(res.status).toBe(404);
    });
});
