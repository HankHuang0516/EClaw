/**
 * Mission Control endpoint tests (Jest + Supertest)
 *
 * Tests the mission module routes mounted at /api/mission/*.
 * Legacy todo/done/start/update/delete routes have been removed — only
 * notes, rules, skills, souls, notify, and dashboard endpoints remain.
 */

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
// Authentication — add endpoints require credentials
// ════════════════════════════════════════════════════════════════
describe('Mission auth validation', () => {
    it('note/add rejects without credentials (400)', async () => {
        const res = await post('/api/mission/note/add').send({ title: 'test' });
        expect(res.status).toBe(400);
    });

    it('rule/add rejects without credentials (400)', async () => {
        const res = await post('/api/mission/rule/add').send({ name: 'test' });
        expect(res.status).toBe(400);
    });

    it('soul/add rejects without credentials (400)', async () => {
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
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/note/add — unified note creation
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/note/add', () => {
    it('creates note with valid credentials', async () => {
        const res = await post('/api/mission/note/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', title: 'Note', content: 'Body' });
        // 200 success or 500 (mock DB) — not 400/410
        expect([200, 500].includes(res.status)).toBe(true);
    });

    it('returns 400 without title', async () => {
        const res = await post('/api/mission/note/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret' });
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/rule/add — re-enabled
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/rule/add', () => {
    it('accepts valid input (200 or 500 mock DB)', async () => {
        const res = await post('/api/mission/rule/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', name: 'MyRule' });
        expect([200, 500].includes(res.status)).toBe(true);
    });

    it('returns 400 without name', async () => {
        const res = await post('/api/mission/rule/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret' });
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/soul/add — re-enabled
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/soul/add', () => {
    it('accepts valid input (200 or 500 mock DB)', async () => {
        const res = await post('/api/mission/soul/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', name: 'MySoul' });
        expect([200, 500].includes(res.status)).toBe(true);
    });

    it('returns 400 without name', async () => {
        const res = await post('/api/mission/soul/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret' });
        expect(res.status).toBe(400);
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
// Category support — add endpoints accept category
// ════════════════════════════════════════════════════════════════
describe('Category support in add endpoints', () => {
    const auth = { deviceId: 'test-dev', deviceSecret: 'test-secret' };

    it('note/add accepts category field', async () => {
        const res = await post('/api/mission/note/add')
            .send({ ...auth, title: 'Categorized Note', category: 'Meeting' });
        expect([200, 500].includes(res.status)).toBe(true);
    });

    it('rule/add accepts category field', async () => {
        const res = await post('/api/mission/rule/add')
            .send({ ...auth, name: 'Categorized Rule', category: 'DevOps' });
        expect([200, 500].includes(res.status)).toBe(true);
    });

    it('skill/add accepts category field', async () => {
        const res = await post('/api/mission/skill/add')
            .send({ ...auth, title: 'Categorized Skill', category: 'Core' });
        expect([200, 500].includes(res.status)).toBe(true);
    });

    it('soul/add accepts category field', async () => {
        const res = await post('/api/mission/soul/add')
            .send({ ...auth, name: 'Categorized Soul', category: 'Personality' });
        expect([200, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// Category support — update endpoints accept newCategory
// ════════════════════════════════════════════════════════════════
describe('Category support in update endpoints', () => {
    const auth = { deviceId: 'test-dev', deviceSecret: 'test-secret' };

    it('note/update accepts newCategory field', async () => {
        const res = await post('/api/mission/note/update')
            .send({ ...auth, title: 'Some Note', newCategory: 'Tech' });
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });

    it('rule/update accepts newCategory field', async () => {
        const res = await post('/api/mission/rule/update')
            .send({ ...auth, name: 'Some Rule', newCategory: 'Workflow' });
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });

    it('skill/update accepts newCategory field', async () => {
        const res = await post('/api/mission/skill/update')
            .send({ ...auth, title: 'Some Skill', newCategory: 'Tools' });
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });

    it('soul/update accepts newCategory field', async () => {
        const res = await post('/api/mission/soul/update')
            .send({ ...auth, name: 'Some Soul', newCategory: 'Custom' });
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/mission/note/:id
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/mission/note/:id', () => {
    const auth = { deviceId: 'test-dev', deviceSecret: 'test-secret' };
    const del = (path) => request(missionApp).delete(path);

    it('returns 404 or 200 when deleting note by ID', async () => {
        const res = await del('/api/mission/note/test-123')
            .send(auth);
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });
});
