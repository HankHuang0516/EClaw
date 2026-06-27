-- Migration: 20260627_action_request_negotiation
-- 需要你 negotiation / consensus workflow (owner-approved build).
--
-- A 需要你 item with options (device on the consensus policy + enough bound
-- entities) opens a bot-to-bot negotiation round: entities VOTE → the task-owner
-- entity (from_entity_id) SYNTHESIZES a best answer → it is written back to the
-- inbox item (SURFACED, never auto-executed) → the owner disposes. Never hangs
-- (server fallback after a grace window); never auto-executes an owner-only item.
--
-- Additive + reversible. The same DDL is self-healed on boot by
-- initAgentActionRequestsDatabase() (ADD COLUMN / CREATE TABLE IF NOT EXISTS), so
-- this file documents + version-controls the change; re-running is a no-op.

-- ============================================
-- agent_action_requests: negotiation state markers
-- ============================================
-- consensus_collect_at: the collection window closed / owner prompted to
--                       synthesize (S1 COLLECTING → S2 SYNTHESIZING). NULL = round
--                       not yet closed (or never opened).
-- negotiation:          TERMINAL conclusion blob — non-null ⇒ "協商完成 — 待裁決".
--                       {conclusion, bestSolution, bestOptionIndex,
--                        votes:{count,total}, perEntity, synthesizedBy,
--                        synthesizedAt, fallback}. status STAYS 'pending' until the
--                        owner disposes / 計畫E ratify auto-resolves; NULL = not
--                        concluded.
ALTER TABLE agent_action_requests
    ADD COLUMN IF NOT EXISTS consensus_collect_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE agent_action_requests
    ADD COLUMN IF NOT EXISTS negotiation JSONB DEFAULT NULL;

-- ============================================
-- agent_action_request_votes: per-entity votes
-- ============================================
-- One vote per (request, entity); last-write-wins via the UNIQUE constraint
-- (INSERT … ON CONFLICT (request_id, entity_id) DO UPDATE). A vote carries an
-- option_index (a choice into the request's options[]) OR free_text, plus an
-- optional rationale. Votes are accepted only while the round is COLLECTING.
CREATE TABLE IF NOT EXISTS agent_action_request_votes (
    id BIGSERIAL PRIMARY KEY,
    request_id UUID NOT NULL,
    entity_id INTEGER NOT NULL,
    option_index INTEGER DEFAULT NULL,
    free_text TEXT DEFAULT NULL,
    rationale TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT aar_votes_unique UNIQUE (request_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_aar_votes_request ON agent_action_request_votes(request_id);

COMMENT ON TABLE agent_action_request_votes IS
    '需要你 negotiation per-entity votes. One vote per (request, entity), '
    'last-write-wins; option_index OR free_text + optional rationale. Accepted '
    'only while the negotiation round is COLLECTING.';
