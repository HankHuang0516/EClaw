/**
 * Chat semantic embedding infrastructure for pgvector-backed search.
 *
 * Safe to load even when pgvector is unavailable: `initSchema()` silently
 * degrades by flipping the module's `vectorEnabled` flag to false, and all
 * downstream calls route through keyword fallback instead.
 */

const { generateEmbedding, toPgVectorLiteral, DEFAULT_DIM } = require('./embedding-client');

let vectorEnabled = false;  // set true after successful schema init
let poolRef = null;

async function initSchema(pool) {
    poolRef = pool;
    // Soft-fail each step independently so ALTER succeeds even if EXTENSION is
    // privileged-only on this PG install (common on hosted PG).
    let extensionOk = false;
    try {
        await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
        extensionOk = true;
    } catch (err) {
        console.warn('[ChatEmbedding] pgvector extension unavailable:', err.message);
    }
    if (!extensionOk) {
        vectorEnabled = false;
        return false;
    }
    try {
        await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS embedding vector(${DEFAULT_DIM})`);
        await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMP WITH TIME ZONE`);
    } catch (err) {
        console.warn('[ChatEmbedding] embedding column migration failed:', err.message);
        vectorEnabled = false;
        return false;
    }
    try {
        // HNSW is fast; falls back to sequential scan if index not present. Safe either way.
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_embedding_hnsw
            ON chat_messages USING hnsw (embedding vector_cosine_ops)`);
    } catch (err) {
        console.warn('[ChatEmbedding] HNSW index creation failed (search still works, just slower):', err.message);
    }
    vectorEnabled = true;
    console.log('[ChatEmbedding] pgvector schema ready');
    return true;
}

function isVectorEnabled() { return vectorEnabled; }

/**
 * Fire-and-forget: generates an embedding for the message and writes it to
 * chat_messages.embedding. Safe to call when the pipeline is disabled — it
 * becomes a no-op.
 */
function embedMessageAsync(messageId, text, opts = {}) {
    if (!vectorEnabled || !messageId || !text) return;
    setImmediate(async () => {
        try {
            const vec = await generateEmbedding(text, opts);
            if (!vec) return;
            const literal = toPgVectorLiteral(vec);
            if (!literal) return;
            await poolRef.query(
                `UPDATE chat_messages SET embedding = $1::vector, embedded_at = NOW() WHERE id = $2`,
                [literal, messageId]
            );
        } catch (err) {
            // Non-critical: silently skip
            if (!err.message.includes('does not exist')) {
                console.warn('[ChatEmbedding] embedMessageAsync failed for', messageId, err.message);
            }
        }
    });
}

/**
 * Semantic cosine search using pgvector. Caller must pre-auth.
 * @returns {Promise<Array>} rows: {id, text, created_at, distance, is_from_user, is_from_bot, entity_id, source}
 */
async function searchBySemantic(deviceId, queryEmbedding, opts = {}) {
    if (!vectorEnabled || !queryEmbedding) return [];
    const literal = toPgVectorLiteral(queryEmbedding);
    if (!literal) return [];
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 5, 1), 50);
    const params = [deviceId, literal, limit];
    let filter = '';
    if (opts.entityId != null && Number.isInteger(opts.entityId)) {
        filter = ` AND entity_id = $${params.length + 1}`;
        params.push(opts.entityId);
    }
    const sql = `
        SELECT id, entity_id, text, source, is_from_user, is_from_bot, created_at,
               embedding <=> $2::vector AS distance
        FROM chat_messages
        WHERE device_id = $1 AND embedding IS NOT NULL${filter}
        ORDER BY embedding <=> $2::vector
        LIMIT $3
    `;
    const result = await poolRef.query(sql, params);
    return result.rows;
}

/**
 * Keyword (ILIKE) fallback when pgvector isn't available or API key missing.
 * Not as smart but always works.
 */
async function searchByKeyword(deviceId, queryText, opts = {}) {
    if (!poolRef || !queryText) return [];
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 5, 1), 50);
    const like = '%' + queryText.replace(/[\\%_]/g, '\\$&') + '%';
    const params = [deviceId, like, limit];
    let filter = '';
    if (opts.entityId != null && Number.isInteger(opts.entityId)) {
        filter = ` AND entity_id = $${params.length + 1}`;
        params.push(opts.entityId);
    }
    const sql = `
        SELECT id, entity_id, text, source, is_from_user, is_from_bot, created_at
        FROM chat_messages
        WHERE device_id = $1 AND text ILIKE $2 ESCAPE '\\'${filter}
        ORDER BY created_at DESC
        LIMIT $3
    `;
    const result = await poolRef.query(sql, params);
    return result.rows;
}

async function countUnembeddedForDevice(deviceId) {
    if (!vectorEnabled || !poolRef) return 0;
    try {
        const r = await poolRef.query(
            `SELECT COUNT(*)::int AS n FROM chat_messages WHERE device_id = $1 AND embedding IS NULL AND text IS NOT NULL`,
            [deviceId]
        );
        return r.rows[0]?.n || 0;
    } catch {
        return 0;
    }
}

module.exports = {
    initSchema,
    isVectorEnabled,
    embedMessageAsync,
    searchBySemantic,
    searchByKeyword,
    countUnembeddedForDevice
};
