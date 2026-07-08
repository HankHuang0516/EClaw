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

/**
 * Given an INSERT SQL string + column name, return the 0-based index into
 * the params array. The column list and VALUES placeholder list can drift
 * (some columns use NOW() / DEFAULT and don't consume a $N slot), so we
 * count $N references in VALUES rather than naively zipping the lists.
 * Adding columns at the end (like card_c2635849's schedule_skip_* pair)
 * does not shift earlier assertions.
 */
function columnParamIndex(sql, columnName) {
    // Extract balanced parenthesis groups — the VALUES clause may contain
    // nested parens (NOW(), $7::jsonb, etc.) so a lazy regex on `)` matches
    // too early. Walk the string tracking depth.
    function takeBalanced(src, startIdx) {
        let depth = 0;
        let start = -1;
        for (let i = startIdx; i < src.length; i++) {
            if (src[i] === '(') {
                if (depth === 0) start = i + 1;
                depth++;
            } else if (src[i] === ')') {
                depth--;
                if (depth === 0) return { body: src.slice(start, i), end: i };
            }
        }
        return null;
    }
    const colKeyword = sql.indexOf('INSERT INTO kanban_cards');
    if (colKeyword < 0) return -1;
    const colGroup = takeBalanced(sql, colKeyword);
    if (!colGroup) return -1;
    const valKeyword = sql.indexOf('VALUES', colGroup.end);
    if (valKeyword < 0) return -1;
    const valGroup = takeBalanced(sql, valKeyword);
    if (!valGroup) return -1;
    const cols = colGroup.body.split(',').map(s => s.trim());
    const values = valGroup.body.split(',').map(s => s.trim());
    if (cols.length !== values.length) return -1;
    for (let i = 0; i < cols.length; i++) {
        if (cols[i] === columnName) {
            const m = values[i].match(/^\$(\d+)/);
            if (!m) return -1;  // column uses NOW()/DEFAULT, no param
            return parseInt(m[1], 10) - 1;
        }
    }
    return -1;
}

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
            .send({ ...AUTH, title: 'Test card', assignedBots: [0], chatAnchorMessageId: 'aaaaaaaa-1111-2222-3333-444444444444' });
        expect(res.status).not.toBe(400);
    });

    it('rejects USER-filed card with no chatAnchorMessageId (400 + errorKey)', async () => {
        const res = await post('/api/mission/card')
            .send({ ...AUTH, title: 'No anchor', assignedBots: [0] });
        expect(res.status).toBe(400);
        expect(res.body.errorKey).toBe('kb_anchor_required');
    });

    // card_1356eaf3: non-UUID chat_anchor placeholders (e.g. the ErrLog/cron
    // creator's "cron-auto") must be treated as "no anchor" at the write boundary
    // so they never reach the DB and pollute the mind-map chat-hub projection.
    it('rejects USER-filed card with a non-UUID chatAnchorMessageId placeholder (card_1356eaf3)', async () => {
        const res = await post('/api/mission/card')
            .send({ ...AUTH, title: 'cron card', assignedBots: [0], chatAnchorMessageId: 'cron-auto' });
        expect(res.status).toBe(400);
        expect(res.body.errorKey).toBe('kb_anchor_required');
    });

    // A bot/cron-filed card (entityId > 0) with a placeholder anchor is accepted,
    // but the placeholder is dropped to NULL rather than persisted verbatim.
    it('drops non-UUID chatAnchorMessageId to NULL for bot-filed cards (card_1356eaf3)', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 'cron-1', device_id: 'test-dev', title: 'cron card',
                description: '', priority: 'P2', status: 'backlog',
                assigned_bots: [0], created_by: 1, chat_anchor_message_id: null,
                created_at: new Date(), updated_at: new Date(),
                status_changed_at: new Date(), archived: false,
            }],
        });
        const res = await post('/api/mission/card')
            .send({ ...AUTH, title: 'cron card', assignedBots: [0], entityId: 1, chatAnchorMessageId: 'cron-auto' });
        expect(res.status).not.toBe(400);
        const insertCall = mockQuery.mock.calls.find(c => /INSERT INTO kanban_cards/.test(c[0]));
        expect(insertCall).toBeTruthy();
        // chat_anchor_message_id index: build a (column → $N) map from the
        // SQL, then convert $N to a params array index. This is robust to
        // adding new columns / SQL-literal placeholders like NOW() that
        // don't consume a param slot.
        const sql = insertCall[0];
        const params = insertCall[1];
        const idx = columnParamIndex(sql, 'chat_anchor_message_id');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(params[idx]).toBe(null);
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
                chat_anchor_message_id: 'aaaaaaaa-1111-2222-3333-444444444444',
                chat_anchor_coord: { x: 142.5, y: -87.3 },
                created_at: new Date(), updated_at: new Date(),
                status_changed_at: new Date(), archived: false,
            }],
        });
        const res = await post('/api/mission/card').send({
            ...AUTH, title: 'From mindmap', assignedBots: [0],
            chatAnchorMessageId: 'aaaaaaaa-1111-2222-3333-444444444444',
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

    // Self-improvement template auto-inject (Hank 2026-06-12 audit follow-up)
    // — every parent card description gets a "## Self-improvement (OODA-R)" slot
    // appended when missing; idempotent when caller already wrote one.
    it('appends ## Self-improvement section to bot-filed card with empty description', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 'si-1', device_id: 'test-dev', title: 'Bot card',
                description: '', priority: 'P2', status: 'backlog',
                assigned_bots: [0], created_by: 1,
                created_at: new Date(), updated_at: new Date(),
                status_changed_at: new Date(), archived: false,
            }],
        });
        const res = await post('/api/mission/card')
            .send({ ...AUTH, title: 'Bot card', assignedBots: [0], entityId: 1 });
        expect(res.status).not.toBe(400);
        const insertCall = mockQuery.mock.calls.find(c => /INSERT INTO kanban_cards/.test(c[0]));
        expect(insertCall).toBeTruthy();
        const descParam = insertCall[1][3];
        expect(descParam).toMatch(/## Self-improvement \(OODA-R\)/);
        expect(descParam).toMatch(/Episode trigger/);
        expect(descParam).toMatch(/Rule promotion candidate/);
    });

    it('appends ## Self-improvement section while preserving caller description', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 'si-2', device_id: 'test-dev', title: 'Has scope',
                description: '## Scope\nDo the thing', priority: 'P2', status: 'backlog',
                assigned_bots: [0], created_by: 1,
                created_at: new Date(), updated_at: new Date(),
                status_changed_at: new Date(), archived: false,
            }],
        });
        const res = await post('/api/mission/card').send({
            ...AUTH, title: 'Has scope', assignedBots: [0], entityId: 1,
            description: '## Scope\nDo the thing',
        });
        expect(res.status).not.toBe(400);
        const insertCall = mockQuery.mock.calls.find(c => /INSERT INTO kanban_cards/.test(c[0]));
        const descParam = insertCall[1][3];
        expect(descParam).toMatch(/^## Scope\nDo the thing/);
        expect(descParam).toMatch(/## Self-improvement \(OODA-R\)/);
    });

    it('is idempotent — does not re-append when description already has Self-improvement', async () => {
        const callerDesc = '## Scope\nFoo\n\n## Self-improvement\n- Episode trigger: custom one';
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 'si-3', device_id: 'test-dev', title: 'Has SI',
                description: callerDesc, priority: 'P2', status: 'backlog',
                assigned_bots: [0], created_by: 1,
                created_at: new Date(), updated_at: new Date(),
                status_changed_at: new Date(), archived: false,
            }],
        });
        const res = await post('/api/mission/card').send({
            ...AUTH, title: 'Has SI', assignedBots: [0], entityId: 1,
            description: callerDesc,
        });
        expect(res.status).not.toBe(400);
        const insertCall = mockQuery.mock.calls.find(c => /INSERT INTO kanban_cards/.test(c[0]));
        const descParam = insertCall[1][3];
        expect(descParam).toBe(callerDesc);
        // ensure the template's distinctive "(OODA-R)" qualifier was NOT appended
        expect(descParam).not.toMatch(/## Self-improvement \(OODA-R\)/);
    });

    it('ignores malformed chatAnchorCoord (NaN coords stored as null)', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 4, device_id: 'test-dev', title: 'Bad coord',
                description: '', priority: 'P2', status: 'backlog',
                assigned_bots: [0], created_by: 0,
                chat_anchor_message_id: 'aaaaaaaa-1111-2222-3333-444444444444',
                chat_anchor_coord: null,
                created_at: new Date(), updated_at: new Date(),
                status_changed_at: new Date(), archived: false,
            }],
        });
        const res = await post('/api/mission/card').send({
            ...AUTH, title: 'Bad coord', assignedBots: [0],
            chatAnchorMessageId: 'aaaaaaaa-1111-2222-3333-444444444444',
            chatAnchorCoord: { x: 'not-a-number', y: null },
        });
        expect(res.status).not.toBe(400);
        const insertCall = mockQuery.mock.calls.find(c => /INSERT INTO kanban_cards/.test(c[0]));
        const sql = insertCall[0];
        const params = insertCall[1];
        // Map column→$N→params index so adding columns (e.g.
        // schedule_skip_if_*_pct_over) or NOW()-literal columns don't shift
        // these assertions.
        const coordIdx = columnParamIndex(sql, 'chat_anchor_coord');
        const dispatchIdx = columnParamIndex(sql, 'dispatch_mode');
        expect(coordIdx).toBeGreaterThanOrEqual(0);
        expect(dispatchIdx).toBeGreaterThanOrEqual(0);
        expect(params[coordIdx]).toBe(null);
        expect(params[dispatchIdx]).toBe('immediate');
    });
});

