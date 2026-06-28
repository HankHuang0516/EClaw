/**
 * 計畫E ratify-loop WIRING tests (card_e9d01b6e).
 *
 * Two integration seams on top of the pure ratify-reversibility.js predicate:
 *
 *  1. recomputeRatifyMode (PUT handler): SERVER-authoritative — never trusts the
 *     agent's claimed `mode`; re-derives it fail-closed AND applies the N-cap from
 *     the immutable audit trail. Stamps armedAt only on default_agree.
 *
 *  2. runRatifyPass (worker): DARK-LAUNCH (action_request_ratify_enabled !== true ⇒
 *     no-op / no query). When enabled, resolves only planE default_agree rows past
 *     their armedAt silence grace, RE-RUNNING the green-light fail-closed at fire
 *     time; any drift ⇒ HOLD (never resolves). Failure-isolated.
 */
'use strict';

const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockPoolQuery,
        connect: jest.fn().mockResolvedValue({ query: mockPoolQuery, release: jest.fn() }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const factory = require('../../agent-action-requests');
const { recomputeRatifyMode, ratifyInputFrom, MAX_RATIFY_RETRIES } = factory;

const deviceId = 'dev-1';
const UUID = '11111111-2222-3333-4444-555555555555';
const PR = 'https://github.com/HankHuang0516/EClaw/pull/9999';

afterEach(() => { mockPoolQuery.mockReset(); mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 }); });

