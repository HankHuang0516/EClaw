-- Migration: 20260614_message_lifecycle
-- Card: card_1b1c13225f10e8a803cef532 (MessageLifecycle Phase 2 Step 1 — DB only)
-- Spec: docs/specs/message-lifecycle-spec.md §3 (Option B), §3.3, §11
--
-- Phase 2 Step 1 of 6: ships ONLY the DB layer for the unified message
-- lifecycle state machine. Steps 2-6 (Redis wheel, dual-write, backfill,
-- debug endpoint, divergence detector) land in follow-up PRs.
--
-- Option choice: B (companion message_lifecycle table) per spec §3.4 trade-off:
--   - Lower migration risk: no ALTER TABLE on the hot chat_messages path.
--   - Cleaner separation: chat_messages callers are unchanged; only the new
--     lifecycle code touches message_lifecycle.
--   - Outbound rows live as their own row (direction='outbound') instead of
--     leaving lifecycle columns NULL on every outbound chat_messages row.
--   - Backfill is INSERT into a separate table (cold path) instead of UPDATE
--     on chat_messages (hot path) — safer for Railway PG.
--
-- Naming note: the spec text uses `chat_history` as the abstract noun for the
-- chat-message corpus. The actual table in this codebase is `chat_messages`
-- (backend/auth_schema.sql:72) with a UUID primary key. We therefore key the
-- lifecycle row by `message_id TEXT` (matches spec §3.2 + §3.3 verbatim) and
-- do NOT add a FK — this keeps schema flexibility and matches spec §3.3 which
-- also uses TEXT without a FK.
--
-- Constraint #1 (§11): no UPDATE/DELETE path rolls back a state field.
--   - Encoded structurally at the app layer (lifecycle.transition() rejects
--     late events into lifecycle_event_log with applied='rejected_late').
--   - A CHECK on `state` restricts values to the enum domain. PG does not
--     have a clean way to forbid an UPDATE that lowers a state index, so the
--     monotonicity invariant is enforced in code (see spec §2.3 rule 2). The
--     audit table preserves every attempt regardless of acceptance.
--
-- Constraint #2 (§11): unknown/null/timeout NEVER inflate user_seen success.
--   - push_delivered_at and user_seen_at are NULLABLE and are NEVER derived
--     by the backfill resolver (spec §5.1). The schema does not COALESCE them
--     anywhere; SLO query authors must keep `user_seen_at IS NOT NULL` in the
--     numerator of real_user_seen_rate (spec §6.2).

