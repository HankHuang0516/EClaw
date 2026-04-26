/**
 * GET /api/mission/mindmap — Live data feed for portal/mission.html mind-map.
 *
 * Verifies the projection of kanban_cards into the {nodes, edges} shape
 * consumed by public/portal/shared/mission-mindmap.js (PR-C, card_90e2ec3).
 */

const mockQuery = jest.fn();

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: (...args) => mockQuery(...args),
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
        'dev-1': {
            deviceSecret: 'sec-1',
            entities: {
                2: { isBound: true, botSecret: 'bot-2', character: 'Bot2' },
            },
        },
    };

    const kanbanModule = require('../../kanban')(mockDevices, {});
    app.use('/api/mission', kanbanModule.router);
});

beforeEach(() => {
    mockQuery.mockReset();
});

const AUTH = '?deviceId=dev-1&deviceSecret=sec-1';

describe('GET /api/mission/mindmap', () => {
    it('rejects unauthenticated requests', async () => {
        const res = await request(app).get('/api/mission/mindmap?deviceId=dev-1');
        expect(res.status).toBe(400);
    });

    it('returns empty graph when no cards exist', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [] }) // cards
            .mockResolvedValueOnce({ rows: [{ n: 0 }] }); // chat embedding count

        const res = await request(app).get('/api/mission/mindmap' + AUTH);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.live).toBe(true);
        expect(res.body.nodes).toEqual([]);
        expect(res.body.edges).toEqual([]);
        expect(res.body.stats.totalCards).toBe(0);
    });

    it('classifies cards by sys-keyword and emits hub→card edges', async () => {
        mockQuery
            .mockResolvedValueOnce({
                rows: [
                    { id: 'card_a', title: 'i18n ko cc_warn 修正', description: 'fix korean', priority: 'P0', status: 'in_progress', parent_card_id: null, is_automation: false, assigned_bots: [5] },
                    { id: 'card_b', title: '看板深層連結 anchor', description: 'kanban deeplink', priority: 'P1', status: 'todo', parent_card_id: null, is_automation: false, assigned_bots: [2] },
                    { id: 'card_c', title: '聊天引用晶片 popover', description: 'chat chip popover', priority: 'P0', status: 'review', parent_card_id: null, is_automation: false, assigned_bots: [2] },
                    { id: 'card_d', title: 'Random thing nobody knows', description: 'fallback', priority: 'P2', status: 'todo', parent_card_id: null, is_automation: false, assigned_bots: [2] },
                ],
            })
            .mockResolvedValueOnce({ rows: [{ n: 42 }] });

        const res = await request(app).get('/api/mission/mindmap' + AUTH);
        expect(res.status).toBe(200);
        const sysOf = id => res.body.nodes.find(n => n.id === id)?.sys;
        expect(sysOf('card_a')).toBe('i18n');
        expect(sysOf('card_b')).toBe('kanban');
        expect(sysOf('card_c')).toBe('chat');
        expect(sysOf('card_d')).toBe('kanban'); // fallback

        // Hubs emitted only for active sys
        const hubIds = res.body.nodes.filter(n => n.id.startsWith('sys:')).map(n => n.id).sort();
        expect(hubIds).toEqual(['sys:chat', 'sys:i18n', 'sys:kanban']);

        // Hub→card edges exist for every parentless card
        const edgeSet = new Set(res.body.edges.map(([s, t]) => `${s}→${t}`));
        expect(edgeSet.has('sys:i18n→card_a')).toBe(true);
        expect(edgeSet.has('sys:kanban→card_b')).toBe(true);
        expect(edgeSet.has('sys:chat→card_c')).toBe(true);
        expect(edgeSet.has('sys:kanban→card_d')).toBe(true);

        // Chat embedding telemetry surfaced on hub
        const chatHub = res.body.nodes.find(n => n.id === 'sys:chat');
        expect(chatHub.summary).toContain('42 則訊息已嵌入');
    });

    it('emits parent→child edges AND hub edges for child (dual-axis)', async () => {
        mockQuery
            .mockResolvedValueOnce({
                rows: [
                    { id: 'card_p', title: '父卡 i18n', description: '', priority: 'P1', status: 'in_progress', parent_card_id: null, is_automation: false, assigned_bots: [5] },
                    { id: 'card_c', title: '子卡 i18n locale', description: '', priority: 'P2', status: 'todo', parent_card_id: 'card_p', is_automation: false, assigned_bots: [5] },
                ],
            })
            .mockResolvedValueOnce({ rows: [{ n: 0 }] });

        const res = await request(app).get('/api/mission/mindmap' + AUTH);
        const edgeSet = new Set(res.body.edges.map(([s, t]) => `${s}→${t}`));
        expect(edgeSet.has('card_p→card_c')).toBe(true);
        // Both parent and child connect to their content sysHub — child's
        // parent edge is no longer mutually exclusive with the hub edge,
        // so the mindmap can navigate dual-axis (lineage + content).
        expect(edgeSet.has('sys:i18n→card_p')).toBe(true);
        expect(edgeSet.has('sys:i18n→card_c')).toBe(true);
    });

    it('maps kanban status to mind-map status (done/blocked/active)', async () => {
        mockQuery
            .mockResolvedValueOnce({
                rows: [
                    { id: 'card_done',    title: 'kanban thing',  description: '', priority: 'P2', status: 'done',     parent_card_id: null, is_automation: false, assigned_bots: [2] },
                    { id: 'card_back',    title: 'kanban backlog',description: '', priority: 'P2', status: 'backlog',  parent_card_id: null, is_automation: false, assigned_bots: [2] },
                    { id: 'card_inprog',  title: 'kanban active', description: '', priority: 'P2', status: 'in_progress', parent_card_id: null, is_automation: false, assigned_bots: [2] },
                ],
            })
            .mockResolvedValueOnce({ rows: [{ n: 0 }] });

        const res = await request(app).get('/api/mission/mindmap' + AUTH);
        const byId = Object.fromEntries(res.body.nodes.map(n => [n.id, n]));
        expect(byId.card_done.status).toBe('done');
        expect(byId.card_back.status).toBe('blocked');
        expect(byId.card_inprog.status).toBe('active');
    });

    it('automation cards: trigger goes to sys:automation hub; spawned children dual-axis', async () => {
        // Trigger (is_automation=true) — title says "i18n cron" but classifier
        // routes to automation regardless of content keywords. Child cards
        // (is_automation=false) keep their content classification AND get
        // both a hub edge + parent edge.
        mockQuery
            .mockResolvedValueOnce({
                rows: [
                    { id: 'card_cron',  title: 'i18n 巡檢 cron',         description: '',                    priority: 'P2', status: 'in_progress', parent_card_id: null,        is_automation: true,  assigned_bots: [5] },
                    { id: 'card_kid1',  title: 'i18n 巡檢結果 04/26',     description: 'patrol output',       priority: 'P3', status: 'done',        parent_card_id: 'card_cron', is_automation: false, assigned_bots: [5] },
                    { id: 'card_kid2',  title: '看板自動化發現 stale 卡', description: 'auto-found via cron', priority: 'P3', status: 'todo',        parent_card_id: 'card_cron', is_automation: false, assigned_bots: [2] },
                ],
            })
            .mockResolvedValueOnce({ rows: [{ n: 0 }] });

        const res = await request(app).get('/api/mission/mindmap' + AUTH);
        expect(res.status).toBe(200);
        const sysOf = id => res.body.nodes.find(n => n.id === id)?.sys;
        expect(sysOf('card_cron')).toBe('automation');
        expect(sysOf('card_kid1')).toBe('i18n');
        expect(sysOf('card_kid2')).toBe('kanban');

        // sys:automation hub now appears alongside content hubs
        const hubIds = res.body.nodes.filter(n => n.id.startsWith('sys:')).map(n => n.id).sort();
        expect(hubIds).toEqual(['sys:automation', 'sys:i18n', 'sys:kanban']);

        const edgeSet = new Set(res.body.edges.map(([s, t]) => `${s}→${t}`));
        // Trigger anchored to automation hub
        expect(edgeSet.has('sys:automation→card_cron')).toBe(true);
        // Children: lineage to parent + content hub edge (dual-axis)
        expect(edgeSet.has('card_cron→card_kid1')).toBe(true);
        expect(edgeSet.has('card_cron→card_kid2')).toBe(true);
        expect(edgeSet.has('sys:i18n→card_kid1')).toBe(true);
        expect(edgeSet.has('sys:kanban→card_kid2')).toBe(true);

        // isAutomation flag surfaced on node payload for frontend styling
        expect(res.body.nodes.find(n => n.id === 'card_cron').isAutomation).toBe(true);
        expect(res.body.nodes.find(n => n.id === 'card_kid1').isAutomation).toBe(false);
    });

    it('automation no longer filtered by default; includeAutomation flag becomes a no-op', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ n: 0 }] });

        await request(app).get('/api/mission/mindmap' + AUTH);
        const sql1 = mockQuery.mock.calls[0][0];
        // SQL no longer carries the is_automation filter — automation cards
        // are first-class nodes anchored under sys:automation instead of
        // hidden behind an opt-in flag.
        expect(sql1).not.toMatch(/is_automation = false OR is_automation IS NULL/);

        mockQuery.mockReset();
        mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ n: 0 }] });

        // Legacy callers passing ?includeAutomation=true still get a 200 —
        // the flag is now a harmless no-op (kept for backwards compat).
        const res = await request(app).get('/api/mission/mindmap' + AUTH + '&includeAutomation=true');
        expect(res.status).toBe(200);
        const sql2 = mockQuery.mock.calls[0][0];
        expect(sql2).not.toMatch(/is_automation = false OR is_automation IS NULL/);
    });

    it('survives chat_messages.embedding column missing (pgvector not installed)', async () => {
        mockQuery
            .mockResolvedValueOnce({
                rows: [
                    { id: 'card_x', title: '聊天 chip', description: '', priority: 'P2', status: 'todo', parent_card_id: null, is_automation: false, assigned_bots: [2] },
                ],
            })
            .mockRejectedValueOnce(new Error('column "embedding" does not exist'));

        const res = await request(app).get('/api/mission/mindmap' + AUTH);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.stats.messagesWithEmbedding).toBe(0);
    });
});
