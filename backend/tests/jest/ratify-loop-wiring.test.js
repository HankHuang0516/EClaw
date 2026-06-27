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
    test('DARK LAUNCH: ratify_enabled unset ⇒ no ratify query at all (device scan only, policy=keep)', async () => {
        const { mod } = buildModule({ prefs: { action_request_timeout_policy: 'keep' } });
        mockPoolQuery.mockResolvedValueOnce({ rows: [{ device_id: deviceId }] }); // scan
        await mod.enforceActionRequestTimeouts();
        // only the DISTINCT scan ran — ratify pass returned before querying, keep skipped the rest
        expect(mockPoolQuery).toHaveBeenCalledTimes(1);
        expect(mockPoolQuery.mock.calls[0][0]).toMatch(/SELECT DISTINCT device_id/);
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
        // scan + candidate SELECT only; no resolve UPDATE
        expect(mockPoolQuery).toHaveBeenCalledTimes(2);
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
        expect(mockPoolQuery).toHaveBeenCalledTimes(2);
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

    test('DEFAULTS: ratify disabled + 1440-min grace', () => {
        expect(devicePrefs.DEFAULTS.action_request_ratify_enabled).toBe(false);
        expect(devicePrefs.DEFAULTS.action_request_ratify_grace_minutes).toBe(1440);
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
});
