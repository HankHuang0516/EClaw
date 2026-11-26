'use strict';
// Separate fresh process, only the runner's synthetic loopback PostgreSQL DB.
const path = require('node:path');
const { createRequire } = require('node:module');
const { PendingService } = require('./pending-service.cjs');
const f = require('../stray-map-intake/synthetic-fixtures');
async function main() {
    const url = new URL(process.env.DATABASE_URL);
    if (process.env.STRAY_REBUILD_SYNTHETIC !== '1' || url.hostname !== 'localhost'
        || url.pathname !== '/stray_map_synthetic' || url.username !== 'postgres' || url.password) throw Error('SYNTHETIC_DB_ONLY');
    const localRequire = createRequire(path.join(process.argv[2], 'apps/api/package.json'));
    const pool = new (localRequire('pg').Pool)({ connectionString: url.href, ssl: false });
    try {
        const service = new PendingService({ pool, sourcePolicies: [f.policy, f.peerPolicy], now: () => f.SUBMITTED });
        process.stdout.write(JSON.stringify(await service.getReceipt(process.argv[3])));
    } finally { await pool.end(); }
}
if (require.main === module) main().catch(() => { process.stderr.write('ISOLATED_RECEIPT_PROBE_FAILED'); process.exitCode = 1; });
