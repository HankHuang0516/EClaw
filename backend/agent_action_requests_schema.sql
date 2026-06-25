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
    CONSTRAINT aar_prompt_len CHECK (char_length(prompt) BETWEEN 1 AND 2000),
    CONSTRAINT aar_type_valid CHECK (type IN ('decision','approval','input','credential','review','clarify','consensus')),
    CONSTRAINT aar_status_valid CHECK (status IN ('pending','resolved','dismissed'))
);

CREATE INDEX IF NOT EXISTS idx_aar_device_status ON agent_action_requests(device_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aar_anchor ON agent_action_requests(anchor_message_id);
