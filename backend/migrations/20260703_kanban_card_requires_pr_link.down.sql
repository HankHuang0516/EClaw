-- Reverse of 20260703_kanban_card_requires_pr_link.up.sql

ALTER TABLE kanban_cards
    DROP COLUMN IF EXISTS requires_pr_link;
