DROP INDEX IF EXISTS idx_kanban_cards_gated;
ALTER TABLE kanban_cards
    DROP COLUMN IF EXISTS gate_reason,
    DROP COLUMN IF EXISTS gated;
