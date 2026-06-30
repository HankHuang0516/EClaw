/**
 * Tests for the OWNER-DECISION DELIVERY fix (Hank: "eclaw 應該也要提醒？" — owner
 * decisions were created in the 需要你 inbox but never pushed, so they died
 * silently in a collapsed inbox; and ownerOnly items wrongly opened a bot-to-bot
 * consensus round that flooded every entity).
 *
 * Three behaviours, pg mocked:
 *   1. isOwnerOnlyDecision / isNegotiable — an ownerOnly request is NOT negotiable
 *      (no bot consensus round opens for it).
 *   2. createActionRequest — an ownerOnly request pushes to the owner device
 *      (notifyDevice fan-out: socket + Web Push + FCM); a non-owner request and a
 *      push-disabled device do NOT.
 *   3. runOwnerDigestPass — once-per-day morning digest of pending ownerOnly
 *      items; the dedup PK makes it fire exactly once per (device, local-date).
 */

const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockPoolQuery,
        connect: jest.fn().mockResolvedValue({ query: mockPoolQuery, release: jest.fn() }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const factory = require('../../agent-action-requests');
const {
    isOwnerOnlyDecision,
    isNegotiable,
} = factory;

const deviceId = 'dev-1';
const UUID = '11111111-2222-3333-4444-555555555555';

function buildModule({ prefs = {}, notifyDevice } = {}) {
    const emitToRoom = jest.fn();
    const io = { to: jest.fn(() => ({ emit: emitToRoom })) };
    const getDevicePrefs = jest.fn().mockResolvedValue(prefs);
    const dev = {
        [deviceId]: {
            deviceSecret: 'sek',
            entities: {
                1: { isBound: true, botSecret: 'bot-1', bindingType: 'channel' },
                2: { isBound: true, botSecret: 'bot-2', bindingType: 'channel' },
            },
        },
    };
    const mod = factory(dev, {
        serverLog: () => {}, io, getDevicePrefs,
        unifiedPush: jest.fn().mockResolvedValue({}), pushToBot: jest.fn().mockResolvedValue({}),
        notifyDevice,
    });
    return { mod, io, getDevicePrefs };
}

afterEach(() => { mockPoolQuery.mockReset(); mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 }); });

// ───────────────────────── 1. predicate / negotiability ─────────────────────────
describe('isOwnerOnlyDecision', () => {
    test('true only for an object/JSON with ownerOnly===true', () => {
        expect(isOwnerOnlyDecision({ ownerOnly: true })).toBe(true);
        expect(isOwnerOnlyDecision(JSON.stringify({ ownerOnly: true, x: 1 }))).toBe(true);
        expect(isOwnerOnlyDecision({ ownerOnly: false })).toBe(false);
        expect(isOwnerOnlyDecision({})).toBe(false);
        expect(isOwnerOnlyDecision(null)).toBe(false);
        expect(isOwnerOnlyDecision('not json')).toBe(false);
        expect(isOwnerOnlyDecision('{"ownerOnly":1}')).toBe(false); // truthy-but-not-true
    });
});

describe('isNegotiable: ownerOnly never opens a bot consensus round', () => {
    const consensusPrefs = { action_request_timeout_policy: 'consensus', consensus_min_entities: 2 };
    const baseRow = { status: 'pending', consensus_triggered_at: null, options: ['A', 'B'] };

    test('a normal options request IS negotiable', () => {
        expect(isNegotiable({ ...baseRow, decision_context: null }, consensusPrefs, 2)).toBe(true);
    });
    test('an ownerOnly request is NOT negotiable (even with options + consensus policy)', () => {
        expect(isNegotiable({ ...baseRow, decision_context: { ownerOnly: true } }, consensusPrefs, 2)).toBe(false);
    });
    test('ownerOnly as a jsonb string is also not negotiable', () => {
        expect(isNegotiable({ ...baseRow, decision_context: '{"ownerOnly":true}' }, consensusPrefs, 2)).toBe(false);
    });
});

