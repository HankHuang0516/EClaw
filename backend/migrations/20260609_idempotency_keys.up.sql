-- Migration: 20260609_idempotency_keys
-- Server-side idempotency-key dedupe for /api/transform.
-- Card: card_47ed9a0c (OODA-R Phase 2 #5 offline delivery queue).
-- Spec: docs/offline-delivery-queue-spec.md.
--
-- When a client retries a queued send, the server must return the SAME
-- response (status + body) as the first call instead of double-processing.
-- The dedupe key is sha256(deviceId + clientIdempotencyKey) so the raw
-- key never lands in the DB; per-device collision is impossible.

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id BIGSERIAL PRIMARY KEY,
    hash CHAR(64) NOT NULL UNIQUE,
    response_blob JSONB NOT NULL,
    status_code SMALLINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idem_expires_at
    ON idempotency_keys(expires_at);

COMMENT ON TABLE idempotency_keys IS
    'Caches POST /api/transform responses keyed by sha256(deviceId|clientIdempotencyKey) for 24h, so client retries of a queued offline send return the original response instead of double-processing.';
