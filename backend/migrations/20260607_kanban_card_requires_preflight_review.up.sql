-- Migration: 20260607_kanban_card_requires_preflight_review
-- OODA-R Phase 1 #3c — gate kanban_cards transitions to done unless the
-- card has a composer-marker preflight comment AND a 5-item evidence
-- comment. Default TRUE so every existing card gates by default; trivial
-- cards (dep-bumps, doc renames) can flip to FALSE via the standard
-- PUT /card/:id column-mapping path.

ALTER TABLE kanban_cards
    ADD COLUMN IF NOT EXISTS requires_preflight_review BOOLEAN DEFAULT TRUE;

COMMENT ON COLUMN kanban_cards.requires_preflight_review IS
    'OODA-R Phase 1 #3c done-gate: when TRUE (default), moving to done requires '
    'an [OODA-R preflight composer-marker comment + a subsequent evidence '
    'comment citing Scope / Acceptance / Test plan / Evidence plan / Out-of-scope. '
    'Flip to FALSE for trivial cards (dep bumps, doc renames) via PUT /card/:id.';
