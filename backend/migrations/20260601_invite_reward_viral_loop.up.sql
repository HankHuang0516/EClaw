-- Migration: 20260601_invite_reward_viral_loop
-- PR: [Schema] Invite reward viral loop migration
-- Purpose: Add audit columns + ledger type for invite reward viral loop (PR1 of 3)
-- Non-breaking: all new columns have defaults; existing rows auto-populate

-- ============================================================
-- 0. invite_codes — partial unique index (spec § 11, Option B)
-- One active (non-redeemed) invite code per owner_device_id.
-- Enables auto-rotate: after redeem, a new code can be minted for
-- the same owner without violating the per-owner uniqueness constraint.
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS skips existing.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_codes_one_active_per_owner
    ON invite_codes (owner_device_id)
    WHERE used_by_device_id IS NULL;

-- ============================================================
-- 1. ALTER invite_redemptions — add audit columns (all non-breaking)
-- ============================================================
-- NOTE: device_id columns are VARCHAR(64) per auth_schema.sql convention,
-- NOT UUID (live device-auth writes use VARCHAR(64) device identifiers).
ALTER TABLE invite_redemptions
    ADD COLUMN IF NOT EXISTS inviter_device_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS invitee_device_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS inviter_user_id UUID,
    ADD COLUMN IF NOT EXISTS reward_type VARCHAR(32) NOT NULL DEFAULT 'redeem',
    ADD COLUMN IF NOT EXISTS inviter_reward_amount_mli BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS invitee_reward_amount_mli BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS inviter_wallet_ledger_id BIGINT,
    ADD COLUMN IF NOT EXISTS invitee_wallet_ledger_id BIGINT,
    ADD COLUMN IF NOT EXISTS wallet_credit_status VARCHAR(32) NOT NULL DEFAULT 'not_attempted';

-- ============================================================
-- 2. Back-populate existing rows from Phase-5 data
-- Inviter_user_id comes from invite_codes.owner_user_id (FK join).
-- We reference invite_codes via a LATERAL subquery to avoid
-- Postgres UPDATE..FROM self-reference restriction.
-- ============================================================
UPDATE invite_redemptions r
SET
    inviter_user_id           = sub.owner_user_id,
    inviter_reward_amount_mli = r.inviter_reward_mli,
    invitee_reward_amount_mli = r.invitee_reward_mli,
    reward_type               = 'redeem',
    wallet_credit_status      = 'not_attempted'
FROM (
    SELECT ic.code, ic.owner_user_id
    FROM invite_codes ic
) AS sub
WHERE sub.code = r.code
  AND r.inviter_user_id IS NULL;

-- ============================================================
-- 3. Partial unique guard: one 'redeem' per code
-- Prevents race-condition double-redeem on the 'redeem' path.
-- Postgres supports partial unique indexes natively.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_invite_redemptions_code_redeem
    ON invite_redemptions (code)
    WHERE reward_type = 'redeem';

-- ============================================================
-- 4. Add wallet_credit_status check constraint
-- Valid values: not_attempted | pending_user_account | pending | credited | failed
-- NOT VALID to avoid table-lock on large existing tables.
-- Will VALIDATE after back-populate in a follow-up maintenance window.
-- ============================================================
ALTER TABLE invite_redemptions
    ADD CONSTRAINT chk_wallet_credit_status
    CHECK (wallet_credit_status IN (
        'not_attempted',
        'pending_user_account',
        'pending',
        'credited',
        'failed'
    )) NOT VALID;

-- ============================================================
-- 5. Add reward_type check constraint
-- ============================================================
ALTER TABLE invite_redemptions
    ADD CONSTRAINT chk_reward_type
    CHECK (reward_type IN ('redeem', 'first_topup_bonus', 'manual'))
    NOT VALID;

-- ============================================================
-- 6. Validate constraints after back-populate is stable
-- (separate from initial ADD to avoid lock; run after data is clean)
-- ============================================================
ALTER TABLE invite_redemptions VALIDATE CONSTRAINT chk_wallet_credit_status;
ALTER TABLE invite_redemptions VALIDATE CONSTRAINT chk_reward_type;

-- ============================================================
-- 7. Add column comments for documentation
-- ============================================================
COMMENT ON COLUMN invite_redemptions.inviter_device_id       IS 'Device ID of inviter at time of redemption (VARCHAR(64), for device-only invites)';
COMMENT ON COLUMN invite_redemptions.invitee_device_id       IS 'Device ID of invitee at time of redemption (VARCHAR(64))';
COMMENT ON COLUMN invite_redemptions.inviter_user_id         IS 'User ID of inviter (populated from invite_codes.owner_user_id)';
COMMENT ON COLUMN invite_redemptions.reward_type            IS 'Type of reward: redeem (default), first_topup_bonus, manual';
COMMENT ON COLUMN invite_redemptions.inviter_reward_amount_mli IS 'Actual inviter reward in mLI (may differ from Phase-5 inviter_reward_mli)';
COMMENT ON COLUMN invite_redemptions.invitee_reward_amount_mli IS 'Actual invitee reward in mLI';
COMMENT ON COLUMN invite_redemptions.inviter_wallet_ledger_id IS 'wallet_ledger.id for inviter credit (null until credited)';
COMMENT ON COLUMN invite_redemptions.invitee_wallet_ledger_id IS 'wallet_ledger.id for invitee credit (null until credited)';
COMMENT ON COLUMN invite_redemptions.wallet_credit_status  IS 'Wallet credit state: not_attempted|pending_user_account|pending|credited|failed';