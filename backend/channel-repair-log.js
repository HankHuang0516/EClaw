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

// Channel type -> user-facing label + summary (single source of truth for the UI).
// This is a PUBLIC page: every channel is described by what it does for the user,
// never by internal entity numbers, hostnames, or container/runtime names.
const CHANNELS = [
    { channel_type: 'openclaw-channel-eclaw',    label: 'OpenClaw Channel',    summary: 'Self-hosted OpenClaw bots connected to EClaw' },
    { channel_type: 'claude-code-eclaw-channel', label: 'Claude Code Channel', summary: 'A Claude Code session acting as an EClaw bot' },
    { channel_type: 'hermes-eclaw-channel',      label: 'Hermes Channel',      summary: 'Hermes-engine bots connected to EClaw' },
    { channel_type: 'codex-eclaw-bridge',        label: 'Codex Bridge',        summary: 'An OpenAI Codex CLI session connected to EClaw' }
];
const VALID_CHANNELS = new Set(CHANNELS.map(c => c.channel_type));
const VALID_KINDS = new Set(['fix', 'guideline', 'risk', 'todo']);
const VALID_STATUS = new Set(['open', 'mitigated', 'resolved', 'blocked', 'info']);
// PR links are shown to users — only accept a plain GitHub URL (no quotes/spaces,
// so it is safe to drop straight into an href).
const PR_URL_RE = /^https:\/\/github\.com\/[\w.#/-]+$/i;

// Reject anything that looks like a credential leaking into a public record.
// findSecret() (shared OODA-R detector) covers hex-32 / Bearer / JWT / RAILWAY /
// password / sk-; these extra patterns cover generic token / api-key / eck_ keys
// that it intentionally does not match.
const EXTRA_SECRET_PATTERNS = [/\bapi[\s_-]?key\b/i, /\btoken\b/i, /eck_[a-z0-9]/i, /-----BEGIN/i];
function looksLikeSecret(...vals) {
    return vals.some(v => typeof v === 'string' &&
        (findSecret(v) !== null || EXTRA_SECRET_PATTERNS.some(re => re.test(v))));
}

// Bump when SEED_RECORDS content changes so deployed instances replace the old
// curated rows (source='seed') in place, without touching monitor/manual rows.
const SEED_VERSION = 2;

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
                pr_url       TEXT        NULL,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        // Migrate tables created before pr_url existed.
        await pool.query(`ALTER TABLE channel_repair_log ADD COLUMN IF NOT EXISTS pr_url TEXT`);
        await pool.query(`CREATE INDEX IF NOT EXISTS channel_repair_log_chan_time_idx
            ON channel_repair_log (channel_type, occurred_at DESC)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS channel_repair_log_meta (
            k TEXT PRIMARY KEY, v TEXT
        )`);
        await reconcileSeed();
        console.log('[ChannelRepairLog] channel_repair_log schema ready');
    } catch (err) {
        console.error('[ChannelRepairLog] ensureSchema failed:', err.message);
    }
}

