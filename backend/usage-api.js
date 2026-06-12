/**
 * Usage Snapshot API — Plan B Phase 1
 *
 * Mounted at: /api/usage
 *
 * Receives per-device Claude Code / Codex CLI token spend snapshots pushed
 * by the local mac-daemon (~60s cadence), and exposes aggregates for
 * dashboard widgets / bot queries.
 *
 * Endpoints:
 *   POST /snapshot   — daemon push (auth: deviceSecret OR entityId+botSecret)
 *   GET  /snapshot   — latest row + today/7d/30d aggregates
 *   GET  /timeline   — time-series points for the last `hours` (≤ 720)
 *
 * See: kanban card_c68db1d65325e4122acc86aa
 *      research: claude-code-eclaw-channel/usage_integration_research_2026_05_23.md
 */

const express = require('express');
const { Pool } = require('pg');
const safeEqual = require('./safe-equal');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/realbot'
});

const MAX_TIMELINE_HOURS = 720;            // 30 days
const SNAPSHOT_BODY_LIMIT = '200kb';
const FUTURE_SKEW_TOLERANCE_MS = 5 * 60 * 1000;  // accept ≤5min clock skew

// ============================================
// SCHEMA BOOTSTRAP — idempotent, safe to call on every boot.
// Production deploy creates the table on first start without a manual
// migration step; the migration SQL under migrations/ stays the SoT.
// ============================================
async function ensureSchema() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usage_snapshots (
                id              BIGSERIAL PRIMARY KEY,
                device_id       TEXT        NOT NULL,
                entity_id       INTEGER     NULL,
                captured_at     TIMESTAMPTZ NOT NULL,
                received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                daemon_version  TEXT        NULL,
                claude_json     JSONB       NOT NULL DEFAULT '{}'::jsonb,
                codex_json      JSONB       NOT NULL DEFAULT '{}'::jsonb,
                pricing_source  TEXT        NULL
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS usage_snapshots_device_captured_idx
            ON usage_snapshots (device_id, captured_at DESC)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS usage_snapshots_received_idx
            ON usage_snapshots (received_at DESC)`);
        console.log('[UsageAPI] usage_snapshots schema ready');
    } catch (err) {
        console.error('[UsageAPI] ensureSchema failed:', err.message);
    }
}

// ============================================
// AUTH
// ============================================

/**
 * Accept either:
 *   - deviceSecret matching devices[deviceId].deviceSecret, OR
 *   - entityId + botSecret matching devices[deviceId].entities[entityId].botSecret
 *
 * Returns { ok: true, entityId } on success, { ok: false, status, error } otherwise.
 */
function authenticate(devices, { deviceId, deviceSecret, entityId, botSecret }) {
    if (!deviceId) {
        return { ok: false, status: 400, error: 'Missing deviceId' };
    }
    const device = devices[deviceId];
    if (!device) {
        return { ok: false, status: 401, error: 'Invalid credentials' };
    }

    if (deviceSecret && device.deviceSecret && safeEqual(device.deviceSecret, deviceSecret)) {
        const eIdNum = entityId !== undefined && entityId !== null && entityId !== ''
            ? parseInt(entityId, 10) : null;
        return { ok: true, entityId: Number.isFinite(eIdNum) ? eIdNum : null };
    }

    if (botSecret && entityId !== undefined && entityId !== null && entityId !== '') {
        const eIdNum = parseInt(entityId, 10);
        if (!Number.isFinite(eIdNum)) {
            return { ok: false, status: 400, error: 'Invalid entityId' };
        }
        const entity = device.entities && device.entities[eIdNum];
        if (entity && entity.botSecret && safeEqual(entity.botSecret, botSecret)) {
            return { ok: true, entityId: eIdNum };
        }
    }

    return { ok: false, status: 401, error: 'Invalid credentials' };
}

// ============================================
// AGGREGATION HELPERS
// ============================================

/**
 * Sum token + cost fields across the `sessions` array of one engine JSONB blob.
 * Codex uses `cached_tokens`; Claude uses `cache_creation_tokens`/`cache_read_tokens`.
 * We surface a unified `sum_input_tokens` / `sum_output_tokens` / `sum_cost_usd`
 * regardless of which engine is being aggregated.
 */
/**
 * Read Claude rate-limit %s out of the `claude.live` blob the daemon stored.
 *
 * The Claude statusLine hook (~/.claude/usage-statusline.py) emits the
 * **nested** shape — `live.rate_limits.{five_hour,seven_day}.used_percentage`
 * — but earlier callers (including the live dashboard widget) used to also
 * accept a **flat** `live.{five_hour,seven_day}_pct`. The widget already
 * tolerates both; this helper keeps the timeline endpoint in lockstep so
 * the SVG line chart isn't silently empty whenever the only available shape
 * is nested. Returns null if neither shape carries a number.
 *
 * card_555a7d5f99fd5c6f1a28a169
 */
function pickClaudeLivePct(live, key) {
    if (!live) return null;
    const flatKey = key + '_pct';
    if (typeof live[flatKey] === 'number') return live[flatKey];
    const nested = live.rate_limits && live.rate_limits[key];
    if (nested && typeof nested.used_percentage === 'number') return nested.used_percentage;
    return null;
}

function sumEngineSessions(engineJson) {
    const sessions = Array.isArray(engineJson?.sessions) ? engineJson.sessions : [];
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    for (const s of sessions) {
        inputTokens  += Number(s.input_tokens)  || 0;
        outputTokens += Number(s.output_tokens) || 0;
        costUsd      += Number(s.cost_usd)      || 0;
    }
    return {
        session_count: sessions.length,
        sum_input_tokens: inputTokens,
        sum_output_tokens: outputTokens,
        sum_cost_usd: Math.round(costUsd * 1000000) / 1000000
    };
}

function aggregateOverRange(rows) {
    let claude = { session_count: 0, sum_input_tokens: 0, sum_output_tokens: 0, sum_cost_usd: 0 };
    let codex  = { session_count: 0, sum_input_tokens: 0, sum_output_tokens: 0, sum_cost_usd: 0 };
    for (const row of rows) {
        const c = sumEngineSessions(row.claude_json);
        const x = sumEngineSessions(row.codex_json);
        claude.session_count     += c.session_count;
        claude.sum_input_tokens  += c.sum_input_tokens;
        claude.sum_output_tokens += c.sum_output_tokens;
        claude.sum_cost_usd      += c.sum_cost_usd;
        codex.session_count      += x.session_count;
        codex.sum_input_tokens   += x.sum_input_tokens;
        codex.sum_output_tokens  += x.sum_output_tokens;
        codex.sum_cost_usd       += x.sum_cost_usd;
    }
    claude.sum_cost_usd = Math.round(claude.sum_cost_usd * 1000000) / 1000000;
    codex.sum_cost_usd  = Math.round(codex.sum_cost_usd  * 1000000) / 1000000;
    return { claude, codex, snapshot_count: rows.length };
}

// ============================================
// ROUTER
// ============================================

module.exports = function(devices) {
    const router = express.Router();

    // Fire-and-forget bootstrap; harmless if table already exists.
    ensureSchema().catch(() => {});

    // POST /api/usage/snapshot — daemon push
    router.post('/snapshot', express.json({ limit: SNAPSHOT_BODY_LIMIT }), async (req, res) => {
        const body = req.body || {};
        const auth = authenticate(devices, body);
        if (!auth.ok) {
            return res.status(auth.status).json({ success: false, error: auth.error });
        }

        const { captured_at, daemon_version, claude, codex, pricing_source } = body;

        if (!captured_at || typeof captured_at !== 'string') {
            return res.status(400).json({ success: false, error: 'Missing captured_at (ISO8601 string)' });
        }
        const capturedTs = Date.parse(captured_at);
        if (!Number.isFinite(capturedTs)) {
            return res.status(400).json({ success: false, error: 'Invalid captured_at — expected ISO8601' });
        }
        if (capturedTs > Date.now() + FUTURE_SKEW_TOLERANCE_MS) {
            return res.status(400).json({ success: false, error: 'captured_at is in the future' });
        }

        if (claude !== undefined && (claude === null || typeof claude !== 'object' || Array.isArray(claude))) {
            return res.status(400).json({ success: false, error: 'claude must be an object' });
        }
        if (codex !== undefined && (codex === null || typeof codex !== 'object' || Array.isArray(codex))) {
            return res.status(400).json({ success: false, error: 'codex must be an object' });
        }

        const claudeJson = claude || {};
        const codexJson  = codex  || {};
        const daemonVer  = (typeof daemon_version === 'string' && daemon_version) ? daemon_version.slice(0, 64) : null;
        const pricingSrc = (typeof pricing_source === 'string' && pricing_source) ? pricing_source.slice(0, 64) : null;

        try {
            const r = await pool.query(
                `INSERT INTO usage_snapshots
                   (device_id, entity_id, captured_at, daemon_version, claude_json, codex_json, pricing_source)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
                 RETURNING id, received_at`,
                [
                    body.deviceId,
                    auth.entityId,
                    new Date(capturedTs).toISOString(),
                    daemonVer,
                    JSON.stringify(claudeJson),
                    JSON.stringify(codexJson),
                    pricingSrc
                ]
            );
            const row = r.rows[0];
            return res.json({
                ok: true,
                success: true,
                id: row.id,
                received_at: row.received_at
            });
        } catch (err) {
            console.error('[UsageAPI] snapshot insert error:', err.message);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // GET /api/usage/snapshot — latest + today/7d/30d aggregates
    router.get('/snapshot', async (req, res) => {
        const auth = authenticate(devices, req.query);
        if (!auth.ok) {
            return res.status(auth.status).json({ success: false, error: auth.error });
        }
        const { deviceId } = req.query;

        try {
            const latestQ = await pool.query(
                `SELECT id, device_id, entity_id, captured_at, received_at,
                        daemon_version, claude_json, codex_json, pricing_source
                 FROM usage_snapshots
                 WHERE device_id = $1
                 ORDER BY captured_at DESC
                 LIMIT 1`,
                [deviceId]
            );

            const latest = latestQ.rows[0] || null;

            const now = Date.now();
            const dayMs  = 24 * 60 * 60 * 1000;
            const weekMs = 7  * dayMs;
            const monthMs = 30 * dayMs;

            // Use Promise.all for the three range queries.
            const [todayRows, weekRows, monthRows] = await Promise.all([
                pool.query(
                    `SELECT claude_json, codex_json FROM usage_snapshots
                     WHERE device_id = $1 AND captured_at >= $2`,
                    [deviceId, new Date(now - dayMs).toISOString()]
                ),
                pool.query(
                    `SELECT claude_json, codex_json FROM usage_snapshots
                     WHERE device_id = $1 AND captured_at >= $2`,
                    [deviceId, new Date(now - weekMs).toISOString()]
                ),
                pool.query(
                    `SELECT claude_json, codex_json FROM usage_snapshots
                     WHERE device_id = $1 AND captured_at >= $2`,
                    [deviceId, new Date(now - monthMs).toISOString()]
                )
            ]);

            return res.json({
                success: true,
                latest: latest ? {
                    id: latest.id,
                    deviceId: latest.device_id,
                    entityId: latest.entity_id,
                    captured_at: latest.captured_at,
                    received_at: latest.received_at,
                    daemon_version: latest.daemon_version,
                    pricing_source: latest.pricing_source,
                    claude: latest.claude_json,
                    codex:  latest.codex_json
                } : null,
                aggregates: {
                    today: aggregateOverRange(todayRows.rows),
                    week:  aggregateOverRange(weekRows.rows),
                    month: aggregateOverRange(monthRows.rows)
                }
            });
        } catch (err) {
            console.error('[UsageAPI] snapshot get error:', err.message);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // GET /api/usage/timeline?hours=24 — time series points
    router.get('/timeline', async (req, res) => {
        const auth = authenticate(devices, req.query);
        if (!auth.ok) {
            return res.status(auth.status).json({ success: false, error: auth.error });
        }
        const { deviceId } = req.query;

        let hours = parseInt(req.query.hours, 10);
        if (!Number.isFinite(hours) || hours <= 0) hours = 24;
        if (hours > MAX_TIMELINE_HOURS) {
            return res.status(400).json({ success: false, error: `hours must be ≤ ${MAX_TIMELINE_HOURS}` });
        }

        const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

        try {
            const r = await pool.query(
                `SELECT captured_at, claude_json, codex_json
                 FROM usage_snapshots
                 WHERE device_id = $1 AND captured_at >= $2
                 ORDER BY captured_at ASC`,
                [deviceId, sinceIso]
            );

            const points = r.rows.map(row => {
                const c = sumEngineSessions(row.claude_json);
                const x = sumEngineSessions(row.codex_json);
                // card_fb8a5a39ebe67581a66c6061: surface the same %-quota fields
                // the live dashboard widget already reads from the latest row,
                // so the new SVG line chart can render 5h/weekly curves.
                // Tolerate null (statusLine hook may not have populated %s) —
                // chart side filters null points.
                const claudeLive = (row.claude_json && row.claude_json.live) || {};
                const codexLimits = (row.codex_json && row.codex_json.rate_limits) || {};
                return {
                    captured_at: row.captured_at,
                    claude_total_tokens: c.sum_input_tokens + c.sum_output_tokens,
                    codex_total_tokens:  x.sum_input_tokens + x.sum_output_tokens,
                    claude_total_cost_usd: c.sum_cost_usd,
                    codex_total_cost_usd:  x.sum_cost_usd,
                    claude_5h_pct: pickClaudeLivePct(claudeLive, 'five_hour'),
                    claude_7d_pct: pickClaudeLivePct(claudeLive, 'seven_day'),
                    codex_5h_pct: typeof codexLimits.five_hour_pct === 'number' ? codexLimits.five_hour_pct : null,
                    codex_7d_pct: typeof codexLimits.seven_day_pct === 'number' ? codexLimits.seven_day_pct : null,
                };
            });

            return res.json({
                success: true,
                deviceId,
                hours,
                since: sinceIso,
                points
            });
        } catch (err) {
            console.error('[UsageAPI] timeline error:', err.message);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    return {
        router,
        _internal: { authenticate, sumEngineSessions, aggregateOverRange, pickClaudeLivePct, MAX_TIMELINE_HOURS, SNAPSHOT_BODY_LIMIT }
    };
};
