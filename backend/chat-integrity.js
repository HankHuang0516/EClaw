/**
 * Chat Integrity Validation Module
 *
 * Receives mismatch reports from Web/Android clients,
 * deduplicates them, logs via serverLog(), and persists to DB.
 *
 * Flow:
 *   1. Client detects display/data inconsistency after render
 *   2. POST /api/chat/integrity-report → report()
 *   3. serverLog() + DB persist
 */

// ── DB Setup ──────────────────────────────────────────────────────────────────

async function initIntegrityTable(pool) {
    if (!pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_integrity_reports (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                platform VARCHAR(16) NOT NULL,
                layer VARCHAR(16) NOT NULL,
                check_type VARCHAR(64) NOT NULL,
                fingerprint TEXT NOT NULL,
                details JSONB,
                github_issue_url TEXT,
                created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_cir_device ON chat_integrity_reports(device_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_cir_fp ON chat_integrity_reports(fingerprint)`);
        console.log('[ChatIntegrity] Table ready');
    } catch (err) {
        console.error('[ChatIntegrity] Table init error:', err.message);
    }
}

// ── In-memory dedup ───────────────────────────────────────────────────────────
// fingerprint → { count, firstSeenMs }
const _seen = new Map();
const DEDUP_TTL_MS = 60 * 60 * 1000; // 1 hour per unique fingerprint

function _pruneExpired() {
    const now = Date.now();
    for (const [fp, entry] of _seen) {
        if (now - entry.firstSeenMs > DEDUP_TTL_MS) _seen.delete(fp);
    }
}

// ── Core: report() ────────────────────────────────────────────────────────────

/**
 * Process an incoming mismatch report.
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {Object} mismatch - { deviceId, platform, layer, checkType, description, expected, actual, affectedIds, appVersion }
 * @param {Object} deps - { serverLog }
 * @returns {{ logged: boolean, githubIssue: string|null, suppressed: boolean }}
 */
async function report(pool, mismatch, { serverLog }) {
    _pruneExpired();

    const {
        deviceId, platform, layer, checkType,
        description, expected, actual, affectedIds = [], appVersion
    } = mismatch;

    // Build fingerprint: device + check type + first affected ID
    const firstId = affectedIds[0] || 'none';
    const fingerprint = `${deviceId}:${layer}:${checkType}:${firstId}`;

    const now = Date.now();
    const existing = _seen.get(fingerprint);

    if (existing) {
        existing.count++;
        serverLog('warn', 'chat_integrity',
            `[${platform}] ${layer}:${checkType} repeat #${existing.count} — ${description || ''}`,
            { deviceId, metadata: { fingerprint, count: existing.count } }
        );
        return { logged: true, githubIssue: null, suppressed: true };
    }

    // First time seeing this fingerprint
    _seen.set(fingerprint, { count: 1, firstSeenMs: now });

    // Always log
    serverLog('warn', 'chat_integrity',
        `[${platform}] ${layer}:${checkType} — ${description || JSON.stringify({ expected, actual })}`,
        { deviceId, metadata: { fingerprint, checkType, layer, platform, affectedIds, appVersion } }
    );

    // Persist to DB
    let savedId = null;
    if (pool) {
        try {
            const result = await pool.query(
                `INSERT INTO chat_integrity_reports
                 (device_id, platform, layer, check_type, fingerprint, details, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [deviceId, platform, layer, checkType, fingerprint,
                 JSON.stringify({ description, expected, actual, affectedIds, appVersion }), now]
            );
            savedId = result.rows[0]?.id;
        } catch (err) {
            console.error('[ChatIntegrity] DB insert error:', err.message);
        }
    }

    // GitHub issue auto-creation removed — too many false positives from message_count checks.
    // Reports are still logged via serverLog() and persisted to DB for manual review.

    return { logged: true, githubIssue: null, suppressed: false };
}

module.exports = { initIntegrityTable, report };
