CREATE TABLE IF NOT EXISTS codex_plugin_bindings (
    id UUID PRIMARY KEY,
    device_id TEXT NOT NULL,
    request_id UUID NOT NULL,
    entity_id INTEGER,
    channel_account_id INTEGER,
    config JSONB NOT NULL,
    runtime_token_hash TEXT,
    runtime_state TEXT NOT NULL DEFAULT 'offline',
    heartbeat_at BIGINT,
    disconnected BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL,
    UNIQUE (device_id, request_id)
);
CREATE TABLE IF NOT EXISTS codex_plugin_enrollments (
    id UUID PRIMARY KEY,
    binding_id UUID NOT NULL REFERENCES codex_plugin_bindings(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    workspace TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    approved BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (binding_id, token_hash)
);
CREATE TABLE IF NOT EXISTS codex_plugin_jobs (
    id UUID PRIMARY KEY,
    binding_id UUID NOT NULL REFERENCES codex_plugin_bindings(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    created_at BIGINT NOT NULL,
    completed_at BIGINT,
    reply_message TEXT
);
CREATE INDEX IF NOT EXISTS codex_plugin_jobs_pending
    ON codex_plugin_jobs (binding_id, created_at) WHERE completed_at IS NULL;
