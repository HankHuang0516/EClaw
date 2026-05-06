#!/usr/bin/env node

/**
 * Apply idle dispatch database migration
 */

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

async function applyMigration() {
    try {
        console.log('Applying idle dispatch migration...');

        // Add dispatch_mode column
        await pool.query(`
            ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS dispatch_mode VARCHAR(20) DEFAULT 'immediate'
        `);
        console.log('✅ Added dispatch_mode column');

        // Add pending_dispatch column
        await pool.query(`
            ALTER TABLE kanban_cards ADD COLUMN IF NOT EXISTS pending_dispatch BOOLEAN DEFAULT FALSE
        `);
        console.log('✅ Added pending_dispatch column');

        // Add index for pending dispatch cards
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_kanban_cards_pending_dispatch ON kanban_cards(device_id, pending_dispatch, dispatch_mode)
            WHERE pending_dispatch = TRUE
        `);
        console.log('✅ Created pending_dispatch index');

        // Verify columns exist
        const result = await pool.query(`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns
            WHERE table_name = 'kanban_cards'
            AND column_name IN ('dispatch_mode', 'pending_dispatch')
            ORDER BY column_name
        `);

        console.log('\n📋 Migration verification:');
        for (const row of result.rows) {
            console.log(`  ${row.column_name}: ${row.data_type} (default: ${row.column_default})`);
        }

        console.log('\n🎉 Idle dispatch migration completed successfully!');

    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

applyMigration();