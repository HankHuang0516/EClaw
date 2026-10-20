'use strict';
// Existing-service operator migration. Never called by the app or HTTP routes.
const { Pool } = require('pg');
const { migrateSchema } = require('../fraud-app-feedback');
async function main() {
    if (!process.env.DATABASE_URL) throw Object.assign(new Error('Missing existing database'), { code: 'DATABASE_CONFIG_MISSING' });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1,
        connectionTimeoutMillis: 15000, query_timeout: 30000 });
    try {
        const result = await migrateSchema(pool);
        await pool.query('SELECT id FROM fraud_app_feedback_reports LIMIT 0');
        process.stdout.write(JSON.stringify({ success: true, ...result, ready: true }) + '\n');
    } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => {
    const code = /^[A-Z0-9_]{1,64}$/i.test(error.code || '') ? error.code : 'MIGRATION_FAILED';
    process.stderr.write(JSON.stringify({ success: false, error: code }) + '\n');
    process.exitCode = 1;
});
module.exports = { main };
