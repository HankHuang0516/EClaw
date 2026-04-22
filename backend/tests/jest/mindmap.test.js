/**
 * /api/mindmap/traverse — Phase 4 AI reasoning endpoint.
 *
 * Covers validation (missing creds, invalid UUIDs, empty question), the
 * ANTHROPIC_API_KEY-absent 503 short-circuit, and a happy path driven by
 * an isolated mindmap module instance with a stubbed pool + callAnthropic.
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await request(app).post('/api/device/register').set('Host', 'localhost')
        .send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

const SAMPLE_UUID = '11111111-2222-3333-4444-555555555555';

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

describe('POST /api/mindmap/traverse — input validation', () => {
    it('400 when deviceId missing', async () => {
        const res = await post('/api/mindmap/traverse').send({
            root_node_id: SAMPLE_UUID,
            question: 'why?',
        });
        expect(res.status).toBe(400);
    });

    it('401 when deviceId has no matching device record', async () => {
        // Dual-auth rejects unknown deviceId with 401 before the 400
        // "missing secret" check — match the existing behavior of the
        // authenticate() helper (same as other mindmap endpoints).
        const res = await post('/api/mindmap/traverse').send({
            deviceId: 'x',
            root_node_id: SAMPLE_UUID,
            question: 'why?',
        });
        expect(res.status).toBe(401);
    });

    it('401 for invalid device credentials', async () => {
        const res = await post('/api/mindmap/traverse').send({
            deviceId: 'mindmap-bogus-device',
            deviceSecret: 'wrong',
            root_node_id: SAMPLE_UUID,
            question: 'why?',
        });
        expect(res.status).toBe(401);
    });

    it('400 for non-UUID root_node_id (after auth)', async () => {
        const deviceSecret = await registerDevice('mindmap-traverse-invalid-uuid');
        const res = await post('/api/mindmap/traverse').send({
            deviceId: 'mindmap-traverse-invalid-uuid',
            deviceSecret,
            root_node_id: 'not-a-uuid',
            question: 'why?',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/root_node_id/);
    });

    it('400 when question is empty/whitespace', async () => {
        const deviceSecret = await registerDevice('mindmap-traverse-empty-q');
        const res = await post('/api/mindmap/traverse').send({
            deviceId: 'mindmap-traverse-empty-q',
            deviceSecret,
            root_node_id: SAMPLE_UUID,
            question: '   ',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/question/i);
    });
});

describe('POST /api/mindmap/traverse — AI availability gate', () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;

    beforeAll(() => { delete process.env.ANTHROPIC_API_KEY; });
    afterAll(() => {
        if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = savedKey;
    });

    it('503 when ANTHROPIC_API_KEY is not set', async () => {
        const deviceSecret = await registerDevice('mindmap-traverse-nokey');
        const res = await post('/api/mindmap/traverse').send({
            deviceId: 'mindmap-traverse-nokey',
            deviceSecret,
            root_node_id: SAMPLE_UUID,
            question: 'why?',
        });
        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/ANTHROPIC_API_KEY/);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Happy path: isolate the mindmap module so we can drive it with a custom
// pool + mocked anthropic-client. This bypasses the top-level Express app
// so the DB stubs in mock-setup don't interfere.
// ─────────────────────────────────────────────────────────────────────────
describe('mindmap /traverse — happy path (isolated module)', () => {
    const ROOT_ID = '11111111-1111-4111-8111-111111111111';
    const CHILD_ID = '22222222-2222-4222-8222-222222222222';
    const EDGE_ID = '33333333-3333-4333-8333-333333333333';
    const DEVICE_ID = 'happy-dev';
    const DEVICE_SECRET = 'happy-secret';

    let createMindmapModule;
    let callAnthropicMock;
    let poolQueryMock;
    let router;
    let express;
    let supertest;
    let testApp;

    beforeEach(() => {
        process.env.ANTHROPIC_API_KEY = 'test-key';

        jest.isolateModules(() => {
            callAnthropicMock = jest.fn().mockResolvedValue({
                content: [{ type: 'text', text: 'The root explains the child via relates_to [22222222].' }],
            });
            jest.doMock('../../anthropic-client', () => ({
                callAnthropic: callAnthropicMock,
            }));
            createMindmapModule = require('../../mindmap');
            express = require('express');
            supertest = require('supertest');
        });

        poolQueryMock = jest.fn(async (sql, params) => {
            const norm = sql.replace(/\s+/g, ' ').trim();
            // Auth seed check: SELECT id FROM mindmap_nodes WHERE id=$1 AND device_id=$2
            if (/SELECT id FROM mindmap_nodes WHERE id = \$1 AND device_id = \$2/i.test(norm)) {
                if (params[0] === ROOT_ID && params[1] === DEVICE_ID) {
                    return { rowCount: 1, rows: [{ id: ROOT_ID }] };
                }
                return { rowCount: 0, rows: [] };
            }
            // BFS edge fetch
            if (/FROM mindmap_edges\s+WHERE device_id = \$1\s+AND \(source_node_id/i.test(norm)) {
                return {
                    rowCount: 1,
                    rows: [{
                        id: EDGE_ID,
                        device_id: DEVICE_ID,
                        source_node_id: ROOT_ID,
                        target_node_id: CHILD_ID,
                        edge_type: 'relates_to',
                        weight: 1.0,
                    }],
                };
            }
            // Node detail fetch (title/summary/node_type)
            if (/SELECT id, title, summary, node_type FROM mindmap_nodes/i.test(norm)) {
                return {
                    rowCount: 2,
                    rows: [
                        { id: ROOT_ID, title: 'Root', summary: 'anchor', node_type: 'topic' },
                        { id: CHILD_ID, title: 'Child', summary: 'leaf', node_type: 'leaf' },
                    ],
                };
            }
            return { rowCount: 0, rows: [] };
        });

        const devices = {
            [DEVICE_ID]: { deviceSecret: DEVICE_SECRET, entities: {} },
        };
        const module = createMindmapModule(devices);
        router = module.router;
        module.initMindmapTables({ query: poolQueryMock });

        testApp = express();
        testApp.use(express.json());
        testApp.use('/api/mindmap', router);
    });

    afterEach(() => {
        jest.resetModules();
        delete process.env.ANTHROPIC_API_KEY;
    });

    it('returns an AI answer referencing visited nodes', async () => {
        const res = await supertest(testApp)
            .post('/api/mindmap/traverse')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                root_node_id: ROOT_ID,
                question: 'How does the root relate to its child?',
                depth: 1,
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.root).toBe(ROOT_ID);
        expect(res.body.depth).toBe(1);
        expect(res.body.node_count).toBe(2);
        expect(res.body.edge_count).toBe(1);
        expect(res.body.visited_node_ids).toEqual(expect.arrayContaining([ROOT_ID, CHILD_ID]));
        expect(res.body.answer).toContain('relates_to');

        // Anthropic call payload sanity: the serialized subgraph must mention
        // both node short-ids and the edge relation so the prompt actually
        // contains the graph context.
        expect(callAnthropicMock).toHaveBeenCalledTimes(1);
        const [systemPrompt, messages] = callAnthropicMock.mock.calls[0];
        expect(systemPrompt).toMatch(/mindmap subgraph/i);
        expect(messages[0].role).toBe('user');
        expect(messages[0].content).toContain('[11111111]');
        expect(messages[0].content).toContain('[22222222]');
        expect(messages[0].content).toContain('--(relates_to)-->');
        expect(messages[0].content).toContain('How does the root relate');
    });

    it('404 when root node does not belong to device', async () => {
        const res = await supertest(testApp)
            .post('/api/mindmap/traverse')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                root_node_id: '99999999-9999-4999-8999-999999999999',
                question: 'ghost?',
            });
        expect(res.status).toBe(404);
        expect(callAnthropicMock).not.toHaveBeenCalled();
    });

    it('clamps depth above MAX_TRAVERSE_DEPTH back to MAX', async () => {
        const res = await supertest(testApp)
            .post('/api/mindmap/traverse')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                root_node_id: ROOT_ID,
                question: 'why?',
                depth: 99,
            });
        expect(res.status).toBe(200);
        expect(res.body.depth).toBe(4); // MAX_TRAVERSE_DEPTH
    });
});
