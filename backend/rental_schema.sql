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
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    listing_id UUID NOT NULL,
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
--              ended_zero_balance / ended_disputed / ended_violation / ended_admin
CREATE TABLE IF NOT EXISTS rental_contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL,
    owner_user_id UUID NOT NULL,
    renter_user_id UUID NOT NULL,
    renter_device_id TEXT NOT NULL,
    renter_entity_slot INTEGER,
    -- Economic snapshot at reservation time (owner price changes do NOT affect this contract)
    rate_mli_per_ktoken_snapshot BIGINT NOT NULL CHECK (rate_mli_per_ktoken_snapshot >= 0),
    deposit_mli BIGINT NOT NULL CHECK (deposit_mli >= 0),
    -- Time window
    planned_duration_min INTEGER NOT NULL,
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
    contract_id UUID PRIMARY KEY,
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
    contract_id UUID NOT NULL,
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
