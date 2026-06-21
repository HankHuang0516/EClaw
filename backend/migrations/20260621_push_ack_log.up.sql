-- Migration: 20260621_push_ack_log
-- Card: card_0a5d4a97d40d0957aa349e9f ([Spec+Feat/P0] 推播健康檢查 — round-trip verify)
--
-- Round-trip push health verification. The server fires silent health pushes
-- on a cron tick (push-health-check-cron.js); the service worker handler in
-- /sw.js POSTs to /api/push/ack with the nonce; we record the ack here and
-- attribute it back to the run via the nonce that links them together.
--
-- Why a dedicated table (not a column on push_subscriptions): one health run
-- emits N pushes (one per active subscription) and each ack is independent —
-- modeling as a separate fact table lets us reconstruct per-run delivery rates
-- without UPDATE-on-every-ack contention.
--
-- Replayable: IF NOT EXISTS on every object so re-running the migration (or a
-- module's initTable() bootstrap path) is a no-op.

-- ============================================
-- push_health_run: one row per cron tick
-- ============================================
CREATE TABLE IF NOT EXISTS push_health_run (
    run_id VARCHAR(48) PRIMARY KEY,           -- 'run_<hex>' assigned by the cron module
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,                  -- NULL while the 60s ack window is open
    sent_count INTEGER NOT NULL DEFAULT 0,    -- subscriptions we attempted to push to
    delivered_count INTEGER NOT NULL DEFAULT 0, -- web-push send returned success (no error)
    acked_count_60s INTEGER NOT NULL DEFAULT 0, -- nonces ack'd within 60s window
    dead_count INTEGER NOT NULL DEFAULT 0,    -- subscriptions removed (410/404) this run
    error_count INTEGER NOT NULL DEFAULT 0,   -- subscriptions that errored (other than 410/404)
    reason VARCHAR(32) NOT NULL DEFAULT 'cron' -- 'cron' | 'manual' | 'test'
);

CREATE INDEX IF NOT EXISTS idx_push_health_run_started
    ON push_health_run(started_at DESC);

COMMENT ON TABLE push_health_run IS
    'Per-cron-tick rollup of push health verification (card_0a5d4a97). One row '
    'per health-check run; counts are filled when the 60s ack window closes.';

-- ============================================
-- push_ack_log: one row per service-worker ack
-- ============================================
CREATE TABLE IF NOT EXISTS push_ack_log (
    id BIGSERIAL PRIMARY KEY,
    nonce VARCHAR(64) NOT NULL,               -- uuid emitted in the health push payload
    subscription_id INTEGER,                  -- FK-ish ref to push_subscriptions.id (nullable so SW can ack even if row was deleted between send + ack)
    run_id VARCHAR(48),                       -- FK-ish ref to push_health_run.run_id (nullable for resilience)
    acked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One ack per (nonce, subscription). Repeated SW deliveries (Chrome may retry)
-- collapse to a single row instead of inflating acked_count.
CREATE UNIQUE INDEX IF NOT EXISTS uq_push_ack_log_nonce_sub
    ON push_ack_log(nonce, COALESCE(subscription_id, 0));

CREATE INDEX IF NOT EXISTS idx_push_ack_log_run
    ON push_ack_log(run_id, acked_at);

COMMENT ON TABLE push_ack_log IS
    'Service-worker round-trip ack log for push health verification '
    '(card_0a5d4a97). The SW POSTs /api/push/ack with the nonce from the '
    'health push payload; each ack lands here. Joined to push_health_run by '
    'run_id (the cron fills run_id when emitting nonces).';

-- ============================================
-- push_subscriptions: add health-tracking columns
-- ============================================
-- The bare push_subscriptions table (created in notifications.js boot path)
-- has no concept of "dead" — we need columns the cron can update to mark a
-- subscription unhealthy after 3+ consecutive failed runs, and a default of
-- TRUE so all EXISTING rows keep receiving pushes.

ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;

ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS last_health_sent_at TIMESTAMPTZ;

ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS last_health_acked_at TIMESTAMPTZ;

ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS deactivated_reason VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_active
    ON push_subscriptions(is_active)
    WHERE is_active = TRUE;
