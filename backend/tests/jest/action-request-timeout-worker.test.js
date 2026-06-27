/**
 * Tests for the "需要你" action-request TIMEOUT-POLICY worker (card_ce0d685b).
 *
 *  device-preferences:
 *    - action_request_timeout_policy coerces to keep|auto_dismiss|safe_default|
 *      consensus, default keep; the removed 'escalate' now coerces to keep.
 *    - action_request_timeout_minutes clamps to [5, 43200] + defaults to 1440.
 *
 *  worker (enforceActionRequestTimeouts), pg mocked:
 *    - auto_dismiss → dismiss UPDATE + emitChanged('dismissed') + emitter push.
 *    - safe_default → resolveActionRequest(safe-default answer) → kind='resolved'.
 *    - consensus    → stamp consensus_triggered_at + broadcast bot-to-bot prompt +
 *      emitChanged('consensus_triggered'); does NOT resolve. A request that
 *      already has consensus_triggered_at is skipped (WHERE excludes it).
 *    - keep         → no DB writes (device skipped entirely).
 *    - the SELECT carries the timeout-minutes interval + status='pending'.
 */

const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockPoolQuery,
        connect: jest.fn().mockResolvedValue({ query: mockPoolQuery, release: jest.fn() }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const deviceId = 'dev-1';
const UUID = '11111111-2222-3333-4444-555555555555';

function buildModule({ prefs, devices } = {}) {
    const emitToRoom = jest.fn();
    const io = { to: jest.fn(() => ({ emit: emitToRoom })) };
    const unifiedPush = jest.fn().mockResolvedValue({ pushed: true });
    const pushToBot = jest.fn().mockResolvedValue({ pushed: true });
    const getDevicePrefs = jest.fn().mockResolvedValue(prefs);
    const factory = require('../../agent-action-requests');
    const dev = devices || {
        [deviceId]: {
            deviceSecret: 'sek',
            entities: {
                1: { isBound: true, botSecret: 'bot-1', bindingType: 'channel' },
                2: { isBound: true, botSecret: 'bot-2', bindingType: 'channel' },
            },
        },
    };
    const mod = factory(dev, { serverLog: () => {}, io, unifiedPush, pushToBot, getDevicePrefs });
    return { mod, io, emitToRoom, unifiedPush, pushToBot, getDevicePrefs };
}

function pendingRow(over = {}) {
    return {
        id: UUID, device_id: deviceId, from_entity_id: 1, anchor_message_id: null,
        type: 'decision', prompt: '要不要上線?', options: null,
        status: 'pending', answer: null,
        created_at: new Date('2026-06-01T00:00:00Z'), resolved_at: null,
        consensus_triggered_at: null, ...over,
    };
}

afterEach(() => { mockPoolQuery.mockReset(); mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 }); });

