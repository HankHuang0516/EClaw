-- Add explicit ordered linked-task pointers for task chip navigation.
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS linked_prev_card_id VARCHAR(48) DEFAULT NULL;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS linked_next_card_id VARCHAR(48) DEFAULT NULL;
