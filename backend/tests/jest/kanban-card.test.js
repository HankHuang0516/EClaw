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
