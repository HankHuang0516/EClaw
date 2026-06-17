'use strict';

// Pure transition-engine tests (spec §2.3, §11 constraint #1).
//
// Card: card_1b1c13225f10e8a803cef532 (Phase 2 Step 3).
// Spec: docs/specs/message-lifecycle-spec.md §2.3 (idempotent/monotonic/no-rollback),
//       §9.1-§9.3 acceptance scenarios at the pure-logic layer.
//
// The engine is DB-free, so these tests lock the decision contract without any
// harness. The store tests (./store.test.js) then verify the same contract end
// to end against an in-memory Postgres (pg-mem).

const { decideTransition, APPLIED, STATES, stateIndex } = require('../../../lib/message-lifecycle/engine');

const T0 = new Date('2026-06-16T00:00:00Z');
const T1 = new Date('2026-06-16T00:01:00Z');

function rowAt(state, fields = {}) {
    return {
        message_id: 'm',
        state,
        inbound_seen_at: T0,
        bot_acked_at: null,
        push_delivered_at: null,
        user_seen_at: null,
        ...fields,
    };
}

describe('engine: state ordering', () => {
    test('canonical order is inbound_seen < bot_acked < push_delivered < user_seen', () => {
        expect(STATES).toEqual(['inbound_seen', 'bot_acked', 'push_delivered', 'user_seen']);
        expect(stateIndex('inbound_seen')).toBeLessThan(stateIndex('bot_acked'));
        expect(stateIndex('push_delivered')).toBeLessThan(stateIndex('user_seen'));
        expect(stateIndex('nope')).toBe(-1);
    });
});

describe('engine: row creation', () => {
    test('no row + inbound_seen → ACCEPTED create', () => {
        const v = decideTransition(null, 'inbound_seen', T0);
        expect(v.applied).toBe(APPLIED.ACCEPTED);
        expect(v.nextState).toBe('inbound_seen');
        expect(v.setField).toBe('inbound_seen_at');
    });

    test('no row + later state → rejected_unknown_message (never fabricate inbound)', () => {
        const v = decideTransition(null, 'bot_acked', T0);
        expect(v.applied).toBe(APPLIED.REJECTED_UNKNOWN_MESSAGE);
    });

    test('unknown target state → rejected_unknown_message', () => {
        const v = decideTransition(rowAt('inbound_seen'), 'garbage', T0);
        expect(v.applied).toBe(APPLIED.REJECTED_UNKNOWN_MESSAGE);
    });
});

describe('engine: §9.1 idempotent', () => {
    test('re-applying an already-recorded state is a no-op', () => {
        const row = rowAt('bot_acked', { bot_acked_at: T0 });
        const v = decideTransition(row, 'bot_acked', T1);
        expect(v.applied).toBe(APPLIED.IDEMPOTENT_NOOP);
        expect(v.setField).toBeUndefined();
    });
});

describe('engine: §9.2 monotonic — late event rejected', () => {
    test('bot_acked arriving after push_delivered (bot_acked_at NULL) is rejected_late', () => {
        const row = rowAt('push_delivered', { push_delivered_at: T1 });
        const v = decideTransition(row, 'bot_acked', T0);
        expect(v.applied).toBe(APPLIED.REJECTED_LATE);
        expect(v.setField).toBeUndefined();
    });

    test('a strictly-lower state with its *_at NULL is rejected_late (no rollback)', () => {
        const row = rowAt('user_seen', { user_seen_at: T1 });
        const v = decideTransition(row, 'inbound_seen', T0);
        // inbound_seen_at is set (NOT NULL) so this is idempotent, not late:
        expect([APPLIED.IDEMPOTENT_NOOP, APPLIED.REJECTED_LATE]).toContain(v.applied);
        expect(v.nextState).toBeUndefined();
    });
});

describe('engine: §9.3 out-of-order skip', () => {
    test('inbound_seen → user_seen records skipped [bot_acked, push_delivered]', () => {
        const row = rowAt('inbound_seen', { inbound_seen_at: T0 });
        const v = decideTransition(row, 'user_seen', T1);
        expect(v.applied).toBe(APPLIED.ACCEPTED);
        expect(v.nextState).toBe('user_seen');
        expect(v.setField).toBe('user_seen_at');
        expect(v.skippedStates).toEqual(['bot_acked', 'push_delivered']);
    });

    test('after a skip to user_seen, a late bot_acked is rejected_late (never backfills)', () => {
        // Simulate the post-skip row: state=user_seen, bot_acked_at still NULL.
        const row = rowAt('user_seen', { user_seen_at: T1, bot_acked_at: null });
        const v = decideTransition(row, 'bot_acked', T0);
        expect(v.applied).toBe(APPLIED.REJECTED_LATE);
        expect(v.setField).toBeUndefined();
    });
});

describe('engine: forward advance', () => {
    test('inbound_seen → bot_acked sets bot_acked_at, no skips', () => {
        const v = decideTransition(rowAt('inbound_seen'), 'bot_acked', T1);
        expect(v.applied).toBe(APPLIED.ACCEPTED);
        expect(v.setField).toBe('bot_acked_at');
        expect(v.skippedStates).toEqual([]);
    });

    test('bot_acked → push_delivered → user_seen advances stepwise', () => {
        let v = decideTransition(rowAt('bot_acked', { bot_acked_at: T0 }), 'push_delivered', T1);
        expect(v.nextState).toBe('push_delivered');
        v = decideTransition(rowAt('push_delivered', { bot_acked_at: T0, push_delivered_at: T1 }), 'user_seen', T1);
        expect(v.nextState).toBe('user_seen');
    });
});
