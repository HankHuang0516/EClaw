/**
 * Device Feedback Module
 *
 * Integrates user feedback with log/telemetry snapshots to create
 * AI-debuggable bug reports.
 *
 * Flow:
 *   1. User submits feedback (POST /api/feedback)
 *   2. Backend auto-captures: telemetry entries + server logs + device state
 *   3. Auto-triages based on error patterns in captured logs
 *   4. GET /api/feedback/:id/ai-prompt returns a structured diagnostic prompt
 *   5. POST /api/feedback/:id/create-issue creates a GitHub issue
 */

const sharp = require('sharp');

const LOG_WINDOW_MS = 5 * 60 * 1000; // capture last 5 minutes of logs

// ============================================
// DB SETUP
// ============================================

async function initFeedbackTable(pool) {
    if (!pool) return;
    try {
        // Add new columns to existing feedback table (safe migration)
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS category VARCHAR(32) DEFAULT 'bug'`);
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS severity VARCHAR(16) DEFAULT 'medium'`);
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS log_snapshot JSONB`);
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS device_state JSONB`);
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'open'`);
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'`);
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS ai_diagnosis TEXT`);
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS resolution TEXT`);
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS github_issue_url TEXT`);
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS mark_ts BIGINT`);
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS device_secret TEXT`);
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS debug_status VARCHAR(16)`);
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS debug_result JSONB`);
        await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS source VARCHAR(16) DEFAULT 'unknown'`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_device ON feedback(device_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_tags ON feedback USING GIN(tags)`);
        console.log('[Feedback] Table migration complete');
    } catch (err) {
        console.error('[Feedback] Migration error:', err.message);
    }
}

// ============================================
// LOG SNAPSHOT CAPTURE
// ============================================

/**
 * Capture telemetry entries + server logs for a device within a time window.
 * @param {Pool} chatPool - PostgreSQL pool (for server_logs + device_telemetry)
 * @param {string} deviceId
 * @param {number} [sinceMs] - Start of capture window (default: now - 5 min)
 * @returns {object} { telemetry: [], serverLogs: [], capturedAt, windowMs }
 */
async function captureLogSnapshot(chatPool, deviceId, sinceMs) {
    const since = sinceMs || (Date.now() - LOG_WINDOW_MS);
    const snapshot = {
        telemetry: [],
        serverLogs: [],
        capturedAt: Date.now(),
        windowMs: Date.now() - since
    };

    if (!chatPool) return snapshot;

    try {
        // Capture device telemetry entries
        const telResult = await chatPool.query(
            `SELECT ts, type, action, page, input, output, duration, meta
             FROM device_telemetry
             WHERE device_id = $1 AND ts >= $2
             ORDER BY ts DESC
             LIMIT 200`,
            [deviceId, since]
        );
        snapshot.telemetry = telResult.rows.map(r => ({
            ts: parseInt(r.ts),
            type: r.type,
            action: r.action,
            page: r.page,
            input: r.input,
            output: r.output,
            duration: r.duration ? parseInt(r.duration) : null,
            meta: r.meta
        }));
    } catch (err) {
        snapshot.telemetryError = err.message;
    }

    try {
        // Capture server logs (filter by this device)
        const logResult = await chatPool.query(
            `SELECT level, category, message, device_id, entity_id, metadata, created_at
             FROM server_logs
             WHERE (device_id = $1 OR device_id IS NULL)
             AND created_at > $2
             ORDER BY created_at DESC
             LIMIT 100`,
            [deviceId, new Date(since)]
        );
        snapshot.serverLogs = logResult.rows.map(r => ({
            level: r.level,
            category: r.category,
            message: r.message,
            entityId: r.entity_id,
            metadata: r.metadata,
            createdAt: r.created_at
        }));
    } catch (err) {
        snapshot.serverLogsError = err.message;
    }

    return snapshot;
}

/**
 * Capture current device/entity state snapshot.
 * @param {object} devices - In-memory devices map
 * @param {string} deviceId
 * @returns {object|null}
 */
function captureDeviceState(devices, deviceId) {
    const device = devices[deviceId];
    if (!device) return null;

    const entities = [];
    for (let i = 0; i < 4; i++) {
        const e = device.entities[i];
        if (!e) continue;
        entities.push({
            entityId: i,
            isBound: e.isBound,
            name: e.name || null,
            character: e.character,
            state: e.state,
            message: e.message ? e.message.substring(0, 200) : null,
            lastUpdated: e.lastUpdated,
            hasWebhook: !!e.webhook,
            webhookMode: e.webhook ? 'push' : 'polling',
            appVersion: e.appVersion || null
        });
    }

    return {
        deviceId,
        appVersion: device.appVersion || null,
        lastPlatform: device.lastPlatform || null,
        entityCount: entities.length,
        boundCount: entities.filter(e => e.isBound).length,
        entities,
        capturedAt: Date.now()
    };
}

// ============================================
// AUTO-TRIAGE
// ============================================

/**
 * Analyze log snapshot and auto-assign severity, tags, and preliminary diagnosis.
 * @param {object} logSnapshot
 * @returns {{ severity: string, tags: string[], diagnosis: string }}
 */
function autoTriage(logSnapshot) {
    const tags = [];
    let severity = 'low';
    const issues = [];

    if (!logSnapshot) return { severity, tags, diagnosis: '' };

    const telemetry = logSnapshot.telemetry || [];
    const serverLogs = logSnapshot.serverLogs || [];

    // Scan telemetry for HTTP error patterns
    const errorCalls = [];
    for (const entry of telemetry) {
        if (entry.type !== 'api_req') continue;
        const status = entry.output?.status || entry.output?.statusCode;
        if (status >= 400) {
            errorCalls.push({ action: entry.action, status, output: entry.output });
        }
    }

    // Categorize errors
    const has403 = errorCalls.some(e => e.status === 403);
    const has429 = errorCalls.some(e => e.status === 429);
    const has500 = errorCalls.some(e => e.status >= 500);
    const hasTimeout = telemetry.some(e => e.duration && e.duration > 10000);

    if (has500) {
        tags.push('server_error');
        severity = 'critical';
        issues.push(`Server 500 errors detected in ${errorCalls.filter(e => e.status >= 500).length} API call(s)`);
    }
    if (has403) {
        tags.push('auth_issue');
        if (severity !== 'critical') severity = 'high';
        issues.push('Authentication failures (403) detected — botSecret may be invalid or expired');
    }
    if (has429) {
        tags.push('rate_limited');
        if (severity === 'low') severity = 'medium';
        issues.push('Rate limiting (429) triggered — user may have hit daily message limit');
    }
    if (hasTimeout) {
        tags.push('performance');
        if (severity === 'low') severity = 'medium';
        issues.push('Slow API calls detected (>10s) — possible performance issue');
    }

    // Scan server logs for error-level entries
    const errorLogs = serverLogs.filter(l => l.level === 'error');
    if (errorLogs.length > 0) {
        tags.push('backend_error');
        if (severity === 'low') severity = 'medium';
        issues.push(`${errorLogs.length} server-side error(s) in logs`);
    }

    // Scan for specific categories
    const logCategories = [...new Set(serverLogs.map(l => l.category))];
    if (logCategories.includes('broadcast_push') || logCategories.includes('speakto_push')) {
        tags.push('push_related');
    }
    if (logCategories.includes('bind') || logCategories.includes('unbind')) {
        tags.push('binding_related');
    }

    // Telemetry error entries (client-side errors)
    const clientErrors = telemetry.filter(e => e.type === 'error');
    if (clientErrors.length > 0) {
        tags.push('client_error');
        issues.push(`${clientErrors.length} client-side error(s) captured`);
    }

    // Tag affected endpoints
    const affectedEndpoints = [...new Set(errorCalls.map(e => e.action))];
    if (affectedEndpoints.length > 0) {
        tags.push(...affectedEndpoints.map(a => `endpoint:${a}`));
    }

    if (tags.length === 0) {
        tags.push('ux_issue');
    }

    const diagnosis = issues.length > 0
        ? 'Auto-detected issues:\n' + issues.map(i => `- ${i}`).join('\n')
        : 'No obvious errors detected in recent logs. This may be a UX/behavior issue.';

    return { severity, tags, diagnosis };
}

// ============================================
// AI PROMPT GENERATION
// ============================================

/**
 * Generate a structured AI diagnostic prompt from a feedback record.
 * @param {object} feedback - Full feedback row from DB
 * @param {Array} [photos] - Photo metadata array (from getFeedbackPhotos)
 * @returns {string}
 */
function generateAiPrompt(feedback, photos) {
    const lines = [];

    const promptTitleMap = { bug: 'Bug Report', feature: 'Feature Request', question: 'Question', rental_demand: 'Rental Demand' };
    const promptTitle = promptTitleMap[feedback.category] || 'Bug Report';
    lines.push(`## ${promptTitle} #${feedback.id}`);
    lines.push('');
    lines.push(`**Description:** ${feedback.message}`);
    lines.push(`**Category:** ${feedback.category || 'bug'}`);
    lines.push(`**Severity:** ${feedback.severity || 'unknown'}`);
    lines.push(`**Status:** ${feedback.status || 'open'}`);
    lines.push(`**Device:** ${feedback.device_id}`);
    lines.push(`**App Version:** ${feedback.app_version || 'unknown'}`);
    lines.push(`**Source:** ${(feedback.source || 'unknown').toUpperCase() === 'WEB' ? '🌐 Web Portal' : (feedback.source || 'unknown').toUpperCase() === 'ANDROID' ? '📱 Android App' : feedback.source || 'unknown'}`);
    lines.push(`**Reported:** ${new Date(parseInt(feedback.created_at)).toISOString()}`);

    if (feedback.tags && feedback.tags.length > 0) {
        lines.push(`**Tags:** ${feedback.tags.join(', ')}`);
    }

    const snapshot = feedback.log_snapshot;
    if (snapshot) {
        const windowMin = Math.round((snapshot.windowMs || 0) / 60000);

        // Recent API Calls
        const apiCalls = (snapshot.telemetry || []).filter(e => e.type === 'api_req');
        if (apiCalls.length > 0) {
            lines.push('');
            lines.push(`### Recent API Calls (last ${windowMin} min) — ${apiCalls.length} total`);
            lines.push('');
            lines.push('| Time | Endpoint | Status | Duration |');
            lines.push('|------|----------|--------|----------|');
            for (const call of apiCalls.slice(0, 30)) {
                const time = new Date(call.ts).toISOString().split('T')[1].split('.')[0];
                const status = call.output?.status || call.output?.statusCode || '?';
                const dur = call.duration ? `${call.duration}ms` : '-';
                const flag = status >= 400 ? ' **FAILED**' : '';
                lines.push(`| ${time} | ${call.action || '-'} | ${status}${flag} | ${dur} |`);
            }
        }

        // Client-side errors
        const clientErrors = (snapshot.telemetry || []).filter(e => e.type === 'error');
        if (clientErrors.length > 0) {
            lines.push('');
            lines.push(`### Client-Side Errors — ${clientErrors.length} total`);
            for (const err of clientErrors.slice(0, 10)) {
                const time = new Date(err.ts).toISOString().split('T')[1].split('.')[0];
                lines.push(`- [${time}] ${err.action || 'unknown'}: ${JSON.stringify(err.meta || {})}`);
            }
        }

        // Server Logs
        if (snapshot.serverLogs && snapshot.serverLogs.length > 0) {
            lines.push('');
            lines.push(`### Server Logs — ${snapshot.serverLogs.length} entries`);
            lines.push('');
            for (const log of snapshot.serverLogs.slice(0, 20)) {
                const level = log.level === 'error' ? '**ERROR**' : log.level === 'warn' ? 'WARN' : 'info';
                const time = log.createdAt ? new Date(log.createdAt).toISOString().split('T')[1].split('.')[0] : '?';
                lines.push(`- [${time}][${level}] ${log.category}: ${log.message}`);
            }
        }
    }

    // Device State
    const state = feedback.device_state;
    if (state) {
        lines.push('');
        lines.push(`### Device State (${state.boundCount}/${state.entityCount} entities bound)`);
        lines.push('');
        for (const e of (state.entities || [])) {
            const bound = e.isBound ? 'BOUND' : 'unbound';
            const msg = e.message ? `"${e.message.substring(0, 60)}"` : '-';
            lines.push(`- Entity ${e.entityId}: ${e.character} [${bound}] state=${e.state} mode=${e.webhookMode} msg=${msg}`);
        }
    }

    // Auto-diagnosis
    if (feedback.ai_diagnosis) {
        lines.push('');
        lines.push('### Auto-Triage Diagnosis');
        lines.push('');
        lines.push(feedback.ai_diagnosis);
    }

    // User-uploaded photos
    if (photos && photos.length > 0) {
        lines.push('');
        lines.push(`### Attached Photos — ${photos.length} file(s)`);
        lines.push('');
        photos.forEach((p, i) => {
            const sizeKB = p.size ? Math.round(parseInt(p.size) / 1024) : '?';
            lines.push(`- Photo ${i + 1}: [${p.file_name || 'photo'}](${process.env.BASE_URL || 'https://eclawbot.com'}/api/feedback/photo/${p.id}) (${p.content_type}, ${sizeKB}KB)`);
        });
        lines.push('');
        lines.push('> **Note:** These photos were uploaded by the user to help illustrate the issue. Review them for visual context.');
    }

    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('**Instructions for AI:** Analyze the above bug report, API call history, server logs, and device state. ');
    if (photos && photos.length > 0) {
        lines.push('Also review the attached photos for visual evidence of the issue. ');
    }
    lines.push('Identify the root cause, the affected code path in the backend (backend/index.js), and suggest a fix. ');
    lines.push('If the issue is client-side (Android app), indicate which Activity/Repository is involved.');

    return lines.join('\n');
}

