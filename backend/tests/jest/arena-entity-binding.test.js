/**
 * Arena → entity binding (card_ad404375).
 *
 * Pure-function tests for buildInterviewIdentityPatch +
 * extractArenaFieldsFromIdentity. The route-level glue itself is
 * exercised indirectly here (these are the only branches that touch
 * persistence-shaped data).
 *
 * Why pure-function only: the existing interview-arena.test.js exercises
 * the full pg-mock harness for the exam lifecycle — duplicating it for
 * the binding leg adds noise without strengthening the contract. The
 * binding behavior reduces cleanly to "given an exam + mapped result,
 * what writes back to identity?", which is a pure function.
 */

// db.js eagerly creates a pg Pool at require-time. Stub it out so the
// test file doesn't try to open a connection.
jest.mock('pg', () => ({ Pool: jest.fn(() => ({ query: jest.fn(), connect: jest.fn() })) }));

const { buildInterviewIdentityPatch } = require('../../interview-arena');
const { extractArenaFieldsFromIdentity } = require('../../db');

describe('buildInterviewIdentityPatch', () => {
    const validExam = {
        id: 'exam-abc',
        model: 'claude-opus-4',
        total_score: 91,
        max_score: 147,
        completed_at: new Date('2026-06-13T12:00:00Z'),
    };
    const validMapped = { passed: true, normalizedScore: 62 };

    test('returns null for missing exam', () => {
        expect(buildInterviewIdentityPatch(null, validMapped)).toBeNull();
    });

    test('returns null for missing mapped result', () => {
        expect(buildInterviewIdentityPatch(validExam, null)).toBeNull();
    });

    test('writes verified score for happy-path exam', () => {
        const patch = buildInterviewIdentityPatch(validExam, validMapped, 1700000000000);
        expect(patch).not.toBeNull();
        expect(patch.interviewCapabilities).toMatchObject({
            score: 91,
            maxScore: 147,
            passed: true,
            model: 'claude-opus-4',
            examId: 'exam-abc',
            source: 'arena',
        });
        // normalized = round(91 / 147 * 100) = 62
        expect(patch.interviewCapabilities.normalized).toBe(62);
        expect(patch.lastInterviewAt).toBe(1700000000000);
    });

    test('clamps negative server-side total_score to 0', () => {
        const patch = buildInterviewIdentityPatch({ ...validExam, total_score: -5 }, validMapped);
        expect(patch.interviewCapabilities.score).toBe(0);
        expect(patch.interviewCapabilities.normalized).toBe(0);
    });

    test('clamps total_score > max_score down to max_score', () => {
        const patch = buildInterviewIdentityPatch({ ...validExam, total_score: 999 }, validMapped);
        expect(patch.interviewCapabilities.score).toBe(147);
        expect(patch.interviewCapabilities.normalized).toBe(100);
    });

    test('rejects non-numeric total_score', () => {
        expect(buildInterviewIdentityPatch({ ...validExam, total_score: 'NaN' }, validMapped)).toBeNull();
    });

    test('rejects zero or negative max_score', () => {
        expect(buildInterviewIdentityPatch({ ...validExam, max_score: 0 }, validMapped)).toBeNull();
        expect(buildInterviewIdentityPatch({ ...validExam, max_score: -10 }, validMapped)).toBeNull();
    });

    test('passed flag follows mapped.passed (not the score itself)', () => {
        const failed = buildInterviewIdentityPatch(validExam, { passed: false });
        expect(failed.interviewCapabilities.passed).toBe(false);
    });

    test('falls back to nowMs when completed_at missing', () => {
        const patch = buildInterviewIdentityPatch({ ...validExam, completed_at: null }, validMapped, 1234567);
        expect(patch.interviewCapabilities.completedAt).toBe(1234567);
        expect(patch.lastInterviewAt).toBe(1234567);
    });

    test('latest-wins: rerunning yields a fresh patch (overwrites prior)', () => {
        const first = buildInterviewIdentityPatch(validExam, validMapped, 1000);
        const second = buildInterviewIdentityPatch(
            { ...validExam, total_score: 120, completed_at: new Date('2026-06-14T12:00:00Z') },
            { passed: true },
            2000
        );
        expect(second.interviewCapabilities.score).toBe(120);
        expect(second.lastInterviewAt).toBeGreaterThan(first.lastInterviewAt);
    });

    test('model is optional — null when missing', () => {
        const patch = buildInterviewIdentityPatch({ ...validExam, model: undefined }, validMapped);
        expect(patch.interviewCapabilities.model).toBeNull();
    });
});

