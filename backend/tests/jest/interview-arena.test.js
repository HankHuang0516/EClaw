/**
 * Interview Arena — unit tests for challenge generators, scoring engines, and API endpoints.
 */

// Mock pg before requiring the module
jest.mock('pg', () => {
    const state = { exams: [], sessions: [], leaderboard: [], feedback: [], listings: [], interviews: [] };
    globalThis.__arenaState = state;

    function runQuery(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();
        if (/^CREATE/i.test(norm)) return { rows: [], rowCount: 0 };
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(norm)) return { rows: [], rowCount: 0 };

        // INSERT exam
        if (/INSERT INTO arena_exams/i.test(norm)) {
            const row = {
                id: params[0] || ('exam-' + (state.exams.length + 1)),
                exam_token: params[1] || params[0],
                listing_id: params[2] || null,
                status: params[3] || 'waiting',
                max_score: params[4] || 147,
                model: null,
                created_at: new Date(), expires_at: null,
            };
            state.exams.push(row);
            return { rows: [row], rowCount: 1 };
        }
        // INSERT session (batch: 12 sessions × 6 params each = 72 params)
        if (/INSERT INTO arena_sessions/i.test(norm)) {
            const rows = [];
            const stride = 6;
            for (let i = 0; i + stride <= params.length; i += stride) {
                const row = {
                    id: 'sess-' + (state.sessions.length + 1),
                    exam_id: params[i], session_token: params[i+1],
                    test_type: params[i+2], test_index: params[i+3],
                    challenge_config: typeof params[i+4] === 'string' ? JSON.parse(params[i+4]) : params[i+4],
                    max_score: params[i+5], status: 'pending',
                    actions_log: [],
                };
                state.sessions.push(row);
                rows.push(row);
            }
            return { rows, rowCount: rows.length };
        }
        // SELECT session by token
        if (/FROM arena_sessions s.*WHERE s\.session_token/i.test(norm)) {
            const s = state.sessions.find(s => s.session_token === params[0]);
            if (!s) return { rows: [], rowCount: 0 };
            const e = state.exams.find(e => e.id === s.exam_id);
            return { rows: [{ ...s, exam_status: e?.status, expires_at: e?.expires_at || new Date(Date.now() + 60000) }], rowCount: 1 };
        }
        // UPDATE session
        if (/UPDATE arena_sessions SET/i.test(norm)) {
            return { rows: [], rowCount: 1 };
        }
        // UPDATE exam
        if (/UPDATE arena_exams/i.test(norm)) {
            const e = state.exams.find(e => e.id === params[0]);
            if (e) {
                if (/SET status = 'completed'/i.test(norm) || /SET status = 'completed'/i.test(norm)) {
                    e.status = 'completed';
                    e.total_score = params[1];
                    e.report = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
                    e.completed_at = e.completed_at || new Date('2026-04-13T01:36:18Z');
                } else if (/SET status = \$2/i.test(norm)) {
                    e.status = params[1];
                }
            }
            return { rows: [], rowCount: e ? 1 : 0 };
        }
        // SELECT linked exam + listing for finalize sync
        if (/FROM arena_exams e\s+LEFT JOIN bot_listings l/i.test(norm)) {
            const e = state.exams.find(e => e.id === params[0]);
            if (!e) return { rows: [], rowCount: 0 };
            const l = state.listings.find(l => l.id === e.listing_id) || {};
            return { rows: [{ ...e, ...l, id: e.id, listing_id: e.listing_id }], rowCount: 1 };
        }
        // SELECT latest completed linked exam + listing for backfill
        if (/FROM arena_exams e\s+JOIN bot_listings l/i.test(norm)) {
            const rows = state.exams
                .filter(e => e.status === 'completed' && e.listing_id)
                .map(e => {
                    const l = state.listings.find(l => l.id === e.listing_id);
                    return l ? { ...e, ...l, id: e.id, listing_id: e.listing_id } : null;
                })
                .filter(Boolean);
            return { rows, rowCount: rows.length };
        }
        // SELECT exam
        if (/FROM arena_exams WHERE id/i.test(norm)) {
            const e = state.exams.find(e => e.id === params[0]);
            return { rows: e ? [e] : [], rowCount: e ? 1 : 0 };
        }
        // UPDATE bot_listings from finalize sync
        if (/UPDATE bot_listings SET/i.test(norm)) {
            const l = state.listings.find(l => l.id === params[0]);
            if (l) {
                l.interview_passed = params[1];
                l.capabilities = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
                l.benchmark_score = typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3];
                l.model_detected = params[4] || l.model_detected;
                l.last_interview_at = new Date('2026-04-13T01:36:18Z');
            }
            return { rows: [], rowCount: l ? 1 : 0 };
        }
        // INSERT bot interview audit row
        if (/INSERT INTO bot_interviews/i.test(norm)) {
            state.interviews.push({ listing_id: params[0], passed: params[3], score: params[4] });
            return { rows: [], rowCount: 1 };
        }
        // SELECT sessions for exam
        if (/FROM arena_sessions WHERE exam_id/i.test(norm)) {
            const rows = state.sessions.filter(s => s.exam_id === params[0]);
            return { rows, rowCount: rows.length };
        }
        // INSERT leaderboard
        if (/INSERT INTO arena_leaderboard/i.test(norm)) {
            state.leaderboard.push({ name: params[1], score: params[3] });
            return { rows: [], rowCount: 1 };
        }
        // COUNT leaderboard (used by reset-leaderboard)
        if (/SELECT COUNT.*FROM arena_leaderboard/i.test(norm)) {
            return { rows: [{ n: state.leaderboard.length }], rowCount: 1 };
        }
        // TRUNCATE leaderboard (reset-leaderboard)
        if (/TRUNCATE TABLE arena_leaderboard/i.test(norm)) {
            state.leaderboard.length = 0;
            return { rows: [], rowCount: 0 };
        }
        // SELECT leaderboard
        if (/FROM arena_leaderboard/i.test(norm)) {
            return { rows: state.leaderboard, rowCount: state.leaderboard.length };
        }
        // INSERT feedback
        if (/INSERT INTO arena_feedback/i.test(norm)) {
            state.feedback.push({ exam_id: params[0] });
            return { rows: [], rowCount: 1 };
        }
        // SELECT feedback
        if (/FROM arena_feedback/i.test(norm)) {
            return { rows: state.feedback, rowCount: state.feedback.length };
        }
        return { rows: [], rowCount: 0 };
    }

    const mockPool = { query: jest.fn((sql, params) => runQuery(sql, params)) };
    return { Pool: jest.fn(() => mockPool) };
});