// ════════════════════════════════════════════════════════════════
// POST /card + PUT /card/:id/config — per-card requirePrLink option
// (owner directive 2026-07-03: PR link is opt-in, default off)
// ════════════════════════════════════════════════════════════════
describe('requirePrLink per-card option', () => {
    const anchor = 'aaaaaaaa-1111-2222-3333-444444444444';

    function insertCall() {
        return mockQuery.mock.calls.find(c => /INSERT INTO kanban_cards/.test(c[0]));
    }
    function configUpdateCall() {
        return mockQuery.mock.calls.find(c => /UPDATE kanban_cards SET/.test(c[0]) && /requires_pr_link/.test(c[0]));
    }

    it('POST /card persists requires_pr_link=true when requirePrLink:true', async () => {
        const res = await post('/api/mission/card').send({
            ...AUTH, title: 'Opt-in card', assignedBots: [0],
            chatAnchorMessageId: anchor, requirePrLink: true,
        });
        expect(res.status).not.toBe(400);
        const call = insertCall();
        const idx = columnParamIndex(call[0], 'requires_pr_link');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(call[1][idx]).toBe(true);
    });

    it('POST /card defaults requires_pr_link=false when option absent', async () => {
        const res = await post('/api/mission/card').send({
            ...AUTH, title: 'Default card', assignedBots: [0],
            chatAnchorMessageId: anchor,
        });
        expect(res.status).not.toBe(400);
        const call = insertCall();
        const idx = columnParamIndex(call[0], 'requires_pr_link');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(call[1][idx]).toBe(false);
    });

    it('POST /card treats non-true value as false (only === true / "true" opts in)', async () => {
        const res = await post('/api/mission/card').send({
            ...AUTH, title: 'Weird value', assignedBots: [0],
            chatAnchorMessageId: anchor, requirePrLink: 0,
        });
        expect(res.status).not.toBe(400);
        const call = insertCall();
        const idx = columnParamIndex(call[0], 'requires_pr_link');
        expect(call[1][idx]).toBe(false);
    });

    it('PUT /card/:id/config accepts requirePrLink:true and writes requires_pr_link', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 'card-x', device_id: 'test-dev', title: 'C',
                priority: 'P2', status: 'todo', assigned_bots: [0],
                created_by: 0, requires_pr_link: true,
                created_at: new Date(), updated_at: new Date(),
                status_changed_at: new Date(), archived: false,
            }],
        });
        const res = await put('/api/mission/card/card-x/config').send({
            ...AUTH, requirePrLink: true,
        });
        expect(res.status).toBe(200);
        expect(res.body.card.requirePrLink).toBe(true);
        const call = configUpdateCall();
        expect(call).toBeTruthy();
        // the boolean param is coerced via !!requirePrLink
        expect(call[1]).toContain(true);
    });

    it('PUT /card/:id/config accepts requirePrLink:false to turn enforcement off', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 'card-y', device_id: 'test-dev', title: 'C',
                priority: 'P2', status: 'todo', assigned_bots: [0],
                created_by: 0, requires_pr_link: false,
                created_at: new Date(), updated_at: new Date(),
                status_changed_at: new Date(), archived: false,
            }],
        });
        const res = await put('/api/mission/card/card-y/config').send({
            ...AUTH, requirePrLink: false,
        });
        expect(res.status).toBe(200);
        const call = configUpdateCall();
        expect(call).toBeTruthy();
        expect(call[0]).toMatch(/requires_pr_link\s*=\s*\$\d+/);
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
            chatAnchorMessageId: 'aaaaaaaa-1111-2222-3333-444444444444',
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
            chatAnchorMessageId: 'aaaaaaaa-1111-2222-3333-444444444444',
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
