-- Down migration for 20260627_entity_error_counters_current_vs_historical.
-- Reversible: drops the history table + the two additive columns. NOTE that
-- dropping historical_count discards the all-time totals and dropping
-- entity_error_events discards the persisted history — this is a data-losing
-- rollback by nature, so only run it as a deliberate revert. `count` reverts to
-- being the (now post-any-reset) current total.

DROP TABLE IF EXISTS entity_error_events;

ALTER TABLE entity_error_counters
    DROP COLUMN IF EXISTS historical_count;
ALTER TABLE entity_error_counters
    DROP COLUMN IF EXISTS current_reset_at;
