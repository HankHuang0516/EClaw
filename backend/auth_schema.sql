-- ============================================
-- User Accounts Table
-- ============================================
CREATE TABLE IF NOT EXISTS user_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email_verified BOOLEAN DEFAULT FALSE,
    verify_token VARCHAR(128),
    verify_token_expires BIGINT,
    reset_token VARCHAR(128),
    reset_token_expires BIGINT,
    -- Virtual device credentials (auto-generated at registration)
    device_id VARCHAR(64) NOT NULL UNIQUE,
    device_secret VARCHAR(128) NOT NULL,
    -- Subscription
    subscription_status VARCHAR(32) DEFAULT 'free',
    subscription_provider VARCHAR(32),
    subscription_expires_at BIGINT,
    tappay_card_key TEXT,
    tappay_card_token TEXT,
    -- Admin
    is_admin BOOLEAN DEFAULT FALSE,
    -- Growth attribution (aggregate-only source channel, never stores UTM params with PII)
    signup_source VARCHAR(64) DEFAULT 'unknown',
    -- Preferences
    language VARCHAR(10) DEFAULT 'en',
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_user_accounts_email ON user_accounts(email);
CREATE INDEX IF NOT EXISTS idx_user_accounts_device_id ON user_accounts(device_id);
CREATE INDEX IF NOT EXISTS idx_user_accounts_verify_token ON user_accounts(verify_token);
CREATE INDEX IF NOT EXISTS idx_user_accounts_reset_token ON user_accounts(reset_token);
CREATE INDEX IF NOT EXISTS idx_user_accounts_signup_source ON user_accounts(signup_source);

-- ============================================
-- Server-side Usage Tracking
-- ============================================
CREATE TABLE IF NOT EXISTS usage_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    message_count INTEGER DEFAULT 0,
    UNIQUE(device_id, date)
);

CREATE INDEX IF NOT EXISTS idx_usage_device_date ON usage_tracking(device_id, date);

-- ============================================
-- TapPay Transaction Log
-- ============================================
CREATE TABLE IF NOT EXISTS tappay_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_account_id UUID NOT NULL REFERENCES user_accounts(id),
    rec_trade_id VARCHAR(255),
    amount INTEGER NOT NULL,
    currency VARCHAR(10) DEFAULT 'TWD',
    status VARCHAR(32) NOT NULL,
    tappay_response JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tappay_user ON tappay_transactions(user_account_id);

-- ============================================
-- Chat Message History (server-side persistence)
-- ============================================
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id VARCHAR(64) NOT NULL,
    entity_id INTEGER,
    text TEXT NOT NULL,
    source VARCHAR(64) NOT NULL,
    is_from_user BOOLEAN DEFAULT FALSE,
    is_from_bot BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_device ON chat_messages(device_id, created_at DESC);

-- Migration: add read_at column to existing chat_messages tables
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Migration: add delivery tracking for bot-to-bot messages
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_delivered BOOLEAN DEFAULT FALSE;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS delivered_to TEXT DEFAULT NULL;

-- Migration: add is_admin column to existing user_accounts tables
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS signup_source VARCHAR(64) DEFAULT 'unknown';
CREATE INDEX IF NOT EXISTS idx_user_accounts_signup_source ON user_accounts(signup_source);

-- Set admins
UPDATE user_accounts SET is_admin = TRUE WHERE email IN ('hankhuang0516@gmail.com', 'bbb880008@gmail.com');

-- ============================================
-- Migration: OAuth Social Login
-- ============================================
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS google_id VARCHAR(128);
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS facebook_id VARCHAR(128);
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS apple_id VARCHAR(128);
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(32) DEFAULT 'email';

-- Make password_hash nullable (OAuth users have no password)
ALTER TABLE user_accounts ALTER COLUMN password_hash DROP NOT NULL;

-- Make email nullable (Facebook users may not share email; Apple users may use "Hide My Email")
ALTER TABLE user_accounts ALTER COLUMN email DROP NOT NULL;

-- Unique indexes on provider IDs (NULLs are allowed in UNIQUE)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_google_id ON user_accounts(google_id) WHERE google_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_facebook_id ON user_accounts(facebook_id) WHERE facebook_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_apple_id ON user_accounts(apple_id) WHERE apple_id IS NOT NULL;

