-- Migration: 20260606_entity_status_panel_p0
-- PR: [Feature/P0] Entity status panel — counter table for entity_error_counters
-- Purpose: persist cumulative error counters per entity, used by the entity
-- status drawer that opens when a user clicks any non-dashboard avatar.
-- Non-breaking: brand-new table.

CREATE TABLE IF NOT EXISTS entity_error_counters (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL,
    entity_id INT NOT NULL,
    axis VARCHAR(64) NOT NULL,
    count INT NOT NULL DEFAULT 0,
    last_event_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(device_id, entity_id, axis)
);

CREATE INDEX IF NOT EXISTS idx_eec_lookup
    ON entity_error_counters(device_id, entity_id);

COMMENT ON TABLE entity_error_counters IS
    'Per-entity cumulative error counters surfaced in the entity status drawer. '
    'axis examples: chat_no_reply, a2a_no_reply, kanban_nudge_no_reply, system_msg_no_reply. '
    'New axes can be added without schema changes — counter rows are upserted on (device_id, entity_id, axis).';
