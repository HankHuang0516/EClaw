'use strict';

// Operator-only import for the AiHankApps admin hub, over the existing deployment channel (`railway ssh`).
// The collector (tools/aihankapps-hub/collect.js) passes one envelope of daily counts as a base64 argument, or as
// JSON on stdin. There is no HTTP write API. Only the hub's own tables are written; see aihankapps-hub-store.js.
// An envelope with a `feedback` list is a batch of problem reports (拾光AI雲端相簿's App and LINE reports, read with the
// hub's key by the alert schedule on the operator's Mac); see aihankapps-hub-inbox.js.
const fs = require('fs');
const path = require('path');
const hubStore = require('../aihankapps-hub-store');
const { importFeedback } = require('../aihankapps-hub-inbox');
const { MAX_IMPORT_BYTES, importEnvelope } = hubStore;

function fault(code) { const error = new Error(code); error.code = code; return error; }

async function readEnvelope(argument, stream) {
    let text;
    if (argument) {
        if (argument.length > 4 * Math.ceil(MAX_IMPORT_BYTES / 3)) throw fault('IMPORT_TOO_LARGE');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(argument)) throw fault('IMPORT_NOT_BASE64');
        text = Buffer.from(argument, 'base64').toString('utf8');
    } else {
        const chunks = [];
        let size = 0;
        for await (const value of stream) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            size += chunk.length;
            if (size > MAX_IMPORT_BYTES) throw fault('IMPORT_TOO_LARGE');
            chunks.push(chunk);
        }
        text = Buffer.concat(chunks).toString('utf8');
    }
    try { return JSON.parse(text); } catch (_) { throw fault('IMPORT_NOT_JSON'); }
}

// Only apps the portfolio knows may receive numbers.
function catalogAppIds(directory = path.join(__dirname, '..', 'public', 'AiHankApps')) {
    const catalog = JSON.parse(fs.readFileSync(path.join(directory, 'app-catalog.json'), 'utf8'));
    return new Set(catalog.apps.map(app => app.communityId).filter(id => typeof id === 'string'));
}

async function main() {
    const envelope = await readEnvelope(process.argv[2], process.stdin);
    if (!process.env.DATABASE_URL) throw fault('DATABASE_CONFIG_MISSING');
    const { Pool } = require('pg');
    // The service's own URL and TLS parameters; never printed or exported.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 15000, query_timeout: 30000 });
    try {
        const appIds = catalogAppIds();
        let receipt;
        if (envelope && typeof envelope === 'object' && Array.isArray(envelope.feedback)) {
            await hubStore.prepare(pool);          // the receipt goes to aihankapps_hub_sources like every other import
            receipt = await importFeedback(pool, envelope, { appIds });
        } else {
            receipt = await importEnvelope(pool, envelope, { appIds });
        }
        process.stdout.write(JSON.stringify({ success: true, ...receipt }) + '\n');
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main().catch(error => {
        const code = /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'IMPORT_FAILED';
        process.stderr.write(JSON.stringify({ success: false, error: code }) + '\n');
        process.exitCode = 1;
    });
}

module.exports = { readEnvelope, catalogAppIds };
