-- Down migration for 20260621_push_ack_log
-- Round-trip safety: drop every object created by the up migration. Column
-- drops on push_subscriptions use IF EXISTS so the rollback survives even if
-- the up migration was partially applied.

DROP INDEX IF EXISTS idx_push_subscriptions_active;

ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS deactivated_reason;
ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS deactivated_at;
ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS last_health_acked_at;
ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS last_health_sent_at;
ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS consecutive_failures;
ALTER TABLE push_subscriptions DROP COLUMN IF EXISTS is_active;

DROP INDEX IF EXISTS idx_push_ack_log_run;
DROP INDEX IF EXISTS uq_push_ack_log_nonce_sub;
DROP TABLE IF EXISTS push_ack_log;

DROP INDEX IF EXISTS idx_push_health_run_started;
DROP TABLE IF EXISTS push_health_run;
