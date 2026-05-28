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
            .send({ ...AUTH, title: 'Test card', assignedBots: [0], chatAnchorMessageId: 'msg-test-anchor' });
        expect(res.status).not.toBe(400);
    });

    it('rejects USER-filed card with no chatAnchorMessageId (400 + errorKey)', async () => {
        const res = await post('/api/mission/card')
            .send({ ...AUTH, title: 'No anchor', assignedBots: [0] });
        expect(res.status).toBe(400);
        expect(res.body.errorKey).toBe('kb_anchor_required');
    });

    it('allows bot-filed card (entityId > 0) without chatAnchorMessageId', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 2, device_id: 'test-dev', title: 'Bot card',
                description: '', priority: 'P2', status: 'backlog',
                assigned_bots: [0], created_by: 1,
                created_at: new Date(), updated_at: new Date(),
                status_changed_at: new Date(), archived: false,
            }],
        });
        const res = await post('/api/mission/card')
            .send({ ...AUTH, title: 'Bot card', assignedBots: [0], entityId: 1 });
        expect(res.status).not.toBe(400);
    });

    // Phase 4 mindmap write-side: chatAnchorCoord {x,y} from mindmap node
    // is forwarded to INSERT params and shows up in the response payload.
    it('persists chatAnchorCoord {x,y} when filed from mindmap', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 3, device_id: 'test-dev', title: 'From mindmap',
                description: '', priority: 'P2', status: 'backlog',
                assigned_bots: [0], created_by: 0,
                chat_anchor_message_id: 'msg-test-anchor',
                chat_anchor_coord: { x: 142.5, y: -87.3 },
                created_at: new Date(), updated_at: new Date(),
                status_changed_at: new Date(), archived: false,
            }],
        });
        const res = await post('/api/mission/card').send({
            ...AUTH, title: 'From mindmap', assignedBots: [0],
            chatAnchorMessageId: 'msg-test-anchor',
            chatAnchorCoord: { x: 142.5, y: -87.3 },
        });
        expect(res.status).not.toBe(400);
        const insertCall = mockQuery.mock.calls.find(c => /INSERT INTO kanban_cards/.test(c[0]));
        expect(insertCall).toBeTruthy();
        const params = insertCall[1];
        const coordParam = params.find(p => typeof p === 'string' && /"x":142\.5/.test(p));
        expect(coordParam).toBeTruthy();
        expect(JSON.parse(coordParam)).toEqual({ x: 142.5, y: -87.3 });
    });

    it('ignores malformed chatAnchorCoord (NaN coords stored as null)', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 4, device_id: 'test-dev', title: 'Bad coord',
                description: '', priority: 'P2', status: 'backlog',
                assigned_bots: [0], created_by: 0,
                chat_anchor_message_id: 'msg-test-anchor',
                chat_anchor_coord: null,
                created_at: new Date(), updated_at: new Date(),
                status_changed_at: new Date(), archived: false,
            }],
        });
        const res = await post('/api/mission/card').send({
            ...AUTH, title: 'Bad coord', assignedBots: [0],
            chatAnchorMessageId: 'msg-test-anchor',
            chatAnchorCoord: { x: 'not-a-number', y: null },
        });
        expect(res.status).not.toBe(400);
        const insertCall = mockQuery.mock.calls.find(c => /INSERT INTO kanban_cards/.test(c[0]));
        const params = insertCall[1];
        // The coord param immediately precedes dispatch_mode; null when invalid.
        expect(params[params.length - 2]).toBe(null);
        expect(params[params.length - 1]).toBe('immediate');
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

    it('updates automation dispatchMode to idle_only', async () => {
        mockQuery
            .mockResolvedValueOnce({
                rows: [{ id: 'card_auto', device_id: 'test-dev', assigned_bots: [0], dispatch_mode: 'immediate' }],
            })
            .mockResolvedValueOnce({
                rows: [{
                    id: 'card_auto', device_id: 'test-dev', title: 'Automation',
                    description: '', priority: 'P0', status: 'backlog',
                    assigned_bots: [0], created_by: 0, is_automation: true,
                    dispatch_mode: 'idle_only', pending_dispatch: false,
                    created_at: new Date(), updated_at: new Date(),
                    status_changed_at: new Date(), archived: false,
                }],
            })
            .mockResolvedValueOnce({ rows: [] });

        const res = await put('/api/mission/card/card_auto')
            .send({ ...AUTH, dispatchMode: 'idle_only' });

        expect(res.status).toBe(200);
        expect(res.body.card.dispatchMode).toBe('idle_only');
        const updateCall = mockQuery.mock.calls.find(c => /UPDATE kanban_cards SET/.test(c[0]));
        expect(updateCall[0]).toMatch(/dispatch_mode =/);
        expect(updateCall[1]).toContain('idle_only');
    });

    it('clears pending_dispatch when switching dispatchMode back to immediate', async () => {
        mockQuery
            .mockResolvedValueOnce({
                rows: [{ id: 'card_auto', device_id: 'test-dev', assigned_bots: [0], dispatch_mode: 'idle_only', pending_dispatch: true }],
            })
            .mockResolvedValueOnce({
                rows: [{
                    id: 'card_auto', device_id: 'test-dev', title: 'Automation',
                    description: '', priority: 'P0', status: 'backlog',
                    assigned_bots: [0], created_by: 0, is_automation: true,
                    dispatch_mode: 'immediate', pending_dispatch: false,
                    created_at: new Date(), updated_at: new Date(),
                    status_changed_at: new Date(), archived: false,
                }],
            })
            .mockResolvedValueOnce({ rows: [] });

        const res = await put('/api/mission/card/card_auto')
            .send({ ...AUTH, dispatchMode: 'immediate' });

        expect(res.status).toBe(200);
        const updateCall = mockQuery.mock.calls.find(c => /UPDATE kanban_cards SET/.test(c[0]));
        expect(updateCall[0]).toMatch(/dispatch_mode =/);
        expect(updateCall[0]).toMatch(/pending_dispatch = FALSE/);
    });

    it('rejects invalid dispatchMode values', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 'card_auto', device_id: 'test-dev', assigned_bots: [0], dispatch_mode: 'immediate' }],
        });

        const res = await put('/api/mission/card/card_auto')
            .send({ ...AUTH, dispatchMode: 'later' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/dispatchMode/i);
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
            chatAnchorMessageId: 'msg-test-anchor',
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
            chatAnchorMessageId: 'msg-test-anchor',
        });

        expect(res.status).toBe(200);
        // finalAutomation should be true due to recurring schedule
        const insertParams = mockQuery.mock.calls[0][1];
        expect(insertParams[9]).toBe(true); // finalAutomation param (index shifted by +1 after adding id as $1)
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

