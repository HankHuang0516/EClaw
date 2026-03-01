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

-- Set admins
UPDATE user_accounts SET is_admin = TRUE WHERE email IN ('hankhuang0516@gmail.com', 'bbb880008@gmail.com');

-- ============================================
-- Migration: OAuth Social Login
-- ============================================
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS google_id VARCHAR(128);
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS facebook_id VARCHAR(128);
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS display_name VARCHAR(255);
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE user_accounts ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(32) DEFAULT 'email';

-- Make password_hash nullable (OAuth users have no password)
ALTER TABLE user_accounts ALTER COLUMN password_hash DROP NOT NULL;

-- Make email nullable (Facebook users may not share email)
ALTER TABLE user_accounts ALTER COLUMN email DROP NOT NULL;

-- Unique indexes on provider IDs (NULLs are allowed in UNIQUE)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_google_id ON user_accounts(google_id) WHERE google_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_accounts_facebook_id ON user_accounts(facebook_id) WHERE facebook_id IS NOT NULL;
