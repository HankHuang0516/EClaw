#!/usr/bin/env node

/**
 * Apply usage_snapshots migration (Plan B Phase 1).
 *
 * Creates the usage_snapshots table used by /api/usage/* endpoints
 * to store per-device Claude Code / Codex CLI spend snapshots pushed
 * by the local mac-daemon (~60s cadence).
 *
 * Run locally:
 *   cd backend && node apply_usage_snapshots_migration.js
 *
 * Idempotent — safe to re-run.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/realbot'
});

async function applyMigration() {
    const sqlPath = path.join(__dirname, 'migrations', '20260523_usage_snapshots.up.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    try {
        console.log('Applying usage_snapshots migration...');
        await pool.query(sql);
        console.log('✅ Migration SQL executed');

        // Verify schema
        const cols = await pool.query(`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'usage_snapshots'
            ORDER BY ordinal_position
        `);

        console.log('\n📋 usage_snapshots columns:');
        for (const row of cols.rows) {
            console.log(`  ${row.column_name}: ${row.data_type} (null=${row.is_nullable}, default=${row.column_default || 'none'})`);
        }

        const idx = await pool.query(`
            SELECT indexname FROM pg_indexes
            WHERE tablename = 'usage_snapshots'
            ORDER BY indexname
        `);
        console.log('\n📋 Indexes:');
        for (const row of idx.rows) {
            console.log(`  ${row.indexname}`);
        }

        // SELECT smoke
        const smoke = await pool.query('SELECT * FROM usage_snapshots LIMIT 0');
        console.log(`\n✅ SELECT * FROM usage_snapshots LIMIT 0 → ${smoke.fields.length} fields:`);
        console.log('  ' + smoke.fields.map(f => f.name).join(', '));

        console.log('\n🎉 usage_snapshots migration completed successfully!');
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

applyMigration();