// ════════════════════════════════════════════════════════════════
// GET /card/:id — Short-ID prefix resolution
// ════════════════════════════════════════════════════════════════
describe('GET /card/:id — short-ID prefix resolution', () => {
    const fullCard = {
        id: 'card_d3cdda1455152e3caee8d4ac',
        device_id: 'test-dev',
        title: 'Full card',
        description: '',
        priority: 'P2',
        status: 'review',
        assigned_bots: [0],
        created_by: 0,
        created_at: new Date(),
        updated_at: new Date(),
        status_changed_at: new Date(),
        archived: false,
        comment_count: 0,
        note_count: 0,
        file_count: 0,
    };

    it('resolves "card_<8hex>" shorthand to the full card id', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: fullCard.id }] }) // prefix lookup
            .mockResolvedValueOnce({ rows: [fullCard] })            // main query
            .mockResolvedValueOnce({ rows: [] })                    // comments
            .mockResolvedValueOnce({ rows: [] })                    // notes
            .mockResolvedValueOnce({ rows: [] });                   // files

        const res = await get('/api/mission/card/card_d3cdda14').query({ ...AUTH });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.card.id).toBe(fullCard.id);
        // prefix lookup should run first with the stripped hex in both forms
        const prefixParams = mockQuery.mock.calls[0][1];
        expect(prefixParams).toContain('d3cdda14%');
        expect(prefixParams).toContain('card_d3cdda14%');
    });

    it('resolves bare 8-hex UUID prefix (no card_ wrapper)', async () => {
        const uuidCard = { ...fullCard, id: '7b7dd9e3-55e1-4074-b101-40c47161d8de' };
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: uuidCard.id }] })
            .mockResolvedValueOnce({ rows: [uuidCard] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        const res = await get('/api/mission/card/7b7dd9e3').query({ ...AUTH });

        expect(res.status).toBe(200);
        expect(res.body.card.id).toBe(uuidCard.id);
    });

    it('passes full ids through unchanged (no prefix query)', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [fullCard] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });

        const res = await get(`/api/mission/card/${fullCard.id}`).query({ ...AUTH });

        expect(res.status).toBe(200);
        // First call should be the main SELECT, not a prefix lookup
        expect(mockQuery.mock.calls[0][0]).toMatch(/FROM kanban_cards c/);
    });

    it('returns 404 when the prefix is ambiguous (2+ matches)', async () => {
        mockQuery
            .mockResolvedValueOnce({
                rows: [
                    { id: 'card_d3cdda1400000000aaaaaaaa' },
                    { id: 'card_d3cdda14ffffffffbbbbbbbb' },
                ],
            })
            .mockResolvedValueOnce({ rows: [] }); // main lookup with raw id → miss

        const res = await get('/api/mission/card/d3cdda14').query({ ...AUTH });

        expect(res.status).toBe(404);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /cards — funnel filters (q, since, until) — added 2026-04-23
// ════════════════════════════════════════════════════════════════
describe('GET /cards — funnel filters', () => {
    beforeEach(() => {
        // Default: main SELECT + summary SELECT both return empty
        mockQuery.mockResolvedValue({ rows: [] });
    });

    it('passes q as ILIKE on title', async () => {
        const res = await get('/api/mission/cards').query({ ...AUTH, q: 'deploy' });
        expect(res.status).toBe(200);
        const mainCall = mockQuery.mock.calls[0];
        expect(mainCall[0]).toMatch(/c\.title ILIKE/);
        expect(mainCall[1]).toContain('%deploy%');
    });

    it('passes since/until as updated_at range', async () => {
        const res = await get('/api/mission/cards').query({
            ...AUTH, since: '2026-04-01', until: '2026-04-30',
        });
        expect(res.status).toBe(200);
        const sql = mockQuery.mock.calls[0][0];
        expect(sql).toMatch(/c\.updated_at >= /);
        expect(sql).toMatch(/c\.updated_at <= /);
    });

    it('ignores empty q', async () => {
        await get('/api/mission/cards').query({ ...AUTH, q: '   ' });
        const sql = mockQuery.mock.calls[0][0];
        expect(sql).not.toMatch(/c\.title ILIKE/);
    });

    it('orders by updated_at DESC (sort change)', async () => {
        await get('/api/mission/cards').query({ ...AUTH });
        const sql = mockQuery.mock.calls[0][0];
        expect(sql).toMatch(/c\.updated_at DESC NULLS LAST/);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /card/:id/restore — un-archive archived card
// ════════════════════════════════════════════════════════════════
describe('POST /card/:id/restore', () => {
    const ARCHIVED_CARD = {
        id: 'card_abc', device_id: 'test-dev', title: 'Old task',
        description: '', priority: 'P2', status: 'backlog',
        assigned_bots: [0], created_by: 0,
        created_at: new Date(), updated_at: new Date(),
        status_changed_at: new Date(), archived: false, archived_at: null,
    };

    it('restores archived card to backlog and returns the card', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [ARCHIVED_CARD] })  // UPDATE ... RETURNING
            .mockResolvedValueOnce({ rows: [] })               // addSystemComment INSERT
            .mockResolvedValueOnce({ rows: [] })               // addSystemComment UPDATE updated_at
            .mockResolvedValueOnce({ rows: [] });              // bumpVersion

        const res = await post('/api/mission/card/card_abc/restore').send({ ...AUTH });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.card.id).toBe('card_abc');
        const updateCall = mockQuery.mock.calls[0];
        expect(updateCall[0]).toMatch(/archived = false/);
        expect(updateCall[0]).toMatch(/archived = true/); // WHERE clause guards against non-archived rows
        expect(updateCall[0]).toMatch(/status = 'backlog'/);
    });

    it('returns 404 if card is not archived or does not exist', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const res = await post('/api/mission/card/missing/restore').send({ ...AUTH });
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });
});

// ════════════════════════════════════════════════════════════════
// Comment / note / file insert bumps kanban_cards.updated_at
// (so "Recently Updated" sort surfaces cards that get activity)
// ════════════════════════════════════════════════════════════════
describe('activity bumps updated_at', () => {
    it('POST /card/:id/comment updates card.updated_at', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: 'card_x', assigned_bots: [0] }] }) // card SELECT
            .mockResolvedValueOnce({ rows: [{ id: 'c1', from_entity_id: 0, text: 'hi', created_at: new Date() }] }) // INSERT comment
            .mockResolvedValueOnce({ rows: [] })   // UPDATE updated_at (new)
            .mockResolvedValueOnce({ rows: [] });  // bumpVersion

        const res = await post('/api/mission/card/card_x/comment').send({ ...AUTH, entityId: 1, text: 'hi' });
        expect(res.status).toBe(200);
        const updatedAtCall = mockQuery.mock.calls.find(c =>
            /UPDATE kanban_cards SET updated_at = NOW/.test(c[0])
        );
        expect(updatedAtCall).toBeDefined();
    });
});

