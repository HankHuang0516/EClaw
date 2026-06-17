-- Down migration for 20260617_entity_org_grants
-- Round-trip safety: drop every object created by the up migration.

DROP INDEX IF EXISTS idx_entity_org_token_audit_lookup;
DROP TABLE IF EXISTS entity_org_token_audit;

DROP INDEX IF EXISTS idx_entity_org_grants_lookup;
DROP INDEX IF EXISTS uq_entity_org_grants;
DROP TABLE IF EXISTS entity_org_grants;
