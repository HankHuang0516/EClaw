/**
 * Link preview endpoint tests (Jest + Supertest)
 *
 * GET /api/link-preview — fetches OG metadata from a URL.
 * Mocks global.fetch to avoid real network calls.
 */

require('./helpers/mock-setup');
const request = require('supertest');

let app;
const get = (path) => request(app).get(path).set('Host', 'localhost');

beforeAll(() => { app = require('../../index'); });
afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

beforeEach(() => {
    global.fetch = jest.fn();
});

describe('GET /api/link-preview', () => {
    // ── Validation ──────────────────────────────────────────

    test('400 when url parameter is missing', async () => {
        const res = await get('/api/link-preview');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/url.*required/i);
    });

    test('400 for invalid URL format', async () => {
        const res = await get('/api/link-preview?url=not-a-url');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid url/i);
    });

    test('400 for non-http/https protocol', async () => {
        const res = await get('/api/link-preview?url=ftp://example.com');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/http/i);
    });

    // ── Successful fetch with OG tags ───────────────────────

    test('200 returns OG metadata for valid HTML page', async () => {
        const html = '<html><head>'
            + '<meta property="og:title" content="Test Title">'
            + '<meta property="og:description" content="Test Description">'
            + '<meta property="og:image" content="https://example.com/img.png">'
            + '</head></html>';

        global.fetch = jest.fn().mockResolvedValue({
            headers: { get: () => 'text/html' },
            body: {
                getReader: () => ({
                    read: jest.fn()
                        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(html) })
                        .mockResolvedValueOnce({ done: true }),
                    cancel: jest.fn(),
                }),
            },
        });

        const res = await get('/api/link-preview?url=https://example.com/page');
        expect(res.status).toBe(200);
        expect(res.body.title).toBe('Test Title');
        expect(res.body.description).toBe('Test Description');
        expect(res.body.image).toBe('https://example.com/img.png');
        expect(res.body.url).toBe('https://example.com/page');
    });

    // ── Non-HTML content type ───────────────────────────────

    test('200 returns empty fields for non-HTML content', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            headers: { get: () => 'application/json' },
            body: { getReader: jest.fn() },
        });

        const res = await get('/api/link-preview?url=https://example.com/api/data');
        expect(res.status).toBe(200);
        expect(res.body.title).toBe('');
        expect(res.body.description).toBe('');
        expect(res.body.image).toBe('');
    });

    // ── Error handling ──────────────────────────────────────

    test('504 on fetch timeout (AbortError)', async () => {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        global.fetch = jest.fn().mockRejectedValue(abortError);

        const res = await get('/api/link-preview?url=https://slow-site.example.com');
        expect(res.status).toBe(504);
        expect(res.body.error).toMatch(/timeout/i);
    });

    test('500 on generic fetch failure', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

        const res = await get('/api/link-preview?url=https://down.example.com');
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/failed/i);
    });
});
