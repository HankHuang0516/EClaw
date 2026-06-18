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
const EXPECTED_VECTOR_TYPE = `vector(${DEFAULT_DIM})`;

function vectorDim(vec) {
    return Array.isArray(vec) ? vec.length : null;
}

function hasExpectedDim(vec) {
    return vectorDim(vec) === DEFAULT_DIM;
}

async function normalizeEmbeddingColumn(pool) {
    const result = await pool.query(`
        SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type
        FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = 'chat_messages'::regclass
          AND a.attname = 'embedding'
          AND NOT a.attisdropped
        LIMIT 1
    `);
    const columnType = result.rows?.[0]?.column_type;
    if (!columnType || columnType === EXPECTED_VECTOR_TYPE) return;

    console.warn(`[ChatEmbedding] normalizing embedding column ${columnType} -> ${EXPECTED_VECTOR_TYPE}`);
    await pool.query('DROP INDEX IF EXISTS idx_chat_embedding_hnsw');
    await pool.query(`
        UPDATE chat_messages
        SET embedding = NULL, embedded_at = NULL
        WHERE embedding IS NOT NULL
          AND vector_dims(embedding) <> ${DEFAULT_DIM}
    `);
    await pool.query(`
        ALTER TABLE chat_messages
        ALTER COLUMN embedding TYPE vector(${DEFAULT_DIM})
        USING embedding::vector(${DEFAULT_DIM})
    `);
}

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
        await normalizeEmbeddingColumn(pool);
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
            // Stored chat messages are "passages" for asymmetric (e5-style) local
            // models; the role hint is ignored by symmetric providers (openai/voyage).
            const vec = await generateEmbedding(text, { ...opts, role: 'passage' });
            if (!vec) return;
            if (!hasExpectedDim(vec)) {
                console.warn(`[ChatEmbedding] skip embedding write for ${messageId}: dim=${vectorDim(vec)} expected=${DEFAULT_DIM}`);
                return;
            }
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
    if (!hasExpectedDim(queryEmbedding)) {
        console.warn(`[ChatEmbedding] skip semantic search: query dim=${vectorDim(queryEmbedding)} expected=${DEFAULT_DIM}`);
        return [];
    }
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
    } catch (err) {
        console.warn('[ChatEmbedding] countUnembeddedForDevice failed:', err.message);
        return 0;
    }
}

/**
 * Look up a single chat message scoped to device. Returns null if not found
 * or if the pool isn't initialized.
 */
async function findMessage(deviceId, messageId) {
    if (!poolRef || !deviceId || !messageId) return null;
    const hasEmbeddingExpr = vectorEnabled ? '(embedding IS NOT NULL)' : 'FALSE';
    try {
        const r = await poolRef.query(
            `SELECT id, entity_id, text, source, is_from_user, is_from_bot, created_at,
                    ${hasEmbeddingExpr} AS has_embedding
             FROM chat_messages
             WHERE id = $1 AND device_id = $2
             LIMIT 1`,
            [messageId, deviceId]
        );
        return r.rows[0] || null;
    } catch (err) {
        console.warn('[ChatEmbedding] findMessage failed:', err.message);
        return null;
    }
}

/**
 * Nearest-neighbor search anchored on a stored message's embedding. Excludes
 * the anchor message itself. Returns [] when pgvector is off or the anchor
 * has no embedding — caller decides fallback strategy.
 */
async function searchRelatedBySemantic(deviceId, messageId, opts = {}) {
    if (!vectorEnabled || !poolRef || !deviceId || !messageId) return [];
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 5, 1), 50);
    const params = [deviceId, messageId, limit];
    let filter = '';
    if (opts.entityId != null && Number.isInteger(opts.entityId)) {
        filter = ` AND c.entity_id = $${params.length + 1}`;
        params.push(opts.entityId);
    }
    const sql = `
        WITH anchor AS (
            SELECT embedding FROM chat_messages
            WHERE id = $2 AND device_id = $1 AND embedding IS NOT NULL
        )
        SELECT c.id, c.entity_id, c.text, c.source, c.is_from_user, c.is_from_bot, c.created_at,
               c.embedding <=> (SELECT embedding FROM anchor) AS distance
        FROM chat_messages c
        WHERE c.device_id = $1
          AND c.embedding IS NOT NULL
          AND c.id <> $2
          AND EXISTS (SELECT 1 FROM anchor)${filter}
        ORDER BY c.embedding <=> (SELECT embedding FROM anchor)
        LIMIT $3
    `;
    const result = await poolRef.query(sql, params);
    return result.rows;
}

module.exports = {
    initSchema,
    isVectorEnabled,
    embedMessageAsync,
    searchBySemantic,
    searchByKeyword,
    countUnembeddedForDevice,
    findMessage,
    searchRelatedBySemantic
};
