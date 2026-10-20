'use strict';

// Operator-only import over the existing deployment channel. No HTTP write API.
const { Pool } = require('pg');
const { MAX_PAYLOAD_BYTES, validatePayload, importRelease } = require('../admin-demo-runtime');

async function readInput(stream) {
    const chunks = [];
    let size = 0;
    for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > MAX_PAYLOAD_BYTES) {
            const error = new Error('Private import too large');
            error.code = 'PRIVATE_IMPORT_TOO_LARGE';
            throw error;
        }
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function main() {
    const payload = await readInput(process.stdin);
    validatePayload(payload);
    if (!process.env.DATABASE_URL) {
        const error = new Error('Existing database configuration unavailable');
        error.code = 'DATABASE_CONFIG_MISSING';
        throw error;
    }
    // Use the existing service URL and its TLS parameters; never fetch/export it.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1,
        connectionTimeoutMillis: 15000, query_timeout: 30000 });
    try {
        const receipt = await importRelease(pool, payload);
        process.stdout.write(JSON.stringify({ success: true, ...receipt }) + '\n');
    } finally {
        await pool.end();
    }
}
if (require.main === module) {
    main().catch(error => {
        const code = /^[A-Z0-9_]{1,64}$/i.test(error.code || '') ? error.code : 'PRIVATE_IMPORT_FAILED';
        process.stderr.write(JSON.stringify({ success: false, error: code }) + '\n');
        process.exitCode = 1;
    });
}
module.exports = { readInput };