const { TEST_TYPES, MAX_TOTAL_SCORE, SCORING_ENGINES, CHALLENGE_GENERATORS } = require('../../interview-arena');

describe('interview-arena: constants', () => {
    test('has 12 test types', () => {
        expect(TEST_TYPES).toHaveLength(12);
    });

    test('MAX_TOTAL_SCORE is 147', () => {
        expect(MAX_TOTAL_SCORE).toBe(147);
    });

    test('each test type has required fields', () => {
        for (const t of TEST_TYPES) {
            expect(t).toHaveProperty('id');
            expect(t).toHaveProperty('category');
            expect(t).toHaveProperty('weight');
            expect(t).toHaveProperty('name');
            expect(t).toHaveProperty('reference');
        }
    });
});

describe('interview-arena: challenge generators', () => {
    test('all 12 generators exist and return objects', () => {
        for (const t of TEST_TYPES) {
            const gen = CHALLENGE_GENERATORS[t.id];
            expect(gen).toBeDefined();
            const config = gen();
            expect(typeof config).toBe('object');
        }
    });

    test('vision challenge has expectedKeywords', () => {
        const c = CHALLENGE_GENERATORS.arena_vision();
        expect(Array.isArray(c.expectedKeywords)).toBe(true);
        expect(c.expectedKeywords.length).toBeGreaterThan(0);
    });

    test('button_click challenge has correctLabel and buttonCount', () => {
        const c = CHALLENGE_GENERATORS.arena_button_click();
        expect(c.correctLabel).toMatch(/^Order #\d+$/);
        expect(c.buttonCount).toBe(200);
        expect(typeof c.correctIndex).toBe('number');
    });

    test('form_fill challenge has 5-7 fields', () => {
        const c = CHALLENGE_GENERATORS.arena_form_fill();
        expect(c.fields.length).toBeGreaterThanOrEqual(5);
        expect(c.fields.length).toBeLessThanOrEqual(7);
        for (const f of c.fields) {
            expect(f).toHaveProperty('name');
            expect(f).toHaveProperty('type');
            expect(f).toHaveProperty('expectedValue');
        }
    });

    test('drag_drop challenge has positions', () => {
        const c = CHALLENGE_GENERATORS.arena_drag_drop();
        expect(c.sourcePosition).toHaveProperty('x');
        expect(c.targetRect).toHaveProperty('x');
        expect(c.targetRect).toHaveProperty('w');
    });

    test('navigation challenge has correctPath and depth', () => {
        const c = CHALLENGE_GENERATORS.arena_navigation();
        expect(c.correctPath.length).toBe(4);
        expect(c.depth).toBe(4);
    });

    test('table_extract challenge has tableData and question', () => {
        const c = CHALLENGE_GENERATORS.arena_table_extract();
        expect(c.tableData.length).toBe(10);
        expect(c.question).toContain('total revenue');
        expect(c.correctAnswer).toBeTruthy();
    });

    test('coding challenge has title, description, testCases', () => {
        const c = CHALLENGE_GENERATORS.arena_coding();
        expect(c.title).toBeTruthy();
        expect(c.testCases.length).toBeGreaterThan(0);
    });

    test('response_time challenge has question and keywords', () => {
        const c = CHALLENGE_GENERATORS.arena_response_time();
        expect(c.question).toBeTruthy();
        expect(c.expectedKeywords.length).toBeGreaterThan(0);
    });

    test('tts challenge has text and keywords', () => {
        const c = CHALLENGE_GENERATORS.arena_tts();
        expect(c.text).toBeTruthy();
        expect(c.keywords.length).toBeGreaterThan(0);
    });
});

describe('interview-arena: scoring engines', () => {
    test('vision: full marks for correct keywords', () => {
        const config = { weight: 15, expectedKeywords: ['red', 'circle'] };
        const actions = [
            { actionType: 'page_loaded' },
            { actionType: 'description_submitted', payload: { text: 'A red circle on white background' } },
        ];
        const result = SCORING_ENGINES.arena_vision(config, actions);
        // page_loaded (10% of 15 = 2) + both keywords (90% of 15 = 14) = 16 (capped by rounding)
        expect(result.score).toBeGreaterThanOrEqual(14);
    });

    test('vision: partial for some keywords', () => {
        const config = { weight: 15, expectedKeywords: ['red', 'circle'] };
        const actions = [
            { actionType: 'page_loaded' },
            { actionType: 'description_submitted', payload: { text: 'A red shape' } },
        ];
        const result = SCORING_ENGINES.arena_vision(config, actions);
        expect(result.score).toBeGreaterThan(0);
        expect(result.score).toBeLessThan(15);
    });

    test('button_click: correct click = full score', () => {
        const config = { weight: 15, correctLabel: 'Order #1234' };
        const actions = [{ actionType: 'button_clicked', payload: { buttonLabel: 'Order #1234' } }];
        expect(SCORING_ENGINES.arena_button_click(config, actions).score).toBe(15);
    });

    test('button_click: wrong click = 0', () => {
        const config = { weight: 15, correctLabel: 'Order #1234' };
        const actions = [{ actionType: 'button_clicked', payload: { buttonLabel: 'Order #9999' } }];
        expect(SCORING_ENGINES.arena_button_click(config, actions).score).toBe(0);
    });

    test('form_fill: all correct = full score', () => {
        const config = {
            weight: 15,
            fields: [
                { name: 'name', type: 'text', expectedValue: 'John' },
                { name: 'agree', type: 'checkbox', expectedValue: true },
            ],
        };
        const actions = [{
            actionType: 'form_submitted',
            payload: { fields: { name: 'John', agree: true } },
        }];
        expect(SCORING_ENGINES.arena_form_fill(config, actions).score).toBe(15);
    });

    test('drag_drop: correct drop = full score', () => {
        const config = { weight: 12, targetRect: { x: 400, y: 100, w: 150, h: 150 } };
        const actions = [{ actionType: 'element_dragged', payload: { dropX: 450, dropY: 150 } }];
        expect(SCORING_ENGINES.arena_drag_drop(config, actions).score).toBe(12);
    });

    test('drag_drop: wrong drop = partial', () => {
        const config = { weight: 12, targetRect: { x: 400, y: 100, w: 150, h: 150 } };
        const actions = [{ actionType: 'element_dragged', payload: { dropX: 100, dropY: 100 } }];
        const result = SCORING_ENGINES.arena_drag_drop(config, actions);
        expect(result.score).toBeGreaterThan(0);
        expect(result.score).toBeLessThan(12);
    });

    test('distraction: real click + no fake = full score', () => {
        const config = { weight: 10, realButtonId: 'real-1', fakeButtonIds: ['fake-1', 'fake-2'] };
        const actions = [{ actionType: 'button_clicked', payload: { buttonId: 'real-1' } }];
        expect(SCORING_ENGINES.arena_distraction(config, actions).score).toBe(10);
    });

    test('distraction: clicked fake = penalty', () => {
        const config = { weight: 10, realButtonId: 'real-1', fakeButtonIds: ['fake-1'] };
        const actions = [
            { actionType: 'button_clicked', payload: { buttonId: 'fake-1' } },
            { actionType: 'button_clicked', payload: { buttonId: 'real-1' } },
        ];
        const result = SCORING_ENGINES.arena_distraction(config, actions);
        expect(result.score).toBeLessThan(10);
    });

    test('coding: self-reported testResults are untrusted → 0 + pending flag', () => {
        // Anti-cheat: bots used to POST {testResults:[true,true,...]} and
        // collect full marks. Until a real sandboxed executor lands we
        // award 0 and surface server_side_execution_pending:true so
        // downstream reporting can explain why.
        const config = { weight: 15, testCases: [{}, {}, {}] };
        const actions = [{ actionType: 'code_submitted', payload: { testResults: [true, true, true] } }];
        const r = SCORING_ENGINES.arena_coding(config, actions);
        expect(r.score).toBe(0);
        expect(r.maxScore).toBe(15);
        expect(r.server_side_execution_pending).toBe(true);
        expect(r.claimedPassed).toBe(3);
        expect(r.totalTests).toBe(3);
    });

    test('coding: empty submission = 0 + pending flag', () => {
        const config = { weight: 15, testCases: [{}, {}, {}] };
        const r = SCORING_ENGINES.arena_coding(config, []);
        expect(r.score).toBe(0);
        expect(r.server_side_execution_pending).toBe(true);
    });

    test('navigation: target_found with matching serial = full score', () => {
        const config = { weight: 13, depth: 4, targetInfo: 'Serial: 8AF0C1B3' };
        const actions = [
            { actionType: 'page_navigated', payload: { depth: 4 } },
            { actionType: 'target_found', payload: { targetInfo: '8af0c1b3' } },
        ];
        expect(SCORING_ENGINES.arena_navigation(config, actions).score).toBe(13);
    });

    test('navigation: target_found with exact "Serial: X" string = full score', () => {
        const config = { weight: 13, depth: 4, targetInfo: 'Serial: 8AF0C1B3' };
        const actions = [
            { actionType: 'target_found', payload: { targetInfo: 'Serial: 8AF0C1B3' } },
        ];
        expect(SCORING_ENGINES.arena_navigation(config, actions).score).toBe(13);
    });

    test('navigation: target_found with bare empty payload = 0 (no depth)', () => {
        const config = { weight: 13, depth: 4, targetInfo: 'Serial: 8AF0C1B3' };
        const actions = [{ actionType: 'target_found', payload: {} }];
        expect(SCORING_ENGINES.arena_navigation(config, actions).score).toBe(0);
    });

    test('navigation: target_found with WRONG serial = 0 (no depth)', () => {
        const config = { weight: 13, depth: 4, targetInfo: 'Serial: 8AF0C1B3' };
        const actions = [{ actionType: 'target_found', payload: { targetInfo: 'DEADBEEF' } }];
        expect(SCORING_ENGINES.arena_navigation(config, actions).score).toBe(0);
    });

    test('navigation: partial depth credit when target not found', () => {
        const config = { weight: 13, depth: 4, targetInfo: 'Serial: 8AF0C1B3' };
        const actions = [
            { actionType: 'page_navigated', payload: { depth: 2 } },
        ];
        const r = SCORING_ENGINES.arena_navigation(config, actions);
        expect(r.score).toBeGreaterThan(0);
        expect(r.score).toBeLessThan(13);
    });

    test('response_time: correct + fast = full score', () => {
        const config = { weight: 10, expectedKeywords: ['paris'] };
        const actions = [{ actionType: 'answer_submitted', payload: { answer: 'Paris', elapsed_ms: 3000 } }];
        expect(SCORING_ENGINES.arena_response_time(config, actions).score).toBe(10);
    });

    test('memory: correct = full score', () => {
        const config = { weight: 10, expectedAnswer: 'red' };
        const actions = [{ actionType: 'answer_submitted', payload: { answer: 'red' } }];
        expect(SCORING_ENGINES.arena_memory(config, actions).score).toBe(10);
    });

    test('file_mgmt: full workflow = full score', () => {
        const config = { weight: 12 };
        const actions = [
            { actionType: 'file_downloaded' },
            { actionType: 'file_renamed' },
            { actionType: 'file_uploaded' },
        ];
        expect(SCORING_ENGINES.arena_file_mgmt(config, actions).score).toBe(12);
    });

    test('tts: correct transcription = full score', () => {
        const config = { weight: 10, keywords: ['hello', 'world'] };
        const actions = [{ actionType: 'transcription_submitted', payload: { text: 'Hello World test' } }];
        expect(SCORING_ENGINES.arena_tts(config, actions).score).toBe(10);
    });

    test('all scorers return low or 0 for empty actions', () => {
        for (const t of TEST_TYPES) {
            const scorer = SCORING_ENGINES[t.id];
            const config = { weight: t.weight, expectedKeywords: [], fields: [], testCases: [],
                             correctLabel: 'x', targetRect: { x: 0, y: 0, w: 1, h: 1 },
                             realButtonId: 'x', fakeButtonIds: ['f1'], keywords: [],
                             expectedAnswer: 'x', correctAnswer: '0', depth: 4 };
            const result = scorer(config, []);
            // Most return 0; distraction may give partial for "not clicking fake" but with fake present it won't
            expect(result.score).toBeLessThanOrEqual(t.weight);
            expect(result.maxScore).toBe(t.weight);
        }
    });
});

describe('interview-arena: API endpoints', () => {
    const request = require('supertest');
    const express = require('express');
    const arenaFactory = require('../../interview-arena');
    // Shape must match production device registry (index.js getOrCreateDevice):
    // { deviceId, deviceSecret, entities: { [id]: { botSecret, ... } } }
    const fakeDevices = {
        'dev-alpha': {
            deviceId: 'dev-alpha',
            deviceSecret: 'device-secret-alpha',
            entities: {
                2: { botSecret: 'bot-secret-commander' },
                5: { botSecret: 'bot-secret-helper' },
            },
        },
    };
    const saveDeviceData = jest.fn(async () => {});
    const arenaModule = arenaFactory({ serverLog: () => {}, io: null, devices: fakeDevices, saveDeviceData });
    const app = express();
    app.use(express.json());
    app.use('/api/arena', arenaModule.router);

    beforeEach(() => {
        globalThis.__arenaState.exams = [];
        globalThis.__arenaState.sessions = [];
        globalThis.__arenaState.leaderboard = [];
        globalThis.__arenaState.feedback = [];
        globalThis.__arenaState.listings = [];
        globalThis.__arenaState.interviews = [];
        fakeDevices['dev-alpha'].entities[1] = { isBound: true, botSecret: 'bot-secret-macf', identity: { public: { description: 'Mac_F' } }, agentCard: { description: 'Mac_F' } };
        saveDeviceData.mockClear();
    });

    test('POST /api/arena/exam creates exam with 12 sessions', async () => {
        const res = await request(app).post('/api/arena/exam');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.exam.examToken).toBeTruthy();
        expect(res.body.sessions).toHaveLength(12);
    });

    test('POST /api/arena/exam/:id/finalize syncs linked listing result to owner namecard without leaderboard submit', async () => {
        globalThis.__arenaState.listings.push({
            id: 'listing-macf',
            owner_device_id: 'dev-alpha',
            owner_entity_id: 1,
            interview_passed: false,
        });
        globalThis.__arenaState.exams.push({
            id: 'exam-linked',
            listing_id: 'listing-macf',
            model: 'minimax-portal/MiniMax-M2.7',
            status: 'active',
            max_score: MAX_TOTAL_SCORE,
            created_at: new Date('2026-04-13T01:30:00Z'),
        });
        globalThis.__arenaState.sessions = TEST_TYPES.map((t, idx) => ({
            id: `sess-linked-${idx}`,
            exam_id: 'exam-linked',
            test_type: t.id,
            test_index: idx,
            status: 'completed',
            score: t.weight,
            max_score: t.weight,
            actions_log: [],
        }));

        const res = await request(app).post('/api/arena/exam/exam-linked/finalize');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.interviewSync.entityBinding).toMatchObject({ entityId: 1, score: MAX_TOTAL_SCORE, maxScore: MAX_TOTAL_SCORE, normalized: 100, passed: true });

        const entity = fakeDevices['dev-alpha'].entities[1];
        expect(entity.identity.interviewCapabilities).toMatchObject({ score: MAX_TOTAL_SCORE, maxScore: MAX_TOTAL_SCORE, source: 'arena', examId: 'exam-linked' });
        expect(entity.identity.public.capabilities).toBeTruthy();
        expect(entity.identity.public.capabilities.reasoning.supported).toBe(true);
        expect(entity.agentCard.capabilities).toEqual(entity.identity.public.capabilities);
        expect(saveDeviceData).toHaveBeenCalledWith('dev-alpha', fakeDevices['dev-alpha']);
        expect(globalThis.__arenaState.leaderboard).toHaveLength(0);
    });

    test('backfillArenaEntityBindings repairs already-completed linked exams', async () => {
        const capMap = { reasoning: { supported: true, probes: [{ id: 'arena_memory', score: 10, maxScore: 10 }] } };
        globalThis.__arenaState.listings.push({
            id: 'listing-old',
            owner_device_id: 'dev-alpha',
            owner_entity_id: 1,
            interview_passed: true,
            capabilities: capMap,
            benchmark_score: { normalizedScore: 97 },
        });
        globalThis.__arenaState.exams.push({
            id: 'exam-old',
            listing_id: 'listing-old',
            model: 'minimax-portal/MiniMax-M2.7',
            status: 'completed',
            total_score: 142,
            max_score: 147,
            report: {},
            completed_at: new Date('2026-04-13T01:36:18Z'),
            created_at: new Date('2026-04-13T01:30:00Z'),
        });

        const result = await arenaModule.backfillArenaEntityBindings();
        expect(result).toMatchObject({ scanned: 1, updated: 1, skipped: 0 });
        const entity = fakeDevices['dev-alpha'].entities[1];
        expect(entity.identity.interviewCapabilities).toMatchObject({ score: 142, maxScore: 147, normalized: 97, source: 'arena' });
        expect(entity.identity.public.capabilities).toEqual(capMap);
        expect(saveDeviceData).toHaveBeenCalledTimes(1);
    });

    test('POST /api/arena/feedback stores feedback', async () => {
        const res = await request(app).post('/api/arena/feedback')
            .send({ desiredCapabilities: ['Code Execution'], credibilityScore: 7, comment: 'Great test!' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('POST /api/arena/feedback rejects invalid credibility', async () => {
        const res = await request(app).post('/api/arena/feedback')
            .send({ credibilityScore: 15 });
        expect(res.status).toBe(400);
    });

    test('GET /api/arena/leaderboard returns entries', async () => {
        const res = await request(app).get('/api/arena/leaderboard');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.leaderboard)).toBe(true);
    });

    describe('POST /api/arena/admin/reset-leaderboard', () => {
        test('rejects request without admin token', async () => {
            const prev = process.env.ADMIN_SECRET;
            process.env.ADMIN_SECRET = 'test-admin-secret';
            try {
                const res = await request(app).post('/api/arena/admin/reset-leaderboard');
                expect(res.status).toBe(403);
                expect(res.body.error).toBe('forbidden');
            } finally {
                if (prev === undefined) delete process.env.ADMIN_SECRET;
                else process.env.ADMIN_SECRET = prev;
            }
        });

        test('wipes leaderboard and returns deleted count', async () => {
            const prev = process.env.ADMIN_SECRET;
            process.env.ADMIN_SECRET = 'test-admin-secret';
            try {
                globalThis.__arenaState.leaderboard.push(
                    { name: 'Alice', score: 120 },
                    { name: 'Bob',   score: 95  },
                    { name: 'Carol', score: 80  },
                );
                const res = await request(app)
                    .post('/api/arena/admin/reset-leaderboard')
                    .set('x-admin-token', 'test-admin-secret');
                expect(res.status).toBe(200);
                expect(res.body.success).toBe(true);
                expect(res.body.deletedCount).toBe(3);
                expect(res.body.table).toBe('arena_leaderboard');
                expect(globalThis.__arenaState.leaderboard).toHaveLength(0);
            } finally {
                if (prev === undefined) delete process.env.ADMIN_SECRET;
                else process.env.ADMIN_SECRET = prev;
            }
        });

        test('returns zero deletedCount on already-empty leaderboard', async () => {
            const prev = process.env.ADMIN_SECRET;
            process.env.ADMIN_SECRET = 'test-admin-secret';
            try {
                const res = await request(app)
                    .post('/api/arena/admin/reset-leaderboard')
                    .set('x-admin-token', 'test-admin-secret');
                expect(res.status).toBe(200);
                expect(res.body.deletedCount).toBe(0);
            } finally {
                if (prev === undefined) delete process.env.ADMIN_SECRET;
                else process.env.ADMIN_SECRET = prev;
            }
        });

        test('accepts deviceId + deviceSecret (device owner auth)', async () => {
            const prev = process.env.ADMIN_SECRET;
            delete process.env.ADMIN_SECRET;
            try {
                globalThis.__arenaState.leaderboard.push({ name: 'Z', score: 5 });
                const res = await request(app)
                    .post('/api/arena/admin/reset-leaderboard')
                    .send({ deviceId: 'dev-alpha', deviceSecret: 'device-secret-alpha' });
                expect(res.status).toBe(200);
                expect(res.body.deletedCount).toBe(1);
            } finally {
                if (prev !== undefined) process.env.ADMIN_SECRET = prev;
            }
        });

        test('accepts deviceId + botSecret + entityId (bot auth)', async () => {
            const prev = process.env.ADMIN_SECRET;
            delete process.env.ADMIN_SECRET;
            try {
                globalThis.__arenaState.leaderboard.push({ name: 'Y', score: 3 });
                const res = await request(app)
                    .post('/api/arena/admin/reset-leaderboard')
                    .send({ deviceId: 'dev-alpha', entityId: 2, botSecret: 'bot-secret-commander' });
                expect(res.status).toBe(200);
                expect(res.body.deletedCount).toBe(1);
            } finally {
                if (prev !== undefined) process.env.ADMIN_SECRET = prev;
            }
        });

        test('rejects wrong deviceSecret', async () => {
            const prev = process.env.ADMIN_SECRET;
            process.env.ADMIN_SECRET = 'unused';
            try {
                const res = await request(app)
                    .post('/api/arena/admin/reset-leaderboard')
                    .send({ deviceId: 'dev-alpha', deviceSecret: 'wrong' });
                expect(res.status).toBe(403);
            } finally {
                if (prev === undefined) delete process.env.ADMIN_SECRET;
                else process.env.ADMIN_SECRET = prev;
            }
        });

        test('rejects unknown deviceId', async () => {
            const prev = process.env.ADMIN_SECRET;
            process.env.ADMIN_SECRET = 'unused';
            try {
                const res = await request(app)
                    .post('/api/arena/admin/reset-leaderboard')
                    .send({ deviceId: 'dev-nope', botSecret: 'anything', entityId: 2 });
                expect(res.status).toBe(403);
            } finally {
                if (prev === undefined) delete process.env.ADMIN_SECRET;
                else process.env.ADMIN_SECRET = prev;
            }
        });

        test('does not touch exams/sessions/feedback', async () => {
            const prev = process.env.ADMIN_SECRET;
            process.env.ADMIN_SECRET = 'test-admin-secret';
            try {
                globalThis.__arenaState.exams.push({ id: 'exam-keep', status: 'completed' });
                globalThis.__arenaState.sessions.push({ id: 'sess-keep', exam_id: 'exam-keep' });
                globalThis.__arenaState.feedback.push({ exam_id: 'exam-keep' });
                globalThis.__arenaState.leaderboard.push({ name: 'X', score: 1 });

                const res = await request(app)
                    .post('/api/arena/admin/reset-leaderboard')
                    .set('x-admin-token', 'test-admin-secret');
                expect(res.status).toBe(200);
                expect(globalThis.__arenaState.leaderboard).toHaveLength(0);
                expect(globalThis.__arenaState.exams).toHaveLength(1);
                expect(globalThis.__arenaState.sessions).toHaveLength(1);
                expect(globalThis.__arenaState.feedback).toHaveLength(1);
            } finally {
                if (prev === undefined) delete process.env.ADMIN_SECRET;
                else process.env.ADMIN_SECRET = prev;
            }
        });

        test('rejects empty-string deviceSecret (safeEqual falsy guard)', async () => {
            const prev = process.env.ADMIN_SECRET;
            process.env.ADMIN_SECRET = 'unused';
            try {
                const res = await request(app)
                    .post('/api/arena/admin/reset-leaderboard')
                    .send({ deviceId: 'dev-alpha', deviceSecret: '' });
                expect(res.status).toBe(403);
                expect(res.body.error).toBe('forbidden');
            } finally {
                if (prev === undefined) delete process.env.ADMIN_SECRET;
                else process.env.ADMIN_SECRET = prev;
            }
        });

        test('rejects localhost when ADMIN_SECRET is configured (no implicit bypass)', async () => {
            const prev = process.env.ADMIN_SECRET;
            process.env.ADMIN_SECRET = 'test-admin-secret';
            try {
                // supertest defaults to 127.0.0.1, but ADMIN_SECRET is set so
                // the "no secret configured" localhost fallback must NOT fire.
                const res = await request(app).post('/api/arena/admin/reset-leaderboard');
                expect(res.status).toBe(403);
                expect(res.body.error).toBe('forbidden');
            } finally {
                if (prev === undefined) delete process.env.ADMIN_SECRET;
                else process.env.ADMIN_SECRET = prev;
            }
        });
    });
});

// ── Arena → Rental capability mapping ──────────────────────────────

describe('Arena: mapArenaResultToCapabilities', () => {
    const { mapArenaResultToCapabilities, ARENA_PASS_THRESHOLD, TEST_TYPES, MAX_TOTAL_SCORE } = require('../../interview-arena');

    test('maps arena report to rental-compatible capabilities', () => {
        const report = {
            totalScore: 100,
            maxScore: MAX_TOTAL_SCORE,
            detail: TEST_TYPES.map(t => ({
                testType: t.id,
                score: Math.round(t.weight * 0.8), // 80% on each
                maxScore: t.weight,
            })),
        };
        const result = mapArenaResultToCapabilities(report);
        expect(result.passed).toBe(true);
        expect(result.normalizedScore).toBeGreaterThan(0);
        expect(result.capabilities.python_exec).toBeDefined();
        expect(result.capabilities.python_exec.supported).toBe(true);
        expect(result.capabilities.web_browse).toBeDefined();
        expect(result.capabilities.vision).toBeDefined();
        expect(result.benchmarkScore.source).toBe('arena');
    });

    test('fails when score below threshold', () => {
        const report = {
            totalScore: 10,
            maxScore: MAX_TOTAL_SCORE,
            detail: TEST_TYPES.map(t => ({ testType: t.id, score: 0, maxScore: t.weight })),
        };
        const result = mapArenaResultToCapabilities(report);
        expect(result.passed).toBe(false);
        expect(result.normalizedScore).toBeLessThan(ARENA_PASS_THRESHOLD * 100);
    });

    test('capability supported only when probe scores >= 50%', () => {
        const report = {
            totalScore: 80,
            maxScore: MAX_TOTAL_SCORE,
            detail: TEST_TYPES.map(t => ({
                testType: t.id,
                // Only coding test passes at 80%, rest at 0%
                score: t.id === 'arena_coding' ? Math.round(t.weight * 0.8) : 0,
                maxScore: t.weight,
            })),
        };
        const result = mapArenaResultToCapabilities(report);
        expect(result.capabilities.python_exec?.supported).toBe(true);
        expect(result.capabilities.web_browse?.supported).toBe(false);
        expect(result.capabilities.vision?.supported).toBe(false);
    });

    test('handles null/empty report gracefully', () => {
        expect(mapArenaResultToCapabilities(null).passed).toBe(false);
        expect(mapArenaResultToCapabilities({}).passed).toBe(false);
        expect(mapArenaResultToCapabilities({ detail: [] }).passed).toBe(false);
    });

    test('probes include source=arena tag', () => {
        const report = {
            totalScore: 100, maxScore: MAX_TOTAL_SCORE,
            detail: [{ testType: 'arena_vision', score: 15, maxScore: 15 }],
        };
        const result = mapArenaResultToCapabilities(report);
        const visionProbe = result.capabilities.vision?.probes?.[0];
        expect(visionProbe?.source).toBe('arena');
        expect(visionProbe?.id).toBe('arena_vision');
    });
});
