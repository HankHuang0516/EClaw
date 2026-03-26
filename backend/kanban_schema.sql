-- Kanban Board Schema (Mission Center v2)
-- PostgreSQL

-- ============================================
-- Kanban Cards Table
-- ============================================
CREATE TABLE IF NOT EXISTS kanban_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id VARCHAR(64) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT DEFAULT '',
    priority VARCHAR(8) NOT NULL DEFAULT 'P2',           -- P0, P1, P2, P3
    status VARCHAR(16) NOT NULL DEFAULT 'backlog',       -- backlog, todo, in_progress, review, done
    assigned_bots JSONB DEFAULT '[]'::jsonb,             -- array of entity IDs e.g. [2, 4]
    created_by INTEGER NOT NULL DEFAULT 0,               -- entity ID of creator
    status_changed_at TIMESTAMPTZ DEFAULT NOW(),         -- for stale detection
    stale_threshold_ms BIGINT DEFAULT 10800000,          -- 3 hours
    done_retention_ms BIGINT DEFAULT 86400000,           -- 24 hours
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
-- Kanban Comments Table (留言板)
-- ============================================
CREATE TABLE IF NOT EXISTS kanban_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id UUID NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
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
    card_id UUID NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
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
    card_id UUID NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    url TEXT NOT NULL,                                   -- link to file (S3, external URL, etc.)
    mime_type VARCHAR(128) DEFAULT NULL,
    file_size BIGINT DEFAULT NULL,
    uploaded_by INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kanban_files_card ON kanban_files(card_id);