// ───────────────────────── recomputeRatifyMode (PUT seam) ─────────────────────────
describe('recomputeRatifyMode — server-authoritative mode + audit-trail N-cap', () => {
    // a stub client whose audit-count query returns `n` prior default_agree arms.
    const clientWithArms = (n) => ({ query: jest.fn().mockResolvedValue({ rows: [{ n }] }) });

    const cleanRatify = (over = {}) => ({
        planE: true,
        decidedOptionLabel: 'use the friendlier copy',
        reversibilityClass: 'copy_text',
        changedFiles: ['backend/public/portal/chat.html'],
        diffSummary: '- old\n+ new friendlier copy',
        prUrl: PR,
        mode: 'default_agree', // agent-claimed — must be IGNORED and recomputed
        ...over,
    });

    test('a clean reversible proposal with 0 prior arms ⇒ default_agree + armedAt stamped', async () => {
        const out = await recomputeRatifyMode(clientWithArms(0), UUID, 'tweak copy', cleanRatify(), 1700);
        expect(out.mode).toBe('default_agree');
        expect(out.serverComputed).toBe(true);
        expect(out.armedAt).toBe(1700);
        expect(out.priorArms).toBe(0);
    });

    test('NEVER trusts the agent-claimed mode: claimed default_agree but danger path ⇒ hold', async () => {
        const out = await recomputeRatifyMode(
            clientWithArms(0), UUID, 'touch auth',
            cleanRatify({ reversibilityClass: 'reversible_code_branch', changedFiles: ['backend/auth.js'], mode: 'default_agree' }),
            1700,
        );
        expect(out.mode).toBe('hold');
        expect(out.armedAt).toBeNull();
        expect(out.holdReasons.join(';')).toMatch(/danger_path/);
    });

    test('owner-decision veto in the proposal forces hold even when the agent claims default_agree', async () => {
        const out = await recomputeRatifyMode(
            clientWithArms(0), UUID, '加預算升級付費訂閱方案',
            cleanRatify({ decidedOptionLabel: '核准付費' }), 1700,
        );
        expect(out.mode).toBe('hold');
        expect(out.holdReasons.join(';')).toMatch(/owner_decision_veto/);
    });

    test('N-cap: at MAX_RATIFY_RETRIES prior arms, a would-be default_agree is forced to hold', async () => {
        const out = await recomputeRatifyMode(clientWithArms(MAX_RATIFY_RETRIES), UUID, 'tweak copy', cleanRatify(), 1700);
        expect(out.mode).toBe('hold');
        expect(out.armedAt).toBeNull();
        expect(out.holdReasons.join(';')).toMatch(/retry_cap_reached/);
    });

    test('N-cap boundary: exactly MAX-1 prior arms still permits default_agree', async () => {
        const out = await recomputeRatifyMode(clientWithArms(MAX_RATIFY_RETRIES - 1), UUID, 'tweak copy', cleanRatify(), 1700);
        expect(out.mode).toBe('default_agree');
    });

    // 計畫E adjustable N-cap (card_c3d48c4607ee753b2c98e04b): the cap is now a device
    // pref passed as maxAttempts (clamped [1,5]). FAILS on old code (hardcoded 2).
    test('N-cap honors the pref: cap=1 ⇒ 1 prior arm already holds', async () => {
        const out = await recomputeRatifyMode(clientWithArms(1), UUID, 'tweak copy', cleanRatify(), 1700, 1);
        expect(out.mode).toBe('hold');
        expect(out.holdReasons.join(';')).toMatch(/retry_cap_reached:1\/1/);
    });

    test('N-cap honors the pref: cap=4 ⇒ 3 prior arms still permits default_agree', async () => {
        const out = await recomputeRatifyMode(clientWithArms(3), UUID, 'tweak copy', cleanRatify(), 1700, 4);
        expect(out.mode).toBe('default_agree');
    });

    test('N-cap pref clamped: junk maxAttempts → default cap 2; out-of-range high → 5', async () => {
        const junk = await recomputeRatifyMode(clientWithArms(MAX_RATIFY_RETRIES), UUID, 'tweak copy', cleanRatify(), 1700, 'nonsense');
        expect(junk.mode).toBe('hold'); // junk → cap 2; 2 prior arms ⇒ hold
        const high = await recomputeRatifyMode(clientWithArms(4), UUID, 'tweak copy', cleanRatify(), 1700, 99);
        expect(high.mode).toBe('default_agree'); // 99 clamped to 5; 4 prior < 5
    });

    test('fail-closed retry-count-unavailable uses the (clamped) pref cap, not the const', async () => {
        const client = { query: jest.fn().mockRejectedValue(new Error('db down')) };
        const out = await recomputeRatifyMode(client, UUID, 'tweak copy', cleanRatify(), 1700, 4);
        expect(out.mode).toBe('hold');
        expect(out.priorArms).toBe(4); // fail-closed: priorArms set to the cap (4), not 2
        expect(out.holdReasons.join(';')).toMatch(/retry_count_unavailable/);
    });

    test('fail-closed when the audit count query throws (count unavailable ⇒ hold)', async () => {
        const client = { query: jest.fn().mockRejectedValue(new Error('db down')) };
        const out = await recomputeRatifyMode(client, UUID, 'tweak copy', cleanRatify(), 1700);
        expect(out.mode).toBe('hold');
        expect(out.holdReasons.join(';')).toMatch(/retry_count_unavailable/);
    });

    test('ratifyInputFrom maps the ratify block + prompt into the predicate input shape', () => {
        const inp = ratifyInputFrom('the proposal', { decidedOptionLabel: 'go', reversibilityClass: 'doc', prUrl: PR });
        expect(inp.proposalText).toBe('the proposal');
        expect(inp.decidedOptionLabel).toBe('go');
        expect(inp.reversibilityClass).toBe('doc');
        expect(inp.prUrl).toBe(PR);
    });
});

// ───────────────────────── runRatifyPass (worker seam) ─────────────────────────
function buildModule({ prefs } = {}) {
    const emitToRoom = jest.fn();
    const io = { to: jest.fn(() => ({ emit: emitToRoom })) };
    const unifiedPush = jest.fn().mockResolvedValue({ pushed: true });
    const pushToBot = jest.fn().mockResolvedValue({ pushed: true });
    const getDevicePrefs = jest.fn().mockResolvedValue(prefs);
    const dev = {
        [deviceId]: {
            deviceSecret: 'sek',
            entities: { 1: { isBound: true, botSecret: 'bot-1', bindingType: 'channel' } },
        },
    };
    const mod = factory(dev, { serverLog: () => {}, io, unifiedPush, pushToBot, getDevicePrefs });
    return { mod, emitToRoom, unifiedPush };
}

