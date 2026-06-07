-- Migration: 20260607_outbound_msg_pending_p0_fix
-- Outbound message tracking for the avatar status drawer's no_reply counters.
-- Solves the semantic gap where the existing axes only ticked on push delivery
-- failure (HTTP 4xx/5xx, AbortError) and missed the real case Hank flagged:
-- push succeeded with HTTP 200 but the recipient bot never wrote a reply back.

CREATE TABLE IF NOT EXISTS outbound_msg_pending (
    id BIGSERIAL PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL,
    sender_entity_id INT NOT NULL,
    recipient_entity_id INT NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    axis VARCHAR(64) NOT NULL,
    dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    payload_snippet TEXT
);

-- Sweeper scans expired rows by axis; recipient_entity_id is the entity that
-- gets credited with the no_reply tick when its row expires unmatched.
CREATE INDEX IF NOT EXISTS idx_omp_expires_at
    ON outbound_msg_pending(expires_at);

-- Reply matching walks (device, recipient→sender, axis) so each incoming
-- transform/speak can delete the matching pending row before it expires.
CREATE INDEX IF NOT EXISTS idx_omp_match
    ON outbound_msg_pending(device_id, sender_entity_id, recipient_entity_id, axis);

COMMENT ON TABLE outbound_msg_pending IS
    'Tracks outbound bot-to-bot / user-to-bot / system-to-bot messages that have not yet been answered. '
    'Inserted by pushToBot on success. Deleted when the recipient writes a matching reply within expires_at. '
    'Swept once per minute: expired-unmatched rows tick the entity_error_counters axis for the recipient. '
    'Powers the avatar status drawer no_reply counters with the correct semantic (brain silence) instead of the previous push-failure-only signal.';
