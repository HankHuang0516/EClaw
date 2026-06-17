-- Migration: 20260617_entity_org_grants
-- Card: card_1242aaa56221c42a1fe5ef87 ([Hermes/P2] H3 t2 — Per-org credential scope)
-- Roadmap: 🤖 Hermes Channel — H3 Private Repo Support (roadmap.html line 682)
--
-- Per-org credential scope for Hermes. Each entity-bound Hermes session may only
-- obtain a scoped GitHub App installation token for orgs explicitly granted here.
-- Orgs NOT present for an entity are refused (403 + audit log) at the
-- /api/hermes/org-token route — the master PAT is never returned.
--
-- Replayable: IF NOT EXISTS on every object so re-running the migration (or the
-- module's initTable() bootstrap) is a no-op.

CREATE TABLE IF NOT EXISTS entity_org_grants (
    id BIGSERIAL PRIMARY KEY,
    -- The EClaw entity (bot) the grant is bound to. Matches entities[].entityId.
    entity_id INTEGER NOT NULL,
    -- Optional device scope. NULL = grant applies to the entity on any device it
    -- is bound to; a value pins the grant to one device's binding of the entity.
    device_id VARCHAR(64),
    -- GitHub org login (case-insensitive compare done in app layer via LOWER()).
    org_login VARCHAR(255) NOT NULL,
    -- The GitHub App installation id for this org, if known. The token-issuance
    -- layer maps org_login -> installation_id; carrying it here lets the route
    -- issue a scoped installation token without a second lookup. Nullable while
    -- App-installation infra is still being wired (token issuance stubbed → 501).
    installation_id BIGINT,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Who/what created the grant (audit aid): 'admin' | 'self-service' | 'seed'.
    granted_by VARCHAR(64) NOT NULL DEFAULT 'admin',
    -- Soft-revoke without losing the audit trail of the original grant.
    revoked_at TIMESTAMPTZ
);

-- One active grant row per (entity, device, org). device_id participates so an
-- entity can be granted org-X on device A but not device B. COALESCE keeps the
-- NULL (any-device) rows unique too.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_org_grants
    ON entity_org_grants(entity_id, COALESCE(device_id, ''), LOWER(org_login));

-- Hot path: grant-check by (entity, org) ignoring revoked rows.
CREATE INDEX IF NOT EXISTS idx_entity_org_grants_lookup
    ON entity_org_grants(entity_id, LOWER(org_login))
    WHERE revoked_at IS NULL;

COMMENT ON TABLE entity_org_grants IS
    'Per-org credential scope for Hermes (card_1242aaa5). Maps an EClaw entity to '
    'the GitHub orgs it may obtain a scoped installation token for. Orgs absent '
    'here are refused at /api/hermes/org-token (403 + audit log). The master PAT '
    'is NEVER returned by that route — only per-org GitHub App installation tokens.';

-- Audit log of every org-token request (granted or refused). Security-critical:
-- this is the trail that proves cross-org access was denied. NEVER stores a token.
CREATE TABLE IF NOT EXISTS entity_org_token_audit (
    id BIGSERIAL PRIMARY KEY,
    entity_id INTEGER NOT NULL,
    device_id VARCHAR(64),
    org_login VARCHAR(255) NOT NULL,
    -- 'granted' | 'denied_no_grant' | 'denied_auth' | 'issuance_unavailable'
    outcome VARCHAR(32) NOT NULL,
    detail TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entity_org_token_audit_lookup
    ON entity_org_token_audit(entity_id, requested_at DESC);

COMMENT ON TABLE entity_org_token_audit IS
    'Append-only audit of org-token requests (card_1242aaa5). One row per call to '
    '/api/hermes/org-token. Records outcome + org but NEVER the token value or PAT.';
