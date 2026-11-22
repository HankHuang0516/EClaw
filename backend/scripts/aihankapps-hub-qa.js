'use strict';
// Operator-only transport. Signed upload capabilities MUST stay in memory;
// never write the prepare-media response to an evidence file or terminal log.
const qa = require('../aihankapps-hub-qa');
const { readEnvelope } = require('./aihankapps-hub-import');
async function run(pool, v) {
    if (!v || typeof v !== 'object') throw new Error('QA_ACTION');
    if (v.action === 'prepare-media') return { success: true, media: await qa.prepareMedia(v) };
    if (v.action === 'publish') return qa.publish(pool, v.batch);
    // Omission keeps the global comment feed (and the legacy read envelope).
    if (v.action === 'read') return qa.read(pool, { after: v.after || '0', limit: v.limit || 500, ...(v.batch === undefined ? {} : { batch: v.batch }) });
    if (v.action === 'alert-replies') return qa.alertReplies(pool, { after: v.after === undefined ? '' : v.after, limit: v.limit === undefined ? 500 : v.limit });
    if (v.action === 'result') return qa.result(pool, v);
    throw new Error('QA_ACTION');
}
async function main() {
    const v = await readEnvelope(process.argv[2], process.stdin);
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 15000, query_timeout: 30000 });
    try { process.stdout.write(JSON.stringify(await run(pool, v)) + '\n'); } finally { await pool.end(); }
}
if (require.main === module) main().catch(e => { process.stderr.write(JSON.stringify({ success: false, error: /^QA_[A-Z_]+$/.test(e.code || e.message || '') ? e.code || e.message : 'QA_OPERATOR_FAILED' }) + '\n'); process.exitCode = 1; });
module.exports = { run };
