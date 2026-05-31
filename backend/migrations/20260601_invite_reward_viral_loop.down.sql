-- Reversal of 20260601_invite_reward_viral_loop
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
