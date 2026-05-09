#!/usr/bin/env node

/**
 * Apply Task #42 Dependency System Migration
 * Applies add_kanban_dependencies.sql to the database
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Use the same database connection logic as the main app
function shouldUseSsl(connectionString) {
    const sslMode = (process.env.PGSSLMODE || '').toLowerCase();
    if (sslMode === 'disable') return false;
    if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full') {
        return { rejectUnauthorized: sslMode !== 'require' };
    }

    try {
        const host = new URL(connectionString).hostname;
        if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.railway.internal')) {
            return false;
        }
    } catch (_) {
        // Fall through to the production default
    }

    const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);
    return isProduction ? { rejectUnauthorized: false } : false;
}

async function applyMigration() {
    console.log('🚀 Starting Task #42 dependency migration...');

    // Database connection
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || 'postgresql://postgres:password@localhost:5432/eclawbot';

    const pool = new Pool({
        connectionString,
        ssl: shouldUseSsl(connectionString)
    });

    try {
        // Test connection
        console.log('🔗 Testing database connection...');
        const testResult = await pool.query('SELECT NOW() as current_time');
        console.log(`✅ Connected to database at ${testResult.rows[0].current_time}`);

        // Read migration file
        const migrationPath = path.join(__dirname, '..', 'migrations', 'add_kanban_dependencies.sql');
        if (!fs.existsSync(migrationPath)) {
            throw new Error(`Migration file not found: ${migrationPath}`);
        }

        console.log('📄 Reading migration file...');
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');

        // Check if migration already applied
        console.log('🔍 Checking if migration already applied...');
        try {
            const checkResult = await pool.query(`
                SELECT COUNT(*) as table_count
                FROM information_schema.tables
                WHERE table_schema = 'public'
                AND table_name = 'kanban_card_dependencies'
            `);

            if (parseInt(checkResult.rows[0].table_count) > 0) {
                console.log('⚠️  Migration appears to already be applied (kanban_card_dependencies table exists)');
                const confirm = process.argv.includes('--force');
                if (!confirm) {
                    console.log('💡 Use --force to reapply migration anyway');
                    process.exit(0);
                }
            }
        } catch (err) {
            // Ignore check errors, proceed with migration
            console.log('⚠️  Could not check migration status, proceeding...');
        }

        // Apply migration
        console.log('⚙️  Applying migration...');
        await pool.query(migrationSql);
        console.log('✅ Migration applied successfully!');

        // Verify tables were created
        console.log('🔍 Verifying migration results...');
        const verifyResult = await pool.query(`
            SELECT
                table_name,
                (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
            FROM information_schema.tables t
            WHERE table_schema = 'public'
            AND table_name IN ('kanban_card_dependencies')
            ORDER BY table_name
        `);

        console.log('📊 Created tables:');
        verifyResult.rows.forEach(row => {
            console.log(`   - ${row.table_name} (${row.column_count} columns)`);
        });

        // Verify functions were created
        const functionResult = await pool.query(`
            SELECT routine_name
            FROM information_schema.routines
            WHERE routine_schema = 'public'
            AND routine_name LIKE '%dependency%'
            ORDER BY routine_name
        `);

        console.log('📊 Created functions:');
        functionResult.rows.forEach(row => {
            console.log(`   - ${row.routine_name}()`);
        });

        console.log('\n🎉 Task #42 dependency migration completed successfully!');
        console.log('📝 Next steps:');
        console.log('   1. Restart backend server to pick up API changes');
        console.log('   2. Implement frontend UI components (Task #7)');
        console.log('   3. Run E2E tests to verify functionality');

    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        console.error('🔍 Error details:', error);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

// Run migration
if (require.main === module) {
    applyMigration().catch(console.error);
}

module.exports = { applyMigration };