describe('extractArenaFieldsFromIdentity', () => {
    test('returns null fields when identity is null/undefined', () => {
        expect(extractArenaFieldsFromIdentity(null)).toEqual({
            arenaScore: null, arenaMaxScore: null, arenaNormalized: null,
            arenaPassed: null, lastInterviewAt: null,
        });
        expect(extractArenaFieldsFromIdentity(undefined).arenaScore).toBeNull();
    });

    test('returns null fields when identity has no interviewCapabilities', () => {
        const out = extractArenaFieldsFromIdentity({ public: { description: 'hi' } });
        expect(out.arenaScore).toBeNull();
        expect(out.arenaPassed).toBeNull();
    });

    test('preserves lastInterviewAt even when interviewCapabilities missing', () => {
        const out = extractArenaFieldsFromIdentity({ lastInterviewAt: 1700000000000 });
        expect(out.lastInterviewAt).toBe(1700000000000);
        expect(out.arenaScore).toBeNull();
    });

    test('extracts full happy-path block', () => {
        const out = extractArenaFieldsFromIdentity({
            interviewCapabilities: {
                score: 91, maxScore: 147, normalized: 62, passed: true,
                completedAt: 1700000000000,
            },
            lastInterviewAt: 1700000000000,
        });
        expect(out).toEqual({
            arenaScore: 91, arenaMaxScore: 147, arenaNormalized: 62,
            arenaPassed: true, lastInterviewAt: 1700000000000,
        });
    });

    test('drops non-numeric score (defense-in-depth)', () => {
        const out = extractArenaFieldsFromIdentity({
            interviewCapabilities: { score: 'not a number', maxScore: 147 },
        });
        expect(out.arenaScore).toBeNull();
        expect(out.arenaMaxScore).toBe(147);
    });

    test('passed must be strict boolean — string "true" rejected', () => {
        const out = extractArenaFieldsFromIdentity({
            interviewCapabilities: { score: 91, maxScore: 147, passed: 'true' },
        });
        expect(out.arenaPassed).toBeNull();
    });

    test('falls back to identity.lastInterviewAt when ic.completedAt missing', () => {
        const out = extractArenaFieldsFromIdentity({
            interviewCapabilities: { score: 91, maxScore: 147 },
            lastInterviewAt: 1700000999999,
        });
        expect(out.lastInterviewAt).toBe(1700000999999);
    });
});