// ───────────────────────────── device-preferences ─────────────────────────────
describe('device-preferences: action_request_timeout_* coercion', () => {
    const devicePrefs = require('../../device-preferences');

    test('DEFAULTS: policy=keep, minutes=1440', () => {
        expect(devicePrefs.DEFAULTS.action_request_timeout_policy).toBe('keep');
        expect(devicePrefs.DEFAULTS.action_request_timeout_minutes).toBe(1440);
    });

    test('policy coerces to keep|auto_dismiss|safe_default|consensus; escalate→keep; junk→keep', async () => {
        const written = [];
        const stubPool = { query: jest.fn((sql, params) => { written.push({ sql, params }); return Promise.resolve({ rows: [] }); }) };
        await devicePrefs.initTable(stubPool);

        const readBack = () => JSON.parse(written[written.length - 1].params[1]);
        const cases = [
            ['keep', 'keep'],
            ['auto_dismiss', 'auto_dismiss'],
            ['safe_default', 'safe_default'],
            ['consensus', 'consensus'],
            ['escalate', 'keep'],   // removed value → default
            ['nonsense', 'keep'],
            [42, 'keep'],
        ];
        for (const [input, expected] of cases) {
            written.length = 0;
            await devicePrefs.updatePrefs(deviceId, { action_request_timeout_policy: input });
            expect(readBack().action_request_timeout_policy).toBe(expected);
        }
    });

    test('需要你 negotiation prefs: defaults + clamps (window/synth-grace/min-entities)', async () => {
        // defaults
        expect(devicePrefs.DEFAULTS.consensus_window_minutes).toBe(30);
        expect(devicePrefs.DEFAULTS.consensus_synthesis_grace_minutes).toBe(360);
        expect(devicePrefs.DEFAULTS.consensus_min_entities).toBe(2);

        const written = [];
        const stubPool = { query: jest.fn((sql, params) => { written.push({ sql, params }); return Promise.resolve({ rows: [] }); }) };
        await devicePrefs.initTable(stubPool);
        const readBack = () => JSON.parse(written[written.length - 1].params[1]);
        const cases = [
            ['consensus_window_minutes', 0, 1],          // below min → clamp up
            ['consensus_window_minutes', 30, 30],
            ['consensus_window_minutes', 99999, 1440],   // above max → clamp down
            ['consensus_window_minutes', 'oops', 30],    // NaN → default
            ['consensus_synthesis_grace_minutes', 1, 5], // below min
            ['consensus_synthesis_grace_minutes', 360, 360],
            ['consensus_synthesis_grace_minutes', 99999, 43200], // above max
            ['consensus_synthesis_grace_minutes', 'x', 360],     // NaN → default
            ['consensus_min_entities', 1, 2],            // below min
            ['consensus_min_entities', 5, 5],
            ['consensus_min_entities', 99, 20],          // above max
            ['consensus_min_entities', 'nope', 2],       // NaN → default
        ];
        for (const [key, input, expected] of cases) {
            written.length = 0;
            await devicePrefs.updatePrefs(deviceId, { [key]: input });
            expect(readBack()[key]).toBe(expected);
        }
    });

    test('minutes clamps to [5,43200], parses ints, defaults invalid → 1440', async () => {
        const written = [];
        const stubPool = { query: jest.fn((sql, params) => { written.push({ sql, params }); return Promise.resolve({ rows: [] }); }) };
        await devicePrefs.initTable(stubPool);
        const readBack = () => JSON.parse(written[written.length - 1].params[1]);

        const cases = [
            [1, 5],            // below min → clamp up
            [4, 5],
            [5, 5],
            [60, 60],
            [43200, 43200],
            [99999, 43200],    // above max → clamp down
            ['120', 120],      // parseInt string
            ['30abc', 30],     // parseInt-style
            ['oops', 1440],    // NaN → default
            [null, 1440],
        ];
        for (const [input, expected] of cases) {
            written.length = 0;
            await devicePrefs.updatePrefs(deviceId, { action_request_timeout_minutes: input });
            expect(readBack().action_request_timeout_minutes).toBe(expected);
        }
    });
});

// ───────────────────────────── worker ─────────────────────────────
// The worker now runs, per device, BEFORE the policy/keep gate: a 計畫E ratify
// pass (no-op unless ratify_enabled) and a POLICY-INDEPENDENT negotiation
// ADVANCE pass (T2 close SELECT + T3b fallback SELECT). consensus policy OPENS
// rounds via a dedicated backstop (no created_at age clause). To stay robust to
// that internal query order we route the pg mock by SQL content rather than by a
// brittle ordered Once-chain; each test supplies only the rows it cares about.
function routeMock({ scan = [], timeoutSelect = [], t2Select = [], t3bSelect = [], backstopSelect = [], onUpdate } = {}) {
    mockPoolQuery.mockImplementation(async (sql) => {
        const s = String(sql);
        if (/SELECT DISTINCT device_id/.test(s)) return { rows: scan };
        if (/SELECT \* FROM agent_action_requests/.test(s)) {
            if (/consensus_collect_at IS NULL/.test(s) && /consensus_triggered_at < NOW/.test(s)) return { rows: t2Select };
            if (/consensus_collect_at IS NOT NULL/.test(s)) return { rows: t3bSelect };
            if (/jsonb_array_length/.test(s)) return { rows: backstopSelect };
            if (/created_at < NOW/.test(s)) return { rows: timeoutSelect };
            return { rows: [] };
        }
        if (/UPDATE agent_action_requests/.test(s)) return onUpdate ? onUpdate(s) : { rows: [] };
        return { rows: [] };
    });
}

