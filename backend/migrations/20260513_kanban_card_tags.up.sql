
-- ============================================
-- Migration: Device-scoped Kanban tags
-- Explicit many-to-many tags for board filters and force-graph clustering.
-- Tags are normalized by API as trim/lower slugs; label preserves display text.
-- ============================================
CREATE TABLE IF NOT EXISTS kanban_tags (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL,
    slug VARCHAR(80) NOT NULL,
    label VARCHAR(120) NOT NULL,
    created_by INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(device_id, slug)
);

CREATE TABLE IF NOT EXISTS kanban_card_tags (
    device_id VARCHAR(64) NOT NULL,
    card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
    tag_id BIGINT NOT NULL REFERENCES kanban_tags(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY(device_id, card_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_kanban_tags_device_slug ON kanban_tags(device_id, slug);
CREATE INDEX IF NOT EXISTS idx_kanban_card_tags_card ON kanban_card_tags(device_id, card_id);
CREATE INDEX IF NOT EXISTS idx_kanban_card_tags_tag ON kanban_card_tags(device_id, tag_id);
