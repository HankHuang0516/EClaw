-- Reversal of 20260601_invite_reward_viral_loop
-- Drop indexes first (in reverse order of creation)
DROP INDEX IF EXISTS idx_invite_codes_one_active_per_owner;
DROP INDEX IF EXISTS idx_invite_redemptions_code_redeem;

-- Drop constraints and columns
ALTER TABLE invite_redemptions
    DROP CONSTRAINT IF EXISTS chk_reward_type,
    DROP CONSTRAINT IF EXISTS chk_wallet_credit_status,
    DROP COLUMN IF EXISTS inviter_device_id,
    DROP COLUMN IF EXISTS invitee_device_id,
    DROP COLUMN IF EXISTS inviter_user_id,
    DROP COLUMN IF EXISTS reward_type,
    DROP COLUMN IF EXISTS inviter_reward_amount_mli,
    DROP COLUMN IF EXISTS invitee_reward_amount_mli,
    DROP COLUMN IF EXISTS inviter_wallet_ledger_id,
    DROP COLUMN IF EXISTS invitee_wallet_ledger_id,
    DROP COLUMN IF EXISTS wallet_credit_status;