// a pending row whose decision_context.ratify is armed default_agree.
function ratifyRow(over = {}, ratifyOver = {}) {
    return {
        id: UUID, device_id: deviceId, from_entity_id: 1, anchor_message_id: null,
        type: 'decision', prompt: 'ship the friendlier copy?', options: null,
        status: 'pending', answer: null,
        created_at: new Date('2026-06-01T00:00:00Z'), resolved_at: null, consensus_triggered_at: null,
        decision_context: {
            ratify: {
                planE: true, mode: 'default_agree', decidedOptionLabel: 'ship it',
                reversibilityClass: 'copy_text', changedFiles: ['backend/public/portal/chat.html'],
                diffSummary: '+ friendlier copy', prUrl: PR, armedAt: 1000, ...ratifyOver,
            },
        },
        ...over,
    };
}

describe('runRatifyPass via enforceActionRequestTimeouts — dark launch + fire-time fail-closed', () => {
    // 計畫E default-ON (card_c3d48c4607ee753b2c98e04b): an UNSET pref now RUNS the
    // ratify pass (it issues the candidate SELECT). FAILS on old dark-launch code
    // (which returned before querying when ratify_enabled !== true).
    test('DEFAULT-ON: ratify_enabled UNSET ⇒ the ratify pass RUNS (candidate SELECT issued, no auto-write on empty)', async () => {
        const { mod } = buildModule({ prefs: { action_request_timeout_policy: 'keep' } });
        mockPoolQuery.mockResolvedValueOnce({ rows: [{ device_id: deviceId }] }); // scan; candidate SELECT → default empty rows
        await mod.enforceActionRequestTimeouts();
        expect(mockPoolQuery.mock.calls[0][0]).toMatch(/SELECT DISTINCT device_id/);
        // default-ON: the ratify candidate SELECT DID run (was skipped under dark-launch)
        expect(mockPoolQuery.mock.calls.find(c => /ratify,planE/.test(c[0]))).toBeDefined();
        // nothing to resolve (no candidate rows) ⇒ no auto-act write
        expect(mockPoolQuery.mock.calls.filter(c => /UPDATE agent_action_requests/.test(c[0]))).toHaveLength(0);
    });

    // Explicit OFF is the ONLY way to disable the worker post-flip.
    test('EXPLICIT OFF: ratify_enabled=false ⇒ no ratify query at all (device scan only, policy=keep)', async () => {
        const { mod } = buildModule({ prefs: { action_request_ratify_enabled: false, action_request_timeout_policy: 'keep' } });
        mockPoolQuery.mockResolvedValueOnce({ rows: [{ device_id: deviceId }] }); // scan
        await mod.enforceActionRequestTimeouts();
        expect(mockPoolQuery.mock.calls[0][0]).toMatch(/SELECT DISTINCT device_id/);
        expect(mockPoolQuery.mock.calls.find(c => /ratify,planE/.test(c[0]))).toBeUndefined();
        expect(mockPoolQuery.mock.calls.filter(c => /UPDATE agent_action_requests/.test(c[0]))).toHaveLength(0);
    });

    test('enabled + default_agree row past grace ⇒ resolve with reason ratify_default_agree', async () => {
        const { mod, emitToRoom, unifiedPush } = buildModule({
            prefs: { action_request_ratify_enabled: true, action_request_ratify_grace_minutes: 1, action_request_timeout_policy: 'keep' },
        });
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ device_id: deviceId }] })                 // scan
            .mockResolvedValueOnce({ rows: [ratifyRow()] })                             // ratify candidate SELECT (armedAt=1000, far in the past)
            .mockResolvedValueOnce({ rows: [ratifyRow({ status: 'resolved', resolved_at: new Date() })] }); // resolve UPDATE
        await mod.enforceActionRequestTimeouts();

        // candidate SELECT filters on planE + mode=default_agree
        expect(mockPoolQuery.mock.calls[1][0]).toMatch(/ratify,planE/);
        expect(mockPoolQuery.mock.calls[1][0]).toMatch(/ratify,mode/);
        // the resolve UPDATE carried the ratify answer payload
        const resolveCall = mockPoolQuery.mock.calls[2];
        expect(resolveCall[0]).toMatch(/SET status = 'resolved'/);
        const answer = JSON.parse(resolveCall[1][0]);
        expect(answer.reason).toBe('ratify_default_agree');
        expect(answer.auto).toBe(true);
        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed', { kind: 'resolved', requestId: UUID, fromEntityId: 1 });
        expect(unifiedPush.mock.calls.some(c => /RESOLVED/.test(c[3].message))).toBe(true);
    });

    test('enabled but row NOT past grace (armedAt recent) ⇒ no resolve', async () => {
        const recent = Date.now() - 1000; // 1s ago, grace is 1440min default
        const { mod, emitToRoom } = buildModule({ prefs: { action_request_ratify_enabled: true, action_request_timeout_policy: 'keep' } });
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ device_id: deviceId }] })
            .mockResolvedValueOnce({ rows: [ratifyRow({}, { armedAt: recent })] });
        await mod.enforceActionRequestTimeouts();
        // candidate SELECT ran but nothing resolved (armedAt too recent)
        expect(mockPoolQuery.mock.calls.filter(c => /UPDATE agent_action_requests/.test(c[0]))).toHaveLength(0);
        expect(emitToRoom).not.toHaveBeenCalled();
    });

    test('FIRE-TIME fail-closed: armed default_agree but danger path now ⇒ HOLD, no resolve', async () => {
        const { mod, emitToRoom } = buildModule({
            prefs: { action_request_ratify_enabled: true, action_request_ratify_grace_minutes: 1, action_request_timeout_policy: 'keep' },
        });
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ device_id: deviceId }] })
            .mockResolvedValueOnce({ rows: [ratifyRow({}, { reversibilityClass: 'reversible_code_branch', changedFiles: ['backend/auth.js'] })] });
        await mod.enforceActionRequestTimeouts();
        // re-derive at fire time HOLDs → no resolve UPDATE
        expect(mockPoolQuery.mock.calls.filter(c => /UPDATE agent_action_requests/.test(c[0]))).toHaveLength(0);
        expect(emitToRoom).not.toHaveBeenCalled();
    });

    test('ratify pass is failure-isolated: a throwing candidate SELECT does not abort the sweep', async () => {
        const { mod } = buildModule({ prefs: { action_request_ratify_enabled: true, action_request_timeout_policy: 'keep' } });
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ device_id: deviceId }] }) // scan
            .mockRejectedValueOnce(new Error('boom'));                  // ratify SELECT throws
        // keep policy means nothing else runs; the point is it does not throw out of the sweep
        await expect(mod.enforceActionRequestTimeouts()).resolves.toBeUndefined();
    });
});

