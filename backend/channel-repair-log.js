/**
 * Channel Repair Log API
 *
 * Mounted at: /api/channel-repair-log
 *
 * A maintenance timeline for each EClaw channel TYPE (not each entity). Stores
 * timestamped repair records / repair guidelines / risks / TODOs so the info
 * page can render a per-channel history that accumulates over time (each monitor
 * run can POST a new record).
 *
 * Channel types:
 *   openclaw-channel-eclaw      -> #1 Mac_F, #3 Mac_E, #4 Eclaw_Office
 *   claude-code-eclaw-channel   -> #2 Mac_ClaudeAce主管
 *   hermes-eclaw-channel        -> #5 Hermes
 *   codex-eclaw-bridge          -> #6 Codex
 *
 * Endpoints:
 *   GET  /api/channel-repair-log   — public read (filter: channel, kind, limit)
 *   POST /api/channel-repair-log   — authenticated write (deviceSecret OR entityId+botSecret)
 *
 * Records must never contain secrets; the POST handler rejects payloads that
 * look like they carry credentials.
 */

const express = require('express');
const { Pool } = require('pg');
const safeEqual = require('./safe-equal');
const { findSecret } = require('./agent-improvement/episode-schema');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/realbot'
});

const BODY_LIMIT = '64kb';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const FUTURE_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

// Channel type -> display label + entity refs (single source of truth for the UI).
const CHANNELS = [
    { channel_type: 'openclaw-channel-eclaw',    label: 'OpenClaw Channel',    entities: '#1 Mac_F · #3 Mac_E · #4 Eclaw_Office' },
    { channel_type: 'claude-code-eclaw-channel', label: 'Claude Code Channel', entities: '#2 Mac_ClaudeAce主管' },
    { channel_type: 'hermes-eclaw-channel',      label: 'Hermes Channel',      entities: '#5 Hermes' },
    { channel_type: 'codex-eclaw-bridge',        label: 'Codex Bridge',        entities: '#6 Codex' }
];
const VALID_CHANNELS = new Set(CHANNELS.map(c => c.channel_type));
const VALID_KINDS = new Set(['fix', 'guideline', 'risk', 'todo']);
const VALID_STATUS = new Set(['open', 'mitigated', 'resolved', 'blocked', 'info']);

// Reject anything that looks like a credential leaking into a public record.
// findSecret() (shared OODA-R detector) covers hex-32 / Bearer / JWT / RAILWAY /
// password / sk-; these extra patterns cover generic token / api-key / eck_ keys
// that it intentionally does not match.
const EXTRA_SECRET_PATTERNS = [/\bapi[\s_-]?key\b/i, /\btoken\b/i, /eck_[a-z0-9]/i, /-----BEGIN/i];
function looksLikeSecret(...vals) {
    return vals.some(v => typeof v === 'string' &&
        (findSecret(v) !== null || EXTRA_SECRET_PATTERNS.some(re => re.test(v))));
}

