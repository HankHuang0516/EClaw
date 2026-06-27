-- Down migration for 20260627_action_request_negotiation
-- Round-trip safety: drop every object created by the up migration. Column drops
-- use IF EXISTS so the rollback survives a partially-applied up migration.

DROP INDEX IF EXISTS idx_aar_votes_request;
DROP TABLE IF EXISTS agent_action_request_votes;

ALTER TABLE agent_action_requests DROP COLUMN IF EXISTS negotiation;
ALTER TABLE agent_action_requests DROP COLUMN IF EXISTS consensus_collect_at;
