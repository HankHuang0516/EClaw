CREATE TABLE IF NOT EXISTS taaze_demo_bundles (
    id TEXT PRIMARY KEY,
    source_sha256 TEXT NOT NULL,
    bundle_sha256 TEXT NOT NULL,
    imported_by TEXT NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS taaze_demo_assets (
    bundle_id TEXT NOT NULL REFERENCES taaze_demo_bundles(id),
    path TEXT NOT NULL,
    content_type TEXT NOT NULL,
    body BYTEA NOT NULL,
    PRIMARY KEY(bundle_id, path)
);
CREATE TABLE IF NOT EXISTS taaze_demo_shares (
    id TEXT PRIMARY KEY,
    bundle_id TEXT NOT NULL REFERENCES taaze_demo_bundles(id),
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_by TEXT,
    UNIQUE(created_by, request_id)
);
ALTER TABLE taaze_demo_shares ALTER COLUMN expires_at DROP NOT NULL;
