/**
 * Discord Integration endpoint validation tests (Jest + Supertest)
 *
 * Tests:
 *   POST /api/discord/apps       — register Discord app
 *   GET  /api/discord/apps       — list Discord apps
 *   DELETE /api/discord/apps/:id — remove Discord app
 *   POST /api/discord/interactions — interaction webhook (ping, slash commands)
 */

require('./helpers/mock-setup');
const request = require('supertest');

let app;
const post = (path) => request(app).post(path).set('Host', 'localhost');
const get = (path) => request(app).get(path).set('Host', 'localhost');
const del = (path) => request(app).delete(path).set('Host', 'localhost');

beforeAll(() => { app = require('../../index'); });
afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

// ════════════════════════════════════════════════════════════════
// POST /api/discord/apps — register Discord app
// ════════════════════════════════════════════════════════════════
describe('POST /api/discord/apps — input validation', () => {
    it('rejects unauthenticated requests', async () => {
        const res = await post('/api/discord/apps')
            .send({ entityId: 0, applicationId: '123', publicKey: 'a'.repeat(64), botToken: 'token' });
        expect(res.status).toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/discord/apps — list Discord apps
// ════════════════════════════════════════════════════════════════
describe('GET /api/discord/apps — input validation', () => {
    it('rejects unauthenticated requests', async () => {
        const res = await get('/api/discord/apps');
        expect(res.status).toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/discord/apps/:entityId — remove Discord app
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/discord/apps/:entityId — input validation', () => {
    it('rejects unauthenticated requests', async () => {
        const res = await del('/api/discord/apps/0');
        expect(res.status).toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/discord/interactions — Discord webhook
// ════════════════════════════════════════════════════════════════
describe('POST /api/discord/interactions — input validation', () => {
    it('rejects requests without signature headers', async () => {
        const res = await post('/api/discord/interactions')
            .send({ type: 1 });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/signature/i);
    });

    it('rejects requests with unknown application_id', async () => {
        const res = await post('/api/discord/interactions')
            .set('X-Signature-Ed25519', 'a'.repeat(128))
            .set('X-Signature-Timestamp', '1234567890')
            .send({ type: 1, application_id: 'unknown_app' });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/unknown/i);
    });
});