// ───────────────────────── 2. push-on-create ─────────────────────────
describe('createActionRequest: owner-device push', () => {
    function insertedRow(decision_context) {
        return {
            id: UUID, device_id: deviceId, from_entity_id: 1, anchor_message_id: null,
            type: 'decision', prompt: '要不要合併 PR #123?', options: ['合', '不合'],
            status: 'pending', answer: null, created_at: new Date('2026-06-30T00:00:00Z'),
            resolved_at: null, consensus_triggered_at: null, decision_context,
        };
    }

    test('ownerOnly request → notifyDevice called once with owner_decision metadata', async () => {
        const notifyDevice = jest.fn().mockResolvedValue(undefined);
        const { mod } = buildModule({ prefs: {}, notifyDevice });
        mockPoolQuery.mockResolvedValueOnce({ rows: [insertedRow({ ownerOnly: true })] }); // the INSERT

        await mod.createActionRequest({
            deviceId, fromEntityId: 1, type: 'decision', prompt: '要不要合併 PR #123?',
            options: ['合', '不合'], decisionContext: { ownerOnly: true, recommendedOptionIndex: 0 },
        });
        // allow the fire-and-forget push microtask to settle
        await Promise.resolve();

        expect(notifyDevice).toHaveBeenCalledTimes(1);
        const [dId, notif] = notifyDevice.mock.calls[0];
        expect(dId).toBe(deviceId);
        expect(notif.category).toBe('action_request');
        expect(notif.metadata.kind).toBe('owner_decision_created');
        expect(notif.metadata.requestId).toBe(UUID);
    });

    test('non-owner request → notifyDevice NOT called', async () => {
        const notifyDevice = jest.fn().mockResolvedValue(undefined);
        const { mod } = buildModule({ prefs: {}, notifyDevice });
        mockPoolQuery.mockResolvedValueOnce({ rows: [insertedRow(null)] });

        await mod.createActionRequest({
            deviceId, fromEntityId: 1, type: 'decision', prompt: 'bot question', options: ['A', 'B'],
        });
        await Promise.resolve();
        expect(notifyDevice).not.toHaveBeenCalled();
    });

    test('opt-out (owner_decision_push_enabled=false) → notifyDevice NOT called', async () => {
        const notifyDevice = jest.fn().mockResolvedValue(undefined);
        const { mod } = buildModule({ prefs: { owner_decision_push_enabled: false }, notifyDevice });
        mockPoolQuery.mockResolvedValueOnce({ rows: [insertedRow({ ownerOnly: true })] });

        await mod.createActionRequest({
            deviceId, fromEntityId: 1, type: 'decision', prompt: 'owner q',
            options: ['合', '不合'], decisionContext: { ownerOnly: true },
        });
        await Promise.resolve();
        expect(notifyDevice).not.toHaveBeenCalled();
    });
});

// ───────────────────────── 3. morning digest ─────────────────────────
describe('runOwnerDigestPass: once-per-day owner reminder', () => {
    // digest_hour:0 makes the morning-window gate always open regardless of the
    // real wall-clock the test runs at.
    const digestPrefs = { owner_decision_digest_hour: 0 };

    test('pending ownerOnly items → notifyDevice digest sent when dedup-insert wins', async () => {
        const notifyDevice = jest.fn().mockResolvedValue(undefined);
        const { mod } = buildModule({ prefs: digestPrefs, notifyDevice });
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ id: UUID, prompt: '要不要合併 PR' }, { id: 'x', prompt: 'petdx ②' }] }) // SELECT
            .mockResolvedValueOnce({ rows: [{ device_id: deviceId }], rowCount: 1 }); // INSERT won

        await mod.runOwnerDigestPass(deviceId, digestPrefs, {});

        expect(notifyDevice).toHaveBeenCalledTimes(1);
        const [, notif] = notifyDevice.mock.calls[0];
        expect(notif.metadata.kind).toBe('owner_decision_digest');
        expect(notif.metadata.count).toBe(2);
        expect(notif.title).toContain('2');
    });

    test('dedup-insert loses (already sent today) → NO second digest', async () => {
        const notifyDevice = jest.fn().mockResolvedValue(undefined);
        const { mod } = buildModule({ prefs: digestPrefs, notifyDevice });
        mockPoolQuery
            .mockResolvedValueOnce({ rows: [{ id: UUID, prompt: 'owner q' }] }) // SELECT
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT conflict → lost

        await mod.runOwnerDigestPass(deviceId, digestPrefs, {});
        expect(notifyDevice).not.toHaveBeenCalled();
    });

    test('no pending ownerOnly items → no digest, no dedup insert', async () => {
        const notifyDevice = jest.fn().mockResolvedValue(undefined);
        const { mod } = buildModule({ prefs: digestPrefs, notifyDevice });
        mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // SELECT empty

        await mod.runOwnerDigestPass(deviceId, digestPrefs, {});
        expect(notifyDevice).not.toHaveBeenCalled();
        expect(mockPoolQuery).toHaveBeenCalledTimes(1); // SELECT only, no INSERT
    });

    test('opt-out (owner_decision_digest_enabled=false) → no query, no digest', async () => {
        const notifyDevice = jest.fn().mockResolvedValue(undefined);
        const { mod } = buildModule({ prefs: {}, notifyDevice });
        await mod.runOwnerDigestPass(deviceId, { owner_decision_digest_enabled: false }, {});
        expect(notifyDevice).not.toHaveBeenCalled();
        expect(mockPoolQuery).not.toHaveBeenCalled();
    });
});