// ============================================
// SCHEMA BOOTSTRAP — idempotent, safe on every boot.
// ============================================
async function ensureSchema() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS channel_repair_log (
                id           BIGSERIAL   PRIMARY KEY,
                channel_type TEXT        NOT NULL,
                entity_refs  TEXT        NULL,
                kind         TEXT        NOT NULL,
                title        TEXT        NOT NULL,
                detail       TEXT        NULL,
                status       TEXT        NULL,
                occurred_at  TIMESTAMPTZ NOT NULL,
                source       TEXT        NULL,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS channel_repair_log_chan_time_idx
            ON channel_repair_log (channel_type, occurred_at DESC)`);
        await seedIfEmpty();
        console.log('[ChannelRepairLog] channel_repair_log schema ready');
    } catch (err) {
        console.error('[ChannelRepairLog] ensureSchema failed:', err.message);
    }
}

// Curated initial records (from README / runbooks). No secrets.
const SEED_RECORDS = [
    {
        channel_type: 'openclaw-channel-eclaw', entity_refs: '#1,#6', kind: 'risk',
        title: 'GPT-5.5 provider cooldown exhausts agent (no fallback lane)',
        detail: '#1 Mac_F / #6 Codex share one openai/gpt-5.5 Codex subscription quota. When it hits the usage limit the gateway logs `model fallback decision ... reason=rate_limit next=none` and the embedded agent fails entirely (`All models failed: Provider openai is in cooldown`). Infra stays green; chat shows `⚠️ Rate-limited — ready in ~N min`. Not fixable by restart/rebuild/upgrade — only the provider reset clears it.',
        status: 'open', occurred_at: '2026-06-08T05:33:00Z'
    },
    {
        channel_type: 'openclaw-channel-eclaw', entity_refs: '#1,#6', kind: 'todo',
        title: 'Durable fix: add fallback model lane / 2nd Codex account',
        detail: 'Configure a fallback lane so a GPT-5.5 cooldown degrades to a secondary model (e.g. minimax default) instead of `next=none` total failure (keeps primary = gpt-5.5/xhigh). Alternative: add a 2nd Codex account/profile for failover. Needs Hank decision (touches strict #1=gpt-5.5/xhigh policy).',
        status: 'open', occurred_at: '2026-06-08T05:37:00Z'
    },
    {
        channel_type: 'openclaw-channel-eclaw', entity_refs: '#1,#3,#4', kind: 'guideline',
        title: 'Webhook delivery is independent of model health',
        detail: 'project-f/e/c keep logging `[E-Claw] Webhook received` even while the model is in cooldown — so kanban/task reception works; only execution is gated by model availability. #1 acts on kanban via card comments (fromEntityId:1) when the model is up. Verify model truth from gateway startup log `agent model: openai/gpt-5.5 (thinking=xhigh)`, not self-report.',
        status: 'info', occurred_at: '2026-06-08T05:34:00Z'
    },
    {
        channel_type: 'claude-code-eclaw-channel', entity_refs: '#2', kind: 'fix',
        title: 'False "busy" from status-bar "esc to interrupt" with background shells',
        detail: 'classifyTmuxScreen() matched "esc to interrupt" before the idle check, so the status bar (N shells · esc to interrupt) made state permanently busy at the ❯ idle prompt. Fix: treat a lone ❯ line as idle. Immediate mitigation: ./restart-channel.sh --bridge-only.',
        status: 'mitigated', occurred_at: '2026-05-11T06:00:00Z'
    },
    {
        channel_type: 'claude-code-eclaw-channel', entity_refs: '#2', kind: 'fix',
        title: 'github-computer MCP permission dialog infinite decline loop',
        detail: 'resolve_stuck_prompt sent Down+Enter which hit "Decline" on the MCP "Allow access for this session?" dialog (required, not set) → infinite loop until 300s giveup. Fix: send Escape for MCP dialogs (graceful cancel) vs Down+Enter for standard Claude Code prompts. Recurred 3x; PR #9 carries the code fix.',
        status: 'mitigated', occurred_at: '2026-05-23T18:26:00Z'
    },
    {
        channel_type: 'claude-code-eclaw-channel', entity_refs: '#2', kind: 'risk',
        title: 'Long compaction can hang Claude Code at idle prompt',
        detail: 'Auto-compact has hung 2h+; bridge stays healthy but the turn never returns to idle, so incoming messages are visible but unprocessed. Containment: ./restart-channel.sh --force. Watch for recurrence after long sessions with background shells.',
        status: 'open', occurred_at: '2026-05-09T03:59:00Z'
    },
    {
        channel_type: 'hermes-eclaw-channel', entity_refs: '#5', kind: 'guideline',
        title: 'Hermes message queue + delivery-stuck heartbeat',
        detail: 'enqueueMessage() centralizes push delivery with a per-entity 200-msg cap + DLQ buffer; delivery-stuck heartbeat detection returns /api/health 503 on severe stuck to trigger Railway auto-restart. Recovery: restart hermes-daemon/hermes-bridge container only, verify local 8645/health then public hermes-b.eclawbot.com/health.',
        status: 'info', occurred_at: '2026-05-21T00:00:00Z'
    },
    {
        channel_type: 'codex-eclaw-bridge', entity_refs: '#6', kind: 'fix',
        title: 'Codex poller restart clears transient model reply-path stall',
        detail: 'Restarting the codex-eclaw-poller (tmux -L codex-eclaw-cua) flips #6 model_health green when the stall is local. But when the underlying openai/gpt-5.5 quota is exhausted the restart does not help — that is the shared cooldown blocker (see OpenClaw Channel risk). Attest #6 model truth from codex-eclaw-bridge diagnostics: codexModel=gpt-5.5, codexReasoningEffort=xhigh.',
        status: 'mitigated', occurred_at: '2026-06-08T05:27:00Z'
    }
];

async function seedIfEmpty() {
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM channel_repair_log');
    if (r.rows[0].c > 0) return;
    for (const rec of SEED_RECORDS) {
        await pool.query(
            `INSERT INTO channel_repair_log
               (channel_type, entity_refs, kind, title, detail, status, occurred_at, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'seed')`,
            [rec.channel_type, rec.entity_refs, rec.kind, rec.title, rec.detail, rec.status, rec.occurred_at]
        );
    }
    console.log(`[ChannelRepairLog] seeded ${SEED_RECORDS.length} initial records`);
}

// ============================================
// AUTH (mirrors usage-api.js)
// ============================================
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
// ROUTER
// ============================================
module.exports = function(devices) {
    const router = express.Router();

    // Fire-and-forget bootstrap; harmless if table already exists.
    ensureSchema().catch(() => {});

    // GET /api/channel-repair-log — public read.
    router.get('/', async (req, res) => {
        try {
            const channel = typeof req.query.channel === 'string' ? req.query.channel : '';
            const kind = typeof req.query.kind === 'string' ? req.query.kind : '';
            let limit = parseInt(req.query.limit, 10);
            if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
            if (limit > MAX_LIMIT) limit = MAX_LIMIT;

            const where = [];
            const params = [];
            if (channel && VALID_CHANNELS.has(channel)) { params.push(channel); where.push(`channel_type = $${params.length}`); }
            if (kind && VALID_KINDS.has(kind)) { params.push(kind); where.push(`kind = $${params.length}`); }
            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
            params.push(limit);

            const r = await pool.query(
                `SELECT id, channel_type, entity_refs, kind, title, detail, status, occurred_at, source
                   FROM channel_repair_log
                   ${whereSql}
                   ORDER BY occurred_at DESC, id DESC
                   LIMIT $${params.length}`,
                params
            );
            const totalR = await pool.query('SELECT COUNT(*)::int AS c FROM channel_repair_log');
            return res.json({
                success: true,
                total: totalR.rows[0].c,
                channels: CHANNELS,
                records: r.rows
            });
        } catch (err) {
            console.error('[ChannelRepairLog] GET error:', err.message);
            return res.status(500).json({ success: false, error: 'Failed to load repair log' });
        }
    });

    // POST /api/channel-repair-log — authenticated write.
    router.post('/', express.json({ limit: BODY_LIMIT }), async (req, res) => {
        const body = req.body || {};
        const auth = authenticate(devices, body);
        if (!auth.ok) {
            return res.status(auth.status).json({ success: false, error: auth.error });
        }

        const { channel_type, entity_refs, kind, title, detail, status, occurred_at, source } = body;

        if (!channel_type || !VALID_CHANNELS.has(channel_type)) {
            return res.status(400).json({ success: false, error: 'Invalid channel_type' });
        }
        if (!kind || !VALID_KINDS.has(kind)) {
            return res.status(400).json({ success: false, error: 'Invalid kind (fix|guideline|risk|todo)' });
        }
        if (!title || typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({ success: false, error: 'Missing title' });
        }
        if (status !== undefined && status !== null && status !== '' && !VALID_STATUS.has(status)) {
            return res.status(400).json({ success: false, error: 'Invalid status' });
        }
        if (looksLikeSecret(title, detail, entity_refs)) {
            return res.status(400).json({ success: false, error: 'Record looks like it contains a secret — rejected' });
        }

        let occurredTs = Date.now();
        if (occurred_at !== undefined && occurred_at !== null && occurred_at !== '') {
            occurredTs = Date.parse(occurred_at);
            if (!Number.isFinite(occurredTs)) {
                return res.status(400).json({ success: false, error: 'Invalid occurred_at — expected ISO8601' });
            }
            if (occurredTs > Date.now() + FUTURE_SKEW_TOLERANCE_MS) {
                return res.status(400).json({ success: false, error: 'occurred_at is in the future' });
            }
        }

        const src = (typeof source === 'string' && source) ? source.slice(0, 32) : 'manual';
        const eRefs = (typeof entity_refs === 'string' && entity_refs) ? entity_refs.slice(0, 128) : null;
        const det = (typeof detail === 'string' && detail) ? detail.slice(0, 8000) : null;
        const st = (status && VALID_STATUS.has(status)) ? status : null;

        try {
            const r = await pool.query(
                `INSERT INTO channel_repair_log
                   (channel_type, entity_refs, kind, title, detail, status, occurred_at, source)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 RETURNING id`,
                [channel_type, eRefs, kind, title.slice(0, 300), det, st, new Date(occurredTs).toISOString(), src]
            );
            console.log(`[ChannelRepairLog] record added: ${channel_type}/${kind} (id=${r.rows[0].id})`);
            return res.json({ success: true, id: r.rows[0].id });
        } catch (err) {
            console.error('[ChannelRepairLog] POST error:', err.message);
            return res.status(500).json({ success: false, error: 'Failed to save record' });
        }
    });

    return {
        router,
        _internal: { ensureSchema, authenticate, looksLikeSecret, CHANNELS, VALID_CHANNELS, VALID_KINDS, pool }
    };
};
