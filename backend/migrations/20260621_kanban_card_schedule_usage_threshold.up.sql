-- Migration: 20260621_kanban_card_schedule_usage_threshold
-- card_c26358498ecee64638b9ca9c (parent card_ad507345ce19fc5f51c2d814)
--
-- Per-card usage-quota guard for recurring cron schedules. When a scheduled
-- automation card fires, the scheduler can now skip dispatching the child
-- card if any assigned entity's current usage% (Claude/Codex 5h or 7d window)
-- exceeds the per-card threshold. This avoids burning quota on a busy
-- subagent or starving the user during peak load.
--
-- Defaults: 5h>85%, 7d>95% (the standard "quota almost full" markers).
-- Range: [50, 99]. Editable per-card via PUT /api/mission/card/:id/schedule.
-- When usage data is unavailable for the entity, treat as 0% (do NOT skip)
-- — preserves the existing dispatch behavior on cards predating this column.

ALTER TABLE kanban_cards
    ADD COLUMN IF NOT EXISTS schedule_skip_if_5h_pct_over SMALLINT DEFAULT 85,
    ADD COLUMN IF NOT EXISTS schedule_skip_if_7d_pct_over SMALLINT DEFAULT 95;

COMMENT ON COLUMN kanban_cards.schedule_skip_if_5h_pct_over IS
    'Recurring-schedule guard: skip child-card dispatch when ANY assigned '
    'entity''s rolling 5-hour usage% strictly exceeds this value. Range '
    '[50, 99]. Default 85. NULL or out-of-range falls back to 85 at fire '
    'time. Wired from PUT /api/mission/card/:id/schedule.';

COMMENT ON COLUMN kanban_cards.schedule_skip_if_7d_pct_over IS
    'Recurring-schedule guard: skip child-card dispatch when ANY assigned '
    'entity''s rolling 7-day usage% strictly exceeds this value. Range '
    '[50, 99]. Default 95. NULL or out-of-range falls back to 95 at fire '
    'time. Wired from PUT /api/mission/card/:id/schedule.';
