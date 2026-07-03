/**
 * Direct-b2b deliver-time low-signal guard (card_39226e06).
 *
 * Problem: entity #6 (Codex) emits routine "Codex #N status heartbeat" messages
 * every ~3 min. After #6→#2 was set in the org chart, #6's watchdog started
 * sending these heartbeats DIRECTLY to #2 via speakTo/transform (the
 * bot-to-bot delivery path — deliverToEntity), NOT via orgChartForward(). The
 * existing low-signal filter (classifyLowSignalFwd) only ran inside
 * orgChartForward, so it never fired on the direct-b2b path → heartbeat noise
 * flooded the commander.
 *
 * Fix: deliverToEntity() now runs classifyLowSignalFwd at the top and DROPS the
 * delivery (before persist/push) when the message is low-signal, recording it in
 * the drop-but-surface suppression log. This test asserts:
 *   (a) a "Codex #6 status heartbeat…" b2b message is SUPPRESSED (dropped),
 *   (b) a substantive #6 report ("已完成任務，PR #1234 merged…") is DELIVERED,
 *   (c) a real-user-style message is DELIVERED (never eat content),
 *   (d) a classification error → DELIVERED (fail-safe; the filter must never
 *       drop a message on error).
 *
 * Guard is exercised through the exported deliver point (index._deliverToEntity)
 * — the SINGLE entity→entity delivery fn shared by /api/transform speakTo +
 * broadcast. A real end user goes through /api/client/speak, which never calls
 * deliverToEntity, so user delivery is untouched by construction; (c) here is the
 * belt-and-suspenders "substantive prose is never suppressed" case.
 *
 * On PRE-CHANGE code (guard absent) case (a) DELIVERS the heartbeat (enqueued,
 * no suppression record) → the (a) assertions FAIL. After the fix they PASS.
 */

require('./helpers/mock-setup');

// Wrap the real org-fwd-filter so the classifier keeps its true behaviour for
// cases (a)-(c), but case (d) can flip `throwNext` to force a classification
// error and assert the deliver-time guard's fail-safe (deliver-on-error). We
// must mock at the module boundary because index.js captures
// classifyLowSignalFwd as a destructured local at load time — spying on the
// module object afterwards would not affect index's binding.
const orgFwdControl = { throwNext: false };
jest.mock('../../org-fwd-filter', () => {
    const actual = jest.requireActual('../../org-fwd-filter');
    return {
        ...actual,
        classifyLowSignalFwd: (message) => {
            if (orgFwdControl.throwNext) throw new Error('boom: classifier poisoned');
            return actual.classifyLowSignalFwd(message);
        },
    };
});

let indexModule;

const DEVICE_ID = 'b2b-deliver-lowsignal-dev';

// Build a minimal-but-valid bound entity object (enough for deliverToEntity:
// messageQueue for enqueue, character/name for labels, isBound, no webhook and
// non-channel binding so NO real push fires — delivery is observable purely via
// the messageQueue + return shape).
function makeEntity(entityId, character) {
    return {
        entityId,
        character,
        name: character,
        isBound: true,
        webhook: null,           // no webhook  → webhook push path skipped
        bindingType: 'personal', // not 'channel' → channel push path skipped
        botSecret: `botsecret-${entityId}`,
        identity: { name: character },
        level: 1,
        state: 'IDLE',
        messageQueue: [],
        deadLetterQueue: [],
    };
}

async function deliver(fromEntity, toEntity, text) {
    return indexModule._deliverToEntity({
        senderDeviceId: DEVICE_ID,
        fromId: fromEntity.entityId,
        fromEntity,
        targetDeviceId: DEVICE_ID,
        toId: toEntity.entityId,
        toEntity,
        text,
        expectsReply: true,
        isBroadcast: false,
        isCrossDevice: false,
    });
}

function suppressionCount() {
    const log = indexModule._suppressionLog[DEVICE_ID] || [];
    return log.length;
}

beforeAll(() => {
    indexModule = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

beforeEach(() => {
    // Fresh suppression buffer per test so counts are unambiguous.
    delete indexModule._suppressionLog[DEVICE_ID];
    orgFwdControl.throwNext = false;
});

describe('deliverToEntity() direct-b2b low-signal guard (card_39226e06)', () => {
    it('(a) SUPPRESSES a "Codex #6 status heartbeat" b2b message to a bot recipient', async () => {
        const from = makeEntity(6, 'LOBSTER'); // #6 Codex
        const to = makeEntity(2, 'COMMANDER'); // #2 commander
        const result = await deliver(from, to, 'Codex #6 status heartbeat — bridge alive, 3m idle');

        // Dropped before persist/push: recognisable "suppressed" result.
        expect(result.suppressed).toBe(true);
        expect(result.mode).toBe('suppressed');
        expect(result.pushed).toBe(false);
        expect(result.reason).toMatch(/^low_signal:heartbeat$/);

        // Nothing enqueued to the recipient bot.
        expect(to.messageQueue).toHaveLength(0);

        // Recorded in the drop-but-surface suppression log with the right reason.
        expect(suppressionCount()).toBe(1);
        const rec = indexModule._suppressionLog[DEVICE_ID][0];
        expect(rec).toMatchObject({ fromEntityId: 6, reason: 'heartbeat' });
    });

    it('(b) DELIVERS a substantive #6 completion report to a bot recipient', async () => {
        const from = makeEntity(6, 'LOBSTER');
        const to = makeEntity(2, 'COMMANDER');
        const text = '已完成任務，PR #1234 merged，card_39226e06 已關閉，詳見 https://github.com/x/y/pull/1234';
        const result = await deliver(from, to, text);

        // Not suppressed — normal fire-and-forget delivery result.
        expect(result.suppressed).toBeUndefined();
        expect(result.mode).not.toBe('suppressed');

        // Enqueued to the recipient bot's messageQueue.
        expect(to.messageQueue).toHaveLength(1);
        expect(to.messageQueue[0].text).toBe(text);

        // No suppression record.
        expect(suppressionCount()).toBe(0);
    });

    it('(c) DELIVERS a real-user-style prose message (never eats content)', async () => {
        const from = makeEntity(6, 'LOBSTER');
        const to = makeEntity(2, 'COMMANDER');
        const text = 'Hello, can you please help me check the order status for my account?';
        const result = await deliver(from, to, text);

        expect(result.suppressed).toBeUndefined();
        expect(to.messageQueue).toHaveLength(1);
        expect(to.messageQueue[0].text).toBe(text);
        expect(suppressionCount()).toBe(0);
    });

    it('(d) FAIL-SAFE: a classification error still DELIVERS the message', async () => {
        const from = makeEntity(6, 'LOBSTER');
        const to = makeEntity(2, 'COMMANDER');

        // Force classifyLowSignalFwd to throw (via the module wrapper). The guard's
        // try/catch must fall through to normal delivery — even a heartbeat-looking
        // body must be DELIVERED when classification cannot run (annoying noise is
        // acceptable; an eaten message on error is not).
        orgFwdControl.throwNext = true;
        const result = await deliver(from, to, 'Codex #6 status heartbeat — should still be delivered on error');

        // Delivered despite the throw — guard fell through to normal path.
        expect(result.suppressed).toBeUndefined();
        expect(result.mode).not.toBe('suppressed');
        expect(to.messageQueue).toHaveLength(1);
        // No suppression record because nothing was dropped.
        expect(suppressionCount()).toBe(0);
    });
});
