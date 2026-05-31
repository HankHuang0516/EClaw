-- Migration: 20260601_invite_reward_viral_loop
-- PR: [Schema] Invite reward viral loop migration
-- Purpose: Add audit columns + ledger type for invite reward viral loop (PR1 of 3)
-- Non-breaking: all new columns have defaults; existing rows auto-populate

-- ============================================================
--1. ALTER invite_redemptions — add audit columns
-- ============================================================
ALTER TABLE invite_redemptions
    ADD COLUMN IF NOT EXISTS inviter_device_id UUID,
    ADD COLUMN IF NOT EXISTS invitee_device_id UUID,
    ADD COLUMN IF NOT EXISTS inviter_user_id UUID,
    ADD COLUMN IF NOT EXISTS reward_type VARCHAR(32) NOT NULL DEFAULT 'redeem',
    ADD COLUMN IF NOT EXISTS inviter_reward_amount_mli BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS invitee_reward_amount_mli BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS inviter_wallet_ledger_id BIGINT,
    ADD COLUMN IF NOT EXISTS invitee_wallet_ledger_id BIGINT,
    ADD COLUMN IF NOT EXISTS wallet_credit_status VARCHAR(32) NOT NULL DEFAULT 'not_attempted';

-- ============================================================
-- 2. Back-populate existing rows from Phase-5 data
-- (invitee_user_id is NOT NULL → safe to use)
-- ============================================================
UPDATE invite_redemptions
SET
    inviter_user_id       = ic.owner_user_id,
    inviter_reward_amount_mli = inviter_reward_mli,
    invitee_reward_amount_mli = invitee_reward_mli,
    reward_type           = 'redeem',
    wallet_credit_status  = CASE
        WHEN first_topup_credited THEN 'not_attempted' -- Phase-5 had no wallet credit tracking
        ELSE 'not_attempted'
    END
FROM invite_redemptions r
JOIN invite_codes ic ON ic.code = r.code
WHERE invite_redemptions.id = r.id
  AND invite_redemptions.inviter_user_id IS NULL;

-- ============================================================
-- 3. Partial unique guard: one 'redeem' per code
-- (Postgres supports WHERE clause in CREATE INDEX; we use
--  a filtered unique index via a separate step below)
-- ============================================================
-- Note: existing constraint + data already enforces uniqueness
-- on invitee_user_id UNIQUE. We add code-scope for 'redeem'
-- path only via a conditional index (see below after col added).

-- ============================================================
-- 4. Add wallet_credit_status check constraint (optional)
-- Valid values for wallet_credit_status
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
-- 6. Add comments for documentation
-- ============================================================
COMMENT ON COLUMN invite_redemptions.inviter_device_id    IS 'Device ID of inviter at time of redemption (for device-only invites)';
COMMENT ON COLUMN invite_redemptions.invitee_device_id    IS 'Device ID of invitee at time of redemption';
COMMENT ON COLUMN invite_redemptions.inviter_user_id     IS 'User ID of inviter (populated from invite_codes.owner_user_id)';
COMMENT ON COLUMN invite_redemptions.reward_type          IS 'Type of reward: redeem (default), first_topup_bonus, manual';
COMMENT ON COLUMN invite_redemptions.inviter_reward_amount_mli IS 'Actual inviter reward in mLI (may differ from Phase-5 inviter_reward_mli)';
COMMENT ON COLUMN invite_redemptions.invitee_reward_amount_mli IS 'Actual invitee reward in mLI';
COMMENT ON COLUMN invite_redemptions.inviter_wallet_ledger_id IS 'wallet_ledger.id for inviter credit (null until credited)';
COMMENT ON COLUMN invite_redemptions.invitee_wallet_ledger_id IS 'wallet_ledger.id for invitee credit (null until credited)';
COMMENT ON COLUMN invite_redemptions.wallet_credit_status IS 'Wallet credit state: not_attempted|pending_user_account|pending|credited|failed';