// ════════════════════════════════════════════════════════════════
// GET /cards — schedule field schema lock
// Hygiene audits (e.g. cron-broken heuristic) need every card row to
// carry a `schedule` key. Cards without a schedule MUST serialize as
// schedule: null, not omit the field — otherwise schema checks can't
// distinguish "not scheduled" from "API forgot to include it".
// ════════════════════════════════════════════════════════════════
describe('GET /cards — schedule field always present', () => {
    const get = (path) => request(app).get(path);
    const baseQ = `?deviceId=test-dev&deviceSecret=test-secret`;

    it('manual card without schedule → schedule: null', async () => {
        mockQuery
            .mockResolvedValueOnce({
                rows: [{
                    id: 'card_manual', device_id: 'test-dev', title: 'Manual',
                    description: '', priority: 'P2', status: 'todo',
                    assigned_bots: [0], created_by: 0,
                    created_at: new Date(), updated_at: new Date(),
                    status_changed_at: new Date(), archived: false,
                    is_automation: false,
                    schedule_enabled: false, schedule_type: null,
                    schedule_cron: null, schedule_last_run_at: null,
                }],
            })
            .mockResolvedValueOnce({ rows: [] }) // tags
            .mockResolvedValueOnce({ rows: [{ manual_count: '1', automation_count: '0' }] }); // summary

        const res = await get(`/api/mission/cards${baseQ}`);
        expect(res.status).toBe(200);
        expect(res.body.cards).toHaveLength(1);
        expect(res.body.cards[0]).toHaveProperty('schedule');
        expect(res.body.cards[0].schedule).toBeNull();
    });

    it('automation card with recurring schedule → full schedule object', async () => {
        const now = new Date();
        mockQuery
            .mockResolvedValueOnce({
                rows: [{
                    id: 'card_cron', device_id: 'test-dev', title: 'Cron',
                    description: '', priority: 'P1', status: 'todo',
                    assigned_bots: [0], created_by: 0,
                    created_at: now, updated_at: now,
                    status_changed_at: now, archived: false,
                    is_automation: true,
                    schedule_enabled: true,
                    schedule_type: 'recurring',
                    schedule_cron: '0 9 * * *',
                    schedule_timezone: 'Asia/Taipei',
                    schedule_last_run_at: now,
                    schedule_next_run_at: new Date(now.getTime() + 86400000),
                }],
            })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ manual_count: '0', automation_count: '1' }] });

        const res = await get(`/api/mission/cards${baseQ}&automation=all`);
        expect(res.status).toBe(200);
        const card = res.body.cards[0];
        expect(card).toHaveProperty('schedule');
        expect(card.schedule).toEqual(expect.objectContaining({
            enabled: true,
            type: 'recurring',
            cronExpression: '0 9 * * *',
            timezone: 'Asia/Taipei',
        }));
        expect(typeof card.schedule.lastRunAt).toBe('number');
        expect(typeof card.schedule.nextRunAt).toBe('number');
    });
});
