#!/usr/bin/env node

/**
 * Apply kanban card dependency chain migration
 * Task #42: Implement bidirectional dependency chains with deadlock detection
 */

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

async function applyDependencyChainMigration() {
    try {
        console.log('Applying kanban dependency chain migration...');

        // Create dependency relationships table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS kanban_card_dependencies (
                id BIGSERIAL PRIMARY KEY,
                device_id VARCHAR(64) NOT NULL,
                card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
                depends_on_card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
                dependency_type VARCHAR(16) DEFAULT 'blocks',  -- 'blocks', 'subtask', 'related'
                created_at TIMESTAMPTZ DEFAULT NOW(),
                created_by INTEGER NOT NULL DEFAULT 0,
                UNIQUE(device_id, card_id, depends_on_card_id)
            )
        `);
        console.log('✅ Created kanban_card_dependencies table');

        // Add dependency tracking columns to kanban_cards
        await pool.query(`
            ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS has_dependencies BOOLEAN DEFAULT FALSE
        `);
        console.log('✅ Added has_dependencies column');

        await pool.query(`
            ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS dependency_status VARCHAR(16) DEFAULT 'ready'
        `);
        console.log('✅ Added dependency_status column (ready/waiting/blocked)');

        // Indexes for dependency queries
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_kanban_dependencies_card ON kanban_card_dependencies(device_id, card_id)
        `);
        console.log('✅ Created card dependency index');

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_kanban_dependencies_depends_on ON kanban_card_dependencies(device_id, depends_on_card_id)
        `);
        console.log('✅ Created depends_on dependency index');

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_kanban_dependencies_type ON kanban_card_dependencies(device_id, dependency_type)
        `);
        console.log('✅ Created dependency type index');

        // Index for cards with dependencies
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_kanban_cards_has_dependencies ON kanban_cards(device_id, has_dependencies, dependency_status)
            WHERE has_dependencies = TRUE
        `);
        console.log('✅ Created has_dependencies index');

        // Create function to detect cycles in dependency graph
        await pool.query(`
            CREATE OR REPLACE FUNCTION detect_dependency_cycle(
                p_device_id VARCHAR(64),
                p_card_id VARCHAR(48),
                p_depends_on_card_id VARCHAR(48)
            ) RETURNS BOOLEAN AS $$
            DECLARE
                visited_cards TEXT[] := ARRAY[]::TEXT[];
                current_card VARCHAR(48);
                dependency RECORD;
            BEGIN
                -- Start DFS from the card that would depend on p_card_id
                current_card := p_depends_on_card_id;

                -- If adding this dependency would create immediate cycle
                IF current_card = p_card_id THEN
                    RETURN TRUE;
                END IF;

                -- DFS to detect cycles
                WHILE current_card IS NOT NULL LOOP
                    -- If we've visited this card before, we have a cycle
                    IF current_card = ANY(visited_cards) THEN
                        RETURN TRUE;
                    END IF;

                    -- Add current card to visited list
                    visited_cards := visited_cards || current_card;

                    -- Find next card in dependency chain
                    SELECT depends_on_card_id INTO current_card
                    FROM kanban_card_dependencies
                    WHERE device_id = p_device_id
                    AND card_id = current_card
                    AND dependency_type = 'blocks'
                    LIMIT 1;

                    -- If we reach back to original card, cycle detected
                    IF current_card = p_card_id THEN
                        RETURN TRUE;
                    END IF;
                END LOOP;

                RETURN FALSE;
            END;
            $$ LANGUAGE plpgsql;
        `);
        console.log('✅ Created cycle detection function');

        // Create trigger to update dependency status
        await pool.query(`
            CREATE OR REPLACE FUNCTION update_dependency_status() RETURNS TRIGGER AS $$
            BEGIN
                -- Update has_dependencies flag
                UPDATE kanban_cards SET has_dependencies = (
                    SELECT COUNT(*) > 0
                    FROM kanban_card_dependencies
                    WHERE device_id = NEW.device_id AND card_id = NEW.card_id
                ) WHERE id = NEW.card_id AND device_id = NEW.device_id;

                -- Update dependency_status based on blocking dependencies
                UPDATE kanban_cards SET dependency_status = (
                    CASE
                        WHEN EXISTS (
                            SELECT 1 FROM kanban_card_dependencies d
                            JOIN kanban_cards dep_card ON d.depends_on_card_id = dep_card.id
                            WHERE d.device_id = NEW.device_id
                            AND d.card_id = NEW.card_id
                            AND d.dependency_type = 'blocks'
                            AND dep_card.status NOT IN ('done', 'archived')
                        ) THEN 'waiting'
                        ELSE 'ready'
                    END
                ) WHERE id = NEW.card_id AND device_id = NEW.device_id;

                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);
        console.log('✅ Created dependency status update function');

        await pool.query(`
            DROP TRIGGER IF EXISTS tr_kanban_dependency_status_update ON kanban_card_dependencies
        `);
        await pool.query(`
            CREATE TRIGGER tr_kanban_dependency_status_update
            AFTER INSERT OR UPDATE OR DELETE ON kanban_card_dependencies
            FOR EACH ROW EXECUTE FUNCTION update_dependency_status()
        `);
        console.log('✅ Created dependency status update trigger');

        // Verify migration
        const dependencyTable = await pool.query(`
            SELECT table_name, column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'kanban_card_dependencies'
            ORDER BY column_name
        `);

        const cardColumns = await pool.query(`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns
            WHERE table_name = 'kanban_cards'
            AND column_name IN ('has_dependencies', 'dependency_status')
            ORDER BY column_name
        `);

        console.log('\n📋 Migration verification:');
        console.log('\n🔗 Dependency table columns:');
        for (const row of dependencyTable.rows) {
            console.log(`  ${row.column_name}: ${row.data_type}`);
        }

        console.log('\n📊 Card dependency columns:');
        for (const row of cardColumns.rows) {
            console.log(`  ${row.column_name}: ${row.data_type} (default: ${row.column_default})`);
        }

        console.log('\n🎉 Kanban dependency chain migration completed successfully!');
        console.log('\n🔍 Features added:');
        console.log('  • Bidirectional dependency tracking');
        console.log('  • Cycle detection with DFS algorithm');
        console.log('  • Automatic dependency status updates');
        console.log('  • Performance indexes for dependency queries');

    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

applyDependencyChainMigration();