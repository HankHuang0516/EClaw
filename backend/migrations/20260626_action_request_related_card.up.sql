-- Migration: 20260626_action_request_related_card
-- Card: card_df6468775f9f91d093b84e04 (計畫D — optional related-card reference
--       on a "需要你" action-request)
--
-- Adds an OPTIONAL kanban-card reference to agent_action_requests. When set, an
-- agent attaches the card a request relates to; the chat "需要你" inbox renders a
-- "🗂 任務卡" chip on that item that deep-links to the card.
--
-- This column is also added at boot by agent-action-requests.js'
-- initAgentActionRequestsDatabase() (the CREATE TABLE in
-- agent_action_requests_schema.sql carries it for fresh installs, and an
-- idempotent ALTER ... ADD COLUMN IF NOT EXISTS adds it to the existing prod
-- table). This migration file is the ops/SoT mirror — both use IF NOT EXISTS so
-- they are idempotent and never conflict.

ALTER TABLE agent_action_requests
    ADD COLUMN IF NOT EXISTS related_card_id VARCHAR(64) DEFAULT NULL;

COMMENT ON COLUMN agent_action_requests.related_card_id IS
    'Optional kanban-card reference (計畫D, card_df646877). NULL = no linked card. '
    'When set, the "需要你" inbox renders a 🗂 任務卡 chip that deep-links to the card.';
