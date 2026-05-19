-- Launch-gate suppression for backlog cards
-- See feedback_kanban_backlog_vs_blocked (Mac_F 2026-05-19) + card_8af4544e8f8f05f70cdfd022.
-- A backlog card with launch_gated=TRUE is excluded from the stale-card scan,
-- so it cannot fire L1 nudges or auto-escalate (L2 priority bump / L3 → blocked).
-- The flag is automatically cleared on POST /card/:id/move whenever the card
-- leaves backlog, preventing accidental nudge-suppression on real work-in-flight.
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS launch_gated BOOLEAN DEFAULT FALSE;
