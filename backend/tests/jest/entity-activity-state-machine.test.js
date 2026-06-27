/**
 * Server-authoritative entity ACTIVITY state machine — deterministic evaluator.
 *
 * These tests pin the behaviour that REPLACES the old random sleep coin-flip
 * (`backend/index.js`: "5 min no update → Math.random() > 0.7 → SLEEPING").
 * That random rule is why bound entities wrongly went to sleep (blocked the
 * walking-emulator QA). Each test exercises a property the OLD code VIOLATED:
 *
 *   #1 idle 6 min, no pending → deterministically IDLE, NEVER SLEEPING before
 *      SLEEP_AFTER; run the evaluator 1000× → zero randomness (old coin-flip
 *      would intermittently return SLEEPING → fails).
 *   #2 pendingWork=true → never IDLE/SLEEPING.
 *   #3 inactivity ≥ SLEEP_AFTER + no pending → SLEEPING.
 *
 * FAIL-ON-OLD: this module (lib/entity-activity.js) does not exist on old code,
 * so the suite hard-fails there; the assertions additionally pin the exact
 * coin-flip failure mode (see the Math.random stub test).
 */

const activity = require('../../lib/entity-activity');
const { ACTIVITY } = activity;

const IDLE_AFTER_MS = 60 * 1000;        // entity_idle_after_seconds default
const SLEEP_AFTER_MS = 20 * 60 * 1000;  // entity_sleep_after_minutes default
const OPTS = { idleAfterMs: IDLE_AFTER_MS, sleepAfterMs: SLEEP_AFTER_MS };
const NOW = 1_700_000_000_000;

function makeEntity(overrides = {}) {
    return {
        entityId: 0,
        isBound: true,
        state: 'IDLE',
        messageQueue: [],
        lastSendAt: null,
        lastActivityAt: NOW,
        lastUpdated: NOW,
        overlayState: null,
        overlayUntil: null,
        ...overrides,
    };
}

describe('entity-activity: deterministic evaluator (no coin-flip)', () => {
    // ── #1 idle 6 min, no pending → IDLE, never SLEEPING, zero randomness ──
    test('idle 6 min with no pending work is deterministically IDLE, never SLEEPING', () => {
        const sixMin = 6 * 60 * 1000;
        const entity = makeEntity({
            lastSendAt: NOW - sixMin,      // sent 6 min ago (> IDLE_AFTER)
            lastActivityAt: NOW - sixMin,  // last activity 6 min ago (< SLEEP_AFTER=20min)
            messageQueue: [],
        });

        const results = new Set();
        for (let i = 0; i < 1000; i++) {
            results.add(activity.evaluateActivityState(entity, NOW, OPTS));
        }
        // Old coin-flip would scatter {IDLE, SLEEPING}; new evaluator returns ONE value.
        expect(results.size).toBe(1);
        expect([...results]).toEqual([ACTIVITY.IDLE]);
        expect(results.has(ACTIVITY.SLEEPING)).toBe(false);
    });

    test('uses no randomness — works even if Math.random is sabotaged', () => {
        const original = Math.random;
        Math.random = () => { throw new Error('Math.random must not be called by the evaluator'); };
        try {
            const entity = makeEntity({ lastSendAt: NOW - 6 * 60 * 1000, lastActivityAt: NOW - 6 * 60 * 1000 });
            expect(activity.evaluateActivityState(entity, NOW, OPTS)).toBe(ACTIVITY.IDLE);
        } finally {
            Math.random = original;
        }
    });

    test('NEVER SLEEPING any time before SLEEP_AFTER (swept across the whole window)', () => {
        // For every minute from "just sent" up to 1 ms before SLEEP_AFTER, the
        // result must be ACTIVE or IDLE — but never SLEEPING.
        for (let elapsed = 0; elapsed < SLEEP_AFTER_MS; elapsed += 60 * 1000) {
            const entity = makeEntity({ lastSendAt: NOW - elapsed, lastActivityAt: NOW - elapsed });
            const state = activity.evaluateActivityState(entity, NOW, OPTS);
            expect(state).not.toBe(ACTIVITY.SLEEPING);
            expect(elapsed < IDLE_AFTER_MS ? state === ACTIVITY.ACTIVE : state === ACTIVITY.IDLE).toBe(true);
        }
    });

    // ── #4 (unit half): just-delivered → ACTIVE within grace, then IDLE ──
    test('recently delivered a message → ACTIVE within idle grace, IDLE after', () => {
        const justSent = makeEntity({ lastSendAt: NOW - 10 * 1000, lastActivityAt: NOW - 10 * 1000 });
        expect(activity.evaluateActivityState(justSent, NOW, OPTS)).toBe(ACTIVITY.ACTIVE);

        const pastGrace = makeEntity({ lastSendAt: NOW - (IDLE_AFTER_MS + 1000), lastActivityAt: NOW - (IDLE_AFTER_MS + 1000) });
        expect(activity.evaluateActivityState(pastGrace, NOW, OPTS)).toBe(ACTIVITY.IDLE);
    });

    test('exact IDLE_AFTER boundary → IDLE (>= is the decay edge)', () => {
        const atEdge = makeEntity({ lastSendAt: NOW - IDLE_AFTER_MS, lastActivityAt: NOW - IDLE_AFTER_MS });
        expect(activity.evaluateActivityState(atEdge, NOW, OPTS)).toBe(ACTIVITY.IDLE);
    });
});

