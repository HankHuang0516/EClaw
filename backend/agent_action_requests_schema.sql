-- agent_action_requests — Human-in-the-Loop "需要你" inbox.
--
-- An autonomous agent (entity) that gets blocked needing the user emits a
-- row here ("I need you to decide / approve / fill in X"). The chat-page
-- "需要你" inbox lists pending rows; the user resolves/dismisses them, and
-- the answer routes back to the agent so it can unblock and continue.
--
-- anchor_message_id pins the originating chat message (the his_<uuid> /
-- chat_messages UUID) so the inbox item can route back to that message and
-- the user's smart-quote reply can be correlated to the exact request.
-- Parent spec: card_a03d9d09 (child card_edeb190b).

CREATE TABLE IF NOT EXISTS agent_action_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id VARCHAR(64) NOT NULL,
    from_entity_id INTEGER NOT NULL,
    anchor_message_id UUID DEFAULT NULL,
    type VARCHAR(16) NOT NULL,
    prompt TEXT NOT NULL,
    options JSONB DEFAULT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    answer JSONB DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ DEFAULT NULL,
    -- Set once when the timeout worker fires a 'consensus' round for this still-
    -- pending request, so the worker never re-triggers a round on each 5-min tick
    -- (card_ce0d685b). NULL = no consensus round triggered yet.
    consensus_triggered_at TIMESTAMPTZ DEFAULT NULL,
    -- Optional kanban-card reference (計畫D, card_df646877). When set, the inbox
    -- item renders a "🗂 任務卡" chip that deep-links to this card. NULL = no card.
    related_card_id VARCHAR(64) DEFAULT NULL,
    CONSTRAINT aar_prompt_len CHECK (char_length(prompt) BETWEEN 1 AND 2000),
    CONSTRAINT aar_type_valid CHECK (type IN ('decision','approval','input','credential','review','clarify','consensus')),
    CONSTRAINT aar_status_valid CHECK (status IN ('pending','resolved','dismissed'))
);

CREATE INDEX IF NOT EXISTS idx_aar_device_status ON agent_action_requests(device_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aar_anchor ON agent_action_requests(anchor_message_id);

-- agent_action_request_audit — tamper-evident edit trail for the PUT edit
-- endpoint (card_cd4f323c). Hank's decision opt2: ANY agent on the device may
-- edit ANY request's content (prompt/options/type), not just the creator. That
-- cross-agent power carries a tampering risk, so EVERY content edit writes one
-- row here in the SAME transaction as the UPDATE. `changes` holds only the
-- fields that actually changed, each as {old,new}. editor_entity_id is the
-- editing agent's entity id, or NULL when a human (deviceSecret) made the edit.
-- Append-only: no edit/resolve/dismiss ever rewrites a row here.
CREATE TABLE IF NOT EXISTS agent_action_request_audit (
    id BIGSERIAL PRIMARY KEY,
    request_id UUID NOT NULL,
    device_id VARCHAR(64) NOT NULL,
    editor_entity_id INTEGER DEFAULT NULL,
    changes JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aar_audit_request ON agent_action_request_audit(request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aar_audit_editor ON agent_action_request_audit(device_id, editor_entity_id, created_at DESC);
