-- Dedicated public-plugin tables. No migrations or changes to legacy OAuth.
-- Codes, consent nonces, access tokens and refresh tokens are stored as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS codex_plugin_oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris TEXT[] NOT NULL,
    grant_types TEXT[] NOT NULL,
    scope TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS codex_plugin_oauth_consents (
    csrf_hash TEXT PRIMARY KEY,
    session_hash TEXT NOT NULL,
    client_id TEXT NOT NULL REFERENCES codex_plugin_oauth_clients(client_id),
    device_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    resource TEXT NOT NULL,
    scope TEXT NOT NULL,
    state TEXT,
    code_challenge TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS codex_plugin_oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES codex_plugin_oauth_clients(client_id),
    device_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    resource TEXT NOT NULL,
    scope TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

-- A grant is a revocable token family with an absolute lifetime (30 days).
CREATE TABLE IF NOT EXISTS codex_plugin_oauth_grants (
    grant_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES codex_plugin_oauth_clients(client_id),
    device_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS codex_plugin_oauth_tokens (
    access_hash TEXT PRIMARY KEY,
    refresh_hash TEXT UNIQUE,
    grant_id TEXT NOT NULL REFERENCES codex_plugin_oauth_grants(grant_id),
    scope TEXT NOT NULL,
    access_expires_at TIMESTAMPTZ NOT NULL,
    refresh_expires_at TIMESTAMPTZ,
    refresh_consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
