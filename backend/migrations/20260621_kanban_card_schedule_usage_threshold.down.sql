-- Reverse of 20260621_kanban_card_schedule_usage_threshold.up.sql

ALTER TABLE kanban_cards
    DROP COLUMN IF EXISTS schedule_skip_if_5h_pct_over,
    DROP COLUMN IF EXISTS schedule_skip_if_7d_pct_over;
