/**
 * Mission Control endpoint tests (Jest + Supertest)
 *
 * Tests the mission module routes mounted at /api/mission/*.
 * Legacy todo/done/start/update/delete routes have been removed — only
 * notes, rules, skills, souls, notify, and dashboard endpoints remain.
 */

// Exposed so deeper tests can seed SELECT/UPDATE responses per-case.
// Keep the `mock` prefix — Jest allows only mock* identifiers in jest.mock factories.
const mockClientQuery = jest.fn().mockResolvedValue({ rows: [] });
const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockPoolQuery,
        connect: jest.fn().mockImplementation(() => Promise.resolve({
            query: mockClientQuery,
            release: jest.fn(),
        })),
        end: jest.fn().mockResolvedValue(undefined),
    })),
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

    it('note/update accepts content as alias for newContent (docs-bot compat)', async () => {
        const res = await post('/api/mission/note/update')
            .send({ ...auth, title: 'Some Note', content: 'Aliased body' });
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });

    it('note/update accepts category as alias for newCategory', async () => {
        const res = await post('/api/mission/note/update')
            .send({ ...auth, title: 'Some Note', category: 'Aliased' });
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });

    it('note/update handles content:null without throwing', async () => {
        const res = await post('/api/mission/note/update')
            .send({ ...auth, title: 'Some Note', content: null });
        // Must not throw TypeError on null.trim → 500 from undefined handler is the bug we're fixing
        expect([200, 404, 500].includes(res.status)).toBe(true);
        if (res.status === 500) expect(res.body.error || '').not.toMatch(/trim/i);
    });

    it('rule/update accepts description as alias for newDescription', async () => {
        const res = await post('/api/mission/rule/update')
            .send({ ...auth, name: 'Some Rule', description: 'Aliased body' });
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });

    it('rule/update accepts category as alias for newCategory', async () => {
        const res = await post('/api/mission/rule/update')
            .send({ ...auth, name: 'Some Rule', category: 'Aliased' });
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });

    it('rule/update handles description:null without throwing', async () => {
        const res = await post('/api/mission/rule/update')
            .send({ ...auth, name: 'Some Rule', description: null });
        expect([200, 404, 500].includes(res.status)).toBe(true);
        if (res.status === 500) expect(res.body.error || '').not.toMatch(/trim/i);
    });

    it('skill/update accepts url as alias for newUrl', async () => {
        const res = await post('/api/mission/skill/update')
            .send({ ...auth, title: 'Some Skill', url: 'https://aliased.example/x' });
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });

    it('skill/update accepts category as alias for newCategory', async () => {
        const res = await post('/api/mission/skill/update')
            .send({ ...auth, title: 'Some Skill', category: 'Aliased' });
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });

    it('soul/update accepts description as alias for newDescription', async () => {
        const res = await post('/api/mission/soul/update')
            .send({ ...auth, name: 'Some Soul', description: 'Aliased body' });
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });

    it('soul/update accepts category as alias for newCategory', async () => {
        const res = await post('/api/mission/soul/update')
            .send({ ...auth, name: 'Some Soul', category: 'Aliased' });
        expect([200, 404, 500].includes(res.status)).toBe(true);
    });

    it('soul/update handles description:null without throwing', async () => {
        const res = await post('/api/mission/soul/update')
            .send({ ...auth, name: 'Some Soul', description: null });
        expect([200, 404, 500].includes(res.status)).toBe(true);
        if (res.status === 500) expect(res.body.error || '').not.toMatch(/trim/i);
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
// Deep persistence — reach the write branch, assert persisted value
// (PR #1889 reviewer follow-up: shallow [200,404,500] tests never
// execute the trim/alias code because mock returns empty rows → 404)
// ════════════════════════════════════════════════════════════════
describe('Deep persistence assertions in update endpoints', () => {
    const auth = { deviceId: 'test-dev', deviceSecret: 'test-secret' };
    let capturedWrites;
    let dashboardRow;

    beforeEach(() => {
        capturedWrites = [];
        dashboardRow = { notes: [], rules: [], skills: [], souls: [] };

        const queryImpl = async (sql, params) => {
            const s = typeof sql === 'string' ? sql.trim() : '';
            if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [] };
            if (/FROM kanban_cards/i.test(s)) {
                const wanted = Array.isArray(params && params[1]) ? new Set(params[1]) : new Set();
                const rows = ['card_a', 'card_b'].filter(id => wanted.has(id)).map(id => ({ id }));
                return { rows };
            }
            if (/^(DELETE|INSERT)/i.test(s)) return { rows: [], rowCount: 1 };
            if (/^SELECT/i.test(s)) return { rows: [dashboardRow] };
            if (/^UPDATE/i.test(s)) {
                capturedWrites.push({ sql: s, params });
                return { rows: [{ version: 42 }] };
            }
            return { rows: [] };
        };
        mockClientQuery.mockImplementation(queryImpl);
        mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    });

    afterEach(() => {
        mockClientQuery.mockReset();
        mockClientQuery.mockResolvedValue({ rows: [] });
        mockPoolQuery.mockReset();
        mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    });

    const writeFor = (column) => capturedWrites.find(w => w.sql.includes(`SET ${column}`));
    const persisted = (column) => JSON.parse(writeFor(column).params[1]);

    it('note/update — content alias reaches write branch and persists value', async () => {
        dashboardRow.notes = [{ title: 'N1', content: 'old-body', category: 'orig' }];
        const res = await post('/api/mission/note/update')
            .send({ ...auth, title: 'N1', content: 'aliased-body' });
        expect(res.status).toBe(200);
        const rows = persisted('notes');
        expect(rows[0].content).toBe('aliased-body');
        expect(rows[0].category).toBe('orig');
    });

    it('note/update — content:null persists as empty string (no TypeError)', async () => {
        dashboardRow.notes = [{ title: 'N1', content: 'old-body' }];
        const res = await post('/api/mission/note/update')
            .send({ ...auth, title: 'N1', content: null });
        expect(res.status).toBe(200);
        expect(persisted('notes')[0].content).toBe('');
    });

    it('note/update — category:null persists as null (not string)', async () => {
        dashboardRow.notes = [{ title: 'N1', category: 'X' }];
        const res = await post('/api/mission/note/update')
            .send({ ...auth, title: 'N1', category: null });
        expect(res.status).toBe(200);
        expect(persisted('notes')[0].category).toBeNull();
    });

    it('rule/update — description alias reaches write branch', async () => {
        dashboardRow.rules = [{ name: 'R1', description: 'old' }];
        const res = await post('/api/mission/rule/update')
            .send({ ...auth, name: 'R1', description: 'aliased-desc' });
        expect(res.status).toBe(200);
        expect(persisted('rules')[0].description).toBe('aliased-desc');
    });

    it('rule/update — description:null persists as empty string', async () => {
        dashboardRow.rules = [{ name: 'R1', description: 'old' }];
        const res = await post('/api/mission/rule/update')
            .send({ ...auth, name: 'R1', description: null });
        expect(res.status).toBe(200);
        expect(persisted('rules')[0].description).toBe('');
    });

    it('skill/update — url alias reaches write branch', async () => {
        dashboardRow.skills = [{ title: 'S1', url: 'https://old.example' }];
        const res = await post('/api/mission/skill/update')
            .send({ ...auth, title: 'S1', url: 'https://new.example' });
        expect(res.status).toBe(200);
        expect(persisted('skills')[0].url).toBe('https://new.example');
    });

    it('soul/update — description alias reaches write branch', async () => {
        dashboardRow.souls = [{ name: 'SL1', description: 'old' }];
        const res = await post('/api/mission/soul/update')
            .send({ ...auth, name: 'SL1', description: 'aliased-desc' });
        expect(res.status).toBe(200);
        expect(persisted('souls')[0].description).toBe('aliased-desc');
    });

    it('soul/update — description:null persists as empty string', async () => {
        dashboardRow.souls = [{ name: 'SL1', description: 'old' }];
        const res = await post('/api/mission/soul/update')
            .send({ ...auth, name: 'SL1', description: null });
        expect(res.status).toBe(200);
        expect(persisted('souls')[0].description).toBe('');
    });

    // ── Phase 4: anchor field round-trip on update ──

    it('note/update — valid kanban_card anchor persists on the note JSON', async () => {
        dashboardRow.notes = [{ title: 'N1', content: 'body' }];
        const res = await post('/api/mission/note/update')
            .send({ ...auth, title: 'N1', anchor: { type: 'kanban_card', refId: 'card_abc', label: 'big card' } });
        expect(res.status).toBe(200);
        expect(persisted('notes')[0].anchor).toEqual({ type: 'kanban_card', refId: 'card_abc', label: 'big card' });
    });

    it('note/update — anchor:null clears the anchor', async () => {
        dashboardRow.notes = [{ title: 'N1', anchor: { type: 'kanban_card', refId: 'card_x', label: null } }];
        const res = await post('/api/mission/note/update')
            .send({ ...auth, title: 'N1', anchor: null });
        expect(res.status).toBe(200);
        expect(persisted('notes')[0].anchor).toBeUndefined();
    });

    it('note/update — malformed anchor (bad type / missing refId) is dropped, not persisted', async () => {
        dashboardRow.notes = [{ title: 'N1' }];
        const res = await post('/api/mission/note/update')
            .send({ ...auth, title: 'N1', anchor: { type: 'note', refId: 'x' } });
        expect(res.status).toBe(200);
        expect(persisted('notes')[0].anchor).toBeUndefined();
    });

    it('note/update — omitting anchor leaves an existing anchor intact', async () => {
        const original = { type: 'chat_message', refId: 'msg_1', label: null };
        dashboardRow.notes = [{ title: 'N1', anchor: original }];
        const res = await post('/api/mission/note/update')
            .send({ ...auth, title: 'N1', content: 'just a body change' });
        expect(res.status).toBe(200);
        expect(persisted('notes')[0].anchor).toEqual(original);
    });
    it('note/update — linkedCardIds replaces explicit note/card links and persists note JSON', async () => {
        dashboardRow.notes = [{ id: 'note_a', title: 'N1', content: 'body' }];
        const res = await post('/api/mission/note/update')
            .send({ ...auth, title: 'N1', entityId: 0, linkedCardIds: ['card_a', 'card_b', 'card_a'] });
        expect(res.status).toBe(200);
        expect(persisted('notes')[0].linkedCardIds).toEqual(['card_a', 'card_b']);
        const sql = capturedWrites.map(w => w.sql).join('\n');
        expect(sql).toMatch(/mission_dashboard SET notes/);
    });

    it('note/update — invalid linkedCardIds returns 400 before persisting', async () => {
        dashboardRow.notes = [{ id: 'note_a', title: 'N1', content: 'body' }];
        const res = await post('/api/mission/note/update')
            .send({ ...auth, title: 'N1', linkedCardIds: ['missing_card'] });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Invalid linkedCardIds/);
    });
});