describe('finalize → entity namecard sync (card_2fd3bac5)', () => {
    // The bug: an exam could complete (finalize updates bot_listings.last_interview_at,
    // so the namecard retest-countdown chip shows) yet leave
    // entity.identity.interviewCapabilities empty — because the identity write only
    // happened in the OPTIONAL, credential-gated POST /api/arena/leaderboard path.
    // The namecard then rendered "尚無 Arena 評測結果" despite a real completed result.
    // The fix writes the verified capabilities to the owner entity's identity during
    // finalize, server-side, via the already-known exam→listing→owner linkage.

    const EXAM_ID = 'exam_test123';
    const DEVICE_ID = 'dev-finalize-1';
    const ENTITY_ID = 1;

    function buildMockPool() {
        return {
            query: jest.fn(async (sql) => {
                const norm = sql.replace(/\s+/g, ' ').trim();
                // sessions for the exam — one completed session worth points
                if (/FROM arena_sessions WHERE exam_id/i.test(norm)) {
                    return {
                        rows: [{
                            id: 'sess-1', exam_id: EXAM_ID, test_type: 'tool_use',
                            test_index: 0, status: 'completed', score: 91, max_score: 147,
                            challenge_config: {}, actions_log: [],
                        }],
                        rowCount: 1,
                    };
                }
                if (/UPDATE arena_exams/i.test(norm)) return { rows: [], rowCount: 1 };
                // exam → listing → owner join (the new query the fix added)
                if (/FROM arena_exams e LEFT JOIN bot_listings l/i.test(norm)) {
                    return {
                        rows: [{
                            id: EXAM_ID, listing_id: 'listing-1', model: 'claude-opus-4',
                            total_score: 91, max_score: 147, completed_at: new Date('2026-06-13T07:43:07Z'),
                            owner_device_id: DEVICE_ID, owner_entity_id: ENTITY_ID,
                        }],
                        rowCount: 1,
                    };
                }
                if (/UPDATE bot_listings/i.test(norm)) return { rows: [], rowCount: 1 };
                if (/INSERT INTO bot_interviews/i.test(norm)) return { rows: [], rowCount: 1 };
                return { rows: [], rowCount: 0 };
            }),
        };
    }

    function findFinalizeRoute(router) {
        return router.stack.find(layer =>
            layer.route &&
            /\/exam\/:examId\/finalize/.test(layer.route.path) &&
            layer.route.methods.post
        ).route.stack[0].handle;
    }

    async function invoke(handler, devices, saveDeviceData) {
        const req = { params: { examId: EXAM_ID }, body: {} };
        let payload = null;
        const res = {
            json: (p) => { payload = p; return res; },
            status: () => res,
        };
        // Allow the fire-and-forget saveDeviceData promise to settle.
        await handler(req, res);
        await new Promise(r => setImmediate(r));
        return payload;
    }

    test('writes interviewCapabilities to the owner entity identity on completion', async () => {
        jest.resetModules();
        const mockPool = buildMockPool();
        jest.doMock('pg', () => ({ Pool: jest.fn(() => mockPool), connect: jest.fn() }));
        const arenaFactory = require('../../interview-arena');

        const entity = { isBound: true, identity: {} };
        const devices = { [DEVICE_ID]: { entities: { [ENTITY_ID]: entity } } };
        const saveDeviceData = jest.fn().mockResolvedValue(true);

        const mod = arenaFactory({ serverLog: () => {}, io: null, devices, saveDeviceData });
        const handler = findFinalizeRoute(mod.router);
        const payload = await invoke(handler, devices, saveDeviceData);

        expect(payload.success).toBe(true);
        // The entity namecard data is now populated — root-cause fix.
        expect(entity.identity.interviewCapabilities).toMatchObject({
            score: 91, maxScore: 147, normalized: 62, source: 'arena', examId: EXAM_ID,
        });
        expect(typeof entity.identity.lastInterviewAt).toBe('number');
        expect(saveDeviceData).toHaveBeenCalledWith(DEVICE_ID, devices[DEVICE_ID]);
        jest.dontMock('pg');
    });

    test('does not throw when owner entity is not in the device registry', async () => {
        jest.resetModules();
        const mockPool = buildMockPool();
        jest.doMock('pg', () => ({ Pool: jest.fn(() => mockPool), connect: jest.fn() }));
        const arenaFactory = require('../../interview-arena');

        // Empty registry — finalize must still succeed (non-blocking identity sync).
        const devices = {};
        const saveDeviceData = jest.fn();
        const mod = arenaFactory({ serverLog: () => {}, io: null, devices, saveDeviceData });
        const handler = findFinalizeRoute(mod.router);
        const payload = await invoke(handler, devices, saveDeviceData);

        expect(payload.success).toBe(true);
        expect(saveDeviceData).not.toHaveBeenCalled();
        jest.dontMock('pg');
    });
});

describe('binding integrity: identity patch never leaks secrets', () => {
    test('patch keys are score-shaped only — no botSecret/deviceSecret/identity-internal', () => {
        const patch = buildInterviewIdentityPatch(
            { id: 'e', model: 'm', total_score: 50, max_score: 100, completed_at: new Date() },
            { passed: true }
        );
        const allowedTop = ['interviewCapabilities', 'lastInterviewAt'];
        expect(Object.keys(patch).sort()).toEqual(allowedTop.sort());
        const ic = patch.interviewCapabilities;
        const allowedIc = ['score', 'maxScore', 'normalized', 'passed', 'model', 'examId', 'completedAt', 'source'].sort();
        expect(Object.keys(ic).sort()).toEqual(allowedIc);
    });
});
