/**
 * Kanban card validation tests (Jest + Supertest)
 *
 * Tests that kanban cards require at least one assigned entity.
 */

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockQuery,
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

jest.mock('../../safe-equal', () => (a, b) => a === b);

const express = require('express');
const request = require('supertest');

let app;

beforeAll(() => {
    app = express();
    app.use(express.json());

    const mockDevices = {
        'test-dev': {
            deviceSecret: 'test-secret',
            entities: {
                0: { isBound: true, botSecret: 'bot-sec', character: 'Bot0' },
                1: { isBound: true, botSecret: 'bot-sec-1', character: 'Bot1' },
            },
        },
    };

    const kanbanModule = require('../../kanban')(mockDevices, {});
    app.use('/api/mission', kanbanModule.router);
});

beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

const post = (path) => request(app).post(path);
const put = (path) => request(app).put(path);

const AUTH = { deviceId: 'test-dev', deviceSecret: 'test-secret' };

// ════════════════════════════════════════════════════════════════
// POST /card — Create card requires assignedBots
// ════════════════════════════════════════════════════════════════
describe('POST /card — assignedBots validation', () => {
    it('rejects card with no assignedBots (400)', async () => {
        const res = await post('/api/mission/card')
            .send({ ...AUTH, title: 'Test card' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/entity.*assigned/i);
    });

    it('rejects card with empty assignedBots array (400)', async () => {
        const res = await post('/api/mission/card')
            .send({ ...AUTH, title: 'Test card', assignedBots: [] });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/entity.*assigned/i);
    });

    it('accepts card with at least one assignedBot', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 1, device_id: 'test-dev', title: 'Test card',
                description: '', priority: 'P2', status: 'backlog',
                assigned_bots: [0], created_by: 0,
                created_at: new Date(), updated_at: new Date(),
                status_changed_at: new Date(), archived: false,
            }],
        });

        const res = await post('/api/mission/card')
            .send({ ...AUTH, title: 'Test card', assignedBots: [0] });
        expect(res.status).not.toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// PUT /card/:id — Update rejects empty assignedBots
// ════════════════════════════════════════════════════════════════
describe('PUT /card/:id — assignedBots validation', () => {
    it('rejects update with empty assignedBots (400)', async () => {
        // Mock: card exists
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 1, device_id: 'test-dev', assigned_bots: [0] }],
        });

        const res = await put('/api/mission/card/1')
            .send({ ...AUTH, assignedBots: [] });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/entity.*assigned/i);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /card/:id/move — Move rejects empty assignedBots
// ════════════════════════════════════════════════════════════════
describe('POST /card/:id/move — assignedBots validation', () => {
    it('rejects move resulting in zero assigned bots (400)', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 1, device_id: 'test-dev', status: 'backlog',
                assigned_bots: [], archived: false,
            }],
        });

        const res = await post('/api/mission/card/1/move')
            .send({ ...AUTH, newStatus: 'todo', assignedBots: [] });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/entity.*assigned/i);
    });

    it('rejects move when card has no bots and none provided (400)', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 1, device_id: 'test-dev', status: 'backlog',
                assigned_bots: [], archived: false,
            }],
        });

        const res = await post('/api/mission/card/1/move')
            .send({ ...AUTH, newStatus: 'todo' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/entity.*assigned/i);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /card — Inline automation + schedule creation
// ════════════════════════════════════════════════════════════════
describe('POST /card — inline automation + schedule', () => {
    const CARD_ROW = {
        id: 'uuid-1', device_id: 'test-dev', title: 'Auto task',
        description: '', priority: 'P2', status: 'backlog',
        assigned_bots: [0], created_by: 0,
        is_automation: true, schedule_enabled: true,
        schedule_type: 'recurring', schedule_cron: '0 */4 * * *',
        schedule_run_at: null, schedule_timezone: 'Asia/Taipei',
        schedule_next_run_at: new Date(), schedule_last_run_at: null,
        parent_card_id: null, is_auto_generated: false,
        last_run_result: null, active_child_id: null,
        created_at: new Date(), updated_at: new Date(),
        status_changed_at: new Date(), archived: false,
    };

    it('creates automation card with recurring schedule in one step', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [CARD_ROW] }); // INSERT
        mockQuery.mockResolvedValueOnce({ rows: [] }); // bumpVersion
        mockQuery.mockResolvedValueOnce({ rows: [] }); // addSystemComment

        const res = await post('/api/mission/card').send({
            ...AUTH, title: 'Auto task', assignedBots: [0],
            isAutomation: true,
            schedule: { type: 'recurring', cron: '0 */4 * * *' },
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.card.isAutomation).toBe(true);
        // Verify INSERT query includes automation columns
        const insertCall = mockQuery.mock.calls[0];
        expect(insertCall[0]).toMatch(/is_automation/);
        expect(insertCall[0]).toMatch(/schedule_enabled/);
    });

    it('auto-promotes to automation when schedule is recurring even without isAutomation flag', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [CARD_ROW] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const res = await post('/api/mission/card').send({
            ...AUTH, title: 'Auto task', assignedBots: [0],
            schedule: { type: 'recurring', cron: '0 9 * * *' },
        });

        expect(res.status).toBe(200);
        // finalAutomation should be true due to recurring schedule
        const insertParams = mockQuery.mock.calls[0][1];
        expect(insertParams[8]).toBe(true); // finalAutomation param
    });

    it('rejects recurring schedule with missing cron', async () => {
        const res = await post('/api/mission/card').send({
            ...AUTH, title: 'Auto task', assignedBots: [0],
            schedule: { type: 'recurring' },
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/cron/i);
    });

    it('rejects once schedule with missing runAt', async () => {
        const res = await post('/api/mission/card').send({
            ...AUTH, title: 'Once task', assignedBots: [0],
            schedule: { type: 'once' },
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/runAt/i);
    });
});

