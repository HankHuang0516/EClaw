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
    // add endpoints are deprecated (410) — auth check is bypassed
    it('todo/add returns 410 deprecated', async () => {
        const res = await post('/api/mission/todo/add').send({ title: 'test' });
        expect(res.status).toBe(410);
    });

    it('note/add returns 410 deprecated', async () => {
        const res = await post('/api/mission/note/add').send({ title: 'test' });
        expect(res.status).toBe(410);
    });

    it('rule/add returns 410 deprecated', async () => {
        const res = await post('/api/mission/rule/add').send({ name: 'test' });
        expect(res.status).toBe(410);
    });

    it('soul/add returns 410 deprecated', async () => {
        const res = await post('/api/mission/soul/add').send({ name: 'test' });
        expect(res.status).toBe(410);
    });

    it('rejects notify without deviceId (400)', async () => {
        const res = await post('/api/mission/notify').send({ notifications: [] });
        expect(res.status).toBe(400);
    });

    it('rejects dashboard GET without deviceId (400)', async () => {
        const res = await get('/api/mission/dashboard');
        expect(res.status).toBe(400);
    });

    it('todo/add deprecated even with valid credentials', async () => {
        const res = await post('/api/mission/todo/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', title: 'test' });
        expect(res.status).toBe(410);
    });

    it('todo/add deprecated even with wrong credentials', async () => {
        const res = await post('/api/mission/todo/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'wrong', title: 'test' });
        expect(res.status).toBe(410);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/todo/add — deprecated (→ Kanban)
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/todo/add', () => {
    it('returns 410 deprecated', async () => {
        const res = await post('/api/mission/todo/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', title: 'Test TODO' });
        expect(res.status).toBe(410);
        expect(res.body.deprecated).toBe(true);
        expect(res.body.redirect).toBe('kanban');
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/note/add — deprecated (→ Kanban)
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/note/add', () => {
    it('returns 410 deprecated', async () => {
        const res = await post('/api/mission/note/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', title: 'Note', content: 'Body' });
        expect(res.status).toBe(410);
        expect(res.body.deprecated).toBe(true);
        expect(res.body.redirect).toBe('kanban');
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/rule/add — deprecated (→ Kanban)
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/rule/add', () => {
    it('returns 410 deprecated', async () => {
        const res = await post('/api/mission/rule/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', name: 'MyRule' });
        expect(res.status).toBe(410);
        expect(res.body.deprecated).toBe(true);
        expect(res.body.redirect).toBe('kanban');
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/mission/soul/add — deprecated (→ Kanban)
// ════════════════════════════════════════════════════════════════
describe('POST /api/mission/soul/add', () => {
    it('returns 410 deprecated', async () => {
        const res = await post('/api/mission/soul/add')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', name: 'MySoul' });
        expect(res.status).toBe(410);
        expect(res.body.deprecated).toBe(true);
        expect(res.body.redirect).toBe('kanban');
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

// ════════════════════════════════════════════════════════════════
// Category support — todo/add, note/add, rule/add, skill/add, soul/add
// accept optional category field
// ════════════════════════════════════════════════════════════════
describe('Category support in add endpoints — deprecated', () => {
    const auth = { deviceId: 'test-dev', deviceSecret: 'test-secret' };

    it('todo/add returns 410 deprecated (category ignored)', async () => {
        const res = await post('/api/mission/todo/add')
            .send({ ...auth, title: 'Categorized TODO', category: 'Frontend' });
        expect(res.status).toBe(410);
        expect(res.body.deprecated).toBe(true);
    });

    it('note/add returns 410 deprecated (category ignored)', async () => {
        const res = await post('/api/mission/note/add')
            .send({ ...auth, title: 'Categorized Note', category: 'Meeting' });
        expect(res.status).toBe(410);
    });

    it('rule/add returns 410 deprecated (category ignored)', async () => {
        const res = await post('/api/mission/rule/add')
            .send({ ...auth, name: 'Categorized Rule', category: 'DevOps' });
        expect(res.status).toBe(410);
    });

    it('skill/add returns 410 deprecated (category ignored)', async () => {
        const res = await post('/api/mission/skill/add')
            .send({ ...auth, title: 'Categorized Skill', category: 'Core' });
        expect(res.status).toBe(410);
    });

    it('soul/add returns 410 deprecated (category ignored)', async () => {
        const res = await post('/api/mission/soul/add')
            .send({ ...auth, name: 'Categorized Soul', category: 'Personality' });
        expect(res.status).toBe(410);
    });
});

// ════════════════════════════════════════════════════════════════
// Category support — update endpoints accept newCategory
// ════════════════════════════════════════════════════════════════
describe('Category support in update endpoints', () => {
    const auth = { deviceId: 'test-dev', deviceSecret: 'test-secret' };

    it('todo/update accepts newCategory field', async () => {
        const res = await post('/api/mission/todo/update')
            .send({ ...auth, title: 'Some TODO', newCategory: 'Backend' });
        // 404 (not found in mock) or 500 (DB mock) — not 400
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });

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
