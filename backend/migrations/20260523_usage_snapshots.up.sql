-- ============================================
-- Migration: usage_snapshots — Plan B Phase 1
-- ============================================
-- Stores per-device Claude Code / Codex CLI token spend snapshots pushed by
-- the local mac-daemon every ~60s. Dashboard widgets and bot queries read
-- the latest row + aggregate sums (today/7d/30d) for display.
--
-- See: kanban card_c68db1d65325e4122acc86aa
--      research: claude-code-eclaw-channel/usage_integration_research_2026_05_23.md
-- ============================================

CREATE TABLE IF NOT EXISTS usage_snapshots (
    id              BIGSERIAL PRIMARY KEY,
    device_id       TEXT        NOT NULL,
    entity_id       INTEGER     NULL,
    captured_at     TIMESTAMPTZ NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    daemon_version  TEXT        NULL,
    claude_json     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    codex_json      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    pricing_source  TEXT        NULL
);

CREATE INDEX IF NOT EXISTS usage_snapshots_device_captured_idx
    ON usage_snapshots (device_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS usage_snapshots_received_idx
    ON usage_snapshots (received_at DESC);