// ───────────────────────── device-preferences coercion ─────────────────────────
describe('device-preferences: ratify pref coercion (dark-launch safe)', () => {
    const devicePrefs = require('../../device-preferences');

    // ⚠️ default-ON global flip (card_c3d48c4607ee753b2c98e04b): was `false`.
    test('DEFAULTS: ratify DEFAULT-ON + 1440-min grace + 2 max-attempts', () => {
        expect(devicePrefs.DEFAULTS.action_request_ratify_enabled).toBe(true);
        expect(devicePrefs.DEFAULTS.action_request_ratify_grace_minutes).toBe(1440);
        expect(devicePrefs.DEFAULTS.action_request_ratify_max_attempts).toBe(2);
    });

    test('action_request_ratify_enabled string-safe: only true/`true` enable; `false`/junk stay off', async () => {
        const written = [];
        const stubPool = { query: jest.fn((sql, params) => { written.push({ sql, params }); return Promise.resolve({ rows: [] }); }) };
        await devicePrefs.initTable(stubPool);
        const readBack = () => JSON.parse(written[written.length - 1].params[1]);
        const cases = [[true, true], ['true', true], [false, false], ['false', false], ['nonsense', false], [1, false]];
        for (const [input, expected] of cases) {
            written.length = 0;
            await devicePrefs.updatePrefs(deviceId, { action_request_ratify_enabled: input });
            expect(readBack().action_request_ratify_enabled).toBe(expected);
        }
    });

    test('action_request_ratify_grace_minutes clamps [5,43200]; invalid → 1440', async () => {
        const written = [];
        const stubPool = { query: jest.fn((sql, params) => { written.push({ sql, params }); return Promise.resolve({ rows: [] }); }) };
        await devicePrefs.initTable(stubPool);
        const readBack = () => JSON.parse(written[written.length - 1].params[1]);
        const cases = [[1, 5], [5, 5], [60, 60], [99999, 43200], ['120', 120], ['oops', 1440], [null, 1440]];
        for (const [input, expected] of cases) {
            written.length = 0;
            await devicePrefs.updatePrefs(deviceId, { action_request_ratify_grace_minutes: input });
            expect(readBack().action_request_ratify_grace_minutes).toBe(expected);
        }
    });

    // 計畫E adjustable N-cap (card_c3d48c4607ee753b2c98e04b): GET/PUT round-trip of the
    // new pref through the persistence coercion. FAILS on old code (key not in DEFAULTS
    // ⇒ updatePrefs filters it out ⇒ readBack has no such key).
    test('action_request_ratify_max_attempts clamps [1,5]; invalid → 2', async () => {
        const written = [];
        const stubPool = { query: jest.fn((sql, params) => { written.push({ sql, params }); return Promise.resolve({ rows: [] }); }) };
        await devicePrefs.initTable(stubPool);
        const readBack = () => JSON.parse(written[written.length - 1].params[1]);
        const cases = [[1, 1], [5, 5], [0, 1], [99, 5], [3, 3], ['4', 4], ['oops', 2], [null, 2]];
        for (const [input, expected] of cases) {
            written.length = 0;
            await devicePrefs.updatePrefs(deviceId, { action_request_ratify_max_attempts: input });
            expect(readBack().action_request_ratify_max_attempts).toBe(expected);
        }
    });
});

