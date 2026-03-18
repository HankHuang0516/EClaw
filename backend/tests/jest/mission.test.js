/**
 * Mission Control endpoint tests (Jest + Supertest)
 *
 * Tests the mission module routes mounted at /api/mission/*.
 * Since mission.js is dependency-injected and uses its own router,
 * we test it by mocking the mission module to install real route handlers.
 */

// We need a different approach for mission — the mission module is mocked as an
// empty router in the standard mock-setup. Instead, we test mission.js directly.

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => {
        const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
        return {
            query: mockQuery,
            connect: jest.fn().mockResolvedValue({
                query: jest.fn().mockResolvedValue({ rows: [] }),
                release: jest.fn(),
            }),
            end: jest.fn().mockResolvedValue(undefined),
        };
    }),
}));

const express = require('express');
const request = require('supertest');

// Create a minimal Express app that hosts the mission router
let missionApp;
let missionModule;

beforeAll(() => {
    missionApp = express();
    missionApp.use(express.json());

    // Provide mock dependencies matching what mission.js expects
    const mockDevices = {
        'test-dev': {
            deviceSecret: 'test-secret',
            entities: {
                0: { isBound: true, botSecret: 'bot-sec', character: 'TestBot', webhook: 'https://example.com/hook' },
                1: { isBound: false, botSecret: null, character: null, webhook: null },
            },
        },
    };
    const mockPool = {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };

    missionModule = require('../../mission')(mockDevices, mockPool, {});
    missionApp.use('/api/mission', missionModule.router);
});

const post = (path) => request(missionApp).post(path);
const get = (path) => request(missionApp).get(path);

// ════════════════════════════════════════════════════════════════
// Authentication — all endpoints require deviceId+deviceSecret
// ════════════════════════════════════════════════════════════════
describe('Mission auth validation', () => {
    it('rejects todo/add without deviceId (400)', async () => {
        const res = await post('/api/mission/todo/add').send({ title: 'test' });
        expect(res.status).toBe(400);
    });

    it('rejects note/add without deviceId (400)', async () => {
        const res = await post('/api/mission/note/add').send({ title: 'test' });
        expect(res.status).toBe(400);
    });

    it('rejects rule/add without deviceId (400)', async () => {
        const res = await post('/api/mission/rule/add').send({ name: 'test' });
        expect(res.status).toBe(400);
    });

    it('rejects soul/add without deviceId (400)', async () => {
        const res = await post('/api/mission/soul/add').send({ name: 'test' });
        expect(res.status).toBe(400);
    });

    it('rejects notify without deviceId (400)', async () => {
        const res = await post('/api/mission/notify').send({ notifications: [] });
        expect(res.status).toBe(400);
    });

    it('rejects dashboard GET without deviceId (400)', async () => {
        const res = await get('/api/mission/dashboard');
        expect(res.status).toBe(400);
    });

    it('rejects with missing credentials (400)', async () => {
        const res = await post('/api/mission/todo/add')
            .send({ deviceId: 'test-dev', title: 'test' });
        expect(res.status).toBe(400);
    });

    it('rejects with wrong deviceSecret (401)', async () => {
        const res = await post('/api/mission/todo/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'wrong', title: 'test' });
        expect(res.status).toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/todo/add — input validation
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/todo/add', () => {
    it('returns 400 when title is missing', async () => {
        const res = await post('/api/mission/todo/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/title/i);
    });

    it('accepts valid todo', async () => {
        const res = await post('/api/mission/todo/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', title: 'Test TODO' });
        // Will either succeed (200) or fail with DB error (500) — not 400
        expect([200, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/note/add — input validation
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/note/add', () => {
    it('returns 400 when title is missing', async () => {
        const res = await post('/api/mission/note/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/title/i);
    });

    it('accepts valid note with content', async () => {
        const res = await post('/api/mission/note/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', title: 'Note', content: 'Body' });
        expect([200, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/rule/add — input validation
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/rule/add', () => {
    it('returns 400 when name is missing', async () => {
        const res = await post('/api/mission/rule/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/name/i);
    });

    it('accepts valid rule', async () => {
        const res = await post('/api/mission/rule/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', name: 'MyRule' });
        expect([200, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/soul/add — input validation
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/soul/add', () => {
    it('returns 400 when name is missing', async () => {
        const res = await post('/api/mission/soul/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/name/i);
    });

    it('accepts valid soul', async () => {
        const res = await post('/api/mission/soul/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', name: 'MySoul' });
        expect([200, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/notify — input validation
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/notify', () => {
    it('returns 400 when notifications array is missing', async () => {
        const res = await post('/api/mission/notify')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/notifications/i);
    });

    it('returns 400 when notifications is empty array', async () => {
        const res = await post('/api/mission/notify')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', notifications: [] });
        expect(res.status).toBe(400);
    });

    it('returns 400 when notifications is not an array', async () => {
        const res = await post('/api/mission/notify')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', notifications: 'bad' });
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/mission/dashboard — dashboard retrieval
// ════════════════════════════════════════════════════════════════
describe('GET /api/mission/dashboard', () => {
    it('returns data for valid device', async () => {
        const res = await get('/api/mission/dashboard?deviceId=test-dev&deviceSecret=test-secret');
        // Either returns dashboard (200) or DB error (500) — not 401
        expect([200, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/todo/update — update validation
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/todo/update', () => {
    it('rejects without credentials (400)', async () => {
        const res = await post('/api/mission/todo/update').send({ id: 1, title: 'x' });
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/todo/done — completion
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/todo/done', () => {
    it('rejects without credentials (400)', async () => {
        const res = await post('/api/mission/todo/done').send({ id: 1 });
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/todo/delete — delete
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/todo/delete', () => {
    it('rejects without credentials (400)', async () => {
        const res = await post('/api/mission/todo/delete').send({ id: 1 });
        expect(res.status).toBe(400);
    });
});