// ============================================
// FEEDBACK DB OPERATIONS
// ============================================

/**
 * Save enhanced feedback with log snapshot.
 */
async function saveFeedback(pool, { deviceId, deviceSecret, message, category, appVersion, logSnapshot, deviceState, markTs, source }) {
    if (!pool) return null;

    const triage = autoTriage(logSnapshot);

    const effectiveCategory = category || 'bug';
    const debugStatus = effectiveCategory === 'bug' ? 'pending' : null;

    // Determine source: explicit > inferred from appVersion > unknown
    const effectiveSource = source || (appVersion && appVersion.startsWith('web') ? 'web' : appVersion ? 'android' : 'unknown');

    try {
        const result = await pool.query(
            `INSERT INTO feedback
             (device_id, device_secret, message, category, app_version, log_snapshot, device_state,
              severity, status, tags, ai_diagnosis, mark_ts, debug_status, source, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10, $11, $12, $13, $14)
             RETURNING id, severity, tags, ai_diagnosis`,
            [
                deviceId,
                deviceSecret || null,
                message,
                effectiveCategory,
                appVersion || '',
                JSON.stringify(logSnapshot),
                JSON.stringify(deviceState),
                triage.severity,
                triage.tags,
                triage.diagnosis,
                markTs || null,
                debugStatus,
                effectiveSource,
                Date.now()
            ]
        );
        return result.rows[0];
    } catch (err) {
        console.error('[Feedback] Save error:', err.message);
        return null;
    }
}

