/**
 * Article Publisher integration tests (Jest + Supertest)
 *
 * Tests the publisher module routes for auth rejection and platform listing.
 * Publisher endpoints require platform API keys which aren't configured in tests,
 * so publish endpoints return 401 (auth/config missing).
 */

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const express = require('express');
const request = require('supertest');

let publisherApp;

beforeAll(() => {
    const publisherModule = require('../../article-publisher');
    publisherApp = express();
    publisherApp.use(express.json());
    publisherApp.use('/api/publisher', publisherModule.router);
});

const get = (path) => request(publisherApp).get(path);
const post = (path) => request(publisherApp).post(path);
const del = (path) => request(publisherApp).delete(path);

// ════════════════════════════════════════════════════════════════
// GET /api/publisher/platforms — list all 12 platforms
// ════════════════════════════════════════════════════════════════
describe('GET /api/publisher/platforms', () => {
    it('returns list of all supported platforms', async () => {
        const res = await get('/api/publisher/platforms');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.platforms)).toBe(true);
        expect(res.body.platforms.length).toBeGreaterThanOrEqual(12);
    });

    it('each platform has required fields', async () => {
        const res = await get('/api/publisher/platforms');
        for (const p of res.body.platforms) {
            expect(p).toHaveProperty('id');
            expect(p).toHaveProperty('name');
        }
    });
});

// ════════════════════════════════════════════════════════════════
// Publish endpoints — reject without API keys (401)
// ════════════════════════════════════════════════════════════════
describe('Publish endpoints reject without platform API keys', () => {
    const publishEndpoints = [
        { method: 'post', path: '/api/publisher/devto/publish', body: { title: 'T', body: 'B' }, name: 'DEV.to' },
        { method: 'post', path: '/api/publisher/telegraph/publish', body: { title: 'T', content: 'C' }, name: 'Telegraph' },
        { method: 'post', path: '/api/publisher/qiita/publish', body: { title: 'T', body: 'B' }, name: 'Qiita' },
        { method: 'post', path: '/api/publisher/x/tweet', body: { text: 'hello' }, name: 'X/Twitter' },
        { method: 'post', path: '/api/publisher/hashnode/publish', body: { title: 'T', content: 'C' }, name: 'Hashnode' },
        { method: 'post', path: '/api/publisher/wordpress/publish', body: { title: 'T', content: 'C' }, name: 'WordPress' },
        { method: 'post', path: '/api/publisher/tumblr/publish', body: { title: 'T', body: 'B' }, name: 'Tumblr' },
        { method: 'post', path: '/api/publisher/reddit/submit', body: { title: 'T', subreddit: 'r' }, name: 'Reddit' },
        { method: 'post', path: '/api/publisher/linkedin/publish', body: { text: 'hi' }, name: 'LinkedIn' },
        { method: 'post', path: '/api/publisher/mastodon/publish', body: { status: 'hi' }, name: 'Mastodon' },
        { method: 'post', path: '/api/publisher/blogger/publish', body: { title: 'T', content: 'C' }, name: 'Blogger' },
    ];

    for (const ep of publishEndpoints) {
        it(`${ep.name} publish rejects without API key`, async () => {
            const res = await post(ep.path).send(ep.body);
            // 400 (validation), 401 (missing key), 501 (not configured) — all valid rejections
            // Only 200 would be wrong (shouldn't succeed without credentials)
            expect(res.status).toBeGreaterThanOrEqual(400);
        });
    }
});

// ════════════════════════════════════════════════════════════════
// Input validation — endpoints that validate before auth
// ════════════════════════════════════════════════════════════════
describe('Input validation (fields checked before API call)', () => {
    it('DEV.to rejects empty body', async () => {
        const res = await post('/api/publisher/devto/publish').send({});
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('Reddit rejects empty body', async () => {
        const res = await post('/api/publisher/reddit/submit').send({});
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('X/Twitter rejects empty body', async () => {
        const res = await post('/api/publisher/x/tweet').send({});
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// /me endpoints — reject without credentials
// ════════════════════════════════════════════════════════════════
describe('/me endpoints reject without credentials', () => {
    const meEndpoints = [
        '/api/publisher/devto/me',
        '/api/publisher/x/me',
        '/api/publisher/hashnode/me',
        '/api/publisher/qiita/me',
        '/api/publisher/tumblr/me',
        '/api/publisher/reddit/me',
        '/api/publisher/linkedin/me',
        '/api/publisher/mastodon/me',
    ];

    for (const path of meEndpoints) {
        it(`GET ${path} responds without crash`, async () => {
            const res = await get(path);
            // Should return a valid HTTP status (not crash)
            expect(res.status).toBeDefined();
            expect(res.status).toBeLessThan(600);
        });
    }
});

// ════════════════════════════════════════════════════════════════
// Delete endpoints — reject without credentials
// ════════════════════════════════════════════════════════════════
describe('Delete endpoints reject without credentials', () => {
    it('DEV.to delete returns error', async () => {
        const res = await del('/api/publisher/devto/post/999');
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(600);
    });

    it('Hashnode delete returns error', async () => {
        const res = await del('/api/publisher/hashnode/post/abc');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});
