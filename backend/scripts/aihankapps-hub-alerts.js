'use strict';
// Operator-only: prints the admin hub's active alerts, exactly as the page computes them, from inside the EClaw
// container (`railway ssh`). It exists so that the schedules on the operator's Mac can clear the alerts a tool can
// clear and leave the rest for a person (Hank, 2026-11-12: "讓現成的排程來處理…自癒的警示 讓警示越來越少").
//
// Read-only. No HTTP API is added and no session is created: the script loads the same data the hub's own answer is
// built from (this service's database, read-only queries), asks each back-end's public health address once, and reads
// the public ops answers over loopback from the running server. Two things live only in the running server's memory
// and are not reproduced: the EClaw device count (no alert depends on it) and the minute-by-minute service checks
// (replaced by the one fresh check made here).
//
//   node backend/scripts/aihankapps-hub-alerts.js          every active alert
//   node backend/scripts/aihankapps-hub-alerts.js --brief  id, type, severity, title and since only
const hub = require('../aihankapps-hub');
const store = require('../aihankapps-hub-store');

function fault(code) { const error = new Error(code); error.code = code; return error; }

async function compute({ pool, now = Date.now, fetchImpl = fetch, fetchOps, services = store.SERVICES, probe = store.probeOne, portfolioDir } = {}) {
    const data = hub.createData({ getPool: () => pool, getAuthPool: () => pool, now, ...(portfolioDir ? { portfolioDir } : {}) });
    const checked = await Promise.all(services.map(async service => {
        const r = await probe(service, { fetchImpl, now });
        return { id: service.id, name: service.name, apps: service.apps, ok: r.ok, status: r.status, ms: r.ms, at: r.at, info: r.info === undefined ? null : r.info };
    }));
    const alerts = hub.createAlerts({ loadHub: () => data.load(), latestServices: () => ({ success: true, checkedAt: now(), services: checked }), now, ...(fetchOps ? { fetchOps } : {}) });
    return alerts.load({ fresh: true });
}

async function main(argv = process.argv.slice(2)) {
    if (!process.env.DATABASE_URL) throw fault('DATABASE_CONFIG_MISSING');
    const { Pool } = require('pg');
    // The service's own URL and TLS parameters; never printed or exported.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 15000, query_timeout: 30000 });
    try {
        const answer = await compute({ pool });
        const brief = argv.includes('--brief');
        const alerts = brief ? answer.alerts.map(a => ({ id: a.id, type: a.type, severity: a.severity, title: a.title, since: a.since })) : answer.alerts;
        process.stdout.write(JSON.stringify({ success: true, computedAt: answer.computedAt, computedAtTaipei: answer.computedAtTaipei, count: alerts.length, alerts,
            // What Hank confirmed on the page and the countermeasures he wrote (see createAlerts).
            ...(brief ? {} : { acks: answer.acks || [] }) }) + '\n');
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main().catch(error => {
        const code = /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'ALERTS_FAILED';
        process.stderr.write(JSON.stringify({ success: false, error: code }) + '\n');
        process.exitCode = 1;
    });
}

module.exports = { compute };
