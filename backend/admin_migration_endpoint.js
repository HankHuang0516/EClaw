/**
 * Admin Migration Endpoint - Task #42 Dependency System
 * Temporary endpoint to apply database migration in production
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

/**
 * Admin endpoint to apply Task #42 dependency migration
 * GET /api/admin/migrate-dependencies
 */
async function applyDependencyMigration(req, res) {
    try {
        // Admin device gate check
        const deviceId = req.query.deviceId || req.headers['x-device-id'];
        if (!deviceId || deviceId !== '480def4c-2183-4d8e-afd0-b131ae89adcc') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }

        // Database connection
        const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
        if (!connectionString) {
            return res.status(500).json({ success: false, error: 'DATABASE_URL not configured' });
        }

        const pool = new Pool({
            connectionString,
            ssl: shouldUseSsl(connectionString)
        });

        // Test connection
        const testResult = await pool.query('SELECT NOW() as current_time');
        console.log(`[Migration] Connected to database at ${testResult.rows[0].current_time}`);

        // Read migration file
        const migrationPath = path.join(__dirname, 'migrations', 'add_kanban_dependencies.sql');
        if (!fs.existsSync(migrationPath)) {
            await pool.end();
            return res.status(500).json({ success: false, error: `Migration file not found: ${migrationPath}` });
        }

        const migrationSql = fs.readFileSync(migrationPath, 'utf8');

        // Check if migration already applied
        try {
            const checkResult = await pool.query(`
                SELECT COUNT(*) as table_count
                FROM information_schema.tables
                WHERE table_schema = 'public'
                AND table_name = 'kanban_card_dependencies'
            `);

            if (parseInt(checkResult.rows[0].table_count) > 0) {
                await pool.end();
                return res.json({
                    success: true,
                    message: 'Migration already applied',
                    alreadyApplied: true
                });
            }
        } catch (err) {
            // Ignore check errors, proceed with migration
            console.log('[Migration] Could not check migration status, proceeding...');
        }

        // Apply migration
        await pool.query(migrationSql);

        // Verify tables were created
        const verifyResult = await pool.query(`
            SELECT
                table_name,
                (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
            FROM information_schema.tables t
            WHERE table_schema = 'public'
            AND table_name IN ('kanban_card_dependencies')
            ORDER BY table_name
        `);

        // Verify functions were created
        const functionResult = await pool.query(`
            SELECT routine_name
            FROM information_schema.routines
            WHERE routine_schema = 'public'
            AND routine_name LIKE '%dependency%'
            ORDER BY routine_name
        `);

        await pool.end();

        res.json({
            success: true,
            message: 'Task #42 dependency migration completed successfully',
            results: {
                tables: verifyResult.rows,
                functions: functionResult.rows
            }
        });

    } catch (error) {
        console.error('[Migration] Failed:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.toString()
        });
    }
}

module.exports = { applyDependencyMigration };