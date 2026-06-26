-- Migration: 20260626_action_request_audit
-- Card: card_cd4f323c2fc2552d85ee15c4 (Plan B — edit "需要你" action-request content)
--
-- Hank's decisions 2026-06-26:
--   opt1 編輯語意: agents may EDIT an existing action-request's content
--                 (prompt text, options/choices, type) via PUT /api/action-requests/:id.
--   opt2 權限範圍: ANY agent on the device may edit ANY request (cross-agent),
--                 not just the creator. That tampering risk is mitigated by a
--                 MANDATORY audit record written on every edit.
--
-- This audit table is also created at boot by agent-action-requests.js'
-- initAgentActionRequestsDatabase() (it runs agent_action_requests_schema.sql,
-- which carries the same DDL). This migration file is the ops/SoT mirror — both
-- use IF NOT EXISTS so they are idempotent and never conflict.
--
-- `changes` stores only the fields that actually changed on a given edit, each
-- as {"old": <prev>, "new": <next>}, e.g.
--   {"prompt": {"old": "pick A", "new": "pick A or B"},
--    "options": {"old": ["A"], "new": ["A","B"]}}
-- editor_entity_id = the editing agent's entity id, or NULL for a human edit.

CREATE TABLE IF NOT EXISTS agent_action_request_audit (
    id BIGSERIAL PRIMARY KEY,
    request_id UUID NOT NULL,
    device_id VARCHAR(64) NOT NULL,
    editor_entity_id INTEGER DEFAULT NULL,
    changes JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aar_audit_request
    ON agent_action_request_audit(request_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aar_audit_editor
    ON agent_action_request_audit(device_id, editor_entity_id, created_at DESC);

COMMENT ON TABLE agent_action_request_audit IS
    'Append-only audit trail of content edits to agent_action_requests (PUT '
    '/api/action-requests/:id, card_cd4f323c). One row per edit; cross-agent '
    'edits are permitted (opt2) so this table is the tampering-risk mitigation. '
    'changes holds only the {old,new} of fields that actually changed.';
