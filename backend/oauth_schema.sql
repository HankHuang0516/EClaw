-- OAuth 2.0 Authorization Server Schema (Issue #190)

CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id VARCHAR(64) PRIMARY KEY,
    client_secret VARCHAR(128) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    redirect_uris JSONB DEFAULT '[]'::jsonb,
    grant_types JSONB DEFAULT '["authorization_code","client_credentials"]'::jsonb,
    scopes JSONB DEFAULT '["read"]'::jsonb,
    owner_device_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
    code VARCHAR(128) PRIMARY KEY,
    client_id VARCHAR(64) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    device_id VARCHAR(255),
    redirect_uri TEXT NOT NULL,
    scopes JSONB DEFAULT '[]'::jsonb,
    expires_at BIGINT NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
    id VARCHAR(64) PRIMARY KEY,
    access_token VARCHAR(512) UNIQUE NOT NULL,
    refresh_token VARCHAR(256) UNIQUE,
    client_id VARCHAR(64) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    device_id VARCHAR(255),
    scopes JSONB DEFAULT '[]'::jsonb,
    expires_at BIGINT NOT NULL,
    revoked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_access ON oauth_tokens(access_token) WHERE revoked = FALSE;
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_token) WHERE revoked = FALSE;
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_authorization_codes(expires_at) WHERE used = FALSE;
