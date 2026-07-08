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
 * Real-activity redesign (stages 0-2, card_35cb55fc):
 *   Stage 0 — _pendingKanban is an IDLE FLOOR, not pendingWork: an open assigned
 *      card → IDLE (awake, never SLEEPING) but NEVER fake-BUSY. Old (#3795)
 *      returned ACTIVE → permanent false-BUSY on #1/#5 (fail-on-old in (a)).
 *   Stage 1 — a FRESH, trusted runtimeState "busy" is the PRIMARY BUSY signal;
 *      absent/stale → graceful fallback to the lastSend/floor heuristics.
 *   Stage 2 — runtimeState "stuck"→REVIEW, "crashed"→FAILED (existing wire
 *      CharacterState strings AgentStatus.fromWireValue already parses).
 *
 * FAIL-ON-OLD: this module (lib/entity-activity.js) does not exist on old code,
 * so the suite hard-fails there; the assertions additionally pin the exact
 * coin-flip failure mode (see the Math.random stub test) and the Stage 0/1/2
 * behavior changes vs the #3795 baseline.
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

describe('entity-activity: open kanban assignment forbids sleep (card_52b9032216e43e6c75ca2b6a)', () => {
    // Mirrors the index.js wiring: a single grouped query returns kanban_cards
    // rows, bucketPendingKanban folds them into Map<deviceId, Set<entityId>>, the
    // loop sets entity._pendingKanban = set.has(entityId), then evaluates.
    const DEVICE = 'dev-A';
    const STALE = {
        // far past SLEEP_AFTER + empty message queue → OLD wiring (no kanban
        // signal) would let this bot decay to SLEEPING ("Zzz" while tasks pile up).
        lastSendAt: NOW - (SLEEP_AFTER_MS + 5 * 60 * 1000),
        lastActivityAt: NOW - (SLEEP_AFTER_MS + 5 * 60 * 1000),
        messageQueue: [],
    };

    function wire(entityId, rows) {
        const byDevice = activity.bucketPendingKanban(rows);
        const openSet = byDevice.get(DEVICE);
        const entity = makeEntity({ entityId, ...STALE });
        entity._pendingKanban = !!(openSet && openSet.has(entity.entityId));
        return entity;
    }

    // ── (a) Stage 0: open assigned card = IDLE FLOOR — IDLE, never SLEEPING,
    //    never fake-BUSY (this is the live false-BUSY fix for #1/#5). ──
    test('(a) open assigned card → IDLE floor (never SLEEPING, never fake-BUSY)', () => {
        const rows = [
            { device_id: DEVICE, status: 'in_progress', archived: false, assigned_bots: [2] },
            { device_id: DEVICE, status: 'todo', archived: false, assigned_bots: [5, 7] },
        ];
        const bot2 = wire(2, rows);
        // Without ANY kanban signal this stale, empty-queue entity → SLEEPING.
        expect(activity.evaluateActivityState(makeEntity({ entityId: 2, ...STALE }), NOW, OPTS))
            .toBe(ACTIVITY.SLEEPING);
        // FAIL-ON-OLD (#3795 wired _pendingKanban as pendingWork → returned ACTIVE
        // here, i.e. a permanent false-BUSY on the wallpaper). Stage 0: the open
        // card is now ONLY an IDLE floor → the bot stays awake but shows IDLE.
        expect(bot2._pendingKanban).toBe(true);
        expect(activity.computePendingWork(bot2)).toBe(false);
        expect(activity.evaluateActivityState(bot2, NOW, OPTS)).toBe(ACTIVITY.IDLE);
        expect(activity.evaluateActivityState(bot2, NOW, OPTS)).not.toBe(ACTIVITY.SLEEPING);
        expect(activity.evaluateActivityState(bot2, NOW, OPTS)).not.toBe(ACTIVITY.ACTIVE);

        // a multi-assignee 'todo' card keeps EACH assignee awake at the IDLE floor.
        expect(activity.evaluateActivityState(wire(5, rows), NOW, OPTS)).toBe(ACTIVITY.IDLE);
        expect(activity.evaluateActivityState(wire(7, rows), NOW, OPTS)).toBe(ACTIVITY.IDLE);
    });

    // ── (b) no assigned cards + stale → SLEEPING (unchanged) ──
    test('(b) bot with NO assigned open cards still SLEEPS after SLEEP_AFTER', () => {
        const rows = [{ device_id: DEVICE, status: 'in_progress', archived: false, assigned_bots: [2] }];
        const bot9 = wire(9, rows); // entity 9 is on no card
        expect(bot9._pendingKanban).toBe(false);
        expect(activity.evaluateActivityState(bot9, NOW, OPTS)).toBe(ACTIVITY.SLEEPING);
    });

    // ── (c) done / review / archived / backlog cards do NOT count as pending ──
    test('(c) done, review, archived and backlog cards do NOT keep a bot awake', () => {
        const rows = [
            { device_id: DEVICE, status: 'done', archived: false, assigned_bots: [2] },
            { device_id: DEVICE, status: 'review', archived: false, assigned_bots: [2] },
            { device_id: DEVICE, status: 'backlog', archived: false, assigned_bots: [2] },
            { device_id: DEVICE, status: 'in_progress', archived: true, assigned_bots: [2] }, // archived
        ];
        const bot2 = wire(2, rows);
        expect(bot2._pendingKanban).toBe(false);
        expect(activity.evaluateActivityState(bot2, NOW, OPTS)).toBe(ACTIVITY.SLEEPING);
    });

    test('bucketPendingKanban folds rows per device + parses stringified JSONB, ignores junk', () => {
        const rows = [
            { device_id: 'dev-A', status: 'todo', archived: false, assigned_bots: '[2,4]' }, // string JSONB
            { device_id: 'dev-B', status: 'in_progress', archived: false, assigned_bots: [4] },
            { device_id: 'dev-A', status: 'done', archived: false, assigned_bots: [9] },       // finished
            null,                                                                              // junk row
            { device_id: 'dev-A', status: 'todo', archived: false, assigned_bots: null },      // no array
        ];
        const map = activity.bucketPendingKanban(rows);
        expect([...map.get('dev-A')].sort((a, b) => a - b)).toEqual([2, 4]);
        expect([...map.get('dev-B')]).toEqual([4]);
        expect(map.has('dev-C')).toBe(false);
        expect(activity.bucketPendingKanban(null).size).toBe(0);
        expect(activity.bucketPendingKanban([]).size).toBe(0);
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
        // Every value is a string AgentStatus.fromWireValue already parses
        // (app/.../data/model/AgentStatus.kt) — no new client art/strings.
        expect(ACTIVITY.ACTIVE).toBe('BUSY');
        expect(ACTIVITY.IDLE).toBe('IDLE');
        expect(ACTIVITY.SLEEPING).toBe('SLEEPING');
        expect(ACTIVITY.REVIEW).toBe('REVIEW');
        expect(ACTIVITY.FAILED).toBe('FAILED');
    });
});

describe('entity-activity: Stage 1/2 real-activity runtimeState (busy/stuck/crashed/idle)', () => {
    const STALE_CARD = {
        // far past SLEEP_AFTER, empty queue, but an OPEN assigned card → without a
        // runtime signal this would sit at the IDLE floor.
        lastSendAt: NOW - (SLEEP_AFTER_MS + 10 * 60 * 1000),
        lastActivityAt: NOW - (SLEEP_AFTER_MS + 10 * 60 * 1000),
        messageQueue: [],
        _pendingKanban: true,
    };
    // 45s default staleness window is applied when opts.runtimeStaleMs is omitted.
    const fresh = (now) => now - 10 * 1000;  // stamped 10s ago = fresh
    const stale = (now) => now - 90 * 1000;  // stamped 90s ago = stale (> 45s)

    // ── (c) fresh runtimeState busy → BUSY regardless of cards ──
    test('(c) fresh runtimeState "busy" → BUSY even with no cards and a stale lastSend', () => {
        const entity = makeEntity({
            lastSendAt: NOW - (SLEEP_AFTER_MS + 60 * 1000), // would otherwise SLEEP
            lastActivityAt: NOW - (SLEEP_AFTER_MS + 60 * 1000),
            runtimeState: 'busy',
            lastRuntimeStateAt: fresh(NOW),
            lastRuntimeBusyAt: fresh(NOW),
        });
        // FAIL-ON-OLD: old evaluator had no runtimeState input → this entity
        // (stale send, no pending) decayed to SLEEPING. Now it is BUSY.
        expect(activity.evaluateActivityState(makeEntity({
            lastSendAt: NOW - (SLEEP_AFTER_MS + 60 * 1000),
            lastActivityAt: NOW - (SLEEP_AFTER_MS + 60 * 1000),
        }), NOW, OPTS)).toBe(ACTIVITY.SLEEPING);
        expect(activity.evaluateActivityState(entity, NOW, OPTS)).toBe(ACTIVITY.ACTIVE);
    });

    // ── (d) fresh runtimeState stuck → REVIEW ──
    test('(d) fresh runtimeState "stuck" → REVIEW (agent waiting at a confirm/prompt)', () => {
        const entity = makeEntity({
            ...STALE_CARD,
            runtimeState: 'stuck',
            lastRuntimeStateAt: fresh(NOW),
        });
        // FAIL-ON-OLD: old code only ever returned BUSY/IDLE/SLEEPING — REVIEW is new.
        expect(activity.evaluateActivityState(entity, NOW, OPTS)).toBe(ACTIVITY.REVIEW);
        expect(activity.evaluateActivityState(entity, NOW, OPTS)).toBe('REVIEW');
    });

    // ── (e) fresh runtimeState crashed → FAILED ──
    test('(e) fresh runtimeState "crashed" → FAILED', () => {
        const entity = makeEntity({
            ...STALE_CARD,
            runtimeState: 'crashed',
            lastRuntimeStateAt: fresh(NOW),
        });
        // FAIL-ON-OLD: FAILED is a new evaluator output.
        expect(activity.evaluateActivityState(entity, NOW, OPTS)).toBe(ACTIVITY.FAILED);
        expect(activity.evaluateActivityState(entity, NOW, OPTS)).toBe('FAILED');
    });

    // ── (f) regression: nothing fresh, no cards → SLEEPING ──
    test('(f) stale runtimeState + no cards + stale send → SLEEPING (regression)', () => {
        const entity = makeEntity({
            lastSendAt: NOW - (SLEEP_AFTER_MS + 60 * 1000),
            lastActivityAt: NOW - (SLEEP_AFTER_MS + 60 * 1000),
            runtimeState: 'busy',
            lastRuntimeStateAt: stale(NOW),       // 90s ago → ignored
            lastRuntimeBusyAt: NOW - (SLEEP_AFTER_MS + 60 * 1000),
        });
        expect(activity.freshRuntimeState(entity, NOW)).toBeNull();
        expect(activity.evaluateActivityState(entity, NOW, OPTS)).toBe(ACTIVITY.SLEEPING);
    });

    // ── (g) stale runtimeState → graceful fallback to lastSendAt heuristic ──
    test('(g) stale runtimeState busy is ignored; lastSendAt grace still applies', () => {
        // stuck reported 90s ago (stale) but a message was sent 10s ago → the
        // evaluator ignores the stale runtime and falls back to lastSend → BUSY.
        const recentSend = makeEntity({
            lastSendAt: NOW - 10 * 1000,
            lastActivityAt: NOW - 10 * 1000,
            runtimeState: 'stuck',
            lastRuntimeStateAt: stale(NOW),
        });
        expect(activity.evaluateActivityState(recentSend, NOW, OPTS)).toBe(ACTIVITY.ACTIVE);

        // same stale runtime but the send is also old + an open card → IDLE floor
        // (NOT the stale REVIEW, NOT SLEEPING).
        const oldSend = makeEntity({
            ...STALE_CARD,
            runtimeState: 'stuck',
            lastRuntimeStateAt: stale(NOW),
        });
        expect(activity.evaluateActivityState(oldSend, NOW, OPTS)).toBe(ACTIVITY.IDLE);
    });

    // ── lastRuntimeBusyAt extends the BUSY grace even with no current heartbeat ──
    test('recent lastRuntimeBusyAt keeps BUSY within idle grace (graceful degradation)', () => {
        const entity = makeEntity({
            lastSendAt: NOW - 60 * 60 * 1000,        // sent long ago
            lastActivityAt: NOW - 60 * 60 * 1000,
            runtimeState: 'busy',
            lastRuntimeStateAt: stale(NOW),          // current beat stale → ignored
            lastRuntimeBusyAt: NOW - 20 * 1000,      // but was busy 20s ago (< idle grace)
        });
        expect(activity.freshRuntimeState(entity, NOW)).toBeNull();
        expect(activity.evaluateActivityState(entity, NOW, OPTS)).toBe(ACTIVITY.ACTIVE);
    });

    // ── fresh "idle" is NOT a hard override; it falls through to heuristics ──
    test('fresh runtimeState "idle" falls through to the IDLE floor / sleep logic', () => {
        const withCard = makeEntity({
            ...STALE_CARD,
            runtimeState: 'idle',
            lastRuntimeStateAt: fresh(NOW),
            lastRuntimeBusyAt: 0,
        });
        expect(activity.evaluateActivityState(withCard, NOW, OPTS)).toBe(ACTIVITY.IDLE);

        const noCard = makeEntity({
            lastSendAt: NOW - (SLEEP_AFTER_MS + 60 * 1000),
            lastActivityAt: NOW - (SLEEP_AFTER_MS + 60 * 1000),
            runtimeState: 'idle',
            lastRuntimeStateAt: fresh(NOW),
        });
        expect(activity.evaluateActivityState(noCard, NOW, OPTS)).toBe(ACTIVITY.SLEEPING);
    });

    // ── out-of-allow-list runtimeState is ignored ──
    test('unknown runtimeState value is ignored (treated as absent)', () => {
        expect(activity.freshRuntimeState({ runtimeState: 'pizza', lastRuntimeStateAt: fresh(NOW) }, NOW)).toBeNull();
        expect(activity.freshRuntimeState({ runtimeState: 'busy', lastRuntimeStateAt: 0 }, NOW)).toBeNull();
        expect(activity.freshRuntimeState({}, NOW)).toBeNull();
        expect(activity.freshRuntimeState(null, NOW)).toBeNull();
        // normalizes case/whitespace
        expect(activity.freshRuntimeState({ runtimeState: '  BUSY ', lastRuntimeStateAt: fresh(NOW) }, NOW)).toBe('busy');
    });

    // ── a custom (shorter) staleness window is honored ──
    test('runtimeStaleMs opt tightens the trust window', () => {
        const entity = makeEntity({
            ...STALE_CARD,
            runtimeState: 'busy',
            lastRuntimeStateAt: NOW - 30 * 1000, // 30s ago
            lastRuntimeBusyAt: NOW - 30 * 1000,
        });
        // default 45s window → fresh → BUSY
        expect(activity.evaluateActivityState(entity, NOW, OPTS)).toBe(ACTIVITY.ACTIVE);
        // tightened to 20s → 30s-old beat is stale → no current grace either
        // (lastRuntimeBusyAt 30s > a 20s idle grace) → IDLE floor.
        expect(activity.evaluateActivityState(entity, NOW, { ...OPTS, idleAfterMs: 20 * 1000, runtimeStaleMs: 20 * 1000 }))
            .toBe(ACTIVITY.IDLE);
    });
});
