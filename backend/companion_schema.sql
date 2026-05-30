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
-- companion_favorites — per (device, entity) favorite list
-- ============================================
-- (device_id, entity_id, companion_id) is the unique grain. entity_id may be
-- NULL for device-only favoriting (deviceSecret auth path); the unique
-- index COALESCEs entity_id to -1 so device-level rows still dedupe.

CREATE TABLE IF NOT EXISTS companion_favorites (
    id            BIGSERIAL PRIMARY KEY,
    device_id     TEXT NOT NULL,
    entity_id     INTEGER,
    companion_id  TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
    created_at    BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_favorites_unique
    ON companion_favorites (device_id, COALESCE(entity_id, -1), companion_id);
CREATE INDEX IF NOT EXISTS idx_companion_favorites_companion
    ON companion_favorites (companion_id);
CREATE INDEX IF NOT EXISTS idx_companion_favorites_owner
    ON companion_favorites (device_id, entity_id);

-- ============================================
-- companion_select_log — append-only history of "select pet" actions
-- ============================================
-- Latest row per (device_id, entity_id) is the current selection. We keep a
-- history rather than a single mutable row so we can show recent activity
-- and let users undo. entity_id NULL = device-level selection.

CREATE TABLE IF NOT EXISTS companion_select_log (
    id            BIGSERIAL PRIMARY KEY,
    device_id     TEXT NOT NULL,
    entity_id     INTEGER,
    companion_id  TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
    selected_at   BIGINT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'portal'
                  CHECK (source IN ('portal','app','api'))
);

CREATE INDEX IF NOT EXISTS idx_companion_select_owner_time
    ON companion_select_log (device_id, entity_id, selected_at DESC);
CREATE INDEX IF NOT EXISTS idx_companion_select_companion
    ON companion_select_log (companion_id);

-- ============================================
-- companion_ratings — single mutable row per (device, entity, companion)
-- ============================================
-- Stars are 1..5 ints. We store updated_at separately so the API can show
-- "edited" without hiding the original review timestamp. companions.rating_avg
-- and rating_count are recomputed on every upsert/delete (small enough table
-- per companion that a SELECT AVG is fine).

CREATE TABLE IF NOT EXISTS companion_ratings (
    id            BIGSERIAL PRIMARY KEY,
    device_id     TEXT NOT NULL,
    entity_id     INTEGER,
    companion_id  TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
    stars         INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    created_at    BIGINT NOT NULL,
    updated_at    BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_ratings_unique
    ON companion_ratings (device_id, COALESCE(entity_id, -1), companion_id);
CREATE INDEX IF NOT EXISTS idx_companion_ratings_companion
    ON companion_ratings (companion_id);

-- ============================================
-- companion_comments — append + soft-delete log
-- ============================================
-- text length capped at 500 (validated in API). deleted_at != NULL hides the
-- row from list queries; companions.comment_count is decremented on delete
-- but we keep the row for moderator audit. Author-only or companion-owner
-- can delete (enforced in router).

CREATE TABLE IF NOT EXISTS companion_comments (
    id            BIGSERIAL PRIMARY KEY,
    device_id     TEXT NOT NULL,
    entity_id     INTEGER,
    companion_id  TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
    text          TEXT NOT NULL,
    created_at    BIGINT NOT NULL,
    deleted_at    BIGINT
);

CREATE INDEX IF NOT EXISTS idx_companion_comments_companion_time
    ON companion_comments (companion_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_companion_comments_owner
    ON companion_comments (device_id, entity_id);

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

-- ============================================
-- Phase 0 amendment (2026-05-30): companion_select_log.origin
-- ============================================
-- Per docs/specs/petdx-uiux-spec-amendment-2026-05-30-phase-0.md §0.2a:
-- Phase 0 auto-assignment writes source = 'api' (CHECK-constrained) and
-- records its real provenance in this new `origin` column so user-selected
-- vs system-default vs rental-inherited is queryable without invalidating
-- the existing CHECK or breaking older callers that read `source`.
-- Values written by Phase 0:
--   'phase0-auto'       — bind / rebind / character-change hook
--   'phase0-backfill'   — scripts/petdx-phase0-backfill.js stamp
--   'user-selected'     — companion-select endpoint
--   'rental-inherited'  — rental bot inheriting lessor's companion
-- Values may also be NULL on rows written before this migration.

ALTER TABLE companion_select_log ADD COLUMN IF NOT EXISTS origin TEXT;

CREATE INDEX IF NOT EXISTS idx_companion_select_origin
    ON companion_select_log (device_id, entity_id, origin);
