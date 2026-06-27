-- Migration: 20260627_entity_error_counters_current_vs_historical
-- Card: card_errctr — split the entity error counter into "current cumulative"
--       (當下累計, resettable) vs "historical cumulative" (歷史累計, never resets)
--       and persist a reviewable error-event history (歷史紀錄).
-- Builds on 20260606_entity_status_panel_p0 (entity_error_counters) and
--          20260607_entity_operation_log_p1 (entity_operation_log).
--
-- OWNER SIGN-OFF: this migration is ADDITIVE and reversible (see the .down.sql).
-- The two ADD COLUMN IF NOT EXISTS are metadata-only on PostgreSQL 11+ (no table
-- rewrite). entity_error_counters.count is REDEFINED in meaning from "all-time
-- total" to "current cumulative" — but it stays numerically identical until the
-- first explicit reset, and the backfill below seeds historical_count = count so
-- NO existing total is lost. The backend (backend/entity-status.js initTable)
-- also applies this same idempotent DDL at boot, so production self-heals even if
-- this file is never run by a migration runner.

-- 歷史累計 / historical cumulative — bumped in lockstep with `count`, NEVER reset.
ALTER TABLE entity_error_counters
    ADD COLUMN IF NOT EXISTS historical_count INT NOT NULL DEFAULT 0;

-- When the resettable `count` was last cleared (NULL = never). Lets the UI show
-- "current since <time>".
ALTER TABLE entity_error_counters
    ADD COLUMN IF NOT EXISTS current_reset_at TIMESTAMPTZ;

-- One-time, invariant-preserving backfill: before this change `count` was never
-- resettable, so it equals the all-time total today. Seed historical_count from
-- it, but ONLY where historical is behind (handles re-runs safely — after a real
-- reset count=0 <= historical so this never claws the historical total back).
UPDATE entity_error_counters
    SET historical_count = count
  WHERE historical_count < count;

COMMENT ON COLUMN entity_error_counters.historical_count IS
    'All-time monotonic error total (歷史累計). NEVER touched by the current-counter reset path; count is the resettable 當下累計.';
COMMENT ON COLUMN entity_error_counters.current_reset_at IS
    'Timestamp of the last current-counter reset (count -> 0). NULL = never reset.';

-- 歷史紀錄 / error-event history. One row per counter tick (silent recipient
-- swept past its grace window, or a direct push failure). Survives a current
-- reset and is bounded per (device, entity) by the backend pruner.
CREATE TABLE IF NOT EXISTS entity_error_events (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL,
    entity_id INT NOT NULL,
    axis VARCHAR(64) NOT NULL,
    event_type VARCHAR(64),
    sender_entity_id INT,
    payload_snippet TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eee_lookup
    ON entity_error_events(device_id, entity_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_eee_axis
    ON entity_error_events(device_id, entity_id, axis, id DESC);

COMMENT ON TABLE entity_error_events IS
    'Persisted, reviewable timeline of per-entity error events (歷史紀錄) surfaced '
    'in the entity status drawer. Appended on every counter tick; survives a '
    'current-counter reset. Bounded per (device, entity) to the newest N rows by '
    'backend/entity-status.js pruneErrorEventsFor().';