// ════════════════════════════════════════════════════════════════
// PUT /card/:id/schedule — recurring auto-promotes is_automation
// ════════════════════════════════════════════════════════════════
describe('PUT /card/:id/schedule — auto-promote automation', () => {
    it('sets is_automation=true when schedule_type is recurring', async () => {
        // Mock: card exists (not yet automation)
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 'uuid-1', device_id: 'test-dev', is_automation: false }],
        });
        // Mock: UPDATE RETURNING
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 'uuid-1', device_id: 'test-dev', title: 'Task',
                description: '', priority: 'P2', status: 'backlog',
                assigned_bots: [0], created_by: 0, is_automation: true,
                schedule_enabled: true, schedule_type: 'recurring',
                schedule_cron: '0 9 * * *', schedule_run_at: null,
                schedule_timezone: 'Asia/Taipei', schedule_next_run_at: new Date(),
                schedule_last_run_at: null, parent_card_id: null,
                is_auto_generated: false, last_run_result: null,
                active_child_id: null, created_at: new Date(),
                updated_at: new Date(), status_changed_at: new Date(),
                archived: false,
            }],
        });
        mockQuery.mockResolvedValueOnce({ rows: [] }); // bumpVersion
        mockQuery.mockResolvedValueOnce({ rows: [] }); // addSystemComment

        const res = await put('/api/mission/card/uuid-1/schedule').send({
            ...AUTH, type: 'recurring', cronExpression: '0 9 * * *',
        });

        expect(res.status).toBe(200);
        // Verify SQL includes is_automation = TRUE
        const updateCall = mockQuery.mock.calls[1];
        expect(updateCall[0]).toMatch(/is_automation\s*=\s*TRUE/i);
    });

    it('does NOT set is_automation for once-type schedule', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 'uuid-2', device_id: 'test-dev', is_automation: false }],
        });
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 'uuid-2', device_id: 'test-dev', title: 'Once',
                description: '', priority: 'P2', status: 'backlog',
                assigned_bots: [0], created_by: 0, is_automation: false,
                schedule_enabled: true, schedule_type: 'once',
                schedule_cron: null, schedule_run_at: new Date(Date.now() + 3600000),
                schedule_timezone: 'Asia/Taipei', schedule_next_run_at: new Date(Date.now() + 3600000),
                schedule_last_run_at: null, parent_card_id: null,
                is_auto_generated: false, last_run_result: null,
                active_child_id: null, created_at: new Date(),
                updated_at: new Date(), status_changed_at: new Date(),
                archived: false,
            }],
        });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const res = await put('/api/mission/card/uuid-2/schedule').send({
            ...AUTH, type: 'once', runAt: Date.now() + 3600000,
        });

        expect(res.status).toBe(200);
        const updateSQL = mockQuery.mock.calls[1][0];
        expect(updateSQL).not.toMatch(/is_automation\s*=\s*TRUE/i);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /cards/projections — Projected run times
// ════════════════════════════════════════════════════════════════
const get = (path) => request(app).get(path);

describe('GET /cards/projections', () => {
    it('rejects without auth (401)', async () => {
        const res = await get('/api/mission/cards/projections')
            .query({ deviceId: 'bad', deviceSecret: 'bad' });
        expect(res.status).toBe(401);
    });

    it('returns projections object for automation cards', async () => {
        // Mock: query returns one automation card with cron
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 'card-1',
                schedule_cron: '0 */4 * * *',
                schedule_timezone: 'Asia/Taipei',
            }],
        });

        const res = await get('/api/mission/cards/projections')
            .query({ ...AUTH });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.projections).toBeDefined();
        expect(typeof res.body.projections).toBe('object');
        // card-1 should have an array of timestamps
        if (res.body.projections['card-1']) {
            expect(Array.isArray(res.body.projections['card-1'])).toBe(true);
            // Every 4 hours in 24h = ~6 entries
            expect(res.body.projections['card-1'].length).toBeGreaterThanOrEqual(5);
            expect(res.body.projections['card-1'].length).toBeLessThanOrEqual(7);
        }
    });

    it('returns empty array for cards with invalid cron', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 'card-bad',
                schedule_cron: 'not-a-cron',
                schedule_timezone: 'Asia/Taipei',
            }],
        });

        const res = await get('/api/mission/cards/projections')
            .query({ ...AUTH });

        expect(res.status).toBe(200);
        expect(res.body.projections['card-bad']).toEqual([]);
    });
});
