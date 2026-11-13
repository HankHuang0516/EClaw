'use strict';
// Operator-only: the alert schedule's notes for the admin hub, written from inside the EClaw container (`railway ssh`).
// Hank, 2026-11-13: "確保排程可以自主處理判斷所有的警示問題 如果需要人為介入就讓排程發一個警示把詳情打上去 讓我看到需要我怎麼幫忙".
//
// One JSON request as a base64 argument (or on stdin):
//   { "action": "set", "ref": "<notification ID>", "state": "auto" | "human" | "done", "note": "...", "ask": "...", "title": "...", "app": "<app id>", "by": "..." }
//   { "action": "list" }            open notes and those changed in the last 7 days
//   { "action": "list", "all": true }
// "human" needs `ask` (what Hank should do). A standalone note uses ref "human-<slug>" and needs a title.
// There is no HTTP write API; only the hub's own aihankapps_hub_notes table is written. See aihankapps-hub-inbox.js.
const { setNote, listNotes } = require('../aihankapps-hub-inbox');
const { readEnvelope, catalogAppIds } = require('./aihankapps-hub-import');

function fault(code) { const error = new Error(code); error.code = code; return error; }

async function run(pool, request, { appIds = catalogAppIds() } = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw fault('NOTE_SHAPE');
    if (request.action === 'list') return { notes: await listNotes(pool, { all: request.all === true }) };
    if (request.action === 'set') {
        const input = Object.assign({}, request);
        delete input.action;
        return { saved: await setNote(pool, input, { appIds }) };
    }
    throw fault('NOTE_ACTION');
}

async function main() {
    const request = await readEnvelope(process.argv[2], process.stdin);
    if (!process.env.DATABASE_URL) throw fault('DATABASE_CONFIG_MISSING');
    const { Pool } = require('pg');
    // The service's own URL and TLS parameters; never printed or exported.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 15000, query_timeout: 30000 });
    try {
        process.stdout.write(JSON.stringify({ success: true, ...(await run(pool, request)) }) + '\n');
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main().catch(error => {
        const code = /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'NOTE_FAILED';
        process.stderr.write(JSON.stringify({ success: false, error: code }) + '\n');
        process.exitCode = 1;
    });
}

module.exports = { run };