/**
 * Get feedback list with filters.
 */
async function getFeedbackList(pool, { deviceId, status, severity, limit = 50, offset = 0 }) {
    if (!pool) return [];

    let query = 'SELECT id, device_id, message, category, severity, status, tags, app_version, source, github_issue_url, created_at FROM feedback WHERE 1=1';
    const params = [];

    if (deviceId) {
        params.push(deviceId);
        query += ` AND device_id = $${params.length}`;
    }
    if (status) {
        params.push(status);
        query += ` AND status = $${params.length}`;
    }
    if (severity) {
        params.push(severity);
        query += ` AND severity = $${params.length}`;
    }

    query += ' ORDER BY created_at DESC';
    params.push(Math.min(parseInt(limit) || 50, 200));
    query += ` LIMIT $${params.length}`;
    params.push(parseInt(offset) || 0);
    query += ` OFFSET $${params.length}`;

    try {
        const result = await pool.query(query, params);
        return result.rows;
    } catch (err) {
        console.error('[Feedback] List error:', err.message);
        return [];
    }
}

const MINIGAME_FEEDBACK_TERMS = Object.freeze([
    'minigame',
    'mini_game',
    'mini-game',
    'mini game',
    'game_factory',
    'game-factory',
    'game factory'
]);

function clampFeedbackPage(value, fallback, max) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.min(parsed, max);
}