// ───────────────────────── worker-side defensive clamps ─────────────────────────
// 計畫E adjustable params (card_c3d48c4607ee753b2c98e04b): the worker re-clamps both
// tunables so a junk/out-of-range pref can never disable the N-cap or fire the timer
// too eagerly. FAILS on old code (these exports did not exist).
describe('agent-action-requests: ratify tunable clamps', () => {
    const { clampRatifyMaxAttempts, clampRatifyGraceMinutes } = factory;

    test('clampRatifyMaxAttempts: [1,5], junk/undefined → default 2', () => {
        expect(clampRatifyMaxAttempts(1)).toBe(1);
        expect(clampRatifyMaxAttempts(5)).toBe(5);
        expect(clampRatifyMaxAttempts(0)).toBe(1);    // below floor → clamp up
        expect(clampRatifyMaxAttempts(99)).toBe(5);   // above ceiling → clamp down
        expect(clampRatifyMaxAttempts('3')).toBe(3);
        expect(clampRatifyMaxAttempts('junk')).toBe(2);
        expect(clampRatifyMaxAttempts(undefined)).toBe(2);
        expect(clampRatifyMaxAttempts(null)).toBe(2);
    });

    test('clampRatifyGraceMinutes: [60,10080], junk/undefined → default 1440', () => {
        expect(clampRatifyGraceMinutes(60)).toBe(60);
        expect(clampRatifyGraceMinutes(10080)).toBe(10080);
        expect(clampRatifyGraceMinutes(1)).toBe(60);        // below floor → 1h floor
        expect(clampRatifyGraceMinutes(99999)).toBe(10080); // above ceiling → 7d cap
        expect(clampRatifyGraceMinutes('120')).toBe(120);
        expect(clampRatifyGraceMinutes('junk')).toBe(1440);
        expect(clampRatifyGraceMinutes(undefined)).toBe(1440);
    });
});
