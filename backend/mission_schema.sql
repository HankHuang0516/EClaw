-- Mission Control Dashboard Database Schema
-- PostgreSQL with Trigger + Optimistic Locking

-- ============================================
-- Main Dashboard Table
-- ============================================
CREATE TABLE IF NOT EXISTS mission_dashboard (
    device_id VARCHAR(64) PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    todo_list JSONB DEFAULT '[]'::jsonb,
    mission_list JSONB DEFAULT '[]'::jsonb,
    done_list JSONB DEFAULT '[]'::jsonb,
    notes JSONB DEFAULT '[]'::jsonb,
    rules JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for faster queries
CREATE INDEX IF NOT EXISTS idx_mission_dashboard_version 
ON mission_dashboard(device_id, version);

-- ============================================
-- Mission Items Table
-- ============================================
CREATE TABLE IF NOT EXISTS mission_items (
    id UUID PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL REFERENCES mission_dashboard(device_id) ON DELETE CASCADE,
    list_type VARCHAR(32) NOT NULL DEFAULT 'todo', -- 'todo', 'mission', 'done'
    title VARCHAR(255) NOT NULL,
    description TEXT DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 2, -- 1=LOW, 2=MEDIUM, 3=HIGH, 4=CRITICAL
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    assigned_bot VARCHAR(64),
    eta TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_by VARCHAR(64) DEFAULT 'user',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mission_items_device 
ON mission_items(device_id);

CREATE INDEX IF NOT EXISTS idx_mission_items_list_type 
ON mission_items(list_type);

CREATE INDEX IF NOT EXISTS idx_mission_items_status 
ON mission_items(status);

CREATE INDEX IF NOT EXISTS idx_mission_items_priority 
ON mission_items(priority DESC);

-- ============================================
-- Notes Table
-- ============================================
CREATE TABLE IF NOT EXISTS mission_notes (
    id UUID PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL REFERENCES mission_dashboard(device_id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    category VARCHAR(64) DEFAULT 'general',
    created_by VARCHAR(64) DEFAULT 'user',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mission_notes_device 
ON mission_notes(device_id);

CREATE INDEX IF NOT EXISTS idx_mission_notes_category 
ON mission_notes(category);

-- ============================================
-- Rules Table
-- ============================================
CREATE TABLE IF NOT EXISTS mission_rules (
    id UUID PRIMARY KEY,
    device_id VARCHAR(64) NOT NULL REFERENCES mission_dashboard(device_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    rule_type VARCHAR(64) NOT NULL, -- 'WORKFLOW', 'CODE_REVIEW', 'COMMUNICATION', 'DEPLOYMENT', 'SYNC'
    is_enabled BOOLEAN DEFAULT TRUE,
    priority INTEGER DEFAULT 0,
    config JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mission_rules_device 
ON mission_rules(device_id);

CREATE INDEX IF NOT EXISTS idx_mission_rules_type 
ON mission_rules(rule_type);

-- ============================================
-- Sync Log Table (for conflict tracking)
-- ============================================
CREATE TABLE IF NOT EXISTS mission_sync_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL, -- 'CREATE', 'UPDATE', 'DELETE', 'SYNC'
    item_type VARCHAR(32), -- 'ITEM', 'NOTE', 'RULE'
    item_id UUID,
    old_version INTEGER,
    new_version INTEGER,
    performed_by VARCHAR(64),
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mission_sync_log_device 
ON mission_sync_log(device_id);

CREATE INDEX IF NOT EXISTS idx_mission_sync_log_timestamp 
ON mission_sync_log(timestamp DESC);

-- ============================================
-- Trigger Function: Auto-increment version
-- ============================================
CREATE OR REPLACE FUNCTION increment_dashboard_version()
RETURNS TRIGGER AS $$
BEGIN
    NEW.version = OLD.version + 1;
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Trigger: Dashboard version increment
-- ============================================
DROP TRIGGER IF EXISTS trg_mission_dashboard_version ON mission_dashboard;

CREATE TRIGGER trg_mission_dashboard_version
    BEFORE UPDATE ON mission_dashboard
    FOR EACH ROW
    EXECUTE FUNCTION increment_dashboard_version();

-- ============================================
-- Optimistic Lock Check Function
-- ============================================
CREATE OR REPLACE FUNCTION check_version_match(
    p_device_id VARCHAR(64),
    p_expected_version INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
    v_current_version INTEGER;
BEGIN
    SELECT version INTO v_current_version 
    FROM mission_dashboard 
    WHERE device_id = p_device_id;
    
    RETURN v_current_version = p_expected_version;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Sync Helper Function
-- ============================================
CREATE OR REPLACE FUNCTION record_sync_action(
    p_device_id VARCHAR(64),
    p_action VARCHAR(64),
    p_item_type VARCHAR(32),
    p_item_id UUID,
    p_old_version INTEGER,
    p_new_version INTEGER,
    p_performed_by VARCHAR(64)
) RETURNS VOID AS $$
BEGIN
    INSERT INTO mission_sync_log (
        device_id, action, item_type, item_id, 
        old_version, new_version, performed_by
    ) VALUES (
        p_device_id, p_action, p_item_type, p_item_id,
        p_old_version, p_new_version, p_performed_by
    );
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Initial Data Helper
-- ============================================
CREATE OR REPLACE FUNCTION init_mission_dashboard(
    p_device_id VARCHAR(64)
) RETURNS VOID AS $$
BEGIN
    INSERT INTO mission_dashboard (device_id)
    VALUES (p_device_id)
    ON CONFLICT (device_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Migration: Add skills column
-- ============================================
ALTER TABLE mission_dashboard ADD COLUMN IF NOT EXISTS skills JSONB DEFAULT '[]'::jsonb;

-- ============================================
-- Migration: Add souls column
-- ============================================
ALTER TABLE mission_dashboard ADD COLUMN IF NOT EXISTS souls JSONB DEFAULT '[]'::jsonb;

-- ============================================
-- Bot File Storage Table
-- ============================================
CREATE TABLE IF NOT EXISTS bot_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id VARCHAR(64) NOT NULL,
    entity_id INTEGER NOT NULL,
    filename VARCHAR(255) NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(device_id, entity_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_bot_files_device_entity
ON bot_files(device_id, entity_id);

-- Grant execute to app user (adjust as needed)
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;
-- GRANT ALL ON ALL TABLES IN SCHEMA public TO app_user;
