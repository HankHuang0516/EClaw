-- ============================================
-- Task #42: Kanban Card Dependencies System
-- Migration: Add dependency tables and cycle detection
-- ============================================

-- ============================================
-- Kanban Card Dependencies Table
-- ============================================
CREATE TABLE IF NOT EXISTS kanban_card_dependencies (
    id VARCHAR(48) PRIMARY KEY DEFAULT ('dep_' || encode(gen_random_bytes(12), 'hex')),
    device_id VARCHAR(64) NOT NULL,
    source_card_id VARCHAR(48) NOT NULL,
    target_card_id VARCHAR(48) NOT NULL,
    created_by INTEGER NOT NULL,                     -- entity ID of creator
    created_at TIMESTAMPTZ DEFAULT NOW(),
    status VARCHAR(16) DEFAULT 'active',             -- active, removed

    -- Foreign key constraints
    CONSTRAINT fk_source_card FOREIGN KEY (source_card_id) REFERENCES kanban_cards(id) ON DELETE CASCADE,
    CONSTRAINT fk_target_card FOREIGN KEY (target_card_id) REFERENCES kanban_cards(id) ON DELETE CASCADE,

    -- Prevent self-dependency and duplicate dependencies
    CONSTRAINT chk_no_self_dependency CHECK (source_card_id != target_card_id),
    CONSTRAINT uk_unique_dependency UNIQUE (device_id, source_card_id, target_card_id, status)
);

-- Indexes for dependency queries
CREATE INDEX IF NOT EXISTS idx_kanban_dependencies_source ON kanban_card_dependencies(device_id, source_card_id, status);
CREATE INDEX IF NOT EXISTS idx_kanban_dependencies_target ON kanban_card_dependencies(device_id, target_card_id, status);
CREATE INDEX IF NOT EXISTS idx_kanban_dependencies_created ON kanban_card_dependencies(created_at DESC);

-- ============================================
-- Add dependency fields to kanban_cards
-- ============================================
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS has_dependencies BOOLEAN DEFAULT FALSE;
ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS dependency_status VARCHAR(16) DEFAULT 'none'; -- none, pending, blocked, ready

-- Index for dependency status queries
CREATE INDEX IF NOT EXISTS idx_kanban_cards_dependency_status ON kanban_cards(device_id, dependency_status)
    WHERE dependency_status != 'none';

-- ============================================
-- PostgreSQL Function: Cycle Detection
-- ============================================
CREATE OR REPLACE FUNCTION detect_dependency_cycle(
    p_device_id VARCHAR(64),
    p_source_card_id VARCHAR(48),
    p_target_card_id VARCHAR(48)
) RETURNS BOOLEAN AS $$
DECLARE
    cycle_found BOOLEAN := FALSE;
BEGIN
    -- Use recursive CTE to detect cycles
    WITH RECURSIVE dependency_path AS (
        -- Base case: start from target card
        SELECT
            target_card_id as current_card,
            source_card_id as next_card,
            1 as depth,
            ARRAY[target_card_id, source_card_id] as path
        FROM kanban_card_dependencies
        WHERE device_id = p_device_id
          AND target_card_id = p_target_card_id
          AND status = 'active'

        UNION ALL

        -- Recursive case: follow dependency chain
        SELECT
            dp.next_card,
            kcd.source_card_id,
            dp.depth + 1,
            dp.path || kcd.source_card_id
        FROM dependency_path dp
        JOIN kanban_card_dependencies kcd
          ON kcd.device_id = p_device_id
         AND kcd.target_card_id = dp.next_card
         AND kcd.status = 'active'
        WHERE dp.depth < 50  -- Prevent infinite recursion
          AND NOT (kcd.source_card_id = ANY(dp.path))  -- Avoid revisiting nodes
    )

    -- Check if proposed dependency would create a cycle
    SELECT EXISTS (
        SELECT 1 FROM dependency_path
        WHERE next_card = p_source_card_id
    ) INTO cycle_found;

    RETURN cycle_found;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Function: Update dependency status for a card
-- ============================================
CREATE OR REPLACE FUNCTION update_card_dependency_status(
    p_device_id VARCHAR(64),
    p_card_id VARCHAR(48)
) RETURNS VOID AS $$
DECLARE
    pending_count INTEGER := 0;
    total_dependencies INTEGER := 0;
    new_status VARCHAR(16);
    has_deps BOOLEAN;
