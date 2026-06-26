-- @brm-crossref: P3 Trust Layer + P4 Risk Management schema
-- Design doc: docs/plans/2026-04-10-bot-rental-marketplace-design.md
-- Roadmap:    /portal/roadmap.html
-- If this module is updated, also update the roadmap page status and the design doc §10 delivery tracker.
-- ============================================
-- Trust & Risk Management Schema (Phase 3 + 4)
-- ============================================

-- ============================================
-- bot_reviews — 1–5★ rating + comment per completed contract
-- ============================================
CREATE TABLE IF NOT EXISTS bot_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id VARCHAR(48) NOT NULL UNIQUE,
    listing_id VARCHAR(48) NOT NULL,
    reviewer_user_id UUID NOT NULL,
    owner_user_id UUID NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_review_contract FOREIGN KEY (contract_id)
        REFERENCES rental_contracts(id) ON DELETE CASCADE,
    CONSTRAINT fk_review_listing FOREIGN KEY (listing_id)
        REFERENCES bot_listings(id) ON DELETE CASCADE,
    CONSTRAINT fk_review_reviewer FOREIGN KEY (reviewer_user_id)
        REFERENCES user_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reviews_listing ON bot_reviews(listing_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON bot_reviews(reviewer_user_id);

-- ============================================
-- disputes — arbitration tickets
-- ============================================
CREATE TABLE IF NOT EXISTS disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id VARCHAR(48) NOT NULL,
    raised_by UUID NOT NULL,
    type VARCHAR(32) NOT NULL,
    evidence TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'open',
    resolution TEXT,
    resolved_by UUID,
    sla_first_response_by TIMESTAMP WITH TIME ZONE,
    sla_resolve_by TIMESTAMP WITH TIME ZONE,
    first_responded_at TIMESTAMP WITH TIME ZONE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    compensation_mli BIGINT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_dispute_contract FOREIGN KEY (contract_id)
        REFERENCES rental_contracts(id) ON DELETE CASCADE,
    CONSTRAINT fk_dispute_raiser FOREIGN KEY (raised_by)
        REFERENCES user_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_disputes_contract ON disputes(contract_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_disputes_sla ON disputes(sla_resolve_by) WHERE status = 'open';

-- ============================================
-- user_credit_scores — aggregate per-user trust metric
-- ============================================
CREATE TABLE IF NOT EXISTS user_credit_scores (
    user_id UUID PRIMARY KEY,
    score NUMERIC(4,2) NOT NULL DEFAULT 5.00,
    total_rentals_as_owner INTEGER NOT NULL DEFAULT 0,
    total_rentals_as_renter INTEGER NOT NULL DEFAULT 0,
    avg_rating_received NUMERIC(3,2) DEFAULT 0,
    crash_count INTEGER NOT NULL DEFAULT 0,
    dispute_count INTEGER NOT NULL DEFAULT 0,
    violation_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_credit_user FOREIGN KEY (user_id)
        REFERENCES user_accounts(id) ON DELETE CASCADE
);

-- ============================================
-- fraud_detection_log — audit trail for anti-fraud triggers
-- ============================================
CREATE TABLE IF NOT EXISTS fraud_detection_log (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    rule_name VARCHAR(64) NOT NULL,
    action VARCHAR(32) NOT NULL DEFAULT 'block',
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fraud_user ON fraud_detection_log(user_id, created_at DESC);

-- ============================================
-- user_blacklist — temporary bans with expiration (P4)
-- ============================================
CREATE TABLE IF NOT EXISTS user_blacklist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    reason TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_by UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_blacklist_user FOREIGN KEY (user_id)
        REFERENCES user_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blacklist_user ON user_blacklist(user_id);
-- Plain b-tree on expires_at: a partial predicate cannot reference NOW()
-- (STABLE, not IMMUTABLE → Postgres rejects it: "functions in index predicate
-- must be marked IMMUTABLE", so the index silently failed to create on prod).
-- A full index on expires_at still serves the active-blacklist range filter
-- (expires_at IS NULL OR expires_at > NOW()); user_id lookups use idx_blacklist_user.
CREATE INDEX IF NOT EXISTS idx_blacklist_active ON user_blacklist(expires_at);

-- ============================================
-- rental_cooldowns — prevent repeat-rental abuse (P4)
-- ============================================
CREATE TABLE IF NOT EXISTS rental_cooldowns (
    user_id UUID NOT NULL,
    listing_id VARCHAR(48) NOT NULL,
    cooldown_until TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (user_id, listing_id)
);

-- ============================================
-- ID prefix migration (idempotent; no-ops after first run)
-- Mirror of rental_schema.sql migration for the FK columns owned by trust_schema.
-- rental_schema runs first in normal boot order, but kept here for defensive
-- idempotency. If the referenced rental tables haven't been widened yet, the
-- runner tolerates the "cannot alter" error and logs a warning.
-- ============================================
ALTER TABLE bot_reviews DROP CONSTRAINT IF EXISTS fk_review_contract;
ALTER TABLE bot_reviews DROP CONSTRAINT IF EXISTS fk_review_listing;
ALTER TABLE disputes DROP CONSTRAINT IF EXISTS fk_dispute_contract;
ALTER TABLE bot_reviews ALTER COLUMN contract_id TYPE VARCHAR(48) USING contract_id::text;
ALTER TABLE bot_reviews ALTER COLUMN listing_id TYPE VARCHAR(48) USING listing_id::text;
ALTER TABLE disputes ALTER COLUMN contract_id TYPE VARCHAR(48) USING contract_id::text;
ALTER TABLE rental_cooldowns ALTER COLUMN listing_id TYPE VARCHAR(48) USING listing_id::text;
ALTER TABLE bot_reviews ADD CONSTRAINT fk_review_contract FOREIGN KEY (contract_id) REFERENCES rental_contracts(id) ON DELETE CASCADE;
ALTER TABLE bot_reviews ADD CONSTRAINT fk_review_listing FOREIGN KEY (listing_id) REFERENCES bot_listings(id) ON DELETE CASCADE;
ALTER TABLE disputes ADD CONSTRAINT fk_dispute_contract FOREIGN KEY (contract_id) REFERENCES rental_contracts(id) ON DELETE CASCADE;
