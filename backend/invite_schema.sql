-- @brm-crossref: P5 Growth Engine — Referral System (⑪)
-- Design doc: docs/plans/2026-04-10-bot-rental-marketplace-design.md
-- Roadmap:    /portal/roadmap.html
-- If this module is updated, also update the roadmap page status and the design doc §10 delivery tracker.
-- ============================================
-- Invite / Referral Schema (Phase 5)
-- ============================================
--
-- NOTE: The `invite_codes` table itself is owned by auth_schema.sql
-- (device-based: owner_device_id / used_by_device_id / used_at).
-- The Phase-5 migration to user-based codes is deferred — see
-- backend/invite.js comment block + index.js:~1947 for the current
-- "router not mounted" state. When the Phase-5 migration ships,
-- re-introduce the invite_codes CREATE here (or migrate in place)
-- and coordinate the cutover with auth_schema.sql.
--
-- This file only owns `invite_redemptions`, which is Phase-5-only
-- and is read by growth.js for conversion analytics even while the
-- Phase-5 router itself stays disabled.

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
