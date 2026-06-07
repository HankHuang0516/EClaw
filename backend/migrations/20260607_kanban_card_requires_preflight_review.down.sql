-- Reverse of 20260607_kanban_card_requires_preflight_review.up.sql

ALTER TABLE kanban_cards
    DROP COLUMN IF EXISTS requires_preflight_review;
