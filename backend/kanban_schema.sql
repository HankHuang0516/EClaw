-- Kanban Board Schema (Mission Center v2)
-- PostgreSQL

-- ============================================
-- Kanban Cards Table
-- ============================================
CREATE TABLE IF NOT EXISTS kanban_cards (
    id VARCHAR(48) PRIMARY KEY DEFAULT ('card_' || encode(gen_random_bytes(12), 'hex')),
    device_id VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT DEFAULT '',
    priority VARCHAR(8) NOT NULL DEFAULT 'P2',           -- P0, P1, P2, P3
    status VARCHAR(16) NOT NULL DEFAULT 'backlog',       -- canonical enum: see public/shared/kanban-status.js (backlog, todo, in_progress, review, done, blocked)
    assigned_bots JSONB DEFAULT '[]'::jsonb,             -- array of entity IDs e.g. [2, 4]
    created_by INTEGER NOT NULL DEFAULT 0,               -- entity ID of creator
    status_changed_at TIMESTAMPTZ DEFAULT NOW(),         -- for stale detection
    stale_threshold_ms BIGINT DEFAULT 10800000,          -- 3 hours
    done_retention_ms BIGINT DEFAULT 604800000,          -- 7 days (2026-04-23: bumped from 24h)
    last_stale_nudge_at TIMESTAMPTZ DEFAULT NULL,        -- last nudge timestamp (min 1hr gap)
    archived BOOLEAN DEFAULT FALSE,
    archived_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kanban_cards_device ON kanban_cards(device_id);
CREATE INDEX IF NOT EXISTS idx_kanban_cards_status ON kanban_cards(device_id, status);
CREATE INDEX IF NOT EXISTS idx_kanban_cards_archived ON kanban_cards(device_id, archived);

-- ============================================
-- Migration: Schedule fields
-- ============================================
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS schedule_type VARCHAR(16) DEFAULT NULL;          -- 'once' or 'recurring'
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS schedule_cron VARCHAR(128) DEFAULT NULL;          -- cron expression
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS schedule_run_at TIMESTAMPTZ DEFAULT NULL;         -- one-time trigger
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS schedule_timezone VARCHAR(64) DEFAULT 'Asia/Taipei';
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS schedule_last_run_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS schedule_next_run_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_kanban_cards_schedule ON kanban_cards(schedule_enabled, schedule_next_run_at)
    WHERE schedule_enabled = true;

-- ============================================
-- Migration: Automation (母卡/子卡) fields
-- ============================================
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS is_automation BOOLEAN DEFAULT FALSE;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS parent_card_id VARCHAR(48) DEFAULT NULL;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS is_auto_generated BOOLEAN DEFAULT FALSE;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS last_run_result TEXT DEFAULT NULL;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS active_child_id VARCHAR(48) DEFAULT NULL;

ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS reviewer_entity_id INTEGER DEFAULT NULL;

-- Screenshot review gate (2026-04-24): cards with this flag cannot move to review/done
-- without at least one image/* file attached via POST /api/mission/card/:id/file.
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS requires_screenshot_review BOOLEAN DEFAULT TRUE;

-- Chat-anchor (2026-04-28): every human-filed card should pin the originating
-- chat message + mind-map coord so the card has provenance back into 心智 / 對話.
-- Auto-cards leave both NULL (rendered as N/A in UI).
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS chat_anchor_message_id TEXT DEFAULT NULL;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS chat_anchor_coord JSONB DEFAULT NULL;

-- Per-entity nudge log (2026-04-28): hard ceiling so a single bot can't be
-- nudged more than once per kanban_nudge_interval_minutes regardless of how
-- many stale cards reference it. Cron-schedule母卡 spawn子卡 path uses the
-- smart per-bot queue (kanban_pending_notify, see below) and never writes here.
CREATE TABLE IF NOT EXISTS kanban_entity_nudge_log (
    device_id VARCHAR(64) NOT NULL,
    entity_id INTEGER NOT NULL,
    last_nudged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (device_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_kanban_cards_automation ON kanban_cards(device_id, is_automation)
    WHERE is_automation = true;
CREATE INDEX IF NOT EXISTS idx_kanban_cards_parent ON kanban_cards(parent_card_id)
    WHERE parent_card_id IS NOT NULL;

-- ============================================
-- Migration: bump done_retention from 24h → 7d (2026-04-23)
-- Change column default, then bump rows still sitting on the old 86400000 value.
-- Rows that have an explicit per-card override (any other value) stay untouched.
-- ============================================
ALTER TABLE kanban_cards ALTER COLUMN done_retention_ms SET DEFAULT 604800000;
UPDATE kanban_cards SET done_retention_ms = 604800000 WHERE done_retention_ms = 86400000;

-- ============================================
-- Index: updated_at DESC for the new default kanban sort (2026-04-23)
-- ============================================
CREATE INDEX IF NOT EXISTS idx_kanban_cards_device_updated ON kanban_cards(device_id, updated_at DESC);

-- ============================================
-- Kanban Comments Table (留言板)
-- ============================================
CREATE TABLE IF NOT EXISTS kanban_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    from_entity_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    is_system BOOLEAN DEFAULT FALSE,                     -- system messages (status changes, nudges)
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kanban_comments_card ON kanban_comments(card_id, created_at);

-- ============================================
-- Kanban Notes Table (筆記區)
-- ============================================
CREATE TABLE IF NOT EXISTS kanban_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    from_entity_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kanban_notes_card ON kanban_notes(card_id);

-- ============================================
-- Kanban Files Table (檔案區)
-- ============================================
CREATE TABLE IF NOT EXISTS kanban_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,                                   -- link to file (S3, external URL, etc.)
    mime_type VARCHAR(128) DEFAULT NULL,
    file_size BIGINT DEFAULT NULL,
    uploaded_by INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kanban_files_card ON kanban_files(card_id);

-- Link to r2_files.file_id so GET can regenerate a fresh signed URL on demand.
-- Nullable for backward-compat with rows that only stored a raw URL.
ALTER TABLE kanban_files ADD COLUMN IF NOT EXISTS file_id TEXT;
CREATE INDEX IF NOT EXISTS idx_kanban_files_file_id ON kanban_files(file_id);

-- ============================================
-- ID prefix migration (idempotent; no-ops after first run)
-- Widen kanban_cards.id UUID → VARCHAR(48) so Stripe-style prefixed IDs
-- (card_<24hex>) can coexist with legacy UUIDs.
-- ============================================
ALTER TABLE kanban_comments DROP CONSTRAINT IF EXISTS kanban_comments_card_id_fkey;
ALTER TABLE kanban_notes DROP CONSTRAINT IF EXISTS kanban_notes_card_id_fkey;
ALTER TABLE kanban_files DROP CONSTRAINT IF EXISTS kanban_files_card_id_fkey;
ALTER TABLE kanban_cards ALTER COLUMN id DROP DEFAULT;
ALTER TABLE kanban_cards ALTER COLUMN id TYPE VARCHAR(48) USING id::text;
ALTER TABLE kanban_cards ALTER COLUMN id SET DEFAULT ('card_' || encode(gen_random_bytes(12), 'hex'));
ALTER TABLE kanban_comments ALTER COLUMN card_id TYPE VARCHAR(48) USING card_id::text;
ALTER TABLE kanban_notes ALTER COLUMN card_id TYPE VARCHAR(48) USING card_id::text;
ALTER TABLE kanban_files ALTER COLUMN card_id TYPE VARCHAR(48) USING card_id::text;
ALTER TABLE kanban_comments ADD CONSTRAINT kanban_comments_card_id_fkey FOREIGN KEY (card_id) REFERENCES kanban_cards(id) ON DELETE CASCADE;
ALTER TABLE kanban_notes ADD CONSTRAINT kanban_notes_card_id_fkey FOREIGN KEY (card_id) REFERENCES kanban_cards(id) ON DELETE CASCADE;
ALTER TABLE kanban_files ADD CONSTRAINT kanban_files_card_id_fkey FOREIGN KEY (card_id) REFERENCES kanban_cards(id) ON DELETE CASCADE;
ALTER TABLE kanban_cards ALTER COLUMN parent_card_id TYPE VARCHAR(48) USING parent_card_id::text;
ALTER TABLE kanban_cards ALTER COLUMN active_child_id TYPE VARCHAR(48) USING active_child_id::text;

-- ============================================
-- Smart-queue notify (card_dfe3b8df Phase 2)
-- Per-bot pending_notify queue: cron auto-spawn child cards enqueue
-- silently when the assignedBot already has active todo/in_progress
-- work; one entry drains per move-to-done event for that bot.
-- ============================================
CREATE TABLE IF NOT EXISTS kanban_pending_notify (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL,
    bot_entity_id INTEGER NOT NULL,
    card_id VARCHAR(48) NOT NULL,
    msg TEXT NOT NULL,
    payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kanban_pending_notify_bot ON kanban_pending_notify(device_id, bot_entity_id, created_at);

-- ============================================
-- Migration: Idle dispatch automation
-- ============================================
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS dispatch_mode VARCHAR(20) DEFAULT 'immediate';
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS pending_dispatch BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_kanban_cards_pending_dispatch ON kanban_cards(device_id, pending_dispatch, dispatch_mode)
    WHERE pending_dispatch = TRUE;

-- ============================================
-- Migration: Card dependency chain (PR-DCA)
-- Restored from PR #2481 (cleaned in #2494) per Mac_F sign-off 2026-05-07.
-- Cycle detection lives in backend/kanban-dependencies.js (BFS in JS); no
-- PL/pgSQL function is registered, so this section stays compatible with
-- the kanban_schema.sql `;`-splitter in initKanbanDatabase().
-- ============================================
CREATE TABLE IF NOT EXISTS kanban_card_dependencies (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL,
    card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
    depends_on_card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
    dependency_type VARCHAR(16) DEFAULT 'blocks',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by INTEGER NOT NULL DEFAULT 0,
    UNIQUE(device_id, card_id, depends_on_card_id)
);

CREATE INDEX IF NOT EXISTS idx_kanban_dependencies_card ON kanban_card_dependencies(device_id, card_id);
CREATE INDEX IF NOT EXISTS idx_kanban_dependencies_depends_on ON kanban_card_dependencies(device_id, depends_on_card_id);
CREATE INDEX IF NOT EXISTS idx_kanban_dependencies_type ON kanban_card_dependencies(device_id, dependency_type);

ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS has_dependencies BOOLEAN DEFAULT FALSE;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS dependency_status VARCHAR(16) DEFAULT 'ready';

-- ============================================
-- Migration: Explicit non-hierarchical card links
-- Separate from parent/automation and dependency/blocking edges.
-- ============================================
CREATE TABLE IF NOT EXISTS kanban_card_links (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL,
    source_card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
    target_card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
    relation_type VARCHAR(24) NOT NULL DEFAULT 'related',
    created_by INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(device_id, source_card_id, target_card_id, relation_type),
    CHECK (source_card_id <> target_card_id)
);

CREATE INDEX IF NOT EXISTS idx_kanban_card_links_source ON kanban_card_links(device_id, source_card_id);
CREATE INDEX IF NOT EXISTS idx_kanban_card_links_target ON kanban_card_links(device_id, target_card_id);
CREATE INDEX IF NOT EXISTS idx_kanban_card_links_relation ON kanban_card_links(device_id, relation_type);

