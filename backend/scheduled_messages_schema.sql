-- Scheduled Messages Schema (Phase 1 backend)
-- PostgreSQL
--
-- Lets users queue a chat message to be dispatched at a future time
-- by a server-side background poller. Dispatch is fire-once: sent_at
-- is stamped atomically via UPDATE ... FOR UPDATE SKIP LOCKED.

CREATE TABLE IF NOT EXISTS scheduled_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT NOT NULL,
    chat_entity_id INTEGER NOT NULL,         -- chat room context (which chat the message was scheduled in)
    user_entity_id INTEGER NOT NULL,         -- sender entity id (typically 0 = device owner)
    target_entity_ids JSONB NOT NULL,        -- array of entity ids, e.g. [0, 3, 5]
    content TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    last_error TEXT,
    CONSTRAINT scheduled_messages_content_len CHECK (char_length(content) BETWEEN 1 AND 10000)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_pending
    ON scheduled_messages (scheduled_at)
    WHERE sent_at IS NULL AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_device
    ON scheduled_messages (device_id, chat_entity_id);
