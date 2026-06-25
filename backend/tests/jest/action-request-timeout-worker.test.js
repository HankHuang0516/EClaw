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
describe('enforceActionRequestTimeouts', () => {
    test('policy=keep → device skipped, NO pending-request SELECT/UPDATE', async () => {
        const { mod } = buildModule({ prefs: { action_request_timeout_policy: 'keep', action_request_timeout_minutes: 1440 } });
        // call 0 = DISTINCT device scan
        mockPoolQuery.mockResolvedValueOnce({ rows: [{ device_id: deviceId }] });
        await mod.enforceActionRequestTimeouts();
        // Only the device-scan query ran; no per-device SELECT or any write.
        expect(mockPoolQuery).toHaveBeenCalledTimes(1);
        expect(mockPoolQuery.mock.calls[0][0]).toMatch(/SELECT DISTINCT device_id/);
    });

    test('the pending SELECT carries the timeout-minutes interval + status=pending', async () => {
        const { mod } = buildModule({ prefs: { action_request_timeout_policy: 'auto_dismiss', action_request_timeout_minutes: 90 } });
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ device_id: deviceId }] }) // scan
            .mockResolvedValueOnce({ rows: [] });                       // pending SELECT → none
        await mod.enforceActionRequestTimeouts();
        const selectCall = mockPoolQuery.mock.calls[1];
        expect(selectCall[0]).toMatch(/status = 'pending'/);
        expect(selectCall[0]).toMatch(/created_at < NOW\(\) - \(\$2 \* interval '1 minute'\)/);
        expect(selectCall[1]).toEqual([deviceId, 90]);
    });

    test('auto_dismiss → dismiss UPDATE + emitChanged(dismissed) + emitter push', async () => {
        const { mod, emitToRoom, unifiedPush } = buildModule({ prefs: { action_request_timeout_policy: 'auto_dismiss', action_request_timeout_minutes: 1440 } });
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ device_id: deviceId }] })       // scan
            .mockResolvedValueOnce({ rows: [pendingRow()] })                  // pending SELECT
            .mockResolvedValueOnce({ rows: [pendingRow({ status: 'dismissed', resolved_at: new Date() })] }); // dismiss UPDATE
        await mod.enforceActionRequestTimeouts();

        const updateCall = mockPoolQuery.mock.calls[2];
        expect(updateCall[0]).toMatch(/SET status = 'dismissed'/);
        expect(updateCall[0]).toMatch(/WHERE id = \$1 AND status = 'pending'/);
        expect(updateCall[1]).toEqual([UUID]);

        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed', { kind: 'dismissed', requestId: UUID, fromEntityId: 1 });
        // emitter (#1) was told it timed out
        const pushed = unifiedPush.mock.calls.find(c => /逾時自動略過/.test(c[3].message));
        expect(pushed).toBeTruthy();
    });

    test('safe_default → resolveActionRequest path: resolve UPDATE + emitChanged(resolved)', async () => {
        const { mod, emitToRoom, unifiedPush } = buildModule({ prefs: { action_request_timeout_policy: 'safe_default', action_request_timeout_minutes: 1440 } });
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ device_id: deviceId }] })       // scan
            .mockResolvedValueOnce({ rows: [pendingRow()] })                  // pending SELECT
            .mockResolvedValueOnce({ rows: [pendingRow({ status: 'resolved', resolved_at: new Date() })] }); // resolve UPDATE
        await mod.enforceActionRequestTimeouts();

        const resolveCall = mockPoolQuery.mock.calls[2];
        expect(resolveCall[0]).toMatch(/SET status = 'resolved'/);
        // safe-default answer payload was passed as the jsonb param
        const answerJson = JSON.parse(resolveCall[1][0]);
        expect(answerJson.reason).toBe('timeout_safe_default');
        expect(answerJson.auto).toBe(true);

        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed', { kind: 'resolved', requestId: UUID, fromEntityId: 1 });
        // emitter notified via the RESOLVED push-back (resolveActionRequest)
        const pushed = unifiedPush.mock.calls.find(c => /RESOLVED/.test(c[3].message));
        expect(pushed).toBeTruthy();
    });

    test('consensus → stamp consensus_triggered_at + broadcast prompt + emitChanged(consensus_triggered); NO resolve', async () => {
        const { mod, emitToRoom, unifiedPush } = buildModule({ prefs: { action_request_timeout_policy: 'consensus', action_request_timeout_minutes: 1440 } });
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ device_id: deviceId }] })       // scan
            .mockResolvedValueOnce({ rows: [pendingRow()] })                  // pending SELECT
            .mockResolvedValueOnce({ rows: [pendingRow({ consensus_triggered_at: new Date() })] }); // stamp UPDATE
        await mod.enforceActionRequestTimeouts();

        // pending SELECT excluded already-triggered rows
        expect(mockPoolQuery.mock.calls[1][0]).toMatch(/consensus_triggered_at IS NULL/);

        const stampCall = mockPoolQuery.mock.calls[2];
        expect(stampCall[0]).toMatch(/SET consensus_triggered_at = NOW\(\)/);
        expect(stampCall[0]).toMatch(/consensus_triggered_at IS NULL/);
        expect(stampCall[1]).toEqual([UUID]);

        // exactly 3 queries → no resolve/dismiss UPDATE fired
        expect(mockPoolQuery).toHaveBeenCalledTimes(3);

        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed', { kind: 'consensus_triggered', requestId: UUID, fromEntityId: 1 });

        // bot-to-bot consensus prompt broadcast to BOTH bound entities
        const consensusPushes = unifiedPush.mock.calls.filter(c => /協商共識/.test(c[3].message));
        expect(consensusPushes.length).toBe(2);
        const msg = consensusPushes[0][3].message;
        expect(msg).toMatch(/requestId=11111111-2222-3333-4444-555555555555/);
        expect(msg).toMatch(/發起：#1/);
    });

    test('consensus: a request already stamped (consensus_triggered_at set) is not re-fired', async () => {
        // The SELECT filters consensus_triggered_at IS NULL, so a stamped row never
        // returns → the worker performs no UPDATE for it.
        const { mod, emitToRoom, unifiedPush } = buildModule({ prefs: { action_request_timeout_policy: 'consensus', action_request_timeout_minutes: 1440 } });
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ device_id: deviceId }] }) // scan
            .mockResolvedValueOnce({ rows: [] });                       // SELECT excludes stamped → empty
        await mod.enforceActionRequestTimeouts();
        expect(mockPoolQuery).toHaveBeenCalledTimes(2);          // scan + empty SELECT only
        expect(emitToRoom).not.toHaveBeenCalled();
        expect(unifiedPush).not.toHaveBeenCalled();
    });

    test('one bad row does not abort the sweep (best-effort per request)', async () => {
        const row2 = pendingRow({ id: '22222222-2222-3333-4444-555555555555', from_entity_id: 2 });
        const { mod, emitToRoom } = buildModule({ prefs: { action_request_timeout_policy: 'auto_dismiss', action_request_timeout_minutes: 1440 } });
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ device_id: deviceId }] })   // scan
            .mockResolvedValueOnce({ rows: [pendingRow(), row2] })        // two pending
            .mockRejectedValueOnce(new Error('boom'))                     // first dismiss throws
            .mockResolvedValueOnce({ rows: [row2] });                     // second dismiss ok
        await mod.enforceActionRequestTimeouts();
        // second row still emitted despite first throwing
        expect(emitToRoom).toHaveBeenCalledWith('action_request:changed', { kind: 'dismissed', requestId: row2.id, fromEntityId: 2 });
    });
});