-- ============================================
-- Migration: Generic OIDC SSO (Issue #175)
-- ============================================
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS oidc_provider VARCHAR(64);
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS oidc_subject VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_oidc ON user_accounts(oidc_provider, oidc_subject)
    WHERE oidc_provider IS NOT NULL AND oidc_subject IS NOT NULL;

-- ============================================
-- Migration: RBAC Role-Based Access Control (Issue #178)
-- ============================================

-- Roles table
CREATE TABLE IF NOT EXISTS roles (
    id VARCHAR(32) PRIMARY KEY,
    description TEXT,
    permissions JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User-role assignments (device-scoped)
CREATE TABLE IF NOT EXISTS user_roles (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
    role_id VARCHAR(32) NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    device_id VARCHAR(64),
    granted_by UUID REFERENCES user_accounts(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- Unique constraint: one role per user per device (NULL device = global)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_unique
    ON user_roles(user_id, role_id, COALESCE(device_id, '__global__'));

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_device ON user_roles(device_id) WHERE device_id IS NOT NULL;

-- Seed default roles
INSERT INTO roles (id, description, permissions) VALUES
    ('admin', 'Full system access', '["*"]'),
    ('developer', 'API access, entity management, logs', '["entity:manage", "entity:read", "logs:read", "api:full", "mission:manage"]'),
    ('operator', 'Entity control, chat, mission management', '["entity:control", "entity:read", "chat:send", "mission:manage", "dashboard:read"]'),
    ('viewer', 'Read-only access to dashboard and logs', '["dashboard:read", "logs:read", "entity:read"]')
ON CONFLICT (id) DO NOTHING;

-- Migrate existing admins to role system
INSERT INTO user_roles (user_id, role_id, device_id)
SELECT id, 'admin', NULL FROM user_accounts WHERE is_admin = TRUE
ON CONFLICT DO NOTHING;

-- ============================================
-- Migration: Invite Code System
-- ============================================

-- invite_codes: one unique code per device, redeemable once
CREATE TABLE IF NOT EXISTS invite_codes (
    code VARCHAR(12) PRIMARY KEY,
    owner_device_id VARCHAR(64) NOT NULL,
    used_by_device_id VARCHAR(64),
    used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_owner ON invite_codes(owner_device_id);

-- invite_rewards: persistent bonus quota that survives daily reset
-- Does NOT go in usage_tracking (which resets daily via CURRENT_DATE)
CREATE TABLE IF NOT EXISTS invite_rewards (
    device_id VARCHAR(64) PRIMARY KEY,
    bonus_messages INTEGER NOT NULL DEFAULT 0,
    total_invited INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Milestone bitmap for tier rewards. Bits set = tier bonus already credited.
-- bit0=bronze (3 invites), bit1=silver (10), bit2=gold (30), bit3=diamond (100).
-- Thresholds + bonuses live in index.js INVITE_TIERS.
ALTER TABLE invite_rewards ADD COLUMN IF NOT EXISTS milestones_claimed INTEGER NOT NULL DEFAULT 0;

-- invite_clicks: funnel step 1 telemetry. Logged when anyone hits
-- /invite/:code (the share URL shown on invite.html + QR codes). Exists
-- because prior to this table the /invite/:code route didn't exist at all
-- — shared links 404'd, so conversion showed 0/N and we had no visibility
-- into whether it was a click problem or a redeem problem.
-- IP is hashed (sha256 truncated to 16 hex) to keep PII footprint low
-- while still allowing unique-visitor heuristics.
CREATE TABLE IF NOT EXISTS invite_clicks (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(12) NOT NULL,
    clicked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ip_hash VARCHAR(16),
    user_agent TEXT,
    referer TEXT
);
CREATE INDEX IF NOT EXISTS idx_invite_clicks_code ON invite_clicks(code);
CREATE INDEX IF NOT EXISTS idx_invite_clicks_clicked_at ON invite_clicks(clicked_at);

-- ============================================
-- Channel Registrations (Phase 1 — channel key auth for /api/transform)
-- ============================================
-- Each row represents one registered bridge (channel) that can authenticate
-- via X-Channel-Key header instead of botSecret.
-- key_hash stores a bcrypt hash of the raw channel key (never stored in plain).
-- allowed_entities is a JSONB array: [{entity_id, permissions:[speak,state,a2a,broadcast]}]
CREATE TABLE IF NOT EXISTS channel_registrations (
    id              SERIAL PRIMARY KEY,
    channel_name    VARCHAR(128) NOT NULL,
    device_id       VARCHAR(64)  NOT NULL,
    key_hash        TEXT         NOT NULL,
    allowed_entities JSONB       NOT NULL DEFAULT '[]',
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at    TIMESTAMP WITH TIME ZONE DEFAULT NULL,
    revoked_at      TIMESTAMP WITH TIME ZONE DEFAULT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_reg_name_device
    ON channel_registrations(channel_name, device_id)
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channel_reg_device
    ON channel_registrations(device_id);

-- via_channel: records which registered channel a transform was authenticated via.
-- Stored separately from source so chat.html parser never needs to understand it.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS via_channel VARCHAR(128) DEFAULT NULL;