function miniGameFeedbackWhereClause(termParam = '$1') {
    return `(
        LOWER(COALESCE(source, '')) = ANY(${termParam}::text[])
        OR LOWER(COALESCE(category, '')) = ANY(${termParam}::text[])
        OR EXISTS (
            SELECT 1
            FROM unnest(COALESCE(tags, ARRAY[]::text[])) AS feedback_tag(tag)
            WHERE LOWER(feedback_tag.tag) = ANY(${termParam}::text[])
        )
        OR message ILIKE '%minigame%'
        OR message ILIKE '%mini game%'
        OR message ILIKE '%game factory%'
    )`;
}

/**
 * Admin-facing MiniGame submission list.
 *
 * MiniGame submissions are stored in the shared feedback table. The public
 * submitter can identify them through source/category/tags; the message
 * fallback keeps older submissions visible if they only mentioned MiniGame in
 * the text body.
 */
async function getMiniGameSubmissions(pool, { limit = 50, offset = 0 } = {}) {
    const empty = {
        summary: { total: 0, open: 0, bugReports: 0, highPriority: 0 },
        submissions: []
    };
    if (!pool) return empty;

    const safeLimit = clampFeedbackPage(limit, 50, 200);
    const safeOffset = clampFeedbackPage(offset, 0, Number.MAX_SAFE_INTEGER);
    const terms = Array.from(MINIGAME_FEEDBACK_TERMS);
    const where = miniGameFeedbackWhereClause('$1');

    try {
        const summaryResult = await pool.query(
            `SELECT
                CAST(COUNT(*) AS int) AS total,
                CAST(COUNT(*) FILTER (WHERE status = 'open') AS int) AS open,
                CAST(COUNT(*) FILTER (WHERE category = 'bug') AS int) AS bug_reports,
                CAST(COUNT(*) FILTER (WHERE severity IN ('critical', 'high')) AS int) AS high_priority
             FROM feedback
             WHERE ${where}`,
            [terms]
        );

        const listResult = await pool.query(
            `SELECT id, device_id, message, category, severity, status, tags, app_version,
                    source, github_issue_url, created_at
             FROM feedback
             WHERE ${where}
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [terms, safeLimit, safeOffset]
        );

        const summaryRow = summaryResult.rows[0] || {};
        return {
            summary: {
                total: parseInt(summaryRow.total, 10) || 0,
                open: parseInt(summaryRow.open, 10) || 0,
                bugReports: parseInt(summaryRow.bug_reports, 10) || 0,
                highPriority: parseInt(summaryRow.high_priority, 10) || 0
            },
            submissions: listResult.rows
        };
    } catch (err) {
        console.error('[Feedback] MiniGame submissions list error:', err.message);
        return empty;
    }
}

function clampAnalyticsWindowHours(value, fallback = 24, max = 24 * 30) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

const MINIGAME_SERVER_LOG_SIGNAL_SQL = `(
    category ILIKE '%minigame%'
    OR message ILIKE '%minigame%'
    OR message ILIKE '%mini game%'
    OR message ILIKE '%game factory%'
    OR message ~* 'GAME-[0-9]+'
    OR COALESCE(metadata::text, '') ILIKE '%minigame%'
    OR COALESCE(metadata::text, '') ILIKE '%mini game%'
    OR COALESCE(metadata::text, '') ILIKE '%game factory%'
    OR COALESCE(metadata::text, '') ~* 'GAME-[0-9]+'
)`;

const MINIGAME_TELEMETRY_SIGNAL_SQL = `(
    COALESCE(page, '') ILIKE '%minigame%'
    OR COALESCE(page, '') ~* 'GAME-[0-9]+'
    OR COALESCE(action, '') ILIKE '%minigame%'
    OR COALESCE(action, '') ILIKE '%mini game%'
    OR COALESCE(action, '') ILIKE '%game factory%'
    OR COALESCE(action, '') ~* 'GAME-[0-9]+'
    OR COALESCE(input::text, '') ILIKE '%minigame%'
    OR COALESCE(output::text, '') ILIKE '%minigame%'
    OR COALESCE(meta::text, '') ILIKE '%minigame%'
    OR COALESCE(input::text, '') ~* 'GAME-[0-9]+'
    OR COALESCE(output::text, '') ~* 'GAME-[0-9]+'
    OR COALESCE(meta::text, '') ~* 'GAME-[0-9]+'
)`;

function normalizeMiniGameAnalyticsRows(rows = []) {
    return rows.map(row => ({
        ...row,
        count: parseInt(row.count, 10) || 0,
        events: parseInt(row.events, 10) || 0,
        totalEvents: parseInt(row.total_events, 10) || parseInt(row.totalEvents, 10) || 0,
        pageViews: parseInt(row.page_views, 10) || parseInt(row.pageViews, 10) || 0,
        playActions: parseInt(row.play_actions, 10) || parseInt(row.playActions, 10) || 0,
        errors: parseInt(row.errors, 10) || 0,
        serverErrors: parseInt(row.server_errors, 10) || parseInt(row.serverErrors, 10) || 0,
        telemetryErrors: parseInt(row.telemetry_errors, 10) || parseInt(row.telemetryErrors, 10) || 0,
        uniqueDevices: parseInt(row.unique_devices, 10) || parseInt(row.uniqueDevices, 10) || 0,
        avgDurationMs: row.avg_duration_ms == null && row.avgDurationMs == null
            ? null
            : Math.round(parseFloat(row.avg_duration_ms ?? row.avgDurationMs) || 0),
        gameId: row.game_id || row.gameId || 'unknown',
        errorSignature: row.error_signature || row.errorSignature || null,
        firstSeenAt: row.first_seen_at || row.firstSeenAt || null,
        lastSeenAt: row.last_seen_at || row.lastSeenAt || null,
        createdAt: row.created_at || row.createdAt || null
    }));
}

/**
 * Admin-facing MiniGame telemetry/error analytics.
 *
 * Data sources are production tables, not ad-hoc CSV exports:
 * - server_logs: backend/runtime error signatures mentioning MiniGame or GAME-###.
 * - device_telemetry: page views, user actions, play starts, and client errors.
 *
 * This intentionally aggregates/limits results so the admin dashboard can show
 * patterns without leaking full logs or secrets.
 */
async function getMiniGameAnalytics(pool, { hours = 24, limit = 25 } = {}) {
    const safeHours = clampAnalyticsWindowHours(hours);
    const safeLimit = clampFeedbackPage(limit, 25, 100);
    const empty = {
        windowHours: safeHours,
        summary: {
            errorEvents: 0,
            serverErrorEvents: 0,
            telemetryErrorEvents: 0,
            totalEvents: 0,
            pageViews: 0,
            playActions: 0,
            uniqueDevices: 0,
            affectedGames: 0
        },
        errorStats: [],
        gameStats: [],
        recentErrors: []
    };
    if (!pool) return empty;

    const params = [safeHours, safeLimit];
    try {
        const summaryResult = await pool.query(
            `WITH telemetry AS (
                SELECT
                    COALESCE(
                        substring(COALESCE(page, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(action, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(input::text, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(output::text, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(meta::text, '') from '(GAME-[0-9]{3,})')
                    ) AS game_id,
                    device_id,
                    type,
                    action
                FROM device_telemetry
                WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
                  AND ${MINIGAME_TELEMETRY_SIGNAL_SQL}
            ),
            server_errors AS (
                SELECT
                    COALESCE(
                        substring(message from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(metadata::text, '') from '(GAME-[0-9]{3,})')
                    ) AS game_id,
                    device_id
                FROM server_logs
                WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
                  AND level IN ('error', 'warn')
                  AND ${MINIGAME_SERVER_LOG_SIGNAL_SQL}
            )
            SELECT
                CAST((SELECT COUNT(*) FROM telemetry) AS int) AS total_events,
                CAST((SELECT COUNT(*) FROM telemetry WHERE type = 'page_view') AS int) AS page_views,
                CAST((SELECT COUNT(*) FROM telemetry WHERE action ILIKE '%play%' OR action ILIKE '%start%' OR action ILIKE '%game_start%') AS int) AS play_actions,
                CAST((SELECT COUNT(*) FROM telemetry WHERE type = 'error') AS int) AS telemetry_error_events,
                CAST((SELECT COUNT(*) FROM server_errors) AS int) AS server_error_events,
                CAST((SELECT COUNT(DISTINCT device_id) FROM telemetry WHERE device_id IS NOT NULL) AS int) AS unique_devices,
                CAST((SELECT COUNT(DISTINCT game_id) FROM (
                    SELECT game_id FROM telemetry WHERE game_id IS NOT NULL
                    UNION ALL
                    SELECT game_id FROM server_errors WHERE game_id IS NOT NULL
                ) games) AS int) AS affected_games`,
            [safeHours]
        );

        const errorStatsResult = await pool.query(
            `WITH errors AS (
                SELECT
                    'server_log' AS source,
                    COALESCE(
                        substring(message from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(metadata::text, '') from '(GAME-[0-9]{3,})'),
                        'unknown'
                    ) AS game_id,
                    regexp_replace(left(message, 240), '\\s+', ' ', 'g') AS error_signature,
                    device_id,
                    created_at
                FROM server_logs
                WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
                  AND level IN ('error', 'warn')
                  AND ${MINIGAME_SERVER_LOG_SIGNAL_SQL}
                UNION ALL
                SELECT
                    'telemetry' AS source,
                    COALESCE(
                        substring(COALESCE(page, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(action, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(input::text, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(output::text, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(meta::text, '') from '(GAME-[0-9]{3,})'),
                        'unknown'
                    ) AS game_id,
                    regexp_replace(left(COALESCE(output->>'message', meta->>'message', input->>'message', action, 'client error'), 240), '\\s+', ' ', 'g') AS error_signature,
                    device_id,
                    created_at
                FROM device_telemetry
                WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
                  AND type = 'error'
                  AND ${MINIGAME_TELEMETRY_SIGNAL_SQL}
            )
            SELECT
                game_id,
                error_signature,
                CAST(COUNT(*) AS int) AS count,
                CAST(COUNT(*) FILTER (WHERE source = 'server_log') AS int) AS server_errors,
                CAST(COUNT(*) FILTER (WHERE source = 'telemetry') AS int) AS telemetry_errors,
                CAST(COUNT(DISTINCT device_id) AS int) AS unique_devices,
                MIN(created_at) AS first_seen_at,
                MAX(created_at) AS last_seen_at
            FROM errors
            GROUP BY game_id, error_signature
            ORDER BY count DESC, last_seen_at DESC
            LIMIT $2`,
            params
        );

        const gameStatsResult = await pool.query(
            `WITH telemetry AS (
                SELECT
                    COALESCE(
                        substring(COALESCE(page, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(action, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(input::text, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(output::text, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(meta::text, '') from '(GAME-[0-9]{3,})'),
                        'unknown'
                    ) AS game_id,
                    device_id,
                    type,
                    action,
                    duration,
                    created_at
                FROM device_telemetry
                WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
                  AND ${MINIGAME_TELEMETRY_SIGNAL_SQL}
            )
            SELECT
                game_id,
                CAST(COUNT(*) AS int) AS total_events,
                CAST(COUNT(*) FILTER (WHERE type = 'page_view') AS int) AS page_views,
                CAST(COUNT(*) FILTER (WHERE action ILIKE '%play%' OR action ILIKE '%start%' OR action ILIKE '%game_start%') AS int) AS play_actions,
                CAST(COUNT(*) FILTER (WHERE type = 'error') AS int) AS errors,
                CAST(COUNT(DISTINCT device_id) AS int) AS unique_devices,
                ROUND(AVG(duration)) AS avg_duration_ms,
                MAX(created_at) AS last_seen_at
            FROM telemetry
            GROUP BY game_id
            ORDER BY total_events DESC, errors DESC, last_seen_at DESC
            LIMIT $2`,
            params
        );

        const recentErrorsResult = await pool.query(
            `WITH recent AS (
                SELECT
                    'server_log' AS source,
                    COALESCE(
                        substring(message from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(metadata::text, '') from '(GAME-[0-9]{3,})'),
                        'unknown'
                    ) AS game_id,
                    level,
                    regexp_replace(left(message, 360), '\\s+', ' ', 'g') AS message,
                    device_id,
                    created_at
                FROM server_logs
                WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
                  AND level IN ('error', 'warn')
                  AND ${MINIGAME_SERVER_LOG_SIGNAL_SQL}
                UNION ALL
                SELECT
                    'telemetry' AS source,
                    COALESCE(
                        substring(COALESCE(page, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(action, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(input::text, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(output::text, '') from '(GAME-[0-9]{3,})'),
                        substring(COALESCE(meta::text, '') from '(GAME-[0-9]{3,})'),
                        'unknown'
                    ) AS game_id,
                    'error' AS level,
                    regexp_replace(left(COALESCE(output->>'message', meta->>'message', input->>'message', action, 'client error'), 360), '\\s+', ' ', 'g') AS message,
                    device_id,
                    created_at
                FROM device_telemetry
                WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
                  AND type = 'error'
                  AND ${MINIGAME_TELEMETRY_SIGNAL_SQL}
            )
            SELECT source, game_id, level, message, device_id, created_at
            FROM recent
            ORDER BY created_at DESC
            LIMIT $2`,
            params
        );

        const summaryRow = summaryResult.rows[0] || {};
        const serverErrorEvents = parseInt(summaryRow.server_error_events, 10) || 0;
        const telemetryErrorEvents = parseInt(summaryRow.telemetry_error_events, 10) || 0;
        return {
            windowHours: safeHours,
            summary: {
                errorEvents: serverErrorEvents + telemetryErrorEvents,
                serverErrorEvents,
                telemetryErrorEvents,
                totalEvents: parseInt(summaryRow.total_events, 10) || 0,
                pageViews: parseInt(summaryRow.page_views, 10) || 0,
                playActions: parseInt(summaryRow.play_actions, 10) || 0,
                uniqueDevices: parseInt(summaryRow.unique_devices, 10) || 0,
                affectedGames: parseInt(summaryRow.affected_games, 10) || 0
            },
            errorStats: normalizeMiniGameAnalyticsRows(errorStatsResult.rows),
            gameStats: normalizeMiniGameAnalyticsRows(gameStatsResult.rows),
            recentErrors: normalizeMiniGameAnalyticsRows(recentErrorsResult.rows)
        };
    } catch (err) {
        console.error('[Feedback] MiniGame analytics error:', err.message);
        return empty;
    }
}

/**
 * Get single feedback by ID (full record with log_snapshot).
 */
async function getFeedbackById(pool, id) {
    if (!pool) return null;
    try {
        const result = await pool.query('SELECT * FROM feedback WHERE id = $1', [id]);
        return result.rows[0] || null;
    } catch (err) {
        console.error('[Feedback] Get error:', err.message);
        return null;
    }
}

/**
 * Update feedback status/resolution.
 */
async function updateFeedback(pool, id, updates) {
    if (!pool) return false;
    const allowed = ['status', 'resolution', 'github_issue_url', 'ai_diagnosis', 'severity', 'debug_status', 'debug_result'];
    const sets = [];
    const params = [];

    for (const [key, value] of Object.entries(updates)) {
        if (allowed.includes(key)) {
            params.push(value);
            sets.push(`${key} = $${params.length}`);
        }
    }
    if (sets.length === 0) return false;

    params.push(id);
    try {
        await pool.query(`UPDATE feedback SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
        return true;
    } catch (err) {
        console.error('[Feedback] Update error:', err.message);
        return false;
    }
}

// ============================================
// YANHUI DEBUG INTEGRATION
// ============================================

/**
 * Get bug feedback pending yanhui debug processing.
 */
async function getPendingDebugFeedback(pool, limit = 20) {
    if (!pool) return [];
    try {
        const result = await pool.query(
            `SELECT id, device_id, message, category, severity, tags, ai_diagnosis, created_at
             FROM feedback
             WHERE debug_status = 'pending' AND category = 'bug'
             ORDER BY created_at DESC
             LIMIT $1`,
            [Math.min(parseInt(limit) || 20, 100)]
        );
        return result.rows;
    } catch (err) {
        console.error('[Feedback] Pending debug query error:', err.message);
        return [];
    }
}

/**
 * Save yanhui debug search/analyze result for a feedback entry.
 */
async function saveDebugResult(pool, id, debugStatus, debugResult) {
    if (!pool) return false;
    try {
        await pool.query(
            `UPDATE feedback SET debug_status = $1, debug_result = $2 WHERE id = $3`,
            [debugStatus, JSON.stringify(debugResult), id]
        );
        return true;
    } catch (err) {
        console.error('[Feedback] Save debug result error:', err.message);
        return false;
    }
}

// ============================================
// GITHUB ISSUE CREATION
// ============================================

/**
 * Create a GitHub issue from feedback.
 * Requires GITHUB_TOKEN and GITHUB_REPO in env.
 * @returns {{ url: string, number: number } | null}
 */
async function createGithubIssue(feedback, photos) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO; // e.g. "HankHuang0516/EClaw"
    if (!token || !repo) return null;

    const prompt = generateAiPrompt(feedback, photos);
    const cat = feedback.category || 'bug';
    const categoryLabelMap = { bug: 'bug', feature: 'enhancement', question: 'question', rental_demand: 'rental-demand' };
    const categoryPrefixMap = { bug: 'Bug', feature: 'Feature', question: 'Question', rental_demand: 'Rental Demand' };
    const categoryLabel = categoryLabelMap[cat] || 'bug';
    const prefix = categoryPrefixMap[cat] || 'Bug';

    const labels = [categoryLabel, 'ai-feedback'];
    if (cat === 'bug') {
        labels.push(`severity:${feedback.severity || 'medium'}`);
    }
    if (feedback.source && feedback.source !== 'unknown') {
        labels.push(feedback.source === 'web' ? 'platform:web' : 'platform:android');
    }
    if (feedback.tags) {
        for (const tag of feedback.tags) {
            if (!tag.startsWith('endpoint:')) labels.push(tag);
        }
    }

    const title = `[${prefix} #${feedback.id}] ${(feedback.message || '').substring(0, 80)}`;
    const body = prompt;

    try {
        const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
            method: 'POST',
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title, body, labels })
        });

        if (!res.ok) {
            const err = await res.text();
            console.error(`[Feedback] GitHub issue creation failed (${res.status}):`, err);
            return null;
        }

        const data = await res.json();
        return { url: data.html_url, number: data.number };
    } catch (err) {
        console.error('[Feedback] GitHub API error:', err.message);
        return null;
    }
}

/**
 * Sync feedback status with GitHub issue state.
 * For any open feedback that has a github_issue_url, check if the issue is closed
 * and auto-update feedback status to 'resolved'.
 */
async function syncGithubStatuses(pool, feedbackList) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    if (!token || !repo || !pool) return;

    const openWithIssue = feedbackList.filter(f => f.status === 'open' && f.github_issue_url);
    if (openWithIssue.length === 0) return;

    for (const fb of openWithIssue) {
        try {
            // Extract issue number from URL like https://github.com/owner/repo/issues/42
            const match = fb.github_issue_url.match(/\/issues\/(\d+)$/);
            if (!match) continue;
            const issueNumber = match[1];

            const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            if (!res.ok) continue;

            const issue = await res.json();
            if (issue.state === 'closed') {
                await updateFeedback(pool, fb.id, { status: 'resolved', resolution: 'GitHub issue closed' });
                fb.status = 'resolved'; // Update in-place for current response
                console.log(`[Feedback] Auto-synced #${fb.id} to resolved (GitHub issue #${issueNumber} closed)`);
            }
        } catch (err) {
            // Silently continue — don't block feedback list for sync errors
        }
    }
}

// ============================================
// MARK TIMESTAMP (for "mark now, report later")
// ============================================

// In-memory mark timestamps: deviceId → timestamp
const markTimestamps = {};

function setMark(deviceId) {
    markTimestamps[deviceId] = Date.now();
    return markTimestamps[deviceId];
}

function getMark(deviceId) {
    return markTimestamps[deviceId] || null;
}

function clearMark(deviceId) {
    delete markTimestamps[deviceId];
}

// ============================================
// FEEDBACK PHOTOS
// ============================================

const MAX_PHOTOS_PER_FEEDBACK = 5;
const MAX_PHOTO_SIZE = 5 * 1024 * 1024; // 5MB per photo
const FEEDBACK_PHOTO_FORMATS = {
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif'
};

async function stripFeedbackPhotoMetadata(photoBuffer, contentType) {
    const format = FEEDBACK_PHOTO_FORMATS[contentType];
    if (!format) {
        return { error: `Unsupported file type: ${contentType || 'unknown'}` };
    }

    try {
        let image = sharp(photoBuffer, {
            animated: contentType === 'image/gif' || contentType === 'image/webp',
            limitInputPixels: 40_000_000
        }).rotate();

        if (format === 'jpeg') {
            image = image.jpeg({ quality: 90, mozjpeg: true });
        } else if (format === 'png') {
            image = image.png();
        } else if (format === 'webp') {
            image = image.webp({ quality: 90 });
        } else if (format === 'gif') {
            image = image.gif();
        }

        const buffer = await image.toBuffer();
        if (buffer.length > MAX_PHOTO_SIZE) {
            return { error: `Processed photo exceeds ${Math.round(MAX_PHOTO_SIZE / 1024 / 1024)}MB limit` };
        }

        return { buffer, contentType };
    } catch (err) {
        console.error('[Feedback] Photo metadata strip error:', err.message);
        return { error: 'Could not process photo safely' };
    }
}

/**
 * Create feedback_photos table (called during init).
 */
async function initFeedbackPhotosTable(pool) {
    if (!pool) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS feedback_photos (
                id SERIAL PRIMARY KEY,
                feedback_id INTEGER NOT NULL,
                photo_data BYTEA NOT NULL,
                content_type VARCHAR(64) NOT NULL,
                file_name TEXT,
                created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_photos_fid ON feedback_photos(feedback_id)`);
        console.log('[Feedback] Photos table ready');
    } catch (err) {
        console.error('[Feedback] Photos table error:', err.message);
    }
}

/**
 * Save a photo for a feedback entry.
 * @returns {{ id: number, feedback_id: number, file_name: string } | null}
 */
async function saveFeedbackPhoto(pool, feedbackId, photoBuffer, contentType, fileName) {
    if (!pool) return null;
    try {
        // Check existing photo count
        const countResult = await pool.query(
            'SELECT COUNT(*) FROM feedback_photos WHERE feedback_id = $1',
            [feedbackId]
        );
        if (parseInt(countResult.rows[0].count) >= MAX_PHOTOS_PER_FEEDBACK) {
            return { error: `Maximum ${MAX_PHOTOS_PER_FEEDBACK} photos per feedback` };
        }

        const sanitizedPhoto = await stripFeedbackPhotoMetadata(photoBuffer, contentType);
        if (sanitizedPhoto.error) {
            return { error: sanitizedPhoto.error };
        }

        const result = await pool.query(
            `INSERT INTO feedback_photos (feedback_id, photo_data, content_type, file_name, created_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, feedback_id, file_name, created_at`,
            [feedbackId, sanitizedPhoto.buffer, sanitizedPhoto.contentType, fileName || 'photo', Date.now()]
        );
        return result.rows[0];
    } catch (err) {
        console.error('[Feedback] Save photo error:', err.message);
        return null;
    }
}

/**
 * Get photo metadata list for a feedback (without binary data).
 */
async function getFeedbackPhotos(pool, feedbackId) {
    if (!pool) return [];
    try {
        const result = await pool.query(
            `SELECT id, feedback_id, content_type, file_name, length(photo_data) as size, created_at
             FROM feedback_photos WHERE feedback_id = $1 ORDER BY id`,
            [feedbackId]
        );
        return result.rows;
    } catch (err) {
        console.error('[Feedback] Get photos error:', err.message);
        return [];
    }
}

/**
 * Get a single photo by ID (with binary data for serving).
 */
async function getFeedbackPhoto(pool, photoId) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            'SELECT id, feedback_id, photo_data, content_type, file_name FROM feedback_photos WHERE id = $1',
            [photoId]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.error('[Feedback] Get photo error:', err.message);
        return null;
    }
}

/**
 * Delete all photos for a feedback entry (called on bug resolved/closed).
 * @returns {number} Number of photos deleted
 */
async function deleteFeedbackPhotos(pool, feedbackId) {
    if (!pool) return 0;
    try {
        const result = await pool.query(
            'DELETE FROM feedback_photos WHERE feedback_id = $1',
            [feedbackId]
        );
        if (result.rowCount > 0) {
            console.log(`[Feedback] Deleted ${result.rowCount} photos for feedback #${feedbackId}`);
        }
        return result.rowCount;
    } catch (err) {
        console.error('[Feedback] Delete photos error:', err.message);
        return 0;
    }
}

/**
 * Cleanup photos for all resolved/closed feedback entries.
 * Called periodically or on status change.
 */
async function cleanupResolvedFeedbackPhotos(pool) {
    if (!pool) return 0;
    try {
        const result = await pool.query(
            `DELETE FROM feedback_photos WHERE feedback_id IN (
                SELECT id FROM feedback WHERE status IN ('resolved', 'closed')
            )`
        );
        if (result.rowCount > 0) {
            console.log(`[Feedback] Cleanup: removed ${result.rowCount} photos from resolved/closed feedback`);
        }
        return result.rowCount;
    } catch (err) {
        console.error('[Feedback] Cleanup photos error:', err.message);
        return 0;
    }
}

/**
 * Delete a feedback entry and its associated photos.
 * @returns {boolean} true if deleted
 */
async function deleteFeedback(pool, feedbackId) {
    if (!pool) return false;
    try {
        await deleteFeedbackPhotos(pool, feedbackId);
        const result = await pool.query('DELETE FROM feedback WHERE id = $1', [feedbackId]);
        return result.rowCount > 0;
    } catch (err) {
        console.error('[Feedback] Delete feedback error:', err.message);
        return false;
    }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
    initFeedbackTable,
    initFeedbackPhotosTable,
    captureLogSnapshot,
    captureDeviceState,
    autoTriage,
    generateAiPrompt,
    saveFeedback,
    getFeedbackList,
    getMiniGameSubmissions,
    getMiniGameAnalytics,
    miniGameFeedbackWhereClause,
    MINIGAME_FEEDBACK_TERMS,
    getFeedbackById,
    updateFeedback,
    createGithubIssue,
    syncGithubStatuses,
    getPendingDebugFeedback,
    saveDebugResult,
    setMark,
    getMark,
    clearMark,
    LOG_WINDOW_MS,
    // Photos
    MAX_PHOTOS_PER_FEEDBACK,
    MAX_PHOTO_SIZE,
    stripFeedbackPhotoMetadata,
    saveFeedbackPhoto,
    getFeedbackPhotos,
    getFeedbackPhoto,
    deleteFeedbackPhotos,
    cleanupResolvedFeedbackPhotos,
    deleteFeedback
};
