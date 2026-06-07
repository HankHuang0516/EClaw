-- Migration: 20260607_entity_operation_log_p1
-- PR: [Feature/P1] Entity status panel — operation log + smart chip + smart quote
-- Builds on 20260606_entity_status_panel_p0 (entity_error_counters).

CREATE TABLE IF NOT EXISTS entity_operation_log (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL,
    entity_id INT NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    event_summary TEXT NOT NULL,
    event_payload JSONB DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eol_lookup
    ON entity_operation_log(device_id, entity_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_eol_event_type
    ON entity_operation_log(device_id, entity_id, event_type, occurred_at DESC);

COMMENT ON TABLE entity_operation_log IS
    'Chronological log of operations performed by/affecting an entity. Surfaced in the entity status drawer block 2. '
    'event_type values: card_create | card_edit | card_status | card_delete | msg_received | a2a_received | system_msg | dashboard_op | counter_inc | other. '
    'event_summary is the human-readable 1-line description shown in the UI list. '
    'event_payload carries full structured context (card_id, sender_entity_id, msg excerpt, etc.) used by chip render + quote injection.';
