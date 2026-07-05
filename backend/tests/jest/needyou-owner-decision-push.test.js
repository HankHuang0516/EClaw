// 需要你 owner-decision MOBILE PUSH (card_c7baa7ae).
//
// createActionRequest historically ONLY emitted the portal socket; an owner-only
// decision died silently in a collapsed phone inbox. This wires an ADDITIVE mobile
// push via the injected notifyDevice (the same owner-device socket + sendWebPush +
// sendFcm fan-out over device_fcm_tokens the rest of the app uses). These tests
// exercise the REAL createActionRequest path (exported by the module) with the pg
// INSERT mocked and notifyDevice mocked, asserting the 4 required behaviours:
//
//   (a) owner-only decision item created → notifyDevice called once with the
//       owner's deviceId as the target.
//   (b) bot-to-bot / non-owner item (no ownerOnly) created → notifyDevice NOT called.
//   (c) needyou_push_enabled=false → notifyDevice NOT called, but the inbox row is
//       still created (INSERT ran) + the socket still emitted.
//   (d) notifyDevice throws → createActionRequest STILL resolves with the row (the
//       push failure can never break inbox-item creation).
//
// Mocks pg so the module's Pool() is captured (mirrors agent-action-requests.test.js).

const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockPoolQuery,
        connect: jest.fn().mockResolvedValue({ query: mockPoolQuery, release: jest.fn() }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const deviceId = 'owner-dev';
const UUID = '99999999-8888-7777-6666-555555555555';

const devices = {
    [deviceId]: {
        deviceSecret: 'dev-secret',
        entities: { 2: { isBound: true, botSecret: 'bot-2' } },
    },
};

function rowFixture(over = {}) {
    return {
        id: UUID, device_id: deviceId, from_entity_id: 2, anchor_message_id: null,
        type: 'decision', prompt: 'Approve merge of PR #123?', options: ['核可', '退回', '延後'],
        related_card_id: 'card_abc123', decision_context: null,
        status: 'pending', answer: null, consensus_triggered_at: null,
        created_at: new Date('2026-07-05T00:00:00Z'), resolved_at: null, ...over,
    };
}

// Build a module wired with a mocked notifyDevice + an injected getDevicePrefs so
// no real device-preferences / negotiation DB traffic fires. Policy 'keep' keeps
// isNegotiable() false → the INSERT is the ONLY pg query createActionRequest issues.
function buildMod({ notifyDevice, prefs = {} } = {}) {
    // Fresh require so the pg mock's call log is per-suite clean.
    const factory = require('../../agent-action-requests');
    const io = { to: () => ({ emit: () => {} }) }; // socket emit is a no-op sink here
    return factory(devices, {
        serverLog: () => {},
        io,
        notifyDevice,
        getDevicePrefs: () => ({ action_request_timeout_policy: 'keep', ...prefs }),
    });
}

afterEach(() => mockPoolQuery.mockReset());

describe('需要你 owner-decision mobile push — createActionRequest wiring (card_c7baa7ae)', () => {
    it('(a) owner-only decision → notifyDevice called once targeting the owner deviceId', async () => {
        const dc = { ownerOnly: true, whatWasDone: 'merged PR', recommendedOptionIndex: 0 };
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ decision_context: dc })] }); // INSERT RETURNING *
        const notifyDevice = jest.fn().mockResolvedValue(undefined);
        const mod = buildMod({ notifyDevice });

        const api = await mod.createActionRequest({
            deviceId, fromEntityId: 2, type: 'decision', prompt: 'Approve merge of PR #123?',
            options: ['核可', '退回', '延後'], relatedCardId: 'card_abc123', decisionContext: dc,
        });

        expect(api).toBeTruthy();
        expect(api.id).toBe(UUID);
        expect(notifyDevice).toHaveBeenCalledTimes(1);
        const [targetDeviceId, notification] = notifyDevice.mock.calls[0];
        // Targets the OWNER's own device — not a broadcast, not a bot.
        expect(targetDeviceId).toBe(deviceId);
        expect(notification.category).toBe('rich_card_question');
        expect(notification.metadata.requestId).toBe(UUID);
        expect(notification.metadata.ownerDecision).toBe(true);
        // No token/secret leaked into the notification payload.
        expect(JSON.stringify(notification)).not.toMatch(/secret|token/i);
    });

    it('(b) bot-to-bot / non-owner item (no ownerOnly) → notifyDevice NOT called', async () => {
        // A negotiation-style item: has options but NO ownerOnly flag → must not buzz.
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ decision_context: { whatWasDone: 'x' } })] });
        const notifyDevice = jest.fn().mockResolvedValue(undefined);
        const mod = buildMod({ notifyDevice });

        await mod.createActionRequest({
            deviceId, fromEntityId: 2, type: 'consensus', prompt: 'entities vote',
            options: ['A', 'B'], decisionContext: { whatWasDone: 'x' },
        });
        expect(notifyDevice).not.toHaveBeenCalled();

        // Also: a plain item with NO decision_context at all → no push.
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ decision_context: null, options: null })] });
        await mod.createActionRequest({ deviceId, fromEntityId: 2, type: 'input', prompt: 'status' });
        expect(notifyDevice).not.toHaveBeenCalled();
    });

    it('(c) needyou_push_enabled=false → notifyDevice NOT called, but the inbox row IS still created', async () => {
        const dc = { ownerOnly: true, whatWasDone: 'merged PR' };
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ decision_context: dc })] }); // INSERT still runs
        const notifyDevice = jest.fn().mockResolvedValue(undefined);
        const mod = buildMod({ notifyDevice, prefs: { needyou_push_enabled: false } });

        const api = await mod.createActionRequest({
            deviceId, fromEntityId: 2, type: 'decision', prompt: 'Approve?',
            options: ['核可', '退回'], decisionContext: dc,
        });

        // Push suppressed…
        expect(notifyDevice).not.toHaveBeenCalled();
        // …but the inbox item was still created (INSERT ran + row returned).
        expect(api).toBeTruthy();
        expect(api.id).toBe(UUID);
        const insertCall = mockPoolQuery.mock.calls.find(c => /INSERT INTO agent_action_requests/.test(c[0]));
        expect(insertCall).toBeTruthy();
    });

    it('(d) notifyDevice throws → createActionRequest still returns the row (push failure is isolated)', async () => {
        const dc = { ownerOnly: true, whatWasDone: 'merged PR' };
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ decision_context: dc })] });
        const notifyDevice = jest.fn().mockRejectedValue(new Error('FCM exploded'));
        const mod = buildMod({ notifyDevice });

        const api = await mod.createActionRequest({
            deviceId, fromEntityId: 2, type: 'decision', prompt: 'Approve?',
            options: ['核可', '退回'], decisionContext: dc,
        });

        // Attempted the push…
        expect(notifyDevice).toHaveBeenCalledTimes(1);
        // …but the throw did NOT break creation — the row still came back.
        expect(api).toBeTruthy();
        expect(api.id).toBe(UUID);
    });
});