// ════════════════════════════════════════════════════════════════
// Mission note ↔ Kanban card explicit link CRUD
// ════════════════════════════════════════════════════════════════
describe('Mission note/card link CRUD', () => {
    const auth = { deviceId: 'test-dev', deviceSecret: 'test-secret', entityId: 0 };
    let dashboardRow;
    let cardRows;
    let linkRows;

    beforeEach(() => {
        dashboardRow = { notes: [{ id: 'note_a', title: 'N1', content: 'body' }] };
        cardRows = [
            { id: 'card_a', title: 'Card A', status: 'todo', priority: 'P1' },
            { id: 'card_b', title: 'Card B', status: 'review', priority: 'P2' },
        ];
        linkRows = [{ note_id: 'note_a', card_id: 'card_a', title: 'Card A', status: 'todo', priority: 'P1', created_at: new Date('2026-05-13T00:00:00Z') }];
        const queryImpl = async (sql, params) => {
            const s = typeof sql === 'string' ? sql.trim() : '';
            if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [] };
            if (/FROM kanban_cards/i.test(s)) {
                const wanted = Array.isArray(params && params[1]) ? new Set(params[1]) : new Set(cardRows.map(c => c.id));
                return { rows: cardRows.filter(c => wanted.has(c.id)) };
            }
            if (/FROM mission_dashboard/i.test(s)) return { rows: [dashboardRow] };
            if (/FROM mission_note_card_links/i.test(s)) return { rows: linkRows };
            if (/^UPDATE/i.test(s)) {
                if (/SET notes/.test(s)) dashboardRow.notes = JSON.parse(params[1]);
                return { rows: [{ version: 7 }] };
            }
            if (/^(DELETE|INSERT)/i.test(s)) return { rows: [], rowCount: 1 };
            return { rows: [] };
        };
        mockClientQuery.mockImplementation(queryImpl);
        mockPoolQuery.mockImplementation(queryImpl);
    });

    afterEach(() => {
        mockClientQuery.mockReset();
        mockClientQuery.mockResolvedValue({ rows: [] });
        mockPoolQuery.mockReset();
        mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    });

    it('GET /note/:noteId/cards lists device-scoped linked cards', async () => {
        const res = await get('/api/mission/note/note_a/cards').query(auth);
        expect(res.status).toBe(200);
        expect(res.body.linkedCardIds).toEqual(['card_a']);
        expect(res.body.cards[0]).toMatchObject({ id: 'card_a', title: 'Card A' });
    });

    it('PUT /note/:noteId/cards replaces links and mirrors note JSON', async () => {
        const res = await request(missionApp)
            .put('/api/mission/note/note_a/cards')
            .send({ ...auth, linkedCardIds: ['card_a', 'card_b'] });
        expect(res.status).toBe(200);
        expect(res.body.linkedCardIds).toEqual(['card_a', 'card_b']);
        expect(dashboardRow.notes[0].linkedCardIds).toEqual(['card_a', 'card_b']);
    });

    it('PUT /note/:noteId/cards rejects invalid card ids for device isolation', async () => {
        const res = await request(missionApp)
            .put('/api/mission/note/note_a/cards')
            .send({ ...auth, linkedCardIds: ['card_a', 'card_elsewhere'] });
        expect(res.status).toBe(400);
    });

    it('DELETE /note/:noteId/card/:cardId clears one link', async () => {
        const res = await request(missionApp)
            .delete('/api/mission/note/note_a/card/card_a')
            .send(auth);
        expect(res.status).toBe(200);
        expect(res.body.linkedCardIds).toEqual([]);
        expect(dashboardRow.notes[0].linkedCardIds).toEqual([]);
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
