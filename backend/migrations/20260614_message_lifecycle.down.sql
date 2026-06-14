-- Down: 20260614_message_lifecycle
-- Drop the lifecycle schema in reverse order.

DROP INDEX IF EXISTS idx_lel_message;
DROP TABLE IF EXISTS lifecycle_event_log;

DROP INDEX IF EXISTS idx_ml_reply_chain;
DROP INDEX IF EXISTS idx_ml_stuck_lookup;
DROP INDEX IF EXISTS idx_ml_device_entity_state;
DROP TABLE IF EXISTS message_lifecycle;