describe('entity-activity: pendingWork forbids IDLE/SLEEPING', () => {
    // ── #2 pendingWork=true → never IDLE/SLEEPING ──
    test('unacked messageQueue item keeps entity ACTIVE even after an hour idle', () => {
        const entity = makeEntity({
            lastSendAt: NOW - 60 * 60 * 1000,      // sent an hour ago
            lastActivityAt: NOW - 60 * 60 * 1000,  // far past SLEEP_AFTER
            messageQueue: [{ text: 'hi', from: 'user' }],
        });
        expect(activity.computePendingWork(entity)).toBe(true);
        for (let i = 0; i < 200; i++) {
            const s = activity.evaluateActivityState(entity, NOW, OPTS);
            expect(s).toBe(ACTIVITY.ACTIVE);
            expect(s).not.toBe(ACTIVITY.IDLE);
            expect(s).not.toBe(ACTIVITY.SLEEPING);
        }
    });

    test('precomputed kanban in_progress flag blocks sleep', () => {
        const entity = makeEntity({
            lastSendAt: NOW - 60 * 60 * 1000,
            lastActivityAt: NOW - 60 * 60 * 1000,
            messageQueue: [],
            _pendingKanban: true,
        });
        expect(activity.computePendingWork(entity)).toBe(true);
        expect(activity.evaluateActivityState(entity, NOW, OPTS)).toBe(ACTIVITY.ACTIVE);
    });

    test('precomputed queued scheduled-message flag blocks sleep', () => {
        const entity = makeEntity({
            lastSendAt: NOW - 60 * 60 * 1000,
            lastActivityAt: NOW - 60 * 60 * 1000,
            messageQueue: [],
            _pendingScheduled: true,
        });
        expect(activity.computePendingWork(entity)).toBe(true);
        expect(activity.evaluateActivityState(entity, NOW, OPTS)).toBe(ACTIVITY.ACTIVE);
    });

    test('computePendingWork is false for an empty/quiet entity', () => {
        expect(activity.computePendingWork(makeEntity({ messageQueue: [] }))).toBe(false);
        expect(activity.computePendingWork(null)).toBe(false);
        expect(activity.computePendingWork({})).toBe(false);
    });
});

describe('entity-activity: SLEEPING only after SLEEP_AFTER with no pending', () => {
    // ── #3 inactivity ≥ SLEEP_AFTER + no pending → SLEEPING ──
    test('inactivity past SLEEP_AFTER with no pending → SLEEPING (deterministic)', () => {
        const entity = makeEntity({
            lastSendAt: NOW - (SLEEP_AFTER_MS + 60 * 1000),
            lastActivityAt: NOW - (SLEEP_AFTER_MS + 60 * 1000),
            messageQueue: [],
        });
        const results = new Set();
        for (let i = 0; i < 1000; i++) results.add(activity.evaluateActivityState(entity, NOW, OPTS));
        expect([...results]).toEqual([ACTIVITY.SLEEPING]);
    });

    test('exact SLEEP_AFTER boundary → SLEEPING', () => {
        const entity = makeEntity({
            lastSendAt: NOW - SLEEP_AFTER_MS,
            lastActivityAt: NOW - SLEEP_AFTER_MS,
            messageQueue: [],
        });
        expect(activity.evaluateActivityState(entity, NOW, OPTS)).toBe(ACTIVITY.SLEEPING);
    });

    test('a recent inbound (lastActivityAt fresh) prevents sleep even if last send is old', () => {
        const entity = makeEntity({
            lastSendAt: NOW - (SLEEP_AFTER_MS + 60 * 1000), // sent long ago
            lastActivityAt: NOW - 5 * 1000,                  // but got an inbound 5 s ago
            messageQueue: [],                                // already drained
        });
        // past idle grace + no pending, but activity is recent → IDLE, not SLEEPING.
        expect(activity.evaluateActivityState(entity, NOW, OPTS)).toBe(ACTIVITY.IDLE);
    });
});

describe('entity-activity: expressive overlays + state classifiers', () => {
    test('busy-family states classify as active', () => {
        for (const s of ['BUSY', 'PROCESSING', 'WORKING', 'IN_PROGRESS', 'IN-PROGRESS', 'busy', ' processing ']) {
            expect(activity.isBusyFamilyState(s)).toBe(true);
        }
        expect(activity.isBusyFamilyState('IDLE')).toBe(false);
        expect(activity.isBusyFamilyState('EXCITED')).toBe(false);
    });

    test('expressive states are recognised', () => {
        for (const s of ['EXCITED', 'HAPPY', 'WAVING', 'JUMPING', 'REVIEW', 'FAILED', 'excited']) {
            expect(activity.isExpressiveState(s)).toBe(true);
        }
        expect(activity.isExpressiveState('BUSY')).toBe(false);
        expect(activity.isExpressiveState('IDLE')).toBe(false);
    });

    test('overlayActive respects the TTL', () => {
        expect(activity.overlayActive({ overlayState: 'EXCITED', overlayUntil: NOW + 1000 }, NOW)).toBe(true);
        expect(activity.overlayActive({ overlayState: 'EXCITED', overlayUntil: NOW - 1 }, NOW)).toBe(false);
        expect(activity.overlayActive({ overlayState: null, overlayUntil: null }, NOW)).toBe(false);
    });

    test('canonical activity states map to existing wire CharacterState values', () => {
        expect(ACTIVITY.ACTIVE).toBe('BUSY');
        expect(ACTIVITY.IDLE).toBe('IDLE');
        expect(ACTIVITY.SLEEPING).toBe('SLEEPING');
    });
});
