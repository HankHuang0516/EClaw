-- @brm-crossref: ④⑦⑧⑨ Bot Interview + Contract + Token Metering + Reviews schema
-- Design doc: docs/plans/2026-04-10-bot-rental-marketplace-design.md
-- Roadmap:    /portal/roadmap.html
-- If this module is updated, also update the roadmap page status and the design doc §10 delivery tracker.
-- ============================================
-- Bot Rental Marketplace Schema (Phase 1 foundation)
-- ============================================
--
-- Tables added here cover: bot listings, interview records, capability
-- snapshots, rental contracts with snapshot versioning, usage events
-- for token metering, and a pricing market snapshot used by the
-- advisor. Reviews / disputes / credit scores land in Phase 3.
--
-- All amounts are in 厘 (mli, same unit as wallet.js): 1 e幣 = 1000 厘.
-- See memory/project_bot_rental_system.md for design rationale.
-- ============================================

-- ============================================
-- bot_listings — one row per published / draft listing
-- ============================================
-- status lifecycle: draft → interview → listed → paused → delisted
CREATE TABLE IF NOT EXISTS bot_listings (
    id VARCHAR(48) PRIMARY KEY DEFAULT ('listing_' || encode(gen_random_bytes(12), 'hex')),
    owner_user_id UUID NOT NULL,
    owner_device_id TEXT NOT NULL,
    owner_entity_id INTEGER NOT NULL,
    title VARCHAR(120) NOT NULL,
    description TEXT,
    -- Rental economics (owner-set, see pricing-advisor.js for suggestions)
    rate_mli_per_ktoken BIGINT NOT NULL CHECK (rate_mli_per_ktoken >= 0),
    min_rental_minutes INTEGER NOT NULL DEFAULT 30 CHECK (min_rental_minutes >= 30),
    max_rental_minutes INTEGER NOT NULL DEFAULT 10080 CHECK (max_rental_minutes <= 10080),
    availability_windows JSONB DEFAULT '[]'::jsonb,
    -- Interview output — LOCKED once interview passes, owner cannot edit
    model_detected TEXT,
    capabilities JSONB DEFAULT '{}'::jsonb,
    benchmark_score JSONB DEFAULT '{}'::jsonb,
    interview_passed BOOLEAN NOT NULL DEFAULT FALSE,
    last_interview_at TIMESTAMP WITH TIME ZONE,
    -- Market stats (updated by cron / on-demand)
    avg_rating NUMERIC(3,2) DEFAULT 0,
    total_rentals INTEGER NOT NULL DEFAULT 0,
    uptime_pct NUMERIC(5,2) DEFAULT 100,
    -- Lifecycle
    status VARCHAR(32) NOT NULL DEFAULT 'draft',
    -- Identity-drift detection (P0: silent rebind cascade)
    -- Snapshot of entities[owner_entity_id].rebindCount at listing creation.
    -- If the live entity rebindCount drifts past this value, the listing now
    -- points at a different bot than was advertised; query layer must hide it.
    bound_rebind_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_listing_owner FOREIGN KEY (owner_user_id)
        REFERENCES user_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_listings_owner ON bot_listings(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON bot_listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_rate ON bot_listings(rate_mli_per_ktoken)
    WHERE status = 'listed';
CREATE INDEX IF NOT EXISTS idx_listings_rating ON bot_listings(avg_rating DESC)
    WHERE status = 'listed';

-- ============================================
-- bot_interviews — one row per interview attempt
-- ============================================
CREATE TABLE IF NOT EXISTS bot_interviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id VARCHAR(48) NOT NULL,
    probes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    responses_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    passed BOOLEAN NOT NULL DEFAULT FALSE,
    score INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
    duration_ms INTEGER NOT NULL DEFAULT 0,
    failure_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_interview_listing FOREIGN KEY (listing_id)
        REFERENCES bot_listings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_interviews_listing ON bot_interviews(listing_id, created_at DESC);

-- ============================================
-- rental_contracts — one row per rental agreement
-- ============================================
-- status lifecycle:
--   reserved → active → suspended_insufficient_funds → active OR
--   reserved → active → ended_normal / ended_early_by_renter /
--              ended_zero_balance / ended_disputed / ended_violation / ended_admin /
--              terminated_by_rebind
CREATE TABLE IF NOT EXISTS rental_contracts (
    id VARCHAR(48) PRIMARY KEY DEFAULT ('contract_' || encode(gen_random_bytes(12), 'hex')),
    listing_id VARCHAR(48) NOT NULL,
    owner_user_id UUID NOT NULL,
    renter_user_id UUID NOT NULL,
    renter_device_id TEXT NOT NULL,
    renter_entity_slot INTEGER,
    -- Economic snapshot at reservation time (owner price changes do NOT affect this contract)
    rate_mli_per_ktoken_snapshot BIGINT NOT NULL CHECK (rate_mli_per_ktoken_snapshot >= 0),
    deposit_mli BIGINT NOT NULL CHECK (deposit_mli >= 0),
    -- Time window
    planned_duration_min INTEGER NOT NULL,
    -- Stable denominator for per-second rebind refunds. Backfilled from
    -- planned_duration_min on existing deployments; new startRental writes it.
    total_duration_sec INTEGER CHECK (total_duration_sec IS NULL OR total_duration_sec >= 0),
    started_at TIMESTAMP WITH TIME ZONE,
    ends_at TIMESTAMP WITH TIME ZONE,
    actual_ended_at TIMESTAMP WITH TIME ZONE,
    grace_period_starts_at TIMESTAMP WITH TIME ZONE,
    -- Usage aggregates (updated inline by rental-proxy.js)
    tokens_consumed BIGINT NOT NULL DEFAULT 0,
    ecoin_charged_mli BIGINT NOT NULL DEFAULT 0,
    violation_count INTEGER NOT NULL DEFAULT 0,
    -- Lifecycle
    status VARCHAR(40) NOT NULL DEFAULT 'reserved',
    end_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_contract_listing FOREIGN KEY (listing_id)
        REFERENCES bot_listings(id) ON DELETE RESTRICT,
    CONSTRAINT fk_contract_owner FOREIGN KEY (owner_user_id)
        REFERENCES user_accounts(id) ON DELETE CASCADE,
    CONSTRAINT fk_contract_renter FOREIGN KEY (renter_user_id)
        REFERENCES user_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contracts_renter ON rental_contracts(renter_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contracts_owner ON rental_contracts(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contracts_active_ends
    ON rental_contracts(ends_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_contracts_listing ON rental_contracts(listing_id);

-- Enforce bot exclusivity: at most one non-terminal contract per listing.
-- Uses a partial unique index scoped to statuses that represent "active rental".
CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_exclusive_active
    ON rental_contracts(listing_id)
    WHERE status IN ('reserved', 'active', 'suspended_insufficient_funds');

-- ============================================
-- rental_snapshots — frozen copy of owner's bot config at reservation
-- ============================================
-- Owner can change the listing freely but active contracts read from
-- the snapshot, not the live listing. Guarantees renter gets the bot
-- they signed up for.
CREATE TABLE IF NOT EXISTS rental_snapshots (
    contract_id VARCHAR(48) PRIMARY KEY,
    identity JSONB,
    rules JSONB,
    skills JSONB,
    webhook_url TEXT,
    allowed_vars JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_snapshot_contract FOREIGN KEY (contract_id)
        REFERENCES rental_contracts(id) ON DELETE CASCADE
);

-- ============================================
-- rental_usage_events — every proxied message on a rental contract
-- ============================================
-- Written by rental-proxy.js as the renter chats with the rented bot.
-- Each row pairs with a wallet_ledger entry (by idempotency_key).
CREATE TABLE IF NOT EXISTS rental_usage_events (
    id BIGSERIAL PRIMARY KEY,
    contract_id VARCHAR(48) NOT NULL,
    direction VARCHAR(8) NOT NULL CHECK (direction IN ('in', 'out')),
    tokens INTEGER NOT NULL CHECK (tokens >= 0),
    ecoin_charged_mli BIGINT NOT NULL DEFAULT 0,
    message_id VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_usage_contract FOREIGN KEY (contract_id)
        REFERENCES rental_contracts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_contract ON rental_usage_events(contract_id, created_at DESC);

-- ============================================
-- rental_rebind_audit_log — rental-side audit trail for strict rebind refunds
-- ============================================
-- Wallet movements are audited in wallet_ledger via idempotency keys. This
-- table records the rental-domain decision: which active contract was
-- terminated, how remaining seconds were computed, and which ledger keys were
-- used for the deposit release / owner-paid refund.
CREATE TABLE IF NOT EXISTS rental_rebind_audit_log (
    id BIGSERIAL PRIMARY KEY,
    contract_id VARCHAR(48) NOT NULL UNIQUE,
    listing_id VARCHAR(48) NOT NULL,
    owner_device_id TEXT NOT NULL,
    owner_entity_id INTEGER NOT NULL,
    owner_user_id UUID NOT NULL,
    renter_user_id UUID NOT NULL,
    status_from VARCHAR(40) NOT NULL,
    status_to VARCHAR(40) NOT NULL DEFAULT 'terminated_by_rebind',
    deposit_mli BIGINT NOT NULL DEFAULT 0 CHECK (deposit_mli >= 0),
    deposit_release_mli BIGINT NOT NULL DEFAULT 0 CHECK (deposit_release_mli >= 0),
    refund_mli BIGINT NOT NULL DEFAULT 0 CHECK (refund_mli >= 0),
    remaining_sec INTEGER NOT NULL DEFAULT 0 CHECK (remaining_sec >= 0),
    total_duration_sec INTEGER NOT NULL DEFAULT 0 CHECK (total_duration_sec >= 0),
    wallet_release_idempotency_key TEXT,
    wallet_debit_idempotency_key TEXT,
    wallet_credit_idempotency_key TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_rebind_audit_contract FOREIGN KEY (contract_id)
        REFERENCES rental_contracts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rebind_audit_owner_time
    ON rental_rebind_audit_log(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rebind_audit_slot_time
    ON rental_rebind_audit_log(owner_device_id, owner_entity_id, created_at DESC);

-- ============================================
-- pricing_market_snapshots — hourly aggregated market stats
-- ============================================
-- Populated by a cron that re-aggregates `bot_listings` where
-- status='listed'. pricing-advisor.js reads the latest row per
-- model_family to compute suggested rate ranges.
CREATE TABLE IF NOT EXISTS pricing_market_snapshots (
    id BIGSERIAL PRIMARY KEY,
    snapshot_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    model_family TEXT NOT NULL,
    listing_count INTEGER NOT NULL DEFAULT 0,
    rate_p25_mli BIGINT,
    rate_p50_mli BIGINT,
    rate_p75_mli BIGINT,
    rate_p95_mli BIGINT,
    rental_success_rate NUMERIC(4,3)
);

CREATE INDEX IF NOT EXISTS idx_pricing_family_time
    ON pricing_market_snapshots(model_family, snapshot_at DESC);

-- ============================================
-- ID prefix migration (idempotent; no-ops after first run)
-- Widen bot_listings.id and rental_contracts.id UUID → VARCHAR(48) so
-- Stripe-style prefixed IDs (listing_<24hex>, contract_<24hex>) can coexist
-- with legacy UUIDs.
--
-- trust_schema children (bot_reviews.contract_id, bot_reviews.listing_id,
-- disputes.contract_id) are also widened here because rental_schema and
-- trust_schema init independently; we cannot rely on ordering. Duplicate
-- idempotent statements in trust_schema.sql handle the reverse ordering.
-- ============================================
ALTER TABLE bot_interviews DROP CONSTRAINT IF EXISTS fk_interview_listing;
ALTER TABLE rental_contracts DROP CONSTRAINT IF EXISTS fk_contract_listing;
ALTER TABLE rental_snapshots DROP CONSTRAINT IF EXISTS fk_snapshot_contract;
ALTER TABLE rental_usage_events DROP CONSTRAINT IF EXISTS fk_usage_contract;
ALTER TABLE bot_reviews DROP CONSTRAINT IF EXISTS fk_review_contract;
ALTER TABLE bot_reviews DROP CONSTRAINT IF EXISTS fk_review_listing;
ALTER TABLE disputes DROP CONSTRAINT IF EXISTS fk_dispute_contract;
ALTER TABLE bot_listings ALTER COLUMN id DROP DEFAULT;
ALTER TABLE bot_listings ALTER COLUMN id TYPE VARCHAR(48) USING id::text;
ALTER TABLE bot_listings ALTER COLUMN id SET DEFAULT ('listing_' || encode(gen_random_bytes(12), 'hex'));
ALTER TABLE rental_contracts ALTER COLUMN id DROP DEFAULT;
ALTER TABLE rental_contracts ALTER COLUMN id TYPE VARCHAR(48) USING id::text;
ALTER TABLE rental_contracts ALTER COLUMN id SET DEFAULT ('contract_' || encode(gen_random_bytes(12), 'hex'));
ALTER TABLE bot_interviews ALTER COLUMN listing_id TYPE VARCHAR(48) USING listing_id::text;
ALTER TABLE rental_contracts ALTER COLUMN listing_id TYPE VARCHAR(48) USING listing_id::text;
ALTER TABLE rental_snapshots ALTER COLUMN contract_id TYPE VARCHAR(48) USING contract_id::text;
ALTER TABLE rental_usage_events ALTER COLUMN contract_id TYPE VARCHAR(48) USING contract_id::text;
ALTER TABLE bot_reviews ALTER COLUMN contract_id TYPE VARCHAR(48) USING contract_id::text;
ALTER TABLE bot_reviews ALTER COLUMN listing_id TYPE VARCHAR(48) USING listing_id::text;
ALTER TABLE disputes ALTER COLUMN contract_id TYPE VARCHAR(48) USING contract_id::text;
ALTER TABLE bot_interviews ADD CONSTRAINT fk_interview_listing FOREIGN KEY (listing_id) REFERENCES bot_listings(id) ON DELETE CASCADE;
ALTER TABLE rental_contracts ADD CONSTRAINT fk_contract_listing FOREIGN KEY (listing_id) REFERENCES bot_listings(id) ON DELETE RESTRICT;
ALTER TABLE rental_snapshots ADD CONSTRAINT fk_snapshot_contract FOREIGN KEY (contract_id) REFERENCES rental_contracts(id) ON DELETE CASCADE;
ALTER TABLE rental_usage_events ADD CONSTRAINT fk_usage_contract FOREIGN KEY (contract_id) REFERENCES rental_contracts(id) ON DELETE CASCADE;
ALTER TABLE bot_reviews ADD CONSTRAINT fk_review_contract FOREIGN KEY (contract_id) REFERENCES rental_contracts(id) ON DELETE CASCADE;
ALTER TABLE bot_reviews ADD CONSTRAINT fk_review_listing FOREIGN KEY (listing_id) REFERENCES bot_listings(id) ON DELETE CASCADE;
ALTER TABLE disputes ADD CONSTRAINT fk_dispute_contract FOREIGN KEY (contract_id) REFERENCES rental_contracts(id) ON DELETE CASCADE;

-- ============================================
-- Idempotent migration: add bound_rebind_count to existing deployments
-- (P0 entity-rebind cascade — Phase 1)
-- ============================================
ALTER TABLE bot_listings ADD COLUMN IF NOT EXISTS bound_rebind_count INTEGER NOT NULL DEFAULT 0;


-- ============================================
-- Idempotent migration: add total_duration_sec to existing contracts
-- (P0 entity-rebind cascade — Phase 4 strict per-second refunds)
-- ============================================
ALTER TABLE rental_contracts ADD COLUMN IF NOT EXISTS total_duration_sec INTEGER;
UPDATE rental_contracts
   SET total_duration_sec = GREATEST(0, planned_duration_min * 60)
 WHERE total_duration_sec IS NULL
   AND planned_duration_min IS NOT NULL;
