/**
 * MessageLifecycle transition engine — pure state-machine logic (spec §2).
 *
 * Card: card_1b1c13225f10e8a803cef532 (Phase 2 Step 3 — dual-write engine).
 * Spec: docs/specs/message-lifecycle-spec.md §2 (state machine), §11 (#6 constraints).
 *
 * This module is intentionally DB-free and Redis-free. It encodes ONLY the
 * decision: given the current materialized row and an incoming transition
 * attempt, what is the new row + what audit verdict applies. The store
 * (./store.js) owns persistence; this owns correctness.
 *
 * Why split: the two #6 sign-off constraints (idempotent + monotonic; never
 * inflate user_seen) are pure logic. Encoding them here, with exhaustive unit
 * tests, means the persistence layer cannot accidentally roll back a state —
 * it can only apply the verdict this engine returns.
 */
'use strict';

// Canonical state ordering. Index = monotonic rank. Spec §2.1.
const STATES = ['inbound_seen', 'bot_acked', 'push_delivered', 'user_seen'];

// Map state -> the *_at column that records when it was reached.
const STATE_AT_FIELD = {
    inbound_seen: 'inbound_seen_at',
    bot_acked: 'bot_acked_at',
    push_delivered: 'push_delivered_at',
    user_seen: 'user_seen_at',
};

// Audit verdicts (spec §2.4 — lifecycle_event_log.applied domain).
const APPLIED = {
    ACCEPTED: 'accepted',
    IDEMPOTENT_NOOP: 'idempotent_noop',
    REJECTED_LATE: 'rejected_late',
    REJECTED_UNKNOWN_MESSAGE: 'rejected_unknown_message',
};

function stateIndex(state) {
    const i = STATES.indexOf(state);
    return i; // -1 if unknown
}

function isValidState(state) {
    return stateIndex(state) >= 0;
}

/**
 * Decide the outcome of a transition attempt.
 *
 * @param {object|null} row  Current materialized lifecycle row, or null if the
 *   message has no lifecycle row yet (caller decides whether to create one).
 * @param {string} targetState  State the event is trying to advance to.
 * @param {Date|number|string} eventAt  When the upstream event actually happened.
 * @returns {{
 *   applied: string,          // one of APPLIED.*
 *   nextState?: string,       // resulting row.state if accepted
 *   setField?: string,        // the *_at column to set (accepted only)
 *   setValue?: Date,          // value for that column (accepted only)
 *   skippedStates?: string[], // intermediate states jumped over (spec §2.3 rule 3)
 *   reason?: string,          // human-readable diagnostic for the audit row
 * }}
 *
 * Contract (spec §2.3):
 *   1. Idempotent — re-applying the same target at the current state where the
 *      *_at is already set returns IDEMPOTENT_NOOP (no mutation).
 *   2. Monotonic — a target whose rank is <= the current state's rank, and
 *      whose *_at is NOT already settable as a forward advance, is REJECTED_LATE.
 *   3. No rollback — never returns a nextState with lower rank than row.state.
 *   4. Skip-forward — advancing past intermediate states records them in
 *      skippedStates and leaves their *_at NULL (spec §9.3). Their *_at is
 *      NEVER backfilled later (constraint #2 + §9.3).
 */
function decideTransition(row, targetState, eventAt) {
    if (!isValidState(targetState)) {
        return {
            applied: APPLIED.REJECTED_UNKNOWN_MESSAGE,
            reason: `unknown target state '${targetState}'`,
        };
    }

    const at = coerceDate(eventAt);
    const targetIdx = stateIndex(targetState);

    // No existing row: the store decides creation. For inbound_seen this is a
    // fresh-row create; for any later state with no row it is "unknown message"
    // (we never fabricate an inbound_seen we did not observe).
    if (!row) {
        if (targetState === 'inbound_seen') {
            return {
                applied: APPLIED.ACCEPTED,
                nextState: 'inbound_seen',
                setField: 'inbound_seen_at',
                setValue: at,
                skippedStates: [],
                reason: 'created',
            };
        }
        return {
            applied: APPLIED.REJECTED_UNKNOWN_MESSAGE,
            reason: `no lifecycle row for target '${targetState}'`,
        };
    }

    const currentIdx = stateIndex(row.state);

    // Idempotent: the *_at for this exact target is already populated.
    // Re-applying the same advance is a no-op. Spec §2.3 rule 1 + §9.1.
    const targetAtField = STATE_AT_FIELD[targetState];
    if (row[targetAtField] != null) {
        return {
            applied: APPLIED.IDEMPOTENT_NOOP,
            reason: `${targetState} already recorded`,
        };
    }

    // Monotonic guard: a target at or below the current rank, whose *_at is
    // NULL, means a late/out-of-order event for a state we already advanced
    // past (or skipped). It is recorded in the audit log but NEVER mutates the
    // row. Spec §2.3 rule 2 + §9.2 + §9.3 (late bot_acked after skip).
    if (targetIdx <= currentIdx) {
        return {
            applied: APPLIED.REJECTED_LATE,
            reason: `target '${targetState}' (rank ${targetIdx}) <= current '${row.state}' (rank ${currentIdx})`,
        };
    }

    // Forward advance — possibly skipping intermediate states (spec §2.3 rule 3).
    const skipped = [];
    for (let i = currentIdx + 1; i < targetIdx; i++) {
        skipped.push(STATES[i]);
    }

    return {
        applied: APPLIED.ACCEPTED,
        nextState: targetState,
        setField: targetAtField,
        setValue: at,
        skippedStates: skipped,
        reason: skipped.length ? `advanced, skipped [${skipped.join(',')}]` : 'advanced',
    };
}

function coerceDate(v) {
    if (v instanceof Date) return v;
    if (typeof v === 'number') return new Date(v);
    if (typeof v === 'string') return new Date(v);
    return new Date();
}

module.exports = {
    STATES,
    STATE_AT_FIELD,
    APPLIED,
    stateIndex,
    isValidState,
    decideTransition,
};
