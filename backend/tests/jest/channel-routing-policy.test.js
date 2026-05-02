/**
 * GET /api/channel/routing-policy — single source of truth for the smart-routing
 * system prompt that channel bridges inject into their host LLM (issue #2285).
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

describe('GET /api/channel/routing-policy', () => {
    it('returns generic.en policy by default', async () => {
        const res = await get('/api/channel/routing-policy');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.lang).toBe('en');
        expect(res.body.channel).toBe('generic');
        expect(res.body.policy).toContain('ROUTING (CRITICAL)');
        expect(res.body.policy).toContain('senderHint');
        expect(res.body.version).toBeTruthy();
    });

    it('returns zh-TW policy when lang=zh-TW', async () => {
        const res = await get('/api/channel/routing-policy?lang=zh-TW');
        expect(res.status).toBe(200);
        expect(res.body.lang).toBe('zh-TW');
        expect(res.body.policy).toContain('路由（重要）');
    });

    it('falls back to en when lang is unknown', async () => {
        const res = await get('/api/channel/routing-policy?lang=xx');
        expect(res.status).toBe(200);
        expect(res.body.lang).toBe('en');
    });

    it('does not require auth', async () => {
        const res = await get('/api/channel/routing-policy');
        expect(res.status).toBe(200);
    });

    it('sets Cache-Control for client-side caching', async () => {
        const res = await get('/api/channel/routing-policy');
        expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
    });

    it('sanitises hostile channel parameter', async () => {
        // Disallowed chars → falls back to 'generic'
        const res = await get('/api/channel/routing-policy?channel=../etc/passwd');
        expect(res.status).toBe(200);
        expect(res.body.channel).toBe('generic');
    });

    it('accepts known channel name', async () => {
        // Even if no override file exists yet, server falls back to generic
        // and reports the requested channel name in the response.
        const res = await get('/api/channel/routing-policy?channel=claude-code');
        expect(res.status).toBe(200);
        expect(res.body.channel).toBe('claude-code');
        expect(res.body.policy).toContain('ROUTING'); // generic fallback content
    });
});
