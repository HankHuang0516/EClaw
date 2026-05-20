-- Backlog launch-gate flag for kanban cards.
-- When gated=true, L1/L2/L3 staleness escalation skips the card so launch-pending
-- work doesn't bounce backlog→blocked under #1's "draft-done-awaiting-launch" semantic.
-- Auto-resets to false on status change out of backlog (enforced in app layer).
ALTER TABLE kanban_cards
    ADD COLUMN IF NOT EXISTS gated BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS gate_reason VARCHAR(255) DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_kanban_cards_gated
    ON kanban_cards(gated)
    WHERE gated = TRUE;
