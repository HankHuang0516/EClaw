/**
 * GET /api/mindmap/graph — force-graph projection
 *
 * Two layers:
 *   1) Pure projection unit tests against mindmap-graph-projection.js
 *      (no express, no pg) — covers node/edge mapping, caps, scope flags.
 *   2) HTTP-level tests against the mounted route via supertest with a
 *      sequenced mockQuery, matching the pattern used by kanban-mindmap.test.js.
 *
 * Amendment A (chat_anchor edges) and dual-auth scope behavior are both
 * verified — these were the two extensions added on top of the base spec
 * during the PR #2679 review.
 */

const projection = require('../../mindmap-graph-projection');

// ─── Layer 1: pure projection unit tests ─────────────────────────────────
describe('mindmap-graph-projection — pure helpers', () => {
    test('parseBoolFlag accepts truthy and falsy spellings, falls back to default', () => {
        expect(projection.parseBoolFlag('true', false)).toBe(true);
        expect(projection.parseBoolFlag('1', false)).toBe(true);
        expect(projection.parseBoolFlag('YES', false)).toBe(true);
        expect(projection.parseBoolFlag('false', true)).toBe(false);
        expect(projection.parseBoolFlag('no', true)).toBe(false);
        expect(projection.parseBoolFlag('', true)).toBe(true);
        expect(projection.parseBoolFlag(undefined, false)).toBe(false);
        expect(projection.parseBoolFlag('garbage', true)).toBe(true);
    });

    test('clampInt clamps and falls back', () => {
        expect(projection.clampInt('500', 100, 1, 1000)).toBe(500);
        expect(projection.clampInt('5000', 100, 1, 1000)).toBe(1000);
        expect(projection.clampInt('-5', 100, 1, 1000)).toBe(1);
        expect(projection.clampInt(undefined, 100, 1, 1000)).toBe(100);
        expect(projection.clampInt('not-a-number', 100, 1, 1000)).toBe(100);
    });

    test('parseNumericCreatedBy distinguishes "2" from "user"', () => {
        expect(projection.parseNumericCreatedBy('2')).toBe(2);
        expect(projection.parseNumericCreatedBy('0')).toBe(0);
        expect(projection.parseNumericCreatedBy('user')).toBeNull();
        expect(projection.parseNumericCreatedBy('system')).toBeNull();
        expect(projection.parseNumericCreatedBy(null)).toBeNull();
        expect(projection.parseNumericCreatedBy('')).toBeNull();
    });

    test('pickOwnerEntityId prefers first assigned bot, falls back to created_by', () => {
        expect(projection.pickOwnerEntityId({ assigned_bots: [5, 2], created_by: 1 })).toBe(5);
        expect(projection.pickOwnerEntityId({ assigned_bots: [], created_by: 1 })).toBe(1);
        expect(projection.pickOwnerEntityId({ assigned_bots: [], created_by: 0 })).toBeNull();
        expect(projection.pickOwnerEntityId({ assigned_bots: null, created_by: null })).toBeNull();
    });

    test('taskVal weighted by priority, automation, blocked', () => {
        expect(projection.taskVal('P0', false, 'todo')).toBe(8);
        expect(projection.taskVal('P1', false, 'todo')).toBe(6);
        expect(projection.taskVal('P2', true, 'todo')).toBe(5);
        expect(projection.taskVal('P3', false, 'blocked')).toBe(4);
        expect(projection.taskVal('P0', true, 'blocked')).toBe(10);
        expect(projection.taskVal(undefined, false, 'todo')).toBe(4);
    });

    test('buildTaskNode produces forced shape with prefixed id + deep link', () => {
        const node = projection.buildTaskNode({
            id: 'card_abc123',
            title: '[P1] Fix rental refund',
            description: '   Implement   second-level\nrefunds...   ',
            priority: 'P1',
            status: 'in_progress',
            parent_card_id: null,
            assigned_bots: [2, 5],
            created_by: 1,
            reviewer_entity_id: 2,
            is_automation: false,
            archived: false,
            chat_anchor_message_id: 'msg-xyz',
            updated_at: '2026-05-13T01:45:00.000Z',
        }, 4, 1);
        expect(node.id).toBe('task:card_abc123');
        expect(node.sourceId).toBe('card_abc123');
        expect(node.type).toBe('task');
        expect(node.status).toBe('in_progress');
        expect(node.priority).toBe('P1');
        expect(node.ownerEntityId).toBe(2);
        expect(node.assignedEntityIds).toEqual([2, 5]);
        expect(node.reviewerEntityId).toBe(2);
        expect(node.commentCount).toBe(4);
        expect(node.noteCount).toBe(1);
        expect(node.summary).toBe('Implement second-level refunds...');
        expect(node.summary.length).toBeLessThanOrEqual(240);
        expect(node.url).toBe('/portal/kanban.html?card=card_abc123');
        expect(node.colorKey).toBe('status:in_progress');
        expect(node.val).toBe(6);
    });

    test('buildNoteNode maps numeric created_by to ownerEntityId', () => {
        const numeric = projection.buildNoteNode({
            id: 'note_def',
            title: 'Spec note',
            content: 'See spec.',
            category: 'spec',
            created_by: '2',
            updated_at: '2026-05-13T00:00:00Z',
        });
        expect(numeric.id).toBe('note:note_def');
        expect(numeric.type).toBe('note');
        expect(numeric.ownerEntityId).toBe(2);
        expect(numeric.category).toBe('spec');
        expect(numeric.url).toBe('/portal/mission.html?note=note_def');

        const stringOwner = projection.buildNoteNode({
            id: 'note_zzz',
            title: 'User note',
            content: '',
            category: 'general',
            created_by: 'user',
        });
        expect(stringOwner.ownerEntityId).toBeNull();
    });

    test('buildOwnerNode uses entity record character name when available', () => {
        const node = projection.buildOwnerNode(2, { character: 'LOBSTER', avatar: 'http://a.png' });
        expect(node.id).toBe('owner:2');
        expect(node.label).toBe('LOBSTER');
        expect(node.avatar).toBe('http://a.png');
        expect(node.type).toBe('owner');
        const fallback = projection.buildOwnerNode(99, undefined);
        expect(fallback.label).toBe('Entity 99');
    });

    test('buildChatNode produces chat:<id> with deep link', () => {
        const node = projection.buildChatNode('msg-abc12345', null);
        expect(node.id).toBe('chat:msg-abc12345');
        expect(node.type).toBe('chat');
        expect(node.url).toBe('/portal/chat.html?msg=msg-abc12345');
    });

    test('applyCaps drops trailing nodes and orphaned links', () => {
        const nodes = [
            { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
        ];
        const links = [
            { source: 'a', target: 'b' },
            { source: 'c', target: 'd' },
            { source: 'b', target: 'd' },
        ];
        const r = projection.applyCaps(nodes, links, 2, 10);
        expect(nodes.map(n => n.id)).toEqual(['a', 'b']);
        expect(r.truncatedNodes).toBe(2);
        expect(links).toEqual([{ source: 'a', target: 'b' }]);
        expect(r.truncatedLinks).toBe(2);
    });

    test('parseGraphOptions defaults scope from auth type', () => {
        const dev = projection.parseGraphOptions({}, { isDeviceAuth: true, callerEntityId: null });
        expect(dev.scope).toBe('device');
        expect(dev.includeNeighbors).toBe(false);
        expect(dev.includeNotes).toBe(true);

        const ent = projection.parseGraphOptions({}, { isDeviceAuth: false, callerEntityId: 2 });
        expect(ent.scope).toBe('entity');
        expect(ent.callerEntityId).toBe(2);
        expect(ent.includeNeighbors).toBe(true);

        const explicit = projection.parseGraphOptions(
            { scope: 'entity', includeNotes: 'false', limitNodes: '20', limitEdges: '40' },
            { isDeviceAuth: true, callerEntityId: 2 }
        );
        expect(explicit.scope).toBe('entity');
        expect(explicit.includeNotes).toBe(false);
        expect(explicit.limitNodes).toBe(20);
        expect(explicit.limitEdges).toBe(40);
    });

    test('projectGraph wires parent + blocks + owner edges', () => {
        const cards = [
            { id: 'card_p', title: 'parent', description: '', priority: 'P0', status: 'in_progress', parent_card_id: null, is_automation: false, assigned_bots: [2], created_by: 1, reviewer_entity_id: null, chat_anchor_message_id: null, archived: false, updated_at: '2026-05-13T00:00:00Z' },
            { id: 'card_c', title: 'child',  description: '', priority: 'P1', status: 'todo',        parent_card_id: 'card_p', is_automation: false, assigned_bots: [5], created_by: 2, reviewer_entity_id: 1, chat_anchor_message_id: null, archived: false, updated_at: '2026-05-13T00:00:00Z' },
        ];
        const initialCardIds = new Set(['card_p', 'card_c']);
        const result = projection.projectGraph({
            cards,
            initialCardIds,
            depRows: [
                { card_id: 'card_c', depends_on_card_id: 'card_p', dependency_type: 'blocks' },
            ],
            commentCounts: [{ card_id: 'card_p', cnt: 3 }],
            noteCounts: [],
            notes: [],
            anchorRows: [],
            entityMap: {
                2: { character: 'LOBSTER' },
                5: { character: 'Hermes' },
                1: { character: 'Mac_F' },
            },
            options: projection.parseGraphOptions({}, { isDeviceAuth: true, callerEntityId: null }),
        });

        const ids = result.nodes.map(n => n.id).sort();
        // 2 tasks, 3 owners (entities 1, 2, 5 — needed by assigned/reviewer/owner)
        expect(ids).toEqual(expect.arrayContaining(['task:card_p', 'task:card_c', 'owner:1', 'owner:2', 'owner:5']));

        const edgeTypes = result.links.map(l => l.type).sort();
        expect(edgeTypes).toContain('parent');
        expect(edgeTypes).toContain('blocks');
        expect(edgeTypes).toContain('owner');

        const parentEdge = result.links.find(l => l.type === 'parent');
        expect(parentEdge.source).toBe('task:card_p');
        expect(parentEdge.target).toBe('task:card_c');
        expect(parentEdge.directional).toBe(true);

        const blocksEdge = result.links.find(l => l.type === 'blocks');
        // "card_p blocks card_c" semantics — source is the prerequisite.
        expect(blocksEdge.source).toBe('task:card_p');
        expect(blocksEdge.target).toBe('task:card_c');

        expect(result.stats.edgeCounts.parent).toBe(1);
        expect(result.stats.edgeCounts.blocks).toBe(1);
        expect(result.stats.edgeCounts.owner).toBeGreaterThanOrEqual(2);
    });

    test('projectGraph emits explicit card link edges', () => {
        const cards = [
            { id: 'card_a', title: 'A', description: '', priority: 'P1', status: 'todo', parent_card_id: null, is_automation: false, assigned_bots: [], created_by: 0, reviewer_entity_id: null, chat_anchor_message_id: null, archived: false, updated_at: null },
            { id: 'card_b', title: 'B', description: '', priority: 'P1', status: 'todo', parent_card_id: null, is_automation: false, assigned_bots: [], created_by: 0, reviewer_entity_id: null, chat_anchor_message_id: null, archived: false, updated_at: null },
            { id: 'card_c', title: 'C', description: '', priority: 'P1', status: 'todo', parent_card_id: null, is_automation: false, assigned_bots: [], created_by: 0, reviewer_entity_id: null, chat_anchor_message_id: null, archived: false, updated_at: null },
        ];
        const result = projection.projectGraph({
            cards,
            initialCardIds: new Set(cards.map(c => c.id)),
            depRows: [],
            cardLinkRows: [
                { source_card_id: 'card_a', target_card_id: 'card_b', relation_type: 'references' },
                { source_card_id: 'card_b', target_card_id: 'card_c', relation_type: 'duplicates' },
            ],
            commentCounts: [],
            noteCounts: [],
            notes: [],
            anchorRows: [],
            entityMap: {},
            options: projection.parseGraphOptions({ includeOwners: 'none' }, { isDeviceAuth: true, callerEntityId: null }),
        });

        const references = result.links.find(l => l.type === 'references');
        expect(references).toMatchObject({
            source: 'task:card_a',
            target: 'task:card_b',
            evidence: 'kanban_card_links',
            directional: true,
        });
        const duplicate = result.links.find(l => l.type === 'duplicates');
        expect(duplicate).toMatchObject({
            source: 'task:card_b',
            target: 'task:card_c',
            evidence: 'kanban_card_links',
            directional: false,
        });
        expect(result.stats.edgeCounts.references).toBe(1);
        expect(result.stats.edgeCounts.duplicates).toBe(1);
    });

    test('projectGraph emits note_on_card edges from explicit mission_note_card_links', () => {
        const result = projection.projectGraph({
            cards: [
                { id: 'card_a', title: 'A', description: '', priority: 'P1', status: 'todo', parent_card_id: null, is_automation: false, assigned_bots: [], created_by: 0, reviewer_entity_id: null, chat_anchor_message_id: null, archived: false, updated_at: null },
            ],
            initialCardIds: new Set(['card_a']),
            depRows: [],
            noteCardLinkRows: [{ note_id: 'note_a', card_id: 'card_a' }],
            commentCounts: [],
            noteCounts: [],
            notes: [{ id: 'note_a', title: 'linked note', content: '', category: 'general', created_by: '2', updated_at: null }],
            anchorRows: [],
            entityMap: {},
            options: projection.parseGraphOptions(
                { includeNotes: 'true', includeOwners: 'none' },
                { isDeviceAuth: true, callerEntityId: null }
            ),
        });
        const edge = result.links.find(l => l.type === 'note_on_card');
        expect(edge).toMatchObject({
            source: 'note:note_a',
            target: 'task:card_a',
            evidence: 'mission_note_card_links',
        });
        expect(result.stats.edgeCounts.note_on_card).toBe(1);
    });

    test('projectGraph emits chat_anchor edges (amendment A)', () => {
        const cards = [
            { id: 'card_a', title: 'pinned to chat', description: '', priority: 'P1', status: 'todo', parent_card_id: null, is_automation: false, assigned_bots: [2], created_by: 1, reviewer_entity_id: null, chat_anchor_message_id: 'msg-pinned', archived: false, updated_at: null },
        ];
        const result = projection.projectGraph({
            cards,
            initialCardIds: new Set(['card_a']),
            depRows: [],
            commentCounts: [],
            noteCounts: [],
            notes: [
                { id: 'note_a', title: 'cross-linked note', content: '', category: 'general', created_by: '2', updated_at: null },
            ],
            anchorRows: [
                // mindmap_node that bridges note_a + chat msg-mirror + card_a
                { node_id: 'mm-1', anchor_type: 'note',          anchor_ref: 'note_a',     display_label: null },
                { node_id: 'mm-1', anchor_type: 'chat_message', anchor_ref: 'msg-mirror', display_label: null },
                { node_id: 'mm-1', anchor_type: 'kanban_card',  anchor_ref: 'card_a',     display_label: null },
            ],
            entityMap: { 2: { character: 'LOBSTER' }, 1: { character: 'Mac_F' } },
            options: projection.parseGraphOptions(
                { includeNotes: 'true' },
                { isDeviceAuth: true, callerEntityId: null }
            ),
        });

        const chatNodes = result.nodes.filter(n => n.type === 'chat').map(n => n.id).sort();
        expect(chatNodes).toEqual(['chat:msg-mirror', 'chat:msg-pinned']);

        const chatEdges = result.links.filter(l => l.type === 'chat_anchor');
        // Expect: task:card_a → chat:msg-pinned (direct field)
        //          task:card_a → chat:msg-mirror (anchor cross-correlation)
        //          note:note_a → chat:msg-mirror (anchor cross-correlation)
        const pairs = new Set(chatEdges.map(e => `${e.source}->${e.target}`));
        expect(pairs.has('task:card_a->chat:msg-pinned')).toBe(true);
        expect(pairs.has('task:card_a->chat:msg-mirror')).toBe(true);
        expect(pairs.has('note:note_a->chat:msg-mirror')).toBe(true);
        expect(result.stats.edgeCounts.chat_anchor).toBe(3);

        // And the mindmap_node also bridges note_a ↔ card_a — note_on_card edge.
        const noteOnCard = result.links.find(l => l.type === 'note_on_card');
        expect(noteOnCard).toBeTruthy();
        expect(noteOnCard.source).toBe('note:note_a');
        expect(noteOnCard.target).toBe('task:card_a');
    });

    test('projectGraph respects limitNodes by dropping trailing nodes + orphans', () => {
        const cards = Array.from({ length: 5 }, (_, i) => ({
            id: `card_${i}`, title: `t${i}`, description: '',
            priority: 'P2', status: 'todo', parent_card_id: null, is_automation: false,
            assigned_bots: [], created_by: 0, reviewer_entity_id: null,
            chat_anchor_message_id: null, archived: false, updated_at: null,
        }));
        const result = projection.projectGraph({
            cards,
            initialCardIds: new Set(cards.map(c => c.id)),
            depRows: [],
            commentCounts: [],
            noteCounts: [],
            notes: [],
            anchorRows: [],
            entityMap: {},
            options: projection.parseGraphOptions(
                { includeOwners: 'none', limitNodes: '2', limitEdges: '10', includeNotes: 'false' },
                { isDeviceAuth: true, callerEntityId: null }
            ),
        });
        expect(result.nodes.length).toBe(2);
        expect(result.stats.truncatedNodes).toBe(3);
        expect(result.stats.truncated).toBe(true);
    });
});

// ─── Layer 2: HTTP route (supertest + mocked pool) ───────────────────────
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

describe('GET /api/mindmap/graph — HTTP', () => {
    let app;
    const devices = {
        'dev-1': {
            deviceSecret: 'sec-1',
            entities: {
                2: { isBound: true, botSecret: 'bot-2', character: 'LOBSTER' },
                5: { isBound: true, botSecret: 'bot-5', character: 'Hermes' },
            },
        },
    };

    beforeAll(async () => {
        app = express();
        app.use(express.json());
        const mindmapModule = require('../../mindmap')(devices);
        // initMindmapTables wires the module-level `pool` closure. The mocked
        // pg.Pool above returns a stub whose `query` delegates to mockQuery,
        // so any SELECT in `/graph` flows through our sequence.
        const pgPool = new (require('pg').Pool)();
        await mindmapModule.initMindmapTables(pgPool);
        app.use('/api/mindmap', mindmapModule.router);
    });

    beforeEach(() => {
        mockQuery.mockReset();
        // The init phase fires several CREATE TABLE queries — re-assert after reset.
        mockQuery.mockResolvedValue({ rows: [] });
    });

    const AUTH = '?deviceId=dev-1&deviceSecret=sec-1';

    test('400 when deviceId missing', async () => {
        const res = await request(app).get('/api/mindmap/graph');
        expect(res.status).toBe(400);
    });

    test('401 for invalid device credentials', async () => {
        const res = await request(app).get('/api/mindmap/graph?deviceId=dev-1&deviceSecret=wrong');
        expect(res.status).toBe(401);
    });

    test('400 scope=entity without entityId', async () => {
        const res = await request(app).get('/api/mindmap/graph' + AUTH + '&scope=entity');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/entityId/);
    });

    test('happy path: returns graph + meta + edgeCounts', async () => {
        mockQuery.mockReset();
        mockQuery
            // 1) cards
            .mockResolvedValueOnce({
                rows: [
                    { id: 'card_p', title: 'parent', description: '', priority: 'P0', status: 'in_progress', parent_card_id: null, is_automation: false, assigned_bots: [2], created_by: 1, reviewer_entity_id: null, chat_anchor_message_id: null, archived: false, updated_at: '2026-05-13T00:00:00Z' },
                    { id: 'card_c', title: 'child',  description: '', priority: 'P1', status: 'todo',        parent_card_id: 'card_p', is_automation: false, assigned_bots: [5], created_by: 2, reviewer_entity_id: 1, chat_anchor_message_id: null, archived: false, updated_at: '2026-05-13T00:00:00Z' },
                ],
            })
            // 2) dependencies
            .mockResolvedValueOnce({
                rows: [{ card_id: 'card_c', depends_on_card_id: 'card_p', dependency_type: 'blocks' }],
            })
            // 3) explicit card links
            .mockResolvedValueOnce({ rows: [] })
            // 4a) comment counts
            .mockResolvedValueOnce({ rows: [{ card_id: 'card_p', cnt: 2 }] })
            // 4b) note counts
            .mockResolvedValueOnce({ rows: [] })
            // 5) mission_notes
            .mockResolvedValueOnce({ rows: [] })
            // 5b) explicit note/card links
            .mockResolvedValueOnce({ rows: [] })
            // 6) mindmap_node_anchors
            .mockResolvedValueOnce({ rows: [] });

        const res = await request(app).get('/api/mindmap/graph' + AUTH);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.meta.schemaVersion).toBe(1);
        expect(res.body.meta.scope).toBe('device');
        expect(res.body.meta.layoutStorageKey).toBe('mindmap:force-layout:v1:dev-1:device:owner');

        const ids = res.body.graph.nodes.map(n => n.id);
        expect(ids).toContain('task:card_p');
        expect(ids).toContain('task:card_c');
        // Owner nodes for entities 1, 2, 5 (and reviewer 1)
        expect(ids).toContain('owner:1');
        expect(ids).toContain('owner:2');
        expect(ids).toContain('owner:5');

        const types = res.body.graph.links.map(l => l.type);
        expect(types).toContain('parent');
        expect(types).toContain('blocks');
        expect(types).toContain('owner');
        expect(res.body.stats.edgeCounts.parent).toBe(1);
        expect(res.body.stats.edgeCounts.blocks).toBe(1);
    });

    test('entity scope: layout key + entityId in meta', async () => {
        mockQuery.mockReset();
        mockQuery
            .mockResolvedValueOnce({ rows: [] }) // cards
            // No deps query when cards.length === 0 (route short-circuits)
            .mockResolvedValueOnce({ rows: [] }) // mission_notes
            .mockResolvedValueOnce({ rows: [] }); // anchors

        const res = await request(app)
            .get('/api/mindmap/graph?deviceId=dev-1&botSecret=bot-2&entityId=2');
        expect(res.status).toBe(200);
        expect(res.body.meta.scope).toBe('entity');
        expect(res.body.meta.entityId).toBe(2);
        expect(res.body.meta.layoutStorageKey).toBe('mindmap:force-layout:v1:dev-1:entity:2');
    });

    test('chat_anchor edge surfaces when card has chat_anchor_message_id', async () => {
        mockQuery.mockReset();
        mockQuery
            .mockResolvedValueOnce({
                rows: [{
                    id: 'card_a', title: 'pinned', description: '', priority: 'P1', status: 'todo',
                    parent_card_id: null, is_automation: false,
                    assigned_bots: [], created_by: 0, reviewer_entity_id: null,
                    chat_anchor_message_id: 'msg-xyz', archived: false, updated_at: null,
                }],
            })
            .mockResolvedValueOnce({ rows: [] }) // deps
            .mockResolvedValueOnce({ rows: [] }) // explicit card links
            .mockResolvedValueOnce({ rows: [] }) // comment counts
            .mockResolvedValueOnce({ rows: [] }) // note counts
            .mockResolvedValueOnce({ rows: [] }) // mission notes
            .mockResolvedValueOnce({ rows: [] }) // explicit note/card links
            .mockResolvedValueOnce({ rows: [] }); // anchors

        const res = await request(app).get('/api/mindmap/graph' + AUTH);
        expect(res.status).toBe(200);
        const chatNode = res.body.graph.nodes.find(n => n.id === 'chat:msg-xyz');
        expect(chatNode).toBeTruthy();
        const chatEdge = res.body.graph.links.find(l => l.type === 'chat_anchor');
        expect(chatEdge).toBeTruthy();
        expect(chatEdge.source).toBe('task:card_a');
        expect(chatEdge.target).toBe('chat:msg-xyz');
        expect(chatEdge.evidence).toBe('kanban_cards.chat_anchor_message_id');
    });

    test('explicit card links are projected into force-graph edges', async () => {
        mockQuery.mockReset();
        mockQuery
            .mockResolvedValueOnce({
                rows: [
                    { id: 'card_a', title: 'A', description: '', priority: 'P1', status: 'todo', parent_card_id: null, is_automation: false, assigned_bots: [], created_by: 0, reviewer_entity_id: null, chat_anchor_message_id: null, archived: false, updated_at: null },
                    { id: 'card_b', title: 'B', description: '', priority: 'P1', status: 'todo', parent_card_id: null, is_automation: false, assigned_bots: [], created_by: 0, reviewer_entity_id: null, chat_anchor_message_id: null, archived: false, updated_at: null },
                ],
            })
            .mockResolvedValueOnce({ rows: [] }) // deps
            .mockResolvedValueOnce({ rows: [{ source_card_id: 'card_a', target_card_id: 'card_b', relation_type: 'references' }] }) // explicit card links
            .mockResolvedValueOnce({ rows: [] }) // comment counts
            .mockResolvedValueOnce({ rows: [] }) // note counts
            .mockResolvedValueOnce({ rows: [] }) // mission notes
            .mockResolvedValueOnce({ rows: [] }) // explicit note/card links
            .mockResolvedValueOnce({ rows: [] }); // anchors

        const res = await request(app).get('/api/mindmap/graph' + AUTH);
        expect(res.status).toBe(200);
        const edge = res.body.graph.links.find(l => l.type === 'references');
        expect(edge).toMatchObject({
            source: 'task:card_a',
            target: 'task:card_b',
            evidence: 'kanban_card_links',
            directional: true,
        });
        expect(res.body.stats.edgeCounts.references).toBe(1);
    });

    test('explicit note/card links are projected into graph output', async () => {
        mockQuery.mockReset();
        mockQuery
            .mockResolvedValueOnce({
                rows: [{
                    id: 'card_a', title: 'A', description: '', priority: 'P1', status: 'todo',
                    parent_card_id: null, is_automation: false,
                    assigned_bots: [], created_by: 0, reviewer_entity_id: null,
                    chat_anchor_message_id: null, archived: false, updated_at: null,
                }],
            })
            .mockResolvedValueOnce({ rows: [] }) // deps
            .mockResolvedValueOnce({ rows: [] }) // explicit card links
            .mockResolvedValueOnce({ rows: [] }) // comment counts
            .mockResolvedValueOnce({ rows: [] }) // note counts
            .mockResolvedValueOnce({ rows: [{ id: 'note_a', title: 'N', content: '', category: 'general', created_by: '2', updated_at: null }] }) // mission notes
            .mockResolvedValueOnce({ rows: [{ note_id: 'note_a', card_id: 'card_a' }] }) // explicit note/card links
            .mockResolvedValueOnce({ rows: [] }); // anchors

        const res = await request(app).get('/api/mindmap/graph' + AUTH);
        expect(res.status).toBe(200);
        const edge = res.body.graph.links.find(l => l.type === 'note_on_card');
        expect(edge).toMatchObject({
            source: 'note:note_a',
            target: 'task:card_a',
            evidence: 'mission_note_card_links',
        });
        expect(res.body.stats.edgeCounts.note_on_card).toBe(1);
    });

    test('503 when pool unset (initMindmapTables not run)', async () => {
        // Fresh module without initMindmapTables — pool stays null.
        const isolated = express();
        isolated.use(express.json());
        const mod = require('../../mindmap')(devices);
        isolated.use('/api/mindmap', mod.router);
        const res = await request(isolated).get('/api/mindmap/graph' + AUTH);
        expect(res.status).toBe(503);
    });
});
