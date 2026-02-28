/**
 * Device Telemetry Module
 *
 * Structured debug buffer per device (~1 MB cap).
 * Captures device-side operations (pushed from client) and
 * backend-side API calls (auto-captured via middleware).
 *
 * Entry types:
 *   From device:  page_view, user_action, user_input, bot_response,
 *                 push_received, error, lifecycle
 *   From backend: api_req, push_sent, gatekeeper
 */

const MAX_BUFFER_BYTES = 1024 * 1024; // 1 MB per device
const MAX_ENTRIES      = 5000;         // safety cap (avoids runaway row counts)
const PRUNE_BATCH      = 500;          // delete this many oldest rows when pruning

// In-memory size cache: deviceId → { totalBytes, entryCount }
const sizeCache = {};

// ============================================
// DB SETUP
// ============================================

/**
 * Create the telemetry table (call once at startup).
 * @param {import('pg').Pool} pool
 */
async function initTelemetryTable(pool) {
    if (!pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS device_telemetry (
                id         SERIAL PRIMARY KEY,
                device_id  TEXT        NOT NULL,
                ts         BIGINT      NOT NULL,
                type       VARCHAR(32) NOT NULL,
                action     VARCHAR(128),
                page       VARCHAR(64),
                input      JSONB,
                output     JSONB,
                duration   INTEGER,
                meta       JSONB,
                size_bytes INTEGER     DEFAULT 0,
                created_at TIMESTAMP   DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_dtel_device    ON device_telemetry(device_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_dtel_device_ts ON device_telemetry(device_id, ts DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_dtel_type      ON device_telemetry(device_id, type)`);
        console.log('[Telemetry] Database table ready');
    } catch (err) {
        console.error('[Telemetry] Failed to create table:', err.message);
    }
}

// ============================================
// SIZE MANAGEMENT
// ============================================

/**
 * Load size cache for a device (lazy, on first access).
 */
async function ensureSizeCache(pool, deviceId) {
    if (sizeCache[deviceId]) return sizeCache[deviceId];
    if (!pool) {
        sizeCache[deviceId] = { totalBytes: 0, entryCount: 0 };
        return sizeCache[deviceId];
    }
    try {
        const r = await pool.query(
            `SELECT COALESCE(SUM(size_bytes), 0) AS total, COUNT(*) AS cnt
             FROM device_telemetry WHERE device_id = $1`,
            [deviceId]
        );
        sizeCache[deviceId] = {
            totalBytes: parseInt(r.rows[0].total) || 0,
            entryCount: parseInt(r.rows[0].cnt) || 0
        };
    } catch {
        sizeCache[deviceId] = { totalBytes: 0, entryCount: 0 };
    }
    return sizeCache[deviceId];
}

/**
 * Prune oldest entries until the device is under its quota.
 */
async function pruneIfNeeded(pool, deviceId) {
    if (!pool) return;
    const cache = await ensureSizeCache(pool, deviceId);
    if (cache.totalBytes <= MAX_BUFFER_BYTES && cache.entryCount <= MAX_ENTRIES) return;

    try {
        // Delete oldest PRUNE_BATCH entries and recalculate
        await pool.query(
            `DELETE FROM device_telemetry
             WHERE id IN (
                 SELECT id FROM device_telemetry
                 WHERE device_id = $1
                 ORDER BY ts ASC
                 LIMIT $2
             )`,
            [deviceId, PRUNE_BATCH]
        );
        // Recalculate from DB
        const r = await pool.query(
            `SELECT COALESCE(SUM(size_bytes), 0) AS total, COUNT(*) AS cnt
             FROM device_telemetry WHERE device_id = $1`,
            [deviceId]
        );
        sizeCache[deviceId] = {
            totalBytes: parseInt(r.rows[0].total) || 0,
            entryCount: parseInt(r.rows[0].cnt) || 0
        };
        console.log(`[Telemetry] Pruned ${PRUNE_BATCH} entries for ${deviceId}, now ${sizeCache[deviceId].entryCount} entries / ${(sizeCache[deviceId].totalBytes / 1024).toFixed(1)} KB`);

        // Recurse if still over quota
        if (sizeCache[deviceId].totalBytes > MAX_BUFFER_BYTES || sizeCache[deviceId].entryCount > MAX_ENTRIES) {
            await pruneIfNeeded(pool, deviceId);
        }
    } catch (err) {
        console.error('[Telemetry] Prune error:', err.message);
    }
}

// ============================================
// WRITE
// ============================================

// Sensitive keys to strip from logged data
const SENSITIVE_KEYS = ['deviceSecret', 'botSecret', 'password', 'secret', 'token', 'jwt', 'cookie'];

/**
 * Sanitise an object: remove secrets, truncate long strings.
 */
function sanitize(obj, maxStrLen = 200) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
        if (SENSITIVE_KEYS.some(s => k.toLowerCase().includes(s))) {
            out[k] = '[REDACTED]';
        } else if (typeof v === 'string' && v.length > maxStrLen) {
            out[k] = v.substring(0, maxStrLen) + `…(${v.length})`;
        } else if (v && typeof v === 'object') {
            out[k] = sanitize(v, maxStrLen);
        } else {
            out[k] = v;
        }
    }
    return out;
}

/**
 * Append one or more telemetry entries for a device.
 * @param {import('pg').Pool} pool
 * @param {string} deviceId
 * @param {Array<object>} entries - array of { ts, type, action?, page?, input?, output?, duration?, meta? }
 * @returns {Promise<{ accepted: number, dropped: number, bufferUsed: number }>}
 */
async function appendEntries(pool, deviceId, entries) {
    if (!pool || !deviceId || !entries || entries.length === 0) {
        return { accepted: 0, dropped: 0, bufferUsed: 0 };
    }

    const cache = await ensureSizeCache(pool, deviceId);
    let accepted = 0;
    let dropped = 0;

    for (const entry of entries) {
        const ts       = entry.ts || Date.now();
        const type     = (entry.type || 'unknown').substring(0, 32);
        const action   = entry.action ? entry.action.substring(0, 128) : null;
        const page     = entry.page ? entry.page.substring(0, 64) : null;
        const input    = entry.input ? sanitize(entry.input) : null;
        const output   = entry.output ? sanitize(entry.output) : null;
        const duration = typeof entry.duration === 'number' ? Math.round(entry.duration) : null;
        const meta     = entry.meta ? sanitize(entry.meta) : null;

        // Estimate row size (JSON overhead)
        const rowJson  = JSON.stringify({ ts, type, action, page, input, output, duration, meta });
        const sizeBytes = Buffer.byteLength(rowJson, 'utf8');

        // Will this exceed the cap? Prune first.
        if (cache.totalBytes + sizeBytes > MAX_BUFFER_BYTES || cache.entryCount >= MAX_ENTRIES) {
            await pruneIfNeeded(pool, deviceId);
        }

        // If still over after pruning, drop entry
        if (cache.totalBytes + sizeBytes > MAX_BUFFER_BYTES) {
            dropped++;
            continue;
        }

        try {
            await pool.query(
                `INSERT INTO device_telemetry
                 (device_id, ts, type, action, page, input, output, duration, meta, size_bytes)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [deviceId, ts, type, action, page,
                 input ? JSON.stringify(input) : null,
                 output ? JSON.stringify(output) : null,
                 duration, meta ? JSON.stringify(meta) : null, sizeBytes]
            );
            cache.totalBytes += sizeBytes;
            cache.entryCount++;
            accepted++;
        } catch (err) {
            console.error('[Telemetry] Insert error:', err.message);
            dropped++;
        }
    }

    return { accepted, dropped, bufferUsed: cache.totalBytes };
}

/**
 * Fire-and-forget: capture a single backend-side API call.
 * Called from middleware or directly — never awaited.
 */
function captureApiCall(pool, deviceId, data) {
    if (!pool || !deviceId) return;
    appendEntries(pool, deviceId, [{
        ts:       Date.now(),
        type:     'api_req',
        action:   `${data.method} ${data.path}`,
        page:     null,
        input:    data.input || null,
        output:   data.output || null,
        duration: data.duration ?? null,
        meta:     data.meta || null
    }]).catch(() => {});
}

// ============================================
// READ
// ============================================

/**
 * Retrieve telemetry entries for a device.
 * @param {import('pg').Pool} pool
 * @param {string} deviceId
 * @param {object} filters - { type?, page?, action?, since?, until?, limit? }
 * @returns {Promise<Array>}
 */
async function getEntries(pool, deviceId, filters = {}) {
    if (!pool) return [];

    let query = 'SELECT ts, type, action, page, input, output, duration, meta FROM device_telemetry WHERE device_id = $1';
    const params = [deviceId];

    if (filters.type) {
        params.push(filters.type);
        query += ` AND type = $${params.length}`;
    }
    if (filters.page) {
        params.push(filters.page);
        query += ` AND page = $${params.length}`;
    }
    if (filters.action) {
        params.push(`%${filters.action}%`);
        query += ` AND action LIKE $${params.length}`;
    }
    if (filters.since) {
        params.push(parseInt(filters.since));
        query += ` AND ts >= $${params.length}`;
    }
    if (filters.until) {
        params.push(parseInt(filters.until));
        query += ` AND ts <= $${params.length}`;
    }

    const limit = Math.min(parseInt(filters.limit) || 500, 2000);
    params.push(limit);
    query += ` ORDER BY ts DESC LIMIT $${params.length}`;

    try {
        const result = await pool.query(query, params);
        return result.rows.reverse(); // oldest first
    } catch (err) {
        console.error('[Telemetry] Query error:', err.message);
        return [];
    }
}

/**
 * Get summary / overview for a device's telemetry buffer.
 */
async function getSummary(pool, deviceId) {
    if (!pool) return null;
    try {
        const r = await pool.query(
            `SELECT
                COUNT(*)                          AS entry_count,
                COALESCE(SUM(size_bytes), 0)      AS total_bytes,
                MIN(ts)                           AS oldest_ts,
                MAX(ts)                           AS newest_ts
             FROM device_telemetry WHERE device_id = $1`,
            [deviceId]
        );
        const row = r.rows[0];
        // Type breakdown
        const types = await pool.query(
            `SELECT type, COUNT(*) AS cnt FROM device_telemetry
             WHERE device_id = $1 GROUP BY type ORDER BY cnt DESC`,
            [deviceId]
        );
        return {
            entryCount:  parseInt(row.entry_count) || 0,
            totalBytes:  parseInt(row.total_bytes) || 0,
            maxBytes:    MAX_BUFFER_BYTES,
            usagePercent: Math.round(((parseInt(row.total_bytes) || 0) / MAX_BUFFER_BYTES) * 100),
            oldestTs:    row.oldest_ts ? parseInt(row.oldest_ts) : null,
            newestTs:    row.newest_ts ? parseInt(row.newest_ts) : null,
            typeBreakdown: types.rows.reduce((acc, r) => { acc[r.type] = parseInt(r.cnt); return acc; }, {})
        };
    } catch (err) {
        console.error('[Telemetry] Summary error:', err.message);
        return null;
    }
}

/**
 * Clear all telemetry entries for a device.
 */
async function clearEntries(pool, deviceId) {
    if (!pool) return;
    try {
        await pool.query('DELETE FROM device_telemetry WHERE device_id = $1', [deviceId]);
        sizeCache[deviceId] = { totalBytes: 0, entryCount: 0 };
        console.log(`[Telemetry] Cleared buffer for device ${deviceId}`);
    } catch (err) {
        console.error('[Telemetry] Clear error:', err.message);
    }
}

// ============================================
// EXPRESS MIDDLEWARE — auto-capture API calls
// ============================================

/**
 * Returns Express middleware that auto-captures device-scoped API calls.
 * Attach AFTER body parsers, BEFORE route handlers.
 *
 * @param {import('pg').Pool} pool
 * @param {Function} deviceLookup - (deviceId) => device object or null
 */
function createMiddleware(pool, deviceLookup) {
    // Paths to skip (telemetry endpoints themselves, static, health)
    const SKIP = ['/api/device-telemetry', '/favicon', '/shared/', '/portal/'];

    return (req, res, next) => {
        // Only capture API requests
        if (!req.path.startsWith('/api/') || SKIP.some(p => req.path.startsWith(p))) {
            return next();
        }

        const start = Date.now();
        // Save path before Express sub-routers strip mount point
        const capturedPath = req.path;

        // Intercept res.json to capture output
        const originalJson = res.json.bind(res);
        res.json = function (data) {
            const duration = Date.now() - start;

            // Determine deviceId from body or query
            const deviceId = req.body?.deviceId || req.query?.deviceId;
            if (deviceId && deviceLookup(deviceId)) {
                const inputSummary = {};
                const body = req.body || {};
                // Copy only non-sensitive scalar fields for input summary
                for (const [k, v] of Object.entries(body)) {
                    if (SENSITIVE_KEYS.some(s => k.toLowerCase().includes(s))) continue;
                    if (typeof v === 'string' && v.length > 200) {
                        inputSummary[k] = v.substring(0, 200) + '…';
                    } else {
                        inputSummary[k] = v;
                    }
                }
                // Copy query params too (for GET requests)
                if (req.method === 'GET') {
                    for (const [k, v] of Object.entries(req.query)) {
                        if (SENSITIVE_KEYS.some(s => k.toLowerCase().includes(s))) continue;
                        inputSummary[k] = v;
                    }
                }

                // Summarize output (keep it small)
                const outputSummary = {};
                if (data && typeof data === 'object') {
                    if ('success' in data) outputSummary.success = data.success;
                    if ('error' in data)   outputSummary.error = typeof data.error === 'string' ? data.error.substring(0, 200) : data.error;
                    if ('message' in data)  outputSummary.message = typeof data.message === 'string' ? data.message.substring(0, 200) : data.message;
                    if ('count' in data)   outputSummary.count = data.count;
                    // Capture counts from entity/list responses (fixes logging blind spot for #16)
                    if ('activeCount' in data) outputSummary.activeCount = data.activeCount;
                    // Capture array lengths for any response containing lists
                    for (const [k, v] of Object.entries(data)) {
                        if (Array.isArray(v)) {
                            outputSummary[k + 'Count'] = v.length;
                        }
                    }
                }
                outputSummary.status = res.statusCode;

                captureApiCall(pool, deviceId, {
                    method:   req.method,
                    path:     capturedPath,
                    input:    inputSummary,
                    output:   outputSummary,
                    duration: duration
                });
            }

            return originalJson(data);
        };

        next();
    };
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    initTelemetryTable,
    appendEntries,
    captureApiCall,
    getEntries,
    getSummary,
    clearEntries,
    createMiddleware,
    sanitize,
    MAX_BUFFER_BYTES,
    MAX_ENTRIES
};