BEGIN
    -- Count total dependencies for this card
    SELECT COUNT(*) INTO total_dependencies
    FROM kanban_card_dependencies
    WHERE device_id = p_device_id
      AND source_card_id = p_card_id
      AND status = 'active';

    -- Count pending dependencies (target cards not done)
    SELECT COUNT(*) INTO pending_count
    FROM kanban_card_dependencies kcd
    JOIN kanban_cards kc ON kc.id = kcd.target_card_id
    WHERE kcd.device_id = p_device_id
      AND kcd.source_card_id = p_card_id
      AND kcd.status = 'active'
      AND kc.status NOT IN ('done', 'archived');

    -- Determine new dependency status
    IF total_dependencies = 0 THEN
        new_status := 'none';
        has_deps := FALSE;
    ELSIF pending_count = 0 THEN
        new_status := 'ready';
        has_deps := TRUE;
    ELSE
        new_status := 'blocked';
        has_deps := TRUE;
    END IF;

    -- Update card dependency fields
    UPDATE kanban_cards
    SET
        dependency_status = new_status,
        has_dependencies = has_deps,
        updated_at = NOW()
    WHERE id = p_card_id AND device_id = p_device_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Function: Get dependency navigation chain
-- ============================================
CREATE OR REPLACE FUNCTION get_dependency_navigation_chain(
    p_device_id VARCHAR(64),
    p_card_id VARCHAR(48)
) RETURNS JSON AS $$
DECLARE
    result JSON;
BEGIN
    WITH card_dependencies AS (
        -- Get direct dependencies (cards this card depends on)
        SELECT
            'predecessor' as relation_type,
            kcd.target_card_id as related_card_id,
            kc.title as related_title,
            kc.status as related_status
        FROM kanban_card_dependencies kcd
        JOIN kanban_cards kc ON kc.id = kcd.target_card_id
        WHERE kcd.device_id = p_device_id
          AND kcd.source_card_id = p_card_id
          AND kcd.status = 'active'

        UNION ALL

        -- Get dependent cards (cards that depend on this card)
        SELECT
            'successor' as relation_type,
            kcd.source_card_id as related_card_id,
            kc.title as related_title,
            kc.status as related_status
        FROM kanban_card_dependencies kcd
        JOIN kanban_cards kc ON kc.id = kcd.source_card_id
        WHERE kcd.device_id = p_device_id
          AND kcd.target_card_id = p_card_id
          AND kcd.status = 'active'
    )

    SELECT json_build_object(
        'predecessors', COALESCE((
            SELECT json_agg(json_build_object(
                'id', related_card_id,
                'title', related_title,
                'status', related_status
            ))
            FROM card_dependencies
            WHERE relation_type = 'predecessor'
        ), '[]'::json),
        'successors', COALESCE((
            SELECT json_agg(json_build_object(
                'id', related_card_id,
                'title', related_title,
                'status', related_status
            ))
            FROM card_dependencies
            WHERE relation_type = 'successor'
        ), '[]'::json)
    ) INTO result;

    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Trigger: Auto-update dependency status
-- ============================================
CREATE OR REPLACE FUNCTION trigger_update_dependency_status()
RETURNS TRIGGER AS $$
BEGIN
    -- When a card status changes, update dependency status for all dependent cards
    IF TG_OP = 'UPDATE' AND OLD.status != NEW.status THEN
        -- Update all cards that depend on this card
        PERFORM update_card_dependency_status(NEW.device_id, kcd.source_card_id)
        FROM kanban_card_dependencies kcd
        WHERE kcd.device_id = NEW.device_id
          AND kcd.target_card_id = NEW.id
          AND kcd.status = 'active';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Create trigger
DROP TRIGGER IF EXISTS trg_kanban_card_dependency_status ON kanban_cards;
CREATE TRIGGER trg_kanban_card_dependency_status
    AFTER UPDATE OF status ON kanban_cards
    FOR EACH ROW
    EXECUTE FUNCTION trigger_update_dependency_status();

-- ============================================
-- Initial data sync: Update existing cards
-- ============================================
DO $$
BEGIN
    -- Update dependency status for all existing cards
    PERFORM update_card_dependency_status(device_id, id)
    FROM kanban_cards;

    RAISE NOTICE 'Dependency system migration completed successfully';
END;
$$;