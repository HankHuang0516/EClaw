-- @brm-crossref: P5 Growth Engine — Referral System (⑪)
-- Design doc: docs/plans/2026-04-10-bot-rental-marketplace-design.md
-- Roadmap:    /portal/roadmap.html
-- If this module is updated, also update the roadmap page status and the design doc §10 delivery tracker.
-- ============================================
-- Invite / Referral Schema (Phase 5)
-- ============================================

CREATE TABLE IF NOT EXISTS invite_codes (
    code VARCHAR(8) PRIMARY KEY,
    owner_user_id UUID NOT NULL,
    max_uses INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_invite_owner FOREIGN KEY (owner_user_id)
        REFERENCES user_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invite_owner ON invite_codes(owner_user_id);

CREATE TABLE IF NOT EXISTS invite_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(8) NOT NULL,
    invitee_user_id UUID NOT NULL UNIQUE,
    inviter_reward_mli BIGINT NOT NULL DEFAULT 0,
    invitee_reward_mli BIGINT NOT NULL DEFAULT 0,
    first_topup_bonus_mli BIGINT NOT NULL DEFAULT 0,
    first_topup_credited BOOLEAN NOT NULL DEFAULT FALSE,
    redeemed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT fk_redemption_code FOREIGN KEY (code)
        REFERENCES invite_codes(code) ON DELETE CASCADE,
    CONSTRAINT fk_redemption_invitee FOREIGN KEY (invitee_user_id)
        REFERENCES user_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_redemption_code ON invite_redemptions(code);
