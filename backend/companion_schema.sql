-- @brm-crossref: Petdx Companion (伙伴瀏覽器 + 社群伙伴貢獻系統)
-- Spec: docs/specs/petdx-backend-api-spec.md (v0.2)
-- Stage 1 (this file): companions main table only.
-- Stage 2+ will add companion_favorites / companion_ratings / companion_comments
-- / companion_select_log in follow-up PRs.
-- ============================================

-- ============================================
-- companions — main catalog table
-- ============================================
-- Keys: id is the public companion identifier (e.g. "petdx-orange-cat-001").
-- author_entity_id NULL = system built-in (no creator).
-- descriptor stores the full CompanionDescriptor JSON; supported_states is
-- denormalized as a JSON array on the row to keep /states/help cheap.
-- scope+status compound index covers the common community list query
-- (scope='community' AND status='published') with cheap ORDER BY tie-breaks.

CREATE TABLE IF NOT EXISTS companions (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    version          TEXT NOT NULL DEFAULT '1.0.0',
    author_entity_id INTEGER,
    device_id        TEXT,
    descriptor       JSONB NOT NULL,
    asset_type       TEXT NOT NULL CHECK (asset_type IN ('procedural','spritesheet','vector')),
    asset_url        TEXT,
    avatar_url       TEXT,
    thumbnail_url    TEXT,
    supported_states JSONB NOT NULL DEFAULT '["IDLE"]'::jsonb,
    scope            TEXT NOT NULL DEFAULT 'community'
                       CHECK (scope IN ('system','community','private')),
    status           TEXT NOT NULL DEFAULT 'pending_review'
                       CHECK (status IN ('pending_review','published','rejected','hidden','pending_changes')),
    license          TEXT NOT NULL DEFAULT 'EClaw-default',
    category         TEXT,
    mood             TEXT,
    color            TEXT,
    tags             JSONB NOT NULL DEFAULT '[]'::jsonb,
    i18n_data        JSONB,
    download_count   INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
    favorite_count   INTEGER NOT NULL DEFAULT 0 CHECK (favorite_count >= 0),
    rating_avg       REAL,
    rating_count     INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
    comment_count    INTEGER NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
    created_at       BIGINT NOT NULL,
    updated_at       BIGINT NOT NULL,
    published_at     BIGINT,
    rejected_at      BIGINT,
    reject_reason    TEXT
);

CREATE INDEX IF NOT EXISTS idx_companions_status        ON companions(status);
CREATE INDEX IF NOT EXISTS idx_companions_author        ON companions(author_entity_id);
CREATE INDEX IF NOT EXISTS idx_companions_scope_status  ON companions(scope, status);
CREATE INDEX IF NOT EXISTS idx_companions_popular       ON companions(download_count DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_companions_recent        ON companions(published_at DESC)   WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_companions_asset_type    ON companions(asset_type, status);
CREATE INDEX IF NOT EXISTS idx_companions_tags          ON companions USING GIN (tags);

-- ============================================
-- Seed: official system companions (built-in; idempotent)
-- ============================================
-- These are the procedural drawers shipped in public/shared/petdx-renderer.js.
-- ON CONFLICT DO NOTHING keeps repeat runs safe; updates go through a new
-- version + deploy, not by editing seeded rows here.

INSERT INTO companions (
    id, name, version, author_entity_id, device_id,
    descriptor, asset_type, supported_states, scope, status,
    license, category, mood, color, tags,
    created_at, updated_at, published_at
) VALUES
(
    'petdx-lobster-default', '預設龍蝦 Lobster (Default)', '1.0.0',
    NULL, NULL,
    '{"id":"petdx-lobster-default","name":"預設龍蝦","assetType":"procedural","asset":{"renderer":"lobster-procedural","params":{"bodyColor":"#e63946","eyeStyle":"bead","antennaStyle":"double-curl"}},"supportedStates":["IDLE","BUSY","EATING","SLEEPING","EXCITED"],"stateAssets":{"IDLE":{"loop":true,"fps":4},"BUSY":{"loop":true,"fps":6},"EATING":{"loop":true,"fps":6},"SLEEPING":{"loop":true,"fps":2},"EXCITED":{"loop":false,"fps":12}}}'::jsonb,
    'procedural',
    '["IDLE","BUSY","EATING","SLEEPING","EXCITED"]'::jsonb,
    'system', 'published', 'EClaw-default',
    'mascot', 'happy', '#e63946', '["mascot","default","lobster"]'::jsonb,
    1778000000000, 1778000000000, 1778000000000
),
(
    'petdx-lobster-blue', '海洋龍蝦 Lobster (Blue)', '1.0.0',
    NULL, NULL,
    '{"id":"petdx-lobster-blue","name":"海洋龍蝦","assetType":"procedural","asset":{"renderer":"lobster-procedural","params":{"bodyColor":"#0d6efd"}},"supportedStates":["IDLE","BUSY","SLEEPING","EXCITED"],"stateAssets":{"IDLE":{"loop":true,"fps":4},"BUSY":{"loop":true,"fps":6},"SLEEPING":{"loop":true,"fps":2},"EXCITED":{"loop":false,"fps":12}}}'::jsonb,
    'procedural',
    '["IDLE","BUSY","SLEEPING","EXCITED"]'::jsonb,
    'system', 'published', 'EClaw-default',
    'mascot', 'calm', '#0d6efd', '["mascot","ocean","lobster"]'::jsonb,
    1778000000000, 1778000000000, 1778000000000
)
ON CONFLICT (id) DO NOTHING;
