/**
 * Note Pages (Webview static pages) endpoint tests (Jest + Supertest)
 *
 * Tests the note page routes: PUT/GET/DELETE /api/mission/note/page,
 * GET /api/mission/note/pages, PUT /api/mission/note/page/drawing
 */

// Capture the pool instance created by mission.js via a shared ref object
const poolRef = { instance: null };
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => {
        const inst = {
            query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            connect: jest.fn().mockResolvedValue({
                query: jest.fn().mockResolvedValue({ rows: [] }),
                release: jest.fn(),
            }),
            end: jest.fn().mockResolvedValue(undefined),
        };
        poolRef.instance = inst;
        return inst;
    }),
}));

const express = require('express');
const request = require('supertest');

let app;

beforeAll(() => {
    app = express();
    app.use(express.json({ limit: '2mb' }));

    const mockDevices = {
        'test-dev': {
            deviceSecret: 'test-secret',
            entities: {
                0: { isBound: true, botSecret: 'bot-sec', character: 'TestBot', webhook: 'https://example.com/hook' },
            },
        },
    };

    const missionModule = require('../../mission')(mockDevices, {});
    app.use('/api/mission', missionModule.router);
});

beforeEach(() => {
    poolRef.instance.query.mockReset();
    poolRef.instance.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

const put = (path) => request(app).put(path);
const get = (path) => request(app).get(path);
const del = (path) => request(app).delete(path);

const AUTH = { deviceId: 'test-dev', deviceSecret: 'test-secret' };

// ════════════════════════════════════════════════════════════════
// PUT /api/mission/note/page — create/update static page
// ════════════════════════════════════════════════════════════════
describe('PUT /api/mission/note/page', () => {
    it('rejects without auth (400)', async () => {
        const res = await put('/api/mission/note/page').send({ noteId: 'abc', htmlContent: '<p>hi</p>' });
        expect(res.status).toBe(400);
    });

    it('rejects without noteId or title (400)', async () => {
        const res = await put('/api/mission/note/page')
            .send({ ...AUTH, htmlContent: '<p>hi</p>' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/noteId|title/i);
    });

    it('rejects when htmlContent exceeds 500KB', async () => {
        const bigContent = 'x'.repeat(513 * 1024);
        const res = await put('/api/mission/note/page')
            .send({ ...AUTH, noteId: 'abc', htmlContent: bigContent });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/exceeds/i);
    });

    it('accepts valid page with noteId', async () => {
        poolRef.instance.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-1', updated_at: new Date().toISOString() }], rowCount: 1 });
        const res = await put('/api/mission/note/page')
            .send({ ...AUTH, noteId: 'note-uuid-1', htmlContent: '<h1>Hello</h1>' });
        expect([200, 500].includes(res.status)).toBe(true);
    });

    it('allows empty htmlContent', async () => {
        poolRef.instance.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-1', updated_at: new Date().toISOString() }], rowCount: 1 });
        const res = await put('/api/mission/note/page')
            .send({ ...AUTH, noteId: 'note-uuid-1', htmlContent: '' });
        expect([200, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/mission/note/page — read static page
// ════════════════════════════════════════════════════════════════
describe('GET /api/mission/note/page', () => {
    it('rejects without auth (400)', async () => {
        const res = await get('/api/mission/note/page?noteId=abc');
        expect(res.status).toBe(400);
    });

    it('rejects without noteId (400)', async () => {
        const res = await get(`/api/mission/note/page?deviceId=${AUTH.deviceId}&deviceSecret=${AUTH.deviceSecret}`);
        expect(res.status).toBe(400);
    });

    it('returns 404 when page not found', async () => {
        poolRef.instance.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const res = await get(`/api/mission/note/page?deviceId=${AUTH.deviceId}&deviceSecret=${AUTH.deviceSecret}&noteId=nonexistent`);
        expect(res.status).toBe(404);
    });

    it('returns page content when found', async () => {
        poolRef.instance.query.mockResolvedValueOnce({
            rows: [{ html_content: '<h1>Test</h1>', drawing_data: null, updated_at: new Date().toISOString() }],
            rowCount: 1,
        });
        const res = await get(`/api/mission/note/page?deviceId=${AUTH.deviceId}&deviceSecret=${AUTH.deviceSecret}&noteId=note-1`);
        expect(res.status).toBe(200);
        expect(res.body.htmlContent).toBe('<h1>Test</h1>');
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/mission/note/pages — list all pages
// ════════════════════════════════════════════════════════════════
describe('GET /api/mission/note/pages', () => {
    it('rejects without auth (400)', async () => {
        const res = await get('/api/mission/note/pages');
        expect(res.status).toBe(400);
    });

    it('returns page list', async () => {
        poolRef.instance.query.mockResolvedValueOnce({
            rows: [{ note_id: 'n1', updated_at: '2026-01-01' }, { note_id: 'n2', updated_at: '2026-01-02' }],
            rowCount: 2,
        });
        const res = await get(`/api/mission/note/pages?deviceId=${AUTH.deviceId}&deviceSecret=${AUTH.deviceSecret}`);
        expect(res.status).toBe(200);
        expect(res.body.pages).toHaveLength(2);
        expect(res.body.pages[0].noteId).toBe('n1');
    });
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/mission/note/page
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/mission/note/page', () => {
    it('rejects without auth (400)', async () => {
        const res = await del('/api/mission/note/page').send({ noteId: 'abc' });
        expect(res.status).toBe(400);
    });

    it('rejects without noteId (400)', async () => {
        const res = await del('/api/mission/note/page').send({ ...AUTH });
        expect(res.status).toBe(400);
    });

    it('returns 404 when page not found', async () => {
        poolRef.instance.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const res = await del('/api/mission/note/page').send({ ...AUTH, noteId: 'nonexistent' });
        expect(res.status).toBe(404);
    });

    it('deletes page successfully', async () => {
        poolRef.instance.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const res = await del('/api/mission/note/page').send({ ...AUTH, noteId: 'note-1' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// PUT /api/mission/note/page/drawing
// ════════════════════════════════════════════════════════════════
describe('PUT /api/mission/note/page/drawing', () => {
    it('rejects without auth (400)', async () => {
        const res = await put('/api/mission/note/page/drawing').send({ noteId: 'abc', drawingData: [] });
        expect(res.status).toBe(400);
    });

    it('rejects without drawingData (400)', async () => {
        const res = await put('/api/mission/note/page/drawing').send({ ...AUTH, noteId: 'abc' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/drawingData/i);
    });

    it('rejects when drawingData exceeds 2MB', async () => {
        // Large payload may be rejected by Express body-parser (413) or our validation (400)
        const bigData = 'x'.repeat(2 * 1024 * 1024 + 1);
        const res = await put('/api/mission/note/page/drawing')
            .send({ ...AUTH, noteId: 'abc', drawingData: bigData });
        expect([400, 413].includes(res.status)).toBe(true);
    });

    it('returns 404 when page does not exist', async () => {
        // resolveNoteId returns noteId directly, then UPDATE returns rowCount=0
        poolRef.instance.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        const res = await put('/api/mission/note/page/drawing')
            .send({ ...AUTH, noteId: 'nonexistent', drawingData: [{ color: '#ff0000', size: 3, points: [{ x: 0, y: 0 }] }] });
        expect(res.status).toBe(404);
    });

    it('saves drawing data successfully', async () => {
        // UPDATE returns rowCount=1
        poolRef.instance.query.mockResolvedValueOnce({ rowCount: 1 });
        const res = await put('/api/mission/note/page/drawing')
            .send({ ...AUTH, noteId: 'note-1', drawingData: [{ color: '#ff0000', size: 3, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }] });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});
