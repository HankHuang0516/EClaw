-- @brm-crossref: ①②③ Wallet + Top-up + Transaction schema
-- Design doc: docs/plans/2026-04-10-bot-rental-marketplace-design.md
-- Roadmap:    /portal/roadmap.html
-- If this module is updated, also update the roadmap page status and the design doc §10 delivery tracker.
-- ============================================
-- Wallet System Schema (Phase 0 of Bot Rental Marketplace)
-- ============================================
--
-- Units: balances stored in 厘 (mli), where 1 e幣 = 1000 厘.
-- This avoids floating point errors while allowing fractional e幣 for
-- micro-charges during rental token metering.
--
-- Exchange rate: 1 TWD = 100 e幣 = 100,000 厘 (hard-coded in wallet.js).
--
-- Design notes:
-- - wallets.balance_mli holds spendable balance; held_mli holds frozen
--   deposits (rental contract escrow). Sum of the two is the user's
--   total e-coin.
-- - wallet_ledger is append-only double-entry. Every state change to
--   wallets has a corresponding ledger row with idempotency_key enforced
--   unique to prevent double-posting on retry.
-- - CHECK constraints on balance_mli / held_mli prevent negative values
--   at the DB layer (defence-in-depth — application logic should never
--   attempt to drive either below zero).
-- ============================================

-- ============================================
-- wallets — one row per user (1:1 with user_accounts)
-- ============================================
CREATE TABLE IF NOT EXISTS wallets (
    user_id UUID PRIMARY KEY,
    balance_mli BIGINT NOT NULL DEFAULT 0 CHECK (balance_mli >= 0),
    held_mli BIGINT NOT NULL DEFAULT 0 CHECK (held_mli >= 0),
    lifetime_earned_mli BIGINT NOT NULL DEFAULT 0,
    lifetime_spent_mli BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_wallet_user FOREIGN KEY (user_id)
        REFERENCES user_accounts(id) ON DELETE CASCADE
);

-- pending_income_mli: rental income awaiting T+24h settlement delay.
-- Released to balance_mli by the daily income-release cron.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS pending_income_mli BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_wallets_updated ON wallets(updated_at DESC);

-- ============================================
-- wallet_ledger — append-only double-entry ledger
-- ============================================
-- type values (mirror LEDGER_TYPES in wallet.js):
--   topup, rental_income, rental_spend, platform_fee,
--   deposit_hold, deposit_release, deposit_forfeit,
--   referral_bonus, signup_bonus, invite_first_topup_bonus, refund, admin_adjust, withdraw
CREATE TABLE IF NOT EXISTS wallet_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    delta_mli BIGINT NOT NULL,            -- signed: + credit, - debit
    held_delta_mli BIGINT NOT NULL DEFAULT 0, -- signed change to held_mli
    balance_after_mli BIGINT NOT NULL,
    held_after_mli BIGINT NOT NULL,
    type VARCHAR(32) NOT NULL,
    ref_type VARCHAR(32),                 -- e.g. 'topup_order', 'rental_contract'
    ref_id VARCHAR(64),
    counterparty_user_id UUID,            -- for p2p transfers (rental income etc)
    note TEXT,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_ledger_user FOREIGN KEY (user_id)
        REFERENCES user_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ledger_user_time ON wallet_ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON wallet_ledger(type);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON wallet_ledger(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON wallet_ledger(created_at DESC);

-- ============================================
-- topup_orders — e-coin purchase orders
-- ============================================
-- channel values:
--   google_play, apple_iap, admin_grant, invite_bonus, signup_bonus
-- status values:
--   pending, paid, failed, refunded
CREATE TABLE IF NOT EXISTS topup_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    channel VARCHAR(32) NOT NULL,
    amount_twd INTEGER NOT NULL CHECK (amount_twd >= 0),
    ecoin_base_mli BIGINT NOT NULL CHECK (ecoin_base_mli >= 0),
    ecoin_bonus_mli BIGINT NOT NULL DEFAULT 0 CHECK (ecoin_bonus_mli >= 0),
    ecoin_total_mli BIGINT NOT NULL CHECK (ecoin_total_mli >= 0),
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    external_txn_id VARCHAR(255),
    external_raw JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    paid_at TIMESTAMP WITH TIME ZONE,
    refunded_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT fk_topup_user FOREIGN KEY (user_id)
        REFERENCES user_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_topup_user ON topup_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topup_status ON topup_orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topup_external_txn
    ON topup_orders(channel, external_txn_id)
    WHERE external_txn_id IS NOT NULL;

-- ============================================
-- Google Play acknowledge retry (revenue-leak backstop)
-- ============================================
-- After /topup/verify-google credits the ledger, it fire-and-forgets the
-- Google `:acknowledge` call. If that ack silently fails for >3 days Google
-- auto-refunds the user — but our ledger already has the credit, so we'd
-- quietly lose money. The sweep in ack-retry-sweep.js uses these columns
-- to retry failed acks up to 3 times before alerting ops.
--
-- ack_state: 'pending' | 'acked' | 'failed'
--   pending: ack hasn't been confirmed yet (initial state, or in-flight)
--   acked:   Google returned 2xx/204 for :acknowledge
--   failed:  3 retries exhausted; ops must investigate
-- ack_attempts: monotonically-incrementing count of ack calls made.
-- ack_at: timestamp of the successful ack (NULL if never acked).
ALTER TABLE topup_orders
    ADD COLUMN IF NOT EXISTS ack_state VARCHAR(16) NOT NULL DEFAULT 'pending';
ALTER TABLE topup_orders
    ADD COLUMN IF NOT EXISTS ack_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topup_orders
    ADD COLUMN IF NOT EXISTS ack_at TIMESTAMP WITH TIME ZONE;

-- Only google_play rows need ack; partial index keeps it cheap. The sweep
-- runs hourly and filters by (channel, ack_state, created_at window).
-- 'failed' is terminal (3 retries exhausted) so exclude it too — matching
-- the sweep's SELECT predicate keeps this partial index useful.
CREATE INDEX IF NOT EXISTS idx_topup_ack_pending
    ON topup_orders(channel, ack_state, created_at)
    WHERE channel = 'google_play' AND ack_state <> 'acked' AND ack_state <> 'failed';
