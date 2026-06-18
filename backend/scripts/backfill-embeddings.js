#!/usr/bin/env node
/**
 * Backfill embeddings for existing chat_messages rows that have `embedding IS NULL`.
 *
 * Usage:
 *   DATABASE_URL=postgres://... OPENAI_API_KEY=sk-... \
 *     node backend/scripts/backfill-embeddings.js [--batch=50] [--max=2000] [--device=<deviceId>] [--dry-run]
 *
 * Defaults:
 *   --batch  50   rows fetched per iteration
 *   --max    2000 safety cap (set 0 for unlimited)
 *   --device all devices
 *   --dry-run skip UPDATE, just print what would change
 *
 * Safe to re-run: first ensures the pgvector schema matches DEFAULT_DIM, then
 * only touches rows where embedding IS NULL. Rate-limited via the OpenAI API
 * server-side; if you hit rate limits, lower --batch.
 *
 * The script exits with a non-zero code only on fatal errors (db connect
 * failure, missing env). Individual embedding failures are skipped with a
 * warning so one bad row doesn't poison the whole run.
 */

require('dotenv').config();
const { Pool } = require('pg');
const embeddingClient = require('../embedding-client');
const chatEmbedding = require('../chat-embedding');
const { DEFAULT_DIM } = embeddingClient;

function parseArgs(argv) {
    const out = { batch: 50, max: 2000, device: null, dryRun: false };
    for (const a of argv.slice(2)) {
        if (a === '--dry-run') out.dryRun = true;
        else if (a.startsWith('--batch=')) out.batch = parseInt(a.slice(8), 10) || out.batch;
        else if (a.startsWith('--max=')) out.max = parseInt(a.slice(6), 10);
        else if (a.startsWith('--device=')) out.device = a.slice(9);
    }
    return out;
}

async function main() {
    const opts = parseArgs(process.argv);

    if (!process.env.DATABASE_URL) {
        console.error('[backfill] DATABASE_URL required');
        process.exit(1);
    }
    if (!embeddingClient.isConfigured()) {
        console.error('[backfill] No embedding API key configured (set OPENAI_API_KEY or VOYAGE_API_KEY)');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false }
    });

    console.log(`[backfill] provider=${embeddingClient.pickProvider()} expectedDim=${DEFAULT_DIM} batch=${opts.batch} max=${opts.max} device=${opts.device || 'ALL'} dryRun=${opts.dryRun}`);

    // Ensure the runtime schema exists and matches the selected default
    // dimension before querying rows. This also resets incompatible legacy
    // vectors to NULL so the loop below can recompute them.
    try {
        const schemaReady = await chatEmbedding.initSchema(pool);
        if (!schemaReady) {
            throw new Error('chat embedding schema init returned false');
        }
        await pool.query(`SELECT embedding FROM chat_messages WHERE embedding IS NULL LIMIT 0`);
    } catch (err) {
        console.error('[backfill] chat_messages.embedding column not available — install pgvector extension and ensure chat_messages exists:', err.message);
        await pool.end();
        process.exit(2);
    }

    let processed = 0;
    let embedded = 0;
    let failed = 0;

    // Pull one batch at a time so a single long run doesn't hold a huge result set in memory.
    // Ordering oldest-first so older conversation context gets searchable first.
    while (opts.max === 0 || processed < opts.max) {
        const remaining = opts.max === 0 ? opts.batch : Math.min(opts.batch, opts.max - processed);
        const filter = opts.device ? 'AND device_id = $2' : '';
        const params = opts.device ? [remaining, opts.device] : [remaining];
        const { rows } = await pool.query(
            `SELECT id, text FROM chat_messages
             WHERE embedding IS NULL AND text IS NOT NULL AND length(trim(text)) > 0 ${filter}
             ORDER BY created_at ASC
             LIMIT $1`,
            params
        );

        if (rows.length === 0) {
            console.log('[backfill] no more rows to process');
            break;
        }

        for (const row of rows) {
            processed++;
            try {
                const vec = await embeddingClient.generateEmbedding(row.text);
                if (!vec) {
                    failed++;
                    console.warn(`[backfill] null vector for id=${row.id}`);
                    continue;
                }
                if (vec.length !== DEFAULT_DIM) {
                    failed++;
                    console.warn(`[backfill] unexpected dim=${vec.length} (expected ${DEFAULT_DIM}) for id=${row.id}`);
                    continue;
                }
                const literal = embeddingClient.toPgVectorLiteral(vec);
                if (opts.dryRun) {
                    console.log(`[backfill][DRY] id=${row.id} len=${vec.length}`);
                } else {
                    await pool.query(
                        `UPDATE chat_messages SET embedding = $1::vector, embedded_at = NOW() WHERE id = $2 AND embedding IS NULL`,
                        [literal, row.id]
                    );
                }
                embedded++;
                if (embedded % 10 === 0) {
                    console.log(`[backfill] embedded=${embedded} processed=${processed} failed=${failed}`);
                }
            } catch (err) {
                failed++;
                console.warn(`[backfill] id=${row.id} failed:`, err.message);
            }
        }
    }

    console.log(`[backfill] done — embedded=${embedded} failed=${failed} processed=${processed}`);
    await pool.end();
}

main().catch((err) => {
    console.error('[backfill] fatal:', err);
    process.exit(1);
});