describe('enforceActionRequestTimeouts', () => {
    test('policy=keep → no auto-act writes (advance pass runs but writes nothing)', async () => {
        const { mod, emitToRoom } = buildModule({ prefs: { action_request_timeout_policy: 'keep', action_request_timeout_minutes: 1440 } });
        routeMock({ scan: [{ device_id: deviceId }] });
        await mod.enforceActionRequestTimeouts();
        // keep skips the timeout SELECT + every auto-act write; the negotiation
        // advance pass runs but its SELECTs return empty → no UPDATE/resolve/dismiss.
        const writes = mockPoolQuery.mock.calls.filter(c => /UPDATE agent_action_requests/.test(c[0]));
        expect(writes).toHaveLength(0);
        expect(emitToRoom).not.toHaveBeenCalled();
    });

    test('the timeout SELECT carries the timeout-minutes interval + status=pending', async () => {
        const { mod } = buildModule({ prefs: { action_request_timeout_policy: 'auto_dismiss', action_request_timeout_minutes: 90 } });
        routeMock({ scan: [{ device_id: deviceId }], timeoutSelect: [] });
        await mod.enforceActionRequestTimeouts();
        const selectCall = mockPoolQuery.mock.calls.find(c => /SELECT \* FROM agent_action_requests/.test(c[0]) && /created_at < NOW/.test(c[0]));
        expect(selectCall[0]).toMatch(/status = 'pending'/);
        expect(selectCall[0]).toMatch(/created_at < NOW\(\) - \(\$2 \* interval '1 minute'\)/);
        expect(selectCall[1]).toEqual([deviceId, 90]);
    });

    test('auto_dismiss → dismiss UPDATE + emitChanged(dismissed) + emitter push', async () => {
        const { mod, emitToRoom, unifiedPush } = buildModule({ prefs: { action_request_timeout_policy: 'auto_dismiss', action_request_timeout_minutes: 1440 } });
        routeMock({
            scan: [{ device_id: deviceId }],
            timeoutSelect: [pendingRow()],
            onUpdate: () => ({ rows: [pendingRow({ status: 'dismissed', resolved_at: new Date() })] }),
        });
        await mod.enforceActionRequestTimeouts();

        const updateCall = mockPoolQuery.mock.calls.find(c => /UPDATE agent_action_requests/.test(c[0]) && /SET status = 'dismissed'/.test(c[0]));
        expect(updateCall[0]).toMatch(/WHERE id = \$1 AND status = 'pending'/);
        expect(updateCall[1]).toEqual([UUID]);

        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed', { kind: 'dismissed', requestId: UUID, fromEntityId: 1 });
        const pushed = unifiedPush.mock.calls.find(c => /逾時自動略過/.test(c[3].message));
        expect(pushed).toBeTruthy();
    });

    test('safe_default → resolveActionRequest path: resolve UPDATE + emitChanged(resolved)', async () => {
        const { mod, emitToRoom, unifiedPush } = buildModule({ prefs: { action_request_timeout_policy: 'safe_default', action_request_timeout_minutes: 1440 } });
        routeMock({
            scan: [{ device_id: deviceId }],
            timeoutSelect: [pendingRow()],
            onUpdate: () => ({ rows: [pendingRow({ status: 'resolved', resolved_at: new Date() })] }),
        });
        await mod.enforceActionRequestTimeouts();

        const resolveCall = mockPoolQuery.mock.calls.find(c => /UPDATE agent_action_requests/.test(c[0]) && /SET status = 'resolved'/.test(c[0]));
        const answerJson = JSON.parse(resolveCall[1][0]);
        expect(answerJson.reason).toBe('timeout_safe_default');
        expect(answerJson.auto).toBe(true);

        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed', { kind: 'resolved', requestId: UUID, fromEntityId: 1 });
        const pushed = unifiedPush.mock.calls.find(c => /RESOLVED/.test(c[3].message));
        expect(pushed).toBeTruthy();
    });

    test('consensus → OPENS a negotiation round (stamp + structured vote prompt + consensus_triggered); NO resolve', async () => {
        const { mod, emitToRoom, unifiedPush } = buildModule({ prefs: { action_request_timeout_policy: 'consensus', action_request_timeout_minutes: 1440 } });
        const row = pendingRow({ options: ['A', 'B'] });
        routeMock({
            scan: [{ device_id: deviceId }],
            backstopSelect: [row], // the OPEN backstop SELECT (no age clause, jsonb_array_length>=2)
            onUpdate: () => ({ rows: [pendingRow({ options: ['A', 'B'], consensus_triggered_at: new Date() })] }),
        });
        await mod.enforceActionRequestTimeouts();

        // the backstop SELECT has NO created_at age clause + requires options>=2
        const backstop = mockPoolQuery.mock.calls.find(c => /SELECT \* FROM agent_action_requests/.test(c[0]) && /jsonb_array_length/.test(c[0]));
        expect(backstop[0]).toMatch(/consensus_triggered_at IS NULL/);
        expect(backstop[0]).not.toMatch(/created_at < NOW/);

        const stampCall = mockPoolQuery.mock.calls.find(c => /UPDATE agent_action_requests/.test(c[0]) && /SET consensus_triggered_at = NOW\(\)/.test(c[0]));
        expect(stampCall[0]).toMatch(/consensus_triggered_at IS NULL/);
        expect(stampCall[1]).toEqual([UUID]);

        // NO resolve/dismiss UPDATE fired
        const badWrite = mockPoolQuery.mock.calls.find(c => /UPDATE agent_action_requests/.test(c[0]) && /(status = 'resolved'|status = 'dismissed')/.test(c[0]));
        expect(badWrite).toBeUndefined();

        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed', { kind: 'consensus_triggered', requestId: UUID, fromEntityId: 1 });

        // structured vote prompt broadcast to BOTH bound entities, listing options + /vote
        const consensusPushes = unifiedPush.mock.calls.filter(c => /協商共識/.test(c[3].message));
        expect(consensusPushes.length).toBe(2);
        const msg = consensusPushes[0][3].message;
        expect(msg).toMatch(/requestId=11111111-2222-3333-4444-555555555555/);
        expect(msg).toMatch(/發起：#1/);
        expect(msg).toMatch(/\/vote/);
        expect(msg).toMatch(/\[0\] A/);
        expect(msg).toMatch(/\[1\] B/);
    });

    test('consensus: a request already opened (consensus_triggered_at set) is not re-opened', async () => {
        // The backstop SELECT filters consensus_triggered_at IS NULL, so a stamped
        // row never returns → no second open / stamp UPDATE.
        const { mod, emitToRoom, unifiedPush } = buildModule({ prefs: { action_request_timeout_policy: 'consensus', action_request_timeout_minutes: 1440 } });
        routeMock({ scan: [{ device_id: deviceId }], backstopSelect: [] });
        await mod.enforceActionRequestTimeouts();
        const stampCall = mockPoolQuery.mock.calls.find(c => /UPDATE agent_action_requests/.test(c[0]) && /SET consensus_triggered_at = NOW\(\)/.test(c[0]));
        expect(stampCall).toBeUndefined();
        expect(emitToRoom).not.toHaveBeenCalled();
        expect(unifiedPush).not.toHaveBeenCalled();
    });

    test('one bad row does not abort the sweep (best-effort per request)', async () => {
        const row1 = pendingRow();
        const row2 = pendingRow({ id: '22222222-2222-3333-4444-555555555555', from_entity_id: 2 });
        const { mod, emitToRoom } = buildModule({ prefs: { action_request_timeout_policy: 'auto_dismiss', action_request_timeout_minutes: 1440 } });
        routeMock({ scan: [{ device_id: deviceId }], timeoutSelect: [row1, row2] });
        // Make ONLY the first dismiss UPDATE reject; subsequent ones resolve.
        let firstUpdate = true;
        const base = mockPoolQuery.getMockImplementation();
        mockPoolQuery.mockImplementation(async (sql, params) => {
            if (/UPDATE agent_action_requests/.test(String(sql)) && /dismissed/.test(String(sql)) && firstUpdate) {
                firstUpdate = false;
                throw new Error('boom');
            }
            if (/UPDATE agent_action_requests/.test(String(sql)) && /dismissed/.test(String(sql))) {
                return { rows: [row2] };
            }
            return base(sql, params);
        });
        await mod.enforceActionRequestTimeouts();
        // second row still emitted despite the first throwing
        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed', { kind: 'dismissed', requestId: row2.id, fromEntityId: 2 });
    });
});
