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
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_device ON feedback(device_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status)`);
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
 * @returns {string}
 */
function generateAiPrompt(feedback) {
    const lines = [];

    lines.push(`## Bug Report #${feedback.id}`);
    lines.push('');
    lines.push(`**Description:** ${feedback.message}`);
    lines.push(`**Category:** ${feedback.category || 'bug'}`);
    lines.push(`**Severity:** ${feedback.severity || 'unknown'}`);
    lines.push(`**Status:** ${feedback.status || 'open'}`);
    lines.push(`**Device:** ${feedback.device_id}`);
    lines.push(`**App Version:** ${feedback.app_version || 'unknown'}`);
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

    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('**Instructions for AI:** Analyze the above bug report, API call history, server logs, and device state. ');
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
async function saveFeedback(pool, { deviceId, deviceSecret, message, category, appVersion, logSnapshot, deviceState, markTs }) {
    if (!pool) return null;

    const triage = autoTriage(logSnapshot);

    try {
        const result = await pool.query(
            `INSERT INTO feedback
             (device_id, device_secret, message, category, app_version, log_snapshot, device_state,
              severity, status, tags, ai_diagnosis, mark_ts, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10, $11, $12)
             RETURNING id, severity, tags, ai_diagnosis`,
            [
                deviceId,
                deviceSecret || null,
                message,
                category || 'bug',
                appVersion || '',
                JSON.stringify(logSnapshot),
                JSON.stringify(deviceState),
                triage.severity,
                triage.tags,
                triage.diagnosis,
                markTs || null,
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

    let query = 'SELECT id, device_id, message, category, severity, status, tags, app_version, github_issue_url, created_at FROM feedback WHERE 1=1';
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
    const allowed = ['status', 'resolution', 'github_issue_url', 'ai_diagnosis', 'severity'];
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
// GITHUB ISSUE CREATION
// ============================================

/**
 * Create a GitHub issue from feedback.
 * Requires GITHUB_TOKEN and GITHUB_REPO in env.
 * @returns {{ url: string, number: number } | null}
 */
async function createGithubIssue(feedback) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO; // e.g. "HankHuang0516/realbot"
    if (!token || !repo) return null;

    const prompt = generateAiPrompt(feedback);
    const severityLabel = `severity:${feedback.severity || 'medium'}`;
    const labels = ['bug', 'ai-feedback', severityLabel];
    if (feedback.tags) {
        for (const tag of feedback.tags) {
            if (!tag.startsWith('endpoint:')) labels.push(tag);
        }
    }

    const title = `[Feedback #${feedback.id}] ${(feedback.message || '').substring(0, 80)}`;
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
// EXPORTS
// ============================================

module.exports = {
    initFeedbackTable,
    captureLogSnapshot,
    captureDeviceState,
    autoTriage,
    generateAiPrompt,
    saveFeedback,
    getFeedbackList,
    getFeedbackById,
    updateFeedback,
    createGithubIssue,
    setMark,
    getMark,
    clearMark,
    LOG_WINDOW_MS
};