CREATE TABLE IF NOT EXISTS message_lifecycle (
    message_id          TEXT PRIMARY KEY,
    tenant_id           TEXT NOT NULL,
    device_id           VARCHAR(64) NOT NULL,
    entity_id           INTEGER NOT NULL,
    direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    reply_to_message_id TEXT,

    state               TEXT NOT NULL CHECK (state IN ('inbound_seen', 'bot_acked', 'push_delivered', 'user_seen')),
    inbound_seen_at     TIMESTAMPTZ NOT NULL,
    bot_acked_at        TIMESTAMPTZ,
    push_delivered_at   TIMESTAMPTZ,
    user_seen_at        TIMESTAMPTZ,

    -- Spec §2.3 rule 3: out-of-order events advance to the highest observed
    -- state; the skipped intermediate states are recorded here (e.g. ['bot_acked']
    -- if we jumped inbound_seen → push_delivered).
    skipped_states      TEXT[] NOT NULL DEFAULT '{}',

    last_error          TEXT,
    alerted_at          TIMESTAMPTZ,
    source              TEXT NOT NULL DEFAULT 'live'
                        CHECK (source IN ('live', 'backfill', 'backfill+link', 'backfill+heuristic', 'inferred')),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-entity state lookup (dashboard panels, per-entity stuck counts).
CREATE INDEX IF NOT EXISTS idx_ml_device_entity_state
    ON message_lifecycle (device_id, entity_id, state);

-- Sweeper hot path: find rows past their per-state deadline. The COALESCE
-- here is a pivot for "timestamp of current state" (spec §6.3) and is
-- correct because each state's *_at is populated as that state is reached.
-- This does NOT violate constraint #2: COALESCE in an INDEX is only used to
-- locate stuck rows, never to inflate user_seen success in an SLO numerator.
CREATE INDEX IF NOT EXISTS idx_ml_stuck_lookup
    ON message_lifecycle (state, COALESCE(push_delivered_at, bot_acked_at, inbound_seen_at))
    WHERE state <> 'user_seen';

-- Reply-chain joins: given an inbound message_id, find its outbound replies.
CREATE INDEX IF NOT EXISTS idx_ml_reply_chain
    ON message_lifecycle (reply_to_message_id)
    WHERE reply_to_message_id IS NOT NULL;

COMMENT ON TABLE message_lifecycle IS
    'Unified message lifecycle state machine (spec docs/specs/message-lifecycle-spec.md §2). '
    'Replaces legacy chat_no_reply (entity-status.js) and delivery_alert (hermes) counters. '
    'Phase 2 Step 1 ships the schema only — dual-write, Redis wheel, backfill resolver, '
    'and debug endpoint follow in Steps 2-5. Spec §11 constraint #1: no UPDATE path '
    'rolls back a state field (enforced at app layer in lifecycle.transition()). Spec §11 '
    'constraint #2: push_delivered_at and user_seen_at are NEVER derived — SLO queries MUST '
    'keep user_seen_at IS NOT NULL in real_user_seen_rate numerator.';

-- ============================================
-- lifecycle_event_log: audit trail of every transition attempt
-- Spec §2.4 + §3.3
-- ============================================

CREATE TABLE IF NOT EXISTS lifecycle_event_log (
    id              BIGSERIAL PRIMARY KEY,
    message_id      TEXT NOT NULL,
    attempted_state TEXT NOT NULL
                    CHECK (attempted_state IN ('inbound_seen', 'bot_acked', 'push_delivered', 'user_seen')),
    event_at        TIMESTAMPTZ NOT NULL,
    transition_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied         TEXT NOT NULL
                    CHECK (applied IN ('accepted', 'idempotent_noop', 'rejected_late', 'rejected_unknown_message')),
    reason          TEXT,
    source          TEXT NOT NULL
);

-- Per-message audit timeline (debug endpoint hot path, spec §9.1/9.2 acceptance).
CREATE INDEX IF NOT EXISTS idx_lel_message
    ON lifecycle_event_log (message_id, transition_at DESC);

COMMENT ON TABLE lifecycle_event_log IS
    'Append-only audit of every lifecycle transition attempt — accepted, idempotent_noop, '
    'rejected_late, or rejected_unknown_message (spec §2.4). NEVER mutated after insert; '
    'this is the structural enforcement of constraint #1 (no rollback). Read by the debug '
    'endpoint GET /api/debug/message-lifecycle/:messageId (Step 5) for the per-message timeline.';

-- ============================================
-- lifecycle_divergence_log: dual-write divergence detector (Phase 2 Step 6)
-- Spec §6.5 (Phase 3 cutover gate) + §9.10 acceptance.
-- Added in Step 3 (card_1b1c1322) alongside the dual-write paths.
-- ============================================

CREATE TABLE IF NOT EXISTS lifecycle_divergence_log (
    id              BIGSERIAL PRIMARY KEY,
    message_id      TEXT,
    device_id       VARCHAR(64),
    entity_id       INTEGER,
    legacy_counter  TEXT NOT NULL,   -- 'chat_no_reply' | 'delivery_alert' | 'system_msg_no_reply'
    direction       TEXT NOT NULL,   -- 'legacy_skipped' | 'lifecycle_skipped'
    reason          TEXT,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ldl_window
    ON lifecycle_divergence_log (occurred_at DESC);

COMMENT ON TABLE lifecycle_divergence_log IS
    'Dual-write divergence detector (spec §6.5 / §9.10). When a legacy counter '
    'site increments but its paired lifecycle.transition() was skipped (or vice '
    'versa), one row is recorded here. The Phase 3 cutover gate (new_alert_volume '
    '/ legacy_alert_volume within +-10%) reads this so divergence surfaces rather '
    'than silently passing.';