// Curated records, written for end users — plain language, no internal codenames
// or secrets. Each describes a reliability change and how it affects the user.
const SEED_RECORDS = [
    {
        channel_type: 'openclaw-channel-eclaw', kind: 'guideline',
        title: 'Clearer notice when the AI provider is rate-limited',
        detail: 'When the AI model behind this channel hits a temporary usage limit, the bot now replies with a clear "temporarily rate-limited — try again shortly" message instead of going quiet, so you know it is busy rather than broken.',
        status: 'info', occurred_at: '2026-06-08T05:33:00Z'
    },
    {
        channel_type: 'openclaw-channel-eclaw', kind: 'todo',
        title: 'Planned: automatic fallback to a backup model',
        detail: 'When the primary AI model is temporarily unavailable, the bot will automatically switch to a backup model so it keeps responding instead of pausing until the primary model recovers.',
        status: 'open', occurred_at: '2026-06-08T05:37:00Z'
    },
    {
        channel_type: 'openclaw-channel-eclaw', kind: 'guideline',
        title: 'Your messages are never dropped during model hiccups',
        detail: 'Messages you send are always received and queued, even while the AI model is briefly unavailable. The bot catches up and replies as soon as it recovers.',
        status: 'info', occurred_at: '2026-06-08T05:34:00Z'
    },
    {
        channel_type: 'claude-code-eclaw-channel', kind: 'fix',
        title: 'Fixed the bot appearing stuck while background work ran',
        detail: 'Previously the assistant could look "busy" and stop replying while long background jobs were running. It now stays responsive and answers your messages normally.',
        status: 'resolved', occurred_at: '2026-05-11T06:00:00Z'
    },
    {
        channel_type: 'claude-code-eclaw-channel', kind: 'fix',
        title: 'Fixed an approval dialog that could freeze the assistant',
        detail: 'An internal permission prompt could leave the assistant waiting indefinitely. It now cancels cleanly and carries on, so the bot no longer goes silent after such a prompt.',
        status: 'resolved', occurred_at: '2026-05-23T18:26:00Z',
        pr_url: 'https://github.com/HankHuang0516/claude-code-eclaw-channel/pull/9'
    },
    {
        channel_type: 'claude-code-eclaw-channel', kind: 'guideline',
        title: 'Automatic recovery after long maintenance pauses',
        detail: 'After a lengthy internal maintenance pause the channel now restarts cleanly on its own, so the bot resumes replying without manual intervention.',
        status: 'info', occurred_at: '2026-05-09T03:59:00Z'
    },
    {
        channel_type: 'hermes-eclaw-channel', kind: 'guideline',
        title: 'Reliable delivery under heavy load',
        detail: 'This channel uses a message queue with automatic recovery, so messages are delivered in order and are not dropped during busy periods.',
        status: 'info', occurred_at: '2026-05-21T00:00:00Z'
    },
    {
        channel_type: 'codex-eclaw-bridge', kind: 'fix',
        title: 'Automatic reconnection for the Codex connection',
        detail: 'If the connection to Codex stalls, the bridge now restarts it automatically so replies resume on their own, with no manual steps needed.',
        status: 'resolved', occurred_at: '2026-06-08T05:27:00Z'
    }
];

// Replace the curated seed rows in place when SEED_VERSION changes. Only rows we
// authored (source='seed') are touched — monitor/manual records are preserved.
async function reconcileSeed() {
    const meta = await pool.query(`SELECT v FROM channel_repair_log_meta WHERE k = 'seed_version'`);
    const current = meta.rows[0] ? parseInt(meta.rows[0].v, 10) : 0;
    if (current === SEED_VERSION) return;
    await pool.query(`DELETE FROM channel_repair_log WHERE source = 'seed'`);
    for (const rec of SEED_RECORDS) {
        await pool.query(
            `INSERT INTO channel_repair_log
               (channel_type, entity_refs, kind, title, detail, status, occurred_at, source, pr_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'seed',$8)`,
            [rec.channel_type, rec.entity_refs ?? null, rec.kind, rec.title, rec.detail,
             rec.status, rec.occurred_at, rec.pr_url ?? null]
        );
    }
    await pool.query(
        `INSERT INTO channel_repair_log_meta (k, v) VALUES ('seed_version', $1)
         ON CONFLICT (k) DO UPDATE SET v = $1`,
        [String(SEED_VERSION)]
    );
    console.log(`[ChannelRepairLog] reseeded ${SEED_RECORDS.length} records (seed v${SEED_VERSION})`);
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
                `SELECT id, channel_type, entity_refs, kind, title, detail, status, occurred_at, source, pr_url
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

        const { channel_type, entity_refs, kind, title, detail, status, occurred_at, source, pr_url } = body;

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
        if (pr_url !== undefined && pr_url !== null && pr_url !== '' && !PR_URL_RE.test(pr_url)) {
            return res.status(400).json({ success: false, error: 'pr_url must be a https://github.com/... URL' });
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
        const prUrl = (typeof pr_url === 'string' && PR_URL_RE.test(pr_url)) ? pr_url.slice(0, 300) : null;

        try {
            const r = await pool.query(
                `INSERT INTO channel_repair_log
                   (channel_type, entity_refs, kind, title, detail, status, occurred_at, source, pr_url)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 RETURNING id`,
                [channel_type, eRefs, kind, title.slice(0, 300), det, st, new Date(occurredTs).toISOString(), src, prUrl]
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
        _internal: { ensureSchema, authenticate, looksLikeSecret, PR_URL_RE, CHANNELS, VALID_CHANNELS, VALID_KINDS, pool }
    };
};
