-- Migration down: 20260606_entity_status_panel_p0
DROP INDEX IF EXISTS idx_eec_lookup;
DROP TABLE IF EXISTS entity_error_counters;
