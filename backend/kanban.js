/**
 * Mission Center v2 — Kanban Board API
 *
 * Mounted at: /api/mission  (alongside existing mission.js routes)
 *
 * Cards CRUD:
 *   POST   /card          — Create card
 *   GET    /cards          — List cards (filter by status, archived)
 *   GET    /card/:id       — Get card detail (with comments, notes, files)
 *   PUT    /card/:id       — Update card fields
 *   DELETE /card/:id       — Archive card
 *
 * Status transition:
 *   POST   /card/:id/move  — Move card to new status + reassign
 *   POST   /card/:id/reopen — Explicitly reopen Done card with reason + audit
 *
 * Comments (留言板):
 *   GET    /card/:id/comments
 *   POST   /card/:id/comment
 *
 * Notes (筆記區):
 *   GET    /card/:id/notes
 *   POST   /card/:id/note
 *
 * Files (檔案區):
 *   POST   /card/:id/file       (URL-based, not multipart for now)
 *   GET    /card/:id/files
 *
 * Config:
 *   PUT    /card/:id/config     — Update staleThresholdMs / doneRetentionMs
 *
 * Archived:
 *   GET    /cards/archived      — List archived cards (paginated)
 */

const express = require('express');
const { Pool } = require('pg');
const _crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const safeEqual = require('./safe-equal');
const extractCreds = require('./extract-creds');
const { newCardId } = require('./entity-id');
const { tKanban, statusLabel } = require('./i18n/kanban-notifications');
const devicePrefs = require('./device-preferences');
const { emit: emitKanbanEvent } = require('./lib/kanban-events');
const { resolveEntityHostDevice } = require('./lib/per-device-cron');
const mentionParser = require('./mention-parser');

// Cache device→language to avoid repeated lookups
const deviceLangCache = new Map();
const DEVICE_LANG_TTL_MS = 60_000;
// 'zh' holds the Traditional Chinese dict; normalize BCP-47 Traditional aliases on read so
// rows that ended up as zh-TW / zh-Hant / zh-HK still resolve to the Traditional templates.
const KANBAN_ZH_TRADITIONAL_ALIASES = new Set(['zh-TW', 'zh-Hant', 'zh-HK', 'zh-Hant-TW', 'zh-Hant-HK']);
function normalizeKanbanLang(raw) {
    if (KANBAN_ZH_TRADITIONAL_ALIASES.has(raw)) return 'zh';
    return raw || 'en';
}
async function getDeviceLanguage(deviceId) {
    const cached = deviceLangCache.get(deviceId);
    if (cached && cached.expires > Date.now()) return cached.lang;
    try {
        const result = await pool.query(
            'SELECT language FROM user_accounts WHERE device_id = $1 LIMIT 1',
            [deviceId]
        );
        const lang = normalizeKanbanLang(result.rows[0]?.language);
        deviceLangCache.set(deviceId, { lang, expires: Date.now() + DEVICE_LANG_TTL_MS });
        return lang;
    } catch (err) {
        console.warn('[Kanban] getDeviceLanguage failed for', deviceId, ':', err.message);
        return 'en';
    }
}
let CronExpressionParser;
try {
    ({ CronExpressionParser } = require('cron-parser'));
} catch (e) {
    console.warn('[Kanban] cron-parser not available — schedule features disabled');
    CronExpressionParser = null;
}


const SCHEDULE_LATE_FIRE_GRACE_MS = 5 * 60 * 1000;
const SCHEDULE_STALE_EPSILON_MS = 1000;

// Per-card usage-threshold cron skip (card_c2635849, parent card_ad507345).
// Recurring schedules can skip child-card dispatch when ANY assigned entity's
// rolling 5h / 7d usage% strictly exceeds the configured cap. Defaults match
// the standard "quota almost full" markers on the dashboard widget so cards
// created before this column gain a sensible guard automatically.
const SCHEDULE_USAGE_THRESHOLD_MIN = 50;
const SCHEDULE_USAGE_THRESHOLD_MAX = 99;
const DEFAULT_SKIP_5H_PCT = 85;
const DEFAULT_SKIP_7D_PCT = 95;

function clampUsageThreshold(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.trunc(n);
    if (i < SCHEDULE_USAGE_THRESHOLD_MIN || i > SCHEDULE_USAGE_THRESHOLD_MAX) return fallback;
    return i;
}

function isValidUsageThreshold(value) {
    // Returns true iff value is a JS number integer in [50, 99]. Used at the
    // API write boundary so bad input rejects HTTP 400 rather than silently
    // clamping. Strings (even numeric-looking ones like "85"), booleans,
    // decimals, NaN, Infinity all reject — clients must send actual integers
    // so a typo in JSON isn't normalized to a working request.
    if (typeof value !== 'number') return false;
    if (!Number.isFinite(value)) return false;
    if (!Number.isInteger(value)) return false;
    return value >= SCHEDULE_USAGE_THRESHOLD_MIN && value <= SCHEDULE_USAGE_THRESHOLD_MAX;
}

/**
 * Pull the highest "currently used%" signal out of a usage_snapshots row for
 * one engine + window. The Claude statusLine hook writes the nested shape
 * `live.rate_limits.{five_hour,seven_day}.used_percentage`, but earlier
 * callers also produced flat `live.five_hour_pct` (see usage-api.js
 * `pickClaudeLivePct`). Codex daemon writes the flat shape under
 * `rate_limits.{five_hour_pct, seven_day_pct}`. Returns null if no signal
 * is present (caller treats null as 0% to preserve dispatch).
 */
function readClaudeLivePct(claudeJson, key) {
    const live = (claudeJson && claudeJson.live) || null;
    if (!live) return null;
    const flatKey = key + '_pct';
    if (typeof live[flatKey] === 'number') return live[flatKey];
    const nested = live.rate_limits && live.rate_limits[key];
    if (nested && typeof nested.used_percentage === 'number') return nested.used_percentage;
    return null;
}

function readCodexLivePct(codexJson, key) {
    const rl = (codexJson && codexJson.rate_limits) || null;
    if (!rl) return null;
    const flatKey = key + '_pct';
    if (typeof rl[flatKey] === 'number') return rl[flatKey];
    return null;
}

/**
 * Look up the latest usage snapshot for a (deviceId, entityId) pair and
 * extract the 5h / 7d usage% across both Claude + Codex engines. Returns
 * { five: number|null, seven: number|null } where each is the MAX of the
 * two engines' current %, or null if nothing is recorded for that window.
 *
 * The query prefers the entity-scoped row (entity_id = $2) when present,
 * but falls back to the device-scoped row (entity_id IS NULL) because the
 * mac-daemon historically pushed unscoped rows before per-entity routing
 * landed. This keeps the guard working on legacy devices without forcing
 * a daemon upgrade.
 */
async function getEntityUsagePct(deviceId, entityId) {
    if (!deviceId) return { five: null, seven: null };
    try {
        const eid = Number(entityId);
        const useEid = Number.isFinite(eid);
        const sql = useEid
            ? `SELECT claude_json, codex_json
                 FROM usage_snapshots
                 WHERE device_id = $1 AND (entity_id = $2 OR entity_id IS NULL)
                 ORDER BY (entity_id = $2) DESC, captured_at DESC
                 LIMIT 1`
            : `SELECT claude_json, codex_json
                 FROM usage_snapshots
                 WHERE device_id = $1
                 ORDER BY captured_at DESC
                 LIMIT 1`;
        const params = useEid ? [deviceId, eid] : [deviceId];
        const r = await pool.query(sql, params);
        if (!r.rows.length) return { five: null, seven: null };
        const row = r.rows[0];
        const claudeJson = row.claude_json || null;
        const codexJson = row.codex_json || null;
        const claude5 = readClaudeLivePct(claudeJson, 'five_hour');
        const codex5 = readCodexLivePct(codexJson, 'five_hour');
        const claude7 = readClaudeLivePct(claudeJson, 'seven_day');
        const codex7 = readCodexLivePct(codexJson, 'seven_day');
        // Take the worst-case (max) across engines so a saturated Claude
        // session still trips the guard even when Codex is idle.
        const maxOrNull = (a, b) => {
            if (a == null && b == null) return null;
            if (a == null) return b;
            if (b == null) return a;
            return a > b ? a : b;
        };
        return { five: maxOrNull(claude5, codex5), seven: maxOrNull(claude7, codex7) };
    } catch (err) {
        // Don't block dispatch on infra failures — preserve current behavior
        // (Mac daemon down, table missing on staging, etc.).
        console.warn('[Kanban] getEntityUsagePct failed:', err.message);
        return { five: null, seven: null };
    }
}

/**
 * Decide whether a recurring schedule fire should be skipped due to any
 * assigned entity exceeding the per-card usage threshold. Returns
 *   { skip: boolean, reason?: string, entityId?: number, window?: '5h'|'7d',
 *     pct?: number, limit?: number }
 * where `skip=true` carries the first offending entity for log/comment text.
 *
 * Null usage% is treated as 0% (do NOT skip) so the guard never blocks a
 * card whose entity simply doesn't have a daemon push yet — preserves the
 * pre-card_c2635849 dispatch behavior.
 */
async function evaluateUsageSkipDecision(card, bots, usageLookup) {
    const limit5 = clampUsageThreshold(card.schedule_skip_if_5h_pct_over, DEFAULT_SKIP_5H_PCT);
    const limit7 = clampUsageThreshold(card.schedule_skip_if_7d_pct_over, DEFAULT_SKIP_7D_PCT);
    const ids = Array.isArray(bots) ? bots : [];
    // Injectable usage lookup so tests can avoid hitting the real DB; in prod
    // calls into the entity-scoped usage_snapshots query.
    const lookup = typeof usageLookup === 'function' ? usageLookup : getEntityUsagePct;
    for (const botId of ids) {
        const usage = await lookup(card.device_id, botId);
        if (usage && usage.five != null && usage.five > limit5) {
            return { skip: true, entityId: botId, window: '5h', pct: usage.five, limit: limit5 };
        }
        if (usage && usage.seven != null && usage.seven > limit7) {
            return { skip: true, entityId: botId, window: '7d', pct: usage.seven, limit: limit7 };
        }
    }
    return { skip: false };
}

function asValidDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function computeCronNextRun(cronExpression, timezone, currentDate = new Date()) {
    try {
        if (!CronExpressionParser || !cronExpression) return null;
        const expr = CronExpressionParser.parse(cronExpression, {
            tz: timezone || 'Asia/Taipei',
            currentDate,
        });
        return expr.next().toDate();
    } catch (e) {
        console.warn('[Kanban] Invalid cron expression:', cronExpression, e.message);
        return null;
    }
}

function computeCronPreviousRun(cronExpression, timezone, currentDate = new Date()) {
    try {
        if (!CronExpressionParser || !cronExpression) return null;
        const expr = CronExpressionParser.parse(cronExpression, {
            tz: timezone || 'Asia/Taipei',
            currentDate,
        });
        return expr.prev().toDate();
    } catch (e) {
        console.warn('[Kanban] Invalid cron expression:', cronExpression, e.message);
        return null;
    }
}

function getRecurringScheduleFireDecision(card, now = new Date(), graceMs = SCHEDULE_LATE_FIRE_GRACE_MS) {
    const timezone = card.schedule_timezone || 'Asia/Taipei';
    const cronExpression = card.schedule_cron;
    const scheduledFor = asValidDate(card.schedule_next_run_at);
    const nextRun = computeCronNextRun(cronExpression, timezone, now);
    const previousRun = computeCronPreviousRun(cronExpression, timezone, now);

    if (!scheduledFor) {
        return {
            shouldFire: false,
            realignTo: nextRun,
            reason: 'invalid_next_run_at',
        };
    }

    if (scheduledFor.getTime() > now.getTime()) {
        return {
            shouldFire: false,
            realignTo: scheduledFor,
            reason: 'not_due',
        };
    }

    // If the stored next_run_at is from an older cron slot, do not replay it.
    // Replaying old slots collapses intentionally-staggered automations into a
    // single notification burst after a scheduler outage/restart.
    if (previousRun && scheduledFor.getTime() < previousRun.getTime() - SCHEDULE_STALE_EPSILON_MS) {
        return {
            shouldFire: false,
            realignTo: nextRun,
            reason: 'stale_missed_slot',
            previousRun,
        };
    }

    // Fire only the current cron slot within a small late window. This preserves
    // legitimate worker lag (e.g. 12:00 firing at 12:02) while preventing a 10:05
    // stale slot from firing at 12:02, before the intended 12:05 run.
    if (now.getTime() - scheduledFor.getTime() > graceMs) {
        return {
            shouldFire: false,
            realignTo: nextRun,
            reason: 'missed_grace_window',
            previousRun,
        };
    }

    return {
        shouldFire: true,
        realignTo: null,
        reason: 'due',
        previousRun,
    };
}

/**
 * Decide whether a due schedule should be AUTO-DISABLED instead of fired.
 * Returns 'archived' | 'done' | null (null = fire normally).
 *
 * Owner-reported re-nudge loop: when the owner archives or marks DONE a
 * scheduled card (especially a cron母卡), schedule_enabled stays true and
 * schedule_next_run_at stays in the past. The card then looks "due" on every
 * tick forever — the server keeps re-spawning child cards and any consumer
 * (UI badge, an external cron watcher that binds a static card-id snapshot)
 * keeps treating it as pending and re-nudges. Disabling the schedule the first
 * time the scheduler sees the card inactive breaks the loop at the source.
 *
 * `done` only stops AUTOMATION母卡 (is_automation) and one-shot (`once`) cards.
 * A normal self-recurring card legitimately cycles done→todo on each fire
 * (see the recurring branch below), so a plain `done` must NOT disable those.
 */
function scheduleAutoDisableReason(card) {
    if (!card) return null;
    if (card.archived === true) return 'archived';
    if (card.status === 'done' && (card.is_automation === true || card.schedule_type === 'once')) {
        return 'done';
    }
    return null;
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

// R2 client (shared config with files.js) — used to regenerate fresh signed URLs
// for card attachments on every read, so UI never shows an expired link.
const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
});
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'eclaw-files';
// 3 days. Files re-sign on every /card/:id/files GET (mapCardFileRow), but the
// rendered <img src> in the user's browser stays fixed at the URL it received,
// so the lifetime of a card screenshot in an opened tab is bounded by this TTL.
// 10 min was too short — Hank reported screenshots vanishing after ~10 min on
// done cards. R2 / SigV4 max is 7 days; 3 days is well inside that.
const R2_URL_TTL_SECONDS = 3 * 24 * 60 * 60;

async function signCardFileUrl(fileId, deviceId, filename) {
    const result = await pool.query(
        'SELECT r2_key, filename, mime_type FROM r2_files WHERE file_id = $1 AND device_id = $2 AND expires_at > NOW()',
        [fileId, deviceId]
    );
    if (!result.rows.length) return null;
    const row = result.rows[0];
    const cmdParams = { Bucket: R2_BUCKET, Key: row.r2_key };
    if (filename) {
        cmdParams.ResponseContentDisposition = `inline; filename="${encodeURIComponent(row.filename)}"`;
    }
    return await getSignedUrl(r2, new GetObjectCommand(cmdParams), { expiresIn: R2_URL_TTL_SECONDS });
}

async function mapCardFileRow(r) {
    let url = r.url;
    if (r.file_id) {
        try {
            const fresh = await signCardFileUrl(r.file_id, r.device_id, r.filename);
            if (fresh) url = fresh;
        } catch (err) {
            console.warn('[Kanban] signCardFileUrl failed, falling back to stored url:', err.message);
        }
    }
    return {
        id: r.id,
        fileId: r.file_id || null,
        filename: r.filename,
        url,
        mimeType: r.mime_type,
        fileSize: r.file_size ? parseInt(r.file_size) : null,
        uploadedBy: r.uploaded_by,
        createdAt: new Date(r.created_at).getTime(),
    };
}

// Valid statuses + labels — imported from public/shared/kanban-status.js so
// server, kanban UI, settings UI, chat smart-chip, and nudge all share one enum.
const KanbanStatus = require('./public/shared/kanban-status.js');
// OODA-R Phase 4 #9: public roadmap tracker manifest + payload builder.
const { ROADMAP_ITEMS, buildTrackerPayload } = require('./agent-improvement/roadmap-manifest.js');
const STATUSES = KanbanStatus.STATUSES;
const STATUS_LABELS = KanbanStatus.STATUS_LABELS_EN;
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const PRIORITY_COLORS = { P0: '🔴', P1: '🟠', P2: '🔵', P3: '⚪' };
// Supervisors can reopen false-Done cards via the explicit /reopen endpoint.
// This is intentionally narrow and separate from assignedBots: collaborators
// should ask a supervisor/reviewer/creator to reopen rather than drag Done cards.
const REOPEN_SUPERVISOR_ENTITY_IDS = new Set([1, 2]);

// Self-improvement (OODA-R) section auto-appended on every parent card created
// via POST /card. Per Hank 2026-06-12 audit: every parent kanban automation card
// must carry a retro slot so the loop closes. Skipped when description already
// contains "Self-improvement" (idempotent + lets callers opt to write their own).
const SI_TEMPLATE_SECTION = `

## Self-improvement (OODA-R)
- **Episode trigger**: <event that writes an episode — usually move-to-done or done-evidence>
- **Pain taxonomy axis**: <axis from pain taxonomy / episode schema>
- **Feedback ingest**: <signal flowing back into this card — cron output / child retro / chat upvote/downvote / kanban refire>
- **Done-retro slot**: <one question to answer at close-out — "what guard/gate/template change would prevent recurrence?">
- **Rule promotion candidate**: <if learning generalizes, name the meta-PR / lint rule / template diff>
`;

// ── Schema init ──
async function initKanbanDatabase() {
    try {
        const schemaPath = path.join(__dirname, 'kanban_schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        // Remove SQL comments before splitting (-- line comments and block separators)
        const cleaned = schema.replace(/--[^\n]*/g, '').replace(/\n\s*\n/g, '\n');
        const statements = cleaned
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 5);
        console.log(`[Kanban] Schema init: ${statements.length} statements to execute`);
        let ok = 0, skipped = 0, failed = 0;
        for (let i = 0; i < statements.length; i++) {
            const stmt = statements[i];
            const preview = stmt.split('\n')[0].trim().substring(0, 60);
            try {
                await pool.query(stmt);
                ok++;
                console.log(`[Kanban] Schema [${i+1}/${statements.length}] OK: ${preview}`);
            } catch (err) {
                if (err.message.includes('already exists') || err.message.includes('duplicate key')) {
                    skipped++;
                } else {
                    failed++;
                    console.error(`[Kanban] Schema [${i+1}/${statements.length}] FAILED: ${preview}`);
                    console.error(`[Kanban]   Error: ${err.message}`);
                }
            }
        }
        console.log(`[Kanban] Database initialized: ${ok} OK, ${skipped} skipped (already exist), ${failed} failed`);
    } catch (error) {
        console.error('[Kanban] Failed to init database:', error);
    }
}

/**
 * Factory: receives in-memory devices object from index.js
 */
function createKanbanModule(devices, { awardEntityXP, serverLog, pushToEntity, pushToChannelCallback, saveChatMessage, getMissionApiHints, pushToBot, orgChart, notifyDevice, emitDevicePreferences, createActionRequest, dismissActionRequestsForCard } = {}) {
    const router = express.Router();

    // Health check
    router.get("/kanban-health", (req, res) => res.json({ ok: true, module: "kanban", cron: !!CronExpressionParser }));

    // ─────────────────────────────────────────────────────────────────────────
    // Per-entity nudge preference overrides — spec docs/specs/kanban-nudge-spec.md §6
    //
    //   GET  /api/mission/nudge-prefs?deviceId&{botSecret|deviceSecret}[&entityId=N]
    //     → returns {prefs, defaults, effective, overrideKeys}
    //       - prefs:      raw device-level prefs (includes kanban_nudge_per_entity_overrides)
    //       - effective:  merged prefs for `entityId` (or device base if omitted)
    //       - overrideKeys: which keys may be overridden per-entity
    //
    //   PUT  /api/mission/nudge-prefs  body {deviceId, {botSecret|deviceSecret}, entityId, overrides}
    //     → upserts `kanban_nudge_per_entity_overrides[entityId] = overrides`.
    //       Passing null / empty object removes the entity entry.
    // ─────────────────────────────────────────────────────────────────────────
    router.get('/nudge-prefs', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, entityId } = { ...req.query, ...req.body };
        try {
            const prefs = await devicePrefs.getPrefs(deviceId);
            const effective = entityId != null
                ? devicePrefs.mergeEntityOverride(prefs, Number(entityId))
                : prefs;
            res.json({
                success: true,
                prefs,
                defaults: devicePrefs.DEFAULTS,
                effective,
                overrideKeys: devicePrefs.NUDGE_ENTITY_OVERRIDE_KEYS,
            });
        } catch (err) {
            console.error('[Kanban] GET /nudge-prefs error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.put('/nudge-prefs', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, entityId, overrides } = { ...req.query, ...req.body };
        if (entityId == null || !Number.isFinite(Number(entityId))) {
            return res.status(400).json({ success: false, error: 'entityId required' });
        }
        try {
            const current = await devicePrefs.getPrefs(deviceId);
            const map = { ...(current.kanban_nudge_per_entity_overrides || {}) };
            const key = String(Number(entityId));
            const isEmpty = !overrides
                || (typeof overrides === 'object' && !Array.isArray(overrides) && Object.keys(overrides).length === 0);
            if (isEmpty) {
                delete map[key];
            } else if (typeof overrides === 'object' && !Array.isArray(overrides)) {
                map[key] = overrides;
            } else {
                return res.status(400).json({ success: false, error: 'overrides must be an object or null' });
            }
            await devicePrefs.updatePrefs(deviceId, { kanban_nudge_per_entity_overrides: map });
            const updated = await devicePrefs.getPrefs(deviceId);
            const effective = devicePrefs.mergeEntityOverride(updated, Number(entityId));
            if (typeof emitDevicePreferences === 'function') {
                emitDevicePreferences(deviceId, updated);
            }
            res.json({ success: true, prefs: updated, effective });
        } catch (err) {
            console.error('[Kanban] PUT /nudge-prefs error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ── Auth helpers (same as mission.js) ──
    function findEntityByCredentials(deviceId, entityId, botSecret) {
        const device = devices[deviceId];
        if (!device) return null;
        const entity = (device.entities || {})[entityId];
        if (entity && safeEqual(entity.botSecret, botSecret)) return entity;
        // Fallback: entityId missing/0/mismatched, but botSecret is per-entity
        // unique — authenticate as the entity that actually owns this secret.
        // Fixes "[Kanban] Auth failed: { entityId: undefined }" for callers that
        // send a valid botSecret without populating entityId. botSecret stays the
        // source of truth, so this grants access only to the secret's true owner
        // (no privilege escalation — you become whoever the secret belongs to).
        if (botSecret) {
            for (const e of Object.values(device.entities || {})) {
                if (e && safeEqual(e.botSecret, botSecret)) return e;
            }
        }
        return null;
    }

    function findDeviceByCredentials(deviceId, deviceSecret) {
        const device = devices[deviceId];
        if (!device || !safeEqual(device.deviceSecret, deviceSecret)) return null;
        return device;
    }

    function authenticate(req, res) {
        // Accepts secrets via query/body (legacy) OR X-Device-Secret /
        // X-Bot-Secret headers (secret-leakage hardening). Additive: query/body
        // still take precedence so existing callers are unaffected.
        const { deviceId, deviceSecret, botSecret, entityId } = extractCreds(req);

        if (!deviceId) {
            res.status(400).json({ success: false, error: 'Missing deviceId' });
            return false;
        }

        if (deviceSecret) {
            const device = findDeviceByCredentials(deviceId, deviceSecret);
            if (device) return true;
        }

        if (botSecret) {
            const entity = findEntityByCredentials(deviceId, parseInt(entityId || 0), botSecret);
            if (entity) return true;
        }

        if (!deviceSecret && !botSecret) {
            res.status(400).json({ success: false, error: 'Missing deviceSecret or botSecret' });
        } else {
            console.warn('[Kanban] Auth failed:', { deviceId, hasDeviceSecret: !!deviceSecret, hasBotSecret: !!botSecret, entityId });
            res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        return false;
    }

    // ── Helper: bump dashboard version (to trigger frontend refresh) ──
    async function bumpVersion(deviceId) {
        try {
            await pool.query(
                `UPDATE mission_dashboard SET updated_at = NOW() WHERE device_id = $1`,
                [deviceId]
            );
        } catch (e) {
            console.warn('[Kanban] Failed to bump version:', e.message);
        }
    }

    // ── Helper: add system comment to card ──
    // Bumps kanban_cards.updated_at so "Recently Updated" sort surfaces the card.
    async function addSystemComment(cardId, deviceId, text) {
        await pool.query(
            `INSERT INTO kanban_comments (card_id, device_id, from_entity_id, text, is_system)
             VALUES ($1, $2, -1, $3, true)`,
            [cardId, deviceId, text]
        );
        await pool.query(
            `UPDATE kanban_cards SET updated_at = NOW() WHERE id = $1 AND device_id = $2`,
            [cardId, deviceId]
        );
    }

    // ── Helper: push notification to entity via channel callback + save to chat ──
    async function notifyEntities(deviceId, entityIds, message, options = {}) {
        // perDeviceCron: when true (cron dispatch path), resolve which registered
        // device actually HOSTS each assigned entity and push there, instead of
        // assuming the card's own device hosts it. Default false keeps every other
        // caller (once-triggers, manual notifies) on the legacy local-only path.
        // See backend/lib/per-device-cron.js + card_1ce50de359411f0d0947399f.
        const { description, cardId, perDeviceCron = false } = options;
        if (!pushToChannelCallback && !pushToEntity && !pushToBot) {
            console.warn('[Kanban] No push callback available — notifications will not be delivered');
            return;
        }

        const API_BASE = 'https://eclawbot.com';
        const SOURCE_TAG = 'kanban_notify';

        // ── Latest-comment enrichment (card_cc20541e) ──
        // Assignment/@-mention notifications carry the most actionable context
        // when they include the latest留言. Prefer an explicitly-passed
        // latestComment (the @-mention path already has the text in hand); else,
        // when a cardId is given, fetch the newest non-system comment row so the
        // push always reflects the current discussion. Bounded to keep the push
        // payload sane. Best-effort: a failed fetch must never block the push.
        const LATEST_COMMENT_MAX = 1500;
        let latestComment = typeof options.latestComment === 'string' ? options.latestComment : null;
        if (!latestComment && cardId) {
            try {
                const c = await pool.query(
                    `SELECT text FROM kanban_comments
                      WHERE card_id = $1 AND is_system = false
                      ORDER BY created_at DESC
                      LIMIT 1`,
                    [cardId]
                );
                if (c.rows[0]?.text) latestComment = c.rows[0].text;
            } catch (e) {
                console.warn(`[Kanban] latest-comment fetch failed for card ${cardId}:`, e.message);
            }
        }
        if (latestComment && latestComment.length > LATEST_COMMENT_MAX) {
            latestComment = latestComment.slice(0, LATEST_COMMENT_MAX) + '…';
        }
        const commentBlock = latestComment
            ? `\n\n[LATEST COMMENT]\n${latestComment}\n[/LATEST COMMENT]`
            : '';

        for (const eid of entityIds) {
            try {
                // ── Per-device host resolution ──
                // Default: push to the card's own device (legacy single-device).
                // When perDeviceCron is on, redirect the push to the device that
                // actually hosts a reachable copy of this entity (matched by
                // stable publicCode). No host → log a clear reason and fall back
                // to the local binding (never a silent drop, never a hard fail).
                let pushDeviceId = deviceId;
                let pushEid = eid;
                if (perDeviceCron && devices) {
                    const hostDecision = resolveEntityHostDevice({ device_id: deviceId }, eid, devices);
                    if (hostDecision.shouldDispatch) {
                        if (hostDecision.resolution === 'cross_device') {
                            console.log(`[Kanban][per-device-cron] Entity ${eid} (publicCode=${hostDecision.publicCode}) hosted on device ${hostDecision.hostDeviceId} as entity ${hostDecision.hostEntityId} — redirecting cron dispatch there (card device ${deviceId})`);
                            pushDeviceId = hostDecision.hostDeviceId;
                            pushEid = hostDecision.hostEntityId;
                        }
                        // resolution === 'local' → no change, legacy path.
                    } else {
                        console.warn(`[Kanban][per-device-cron] No registered/active host device for entity ${eid} on card device ${deviceId} (reason=${hostDecision.reason}) — falling back to card-device local binding`);
                    }
                }

                const device = devices[pushDeviceId];
                const entity = device?.entities?.[pushEid];
                if (!entity) {
                    console.warn(`[Kanban] Entity ${pushEid} not found on device ${pushDeviceId}`);
                    continue;
                }

                // ── 1. Save to chat history (chat.html visibility) ──
                // If cardId is provided, attach { kind: 'kanban_ref', id } to the `card`
                // column so chat.html can render a clickable "view card" button that
                // opens the entity modal without the user navigating to the kanban page.
                let chatMsgId = null;
                if (saveChatMessage) {
                    try {
                        const cardRef = cardId ? { kind: 'kanban_ref', id: cardId } : null;
                        chatMsgId = await saveChatMessage(
                            deviceId, eid, message,
                            SOURCE_TAG,
                            false,  // is_from_user
                            false,  // is_from_bot (platform notification)
                            null, null,   // mediaType, mediaUrl
                            null, null,   // scheduleId, scheduleLabel
                            null, null,   // backupUrl, mentions
                            cardRef       // card
                        );
                        console.log(`[Kanban] Saved kanban notify to chat history: msgId=${chatMsgId} entity=${eid}`);
                    } catch (e) {
                        console.error(`[Kanban] Failed to save chat message for entity ${eid}:`, e.message);
                    }
                }

                // ── 2. Build standard Mission + Kanban API hints ──
                // Note: getMissionApiHints already embeds [AVAILABLE TOOLS — Kanban Board]
                // (read/move/comment/disable schedule/enable schedule), so we no longer
                // append a second Kanban Board block here.
                // Hints must carry the HOST device's credentials so the receiving
                // entity authenticates against the card via its own binding.
                const kanbanHints = getMissionApiHints
                    ? getMissionApiHints(API_BASE, pushDeviceId, pushEid, entity.botSecret)
                    : '';

                // ── 2b. Task-lifecycle directive (card_c0819f4e) ──
                // The hint block above is a passive TOOL LIST — it shows the
                // "Move card" curl but never tells the assigned agent that it is
                // OBLIGATED to advance this card's status when it starts/finishes.
                // A stateless agent (e.g. Hermes/#5) does the work, reports in
                // chat, and never moves the card → it sits in todo/in_progress and
                // re-nudges forever. This directive names the SPECIFIC card id and
                // states the obligation explicitly, so even an agent with no
                // persistent todo knows exactly which card to move and that a chat
                // reply does not close it. Wording is status-agnostic ("if
                // assigned to you and not yet finished") so it is correct for
                // nudges, assignments, reopens and reviewer asks alike.
                const lifecycleDirective = cardId
                    ? `\n\n[KANBAN LIFECYCLE — ACTION REQUIRED]\n` +
                      `This notification concerns card ${cardId}. If it is assigned to you and not yet finished:\n` +
                      `• when you START working, move it to in_progress\n` +
                      `• when you COMPLETE the work, move it to done (or review if it needs sign-off)\n` +
                      `Replying in chat does NOT change the card's status — you MUST call the "Move card" tool ` +
                      `below with CARD_ID=${cardId} and newStatus=in_progress|review|done. ` +
                      `A card left unmoved keeps re-nudging and auto-escalating.`
                    : '';

                // Hints + lifecycle directive travel together so the obligation
                // sits right next to the Move card command in every push path.
                const missionBlock = kanbanHints + lifecycleDirective;

                // ── 3. Build full message with description ──
                const descBlock = description
                    ? `\n\n[TASK DESCRIPTION]\n${description}\n[/TASK DESCRIPTION]`
                    : '';

                // ── 4. Push to bot (channel or webhook, with standard hints) ──
                if (entity.bindingType === 'channel' && pushToChannelCallback) {
                    const result = await pushToChannelCallback(pushDeviceId, pushEid, {
                        event: 'kanban_notification',
                        from: 'kanban',
                        text: message + descBlock + commentBlock,
                        eclaw_context: {
                            expectsReply: true,
                            silentToken: '[SILENT]',
                            missionHints: missionBlock,
                        }
                    }, entity.channelAccountId);
                    console.log(`[Kanban] Channel push to entity ${pushEid}@${pushDeviceId}: ${result.pushed ? 'OK' : result.reason}`);

                } else if (entity.webhook && pushToBot) {
                    // Non-channel: build full push message with standard hints (same as speak-to webhook path)
                    const pushMsg = [
                        `[KANBAN NOTIFICATION] ${message}`,
                        descBlock,
                        commentBlock,
                        `[NOTIFICATION — NO REPLY EXPECTED] This is a Kanban task notification. Take action on the card as needed.`,
                        missionBlock,
                    ].filter(Boolean).join('\n');

                    const pushResult = await pushToBot(entity, pushDeviceId, 'kanban_notification', { message: pushMsg });
                    console.log(`[Kanban] Webhook push to entity ${pushEid}@${pushDeviceId}: ${pushResult.pushed ? 'OK' : pushResult.reason}`);

                    // Mark delivered if push succeeded
                    if (pushResult.pushed && chatMsgId) {
                        // No markChatMessageDelivered reference here — just log
                        console.log(`[Kanban] Webhook delivered to entity ${pushEid}@${pushDeviceId}, chatMsgId=${chatMsgId}`);
                    }

                } else if (pushToEntity) {
                    // Legacy fallback
                    const pushMsg = `[KANBAN NOTIFICATION] ${message}${descBlock}${commentBlock}${missionBlock}`;
                    await pushToEntity(pushDeviceId, pushEid, pushMsg);
                    console.log(`[Kanban] Legacy push to entity ${pushEid}@${pushDeviceId}`);
                }

            } catch (e) {
                console.error(`[Kanban] Failed to push to entity ${eid}:`, e.message);
            }
        }
    }

    // ── @-mention resolution for card comments (card_cc20541e) ──
    // Reuse the platform's canonical mention parser (backend/mention-parser.js)
    // so card comments accept the exact same token forms as chat: @#N / @N
    // (same-device entityId), <@N>, @xxxxxx / <@xxxxxx> (6-char publicCode),
    // and same-device display names. The parser needs a publicCodeIndex to
    // resolve publicCode tokens; the kanban module is same-device only, so we
    // synthesize a minimal index from the card's own device bindings rather
    // than threading the global index through the factory. Returns an array of
    // same-device entityIds that were @-mentioned.
    function resolveCommentMentions(deviceId, text) {
        if (!text || typeof text !== 'string') return [];
        const device = devices[deviceId];
        const entities = device?.entities || {};
        // Per-device publicCode → { deviceId, entityId } so @xxxxxx resolves
        // without the global publicCodeIndex (cross-device mentions are out of
        // scope for kanban notifications — same device only).
        const localPublicCodeIndex = {};
        for (const [eidRaw, entity] of Object.entries(entities)) {
            if (entity?.isBound && entity?.publicCode) {
                localPublicCodeIndex[entity.publicCode] = { deviceId, entityId: parseInt(eidRaw, 10) };
            }
        }
        let parsed;
        try {
            parsed = mentionParser.parseMentions(text, {
                senderDeviceId: deviceId,
                devices,
                publicCodeIndex: localPublicCodeIndex,
            });
        } catch (e) {
            console.warn('[Kanban] mention parse failed:', e.message);
            return [];
        }
        const ids = new Set();
        for (const m of (parsed.mentions || [])) {
            // Same-device, bound entity only.
            if (m && !m.isCrossDevice && m.deviceId === deviceId && Number.isFinite(m.entityId)) {
                ids.add(Number(m.entityId));
            }
        }
        return [...ids];
    }

    // ── Smart-queue notify helpers (card_dfe3b8df Phase 2 + #2307 hotfix) ──
    // Replaces the deprecated kanban_cron_spawn_notify boolean gate. cron auto-spawn
    // notifies are routed per-bot: fire immediately if the bot has no pending notify
    // queued; else enqueue silently and drain one entry on each move-to-done.
    //
    // Original Phase 2 used "bot has active todo/in_progress cards" as the gate —
    // that buried EVERY new spawn for any bot with persistent work (the common
    // case for active developer bots), because the queue only drained on
    // move-to-done. The empty-queue gate preserves the rate-limit intent (one
    // fresh ping at a time per bot) without silencing first pings.
    async function botHasPendingNotify(deviceId, botId) {
        const r = await pool.query(
            `SELECT 1 FROM kanban_pending_notify
              WHERE device_id = $1 AND bot_entity_id = $2
              LIMIT 1`,
            [deviceId, Number(botId)]
        );
        return r.rows.length > 0;
    }

    // Lane backpressure — count active workload (todo/in_progress/review) for a
    // bot to decide whether an incoming cron-spawned notify should be downgraded
    // from immediate push to the smart queue. See spawnAutomationChild dispatch
    // block for the threshold and the Layer-1 jitter that pairs with this check.
    async function botActiveWorkload(deviceId, botId) {
        const r = await pool.query(
            `SELECT COUNT(*)::int AS n
               FROM kanban_cards
              WHERE device_id = $1
                AND assigned_bots @> $2::jsonb
                AND archived = false
                AND status IN ('todo','in_progress','review')`,
            [deviceId, JSON.stringify([Number(botId)])]
        );
        return r.rows[0]?.n || 0;
    }

    async function enqueuePendingNotify(deviceId, botId, cardId, message, payload) {
        await pool.query(
            `INSERT INTO kanban_pending_notify (device_id, bot_entity_id, card_id, msg, payload)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [deviceId, Number(botId), cardId, message, JSON.stringify(payload || {})]
        );
    }

    async function drainOnePendingNotify(deviceId, botId) {
        const r = await pool.query(
            `DELETE FROM kanban_pending_notify
              WHERE id = (
                  SELECT id FROM kanban_pending_notify
                   WHERE device_id = $1 AND bot_entity_id = $2
                   ORDER BY created_at ASC
                   LIMIT 1
                   FOR UPDATE SKIP LOCKED
              )
              RETURNING card_id, msg, payload`,
            [deviceId, Number(botId)]
        );
        if (r.rows.length === 0) return null;
        const row = r.rows[0];
        await notifyEntities(deviceId, [Number(botId)], row.msg, row.payload || {});
        return row;
    }

    // Debug: kanban-codex-nudge (#2273) — keep until user confirms Codex channel nudges are reliable.
    router.get('/debug/kanban-codex-nudge', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const cardId = req.query.cardId ? String(req.query.cardId) : null;
        const entityId = req.query.entityId !== undefined ? Number(req.query.entityId) : null;

        try {
            const prefs = await devicePrefs.getPrefs(deviceId).catch(() => ({}));
            const cardParams = [deviceId];
            let cardWhere = `device_id = $1 AND archived = false`;
            if (cardId) {
                cardParams.push(cardId);
                cardWhere += ` AND id = $${cardParams.length}`;
            } else {
                // Mirror checkStaleCards' candidate set so this diagnostic reflects
                // what actually gets nudged: backlog is parked → never stale-nudged.
                cardWhere += `
                  AND status IN ('todo', 'in_progress', 'review')
                  AND EXTRACT(EPOCH FROM (NOW() - status_changed_at)) * 1000 > stale_threshold_ms`;
            }
            const cardsRes = await pool.query(
                `SELECT id, title, status, priority, assigned_bots, stale_threshold_ms,
                        status_changed_at, last_stale_nudge_at
                   FROM kanban_cards
                  WHERE ${cardWhere}
                  ORDER BY updated_at DESC NULLS LAST
                  LIMIT 20`,
                cardParams
            );

            const device = devices[deviceId] || null;
            const entityRows = [];
            const ids = new Set();
            for (const card of cardsRes.rows) {
                for (const bid of (card.assigned_bots || [])) ids.add(Number(bid));
            }
            if (Number.isFinite(entityId)) ids.add(entityId);

            for (const id of ids) {
                const ent = device?.entities?.[id] || null;
                entityRows.push({
                    entityId: id,
                    exists: !!ent,
                    isBound: !!ent?.isBound,
                    bindingType: ent?.bindingType || null,
                    hasChannelAccountId: !!ent?.channelAccountId,
                    hasWebhook: !!ent?.webhook,
                    channelPushPossible: !!(ent && ent.bindingType === 'channel' && ent.channelAccountId && pushToChannelCallback),
                    codexBridgeWouldIgnoreOldPayload: true,
                    fixedPayloadExpectsReply: true,
                });
            }

            res.json({
                success: true,
                bug: 'kanban-codex-nudge',
                diagnostics: {
                    deviceInMemory: !!device,
                    hasPushToChannelCallback: !!pushToChannelCallback,
                    prefs: {
                        kanban_nudge_interval_minutes: prefs.kanban_nudge_interval_minutes || null,
                        kanban_nudge_batch_size: prefs.kanban_nudge_batch_size || null,
                        kanban_nudge_priority_mode: prefs.kanban_nudge_priority_mode || null,
                        kanban_nudge_per_entity_throttle: prefs.kanban_nudge_per_entity_throttle !== false,
                        kanban_nudge_statuses: prefs.kanban_nudge_statuses || KanbanStatus.NUDGE_DEFAULT_STATUSES,
                    },
                    cards: cardsRes.rows.map((card) => ({
                        id: card.id,
                        title: card.title,
                        status: card.status,
                        priority: card.priority,
                        assigned_bots: card.assigned_bots || [],
                        stale_threshold_ms: card.stale_threshold_ms,
                        status_changed_at: card.status_changed_at,
                        last_stale_nudge_at: card.last_stale_nudge_at,
                    })),
                    assignedEntities: entityRows,
                    expectedChannelPayload: {
                        event: 'kanban_notification',
                        from: 'kanban',
                        eclaw_context: {
                            expectsReply: true,
                            silentToken: '[SILENT]',
                            missionHints: 'present_when_getMissionApiHints_is_configured',
                        },
                    },
                },
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            console.error('[Kanban] debug kanban-codex-nudge error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ── Helper: compute next cron run time ──
    function computeNextRun(cronExpression, timezone, currentDate = new Date()) {
        return computeCronNextRun(cronExpression, timezone, currentDate);
    }

    // ── Helper: serialize card row to API response ──
    function serializeCard(row) {
        const card = {
            id: row.id,
            title: row.title,
            description: row.description || '',
            priority: row.priority,
            status: row.status,
            assignedBots: row.assigned_bots || [],
            createdBy: row.created_by,
            statusChangedAt: row.status_changed_at ? new Date(row.status_changed_at).getTime() : null,
            staleThresholdMs: parseInt(row.stale_threshold_ms) || 10800000,
            doneRetentionMs: parseInt(row.done_retention_ms) || 604800000,
            archived: row.archived || false,
            createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
            updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
            reviewerEntityId: row.reviewer_entity_id != null ? parseInt(row.reviewer_entity_id) : null,
            requiresScreenshotReview: row.requires_screenshot_review !== false,
            requiresPreflightReview: row.requires_preflight_review !== false,
            gated: !!row.gated,
            gateReason: row.gate_reason || null,
            reopenedAt: row.reopened_at ? new Date(row.reopened_at).getTime() : null,
            reopenedBy: row.reopened_by != null ? parseInt(row.reopened_by) : null,
            reopenReason: row.reopen_reason || null,
            requiresPrRework: !!row.requires_pr_rework,
            reworkPrNumber: row.rework_pr_number || null,
            linkedPrevCardId: row.linked_prev_card_id || null,
            linkedNextCardId: row.linked_next_card_id || null,
            // Aggregated counts (if present from JOIN)
            commentCount: parseInt(row.comment_count) || 0,
            noteCount: parseInt(row.note_count) || 0,
            fileCount: parseInt(row.file_count) || 0,
            tags: Array.isArray(row.tags) ? row.tags : [],
        };

        // Schedule fields — always present so hygiene audits can lock the schema
        // and detect cron-broken cards (enabled=true but nextRunAt stale). Cards
        // without a schedule get null; cards that have ever been scheduled get the
        // full object. Prior to 2026-05-28 this was conditional, which hid the
        // field from manual cards AND from any /cards call that didn't pass
        // ?automation=all (so cron-broken heuristics had nothing to evaluate).
        const hasSchedule = row.schedule_enabled || row.schedule_type || row.schedule_last_run_at;
        card.schedule = hasSchedule ? {
            enabled: !!row.schedule_enabled,
            type: row.schedule_type || null,
            cronExpression: row.schedule_cron || null,
            runAt: row.schedule_run_at ? new Date(row.schedule_run_at).getTime() : null,
            timezone: row.schedule_timezone || 'Asia/Taipei',
            lastRunAt: row.schedule_last_run_at ? new Date(row.schedule_last_run_at).getTime() : null,
            nextRunAt: row.schedule_next_run_at ? new Date(row.schedule_next_run_at).getTime() : null,
            // card_c2635849: per-card usage-quota cron skip thresholds.
            skipIf5hUsagePctOver: clampUsageThreshold(row.schedule_skip_if_5h_pct_over, DEFAULT_SKIP_5H_PCT),
            skipIf7dUsagePctOver: clampUsageThreshold(row.schedule_skip_if_7d_pct_over, DEFAULT_SKIP_7D_PCT),
        } : null;

        // Automation fields
        if (row.is_automation) card.isAutomation = true;
        if (row.parent_card_id) card.parentCardId = row.parent_card_id;
        if (row.is_auto_generated) card.isAutoGenerated = true;
        if (row.last_run_result) card.lastRunResult = row.last_run_result;
        if (row.active_child_id) card.activeChildId = row.active_child_id;

        // Idle dispatch fields
        card.dispatchMode = row.dispatch_mode || 'immediate';
        if (row.pending_dispatch) card.pendingDispatch = true;

        // Chat-anchor (provenance back to chat message + mind-map coord);
        // null on auto-generated cards (renders as N/A in UI).
        card.chatAnchorMessageId = row.chat_anchor_message_id || null;
        card.chatAnchorCoord = row.chat_anchor_coord || null;

        return card;
    }


    async function attachTagsToCards(deviceId, cards) {
        if (!Array.isArray(cards) || cards.length === 0) return cards;
        const ids = [...new Set(cards.map(c => c.id).filter(Boolean))];
        if (ids.length === 0) return cards;
        try {
            const idPlaceholders = ids.map((_, i) => `$${i + 2}`).join(',');
            const result = await pool.query(
                `SELECT ct.card_id, t.slug, t.label
                 FROM kanban_card_tags ct
                 JOIN kanban_tags t ON t.id = ct.tag_id AND t.device_id = ct.device_id
                 WHERE ct.device_id = $1 AND ct.card_id IN (${idPlaceholders})
                 ORDER BY t.slug`,
                [deviceId, ...ids]
            );
            const byCard = new Map();
            for (const row of result.rows) {
                if (!byCard.has(row.card_id)) byCard.set(row.card_id, []);
                byCard.get(row.card_id).push({ slug: row.slug, label: row.label || row.slug });
            }
            for (const card of cards) card.tags = byCard.get(card.id) || [];
        } catch (err) {
            // Backward-compatible during rolling deploy/migration: missing tag
            // tables should not break core board/card reads.
            console.warn('[Kanban] attachTagsToCards skipped:', err.message);
            for (const card of cards) if (!Array.isArray(card.tags)) card.tags = [];
        }
        return cards;
    }

    // ============================================
    // POST /card — Create card
    // ============================================
    router.post('/card', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] POST /card called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        // Source fields from query+body merge (matches authenticate() + sibling handlers).
        // Bug fix: authenticate() accepts creds in the query string, but reading deviceId
        // from req.body alone meant a query-cred caller (deviceId not in body) passed auth
        // then bound NULL device_id into the INSERT → "null value in column device_id ...
        // violates not-null constraint" 500 on card create.
        const { deviceId, title, description, priority, status, assignedBots, entityId, reviewerEntityId, isAutomation, schedule, requiresScreenshotReview, chatAnchorMessageId, chatAnchorCoord, dispatchMode } = { ...req.query, ...req.body };

        if (!deviceId) {
            return res.status(400).json({ success: false, error: 'Missing deviceId' });
        }

        if (!title || !title.trim()) {
            return res.status(400).json({ success: false, error: 'Missing title' });
        }

        const bots = Array.isArray(assignedBots) ? assignedBots.map(Number) : [];
        if (bots.length === 0) {
            return res.status(400).json({ success: false, error: 'At least one entity must be assigned' });
        }

        // #1700: Validate assigned entities are bound (rental entities allowed per design decision #15)
        const device = devices[deviceId];
        if (device) {
            for (const botId of bots) {
                const entity = device.entities?.[botId];
                if (!entity || !entity.isBound) {
                    return res.status(400).json({
                        success: false,
                        error: `Entity #${botId} is not bound`,
                        hint: 'Use POST /api/bind to bind the entity first',
                    });
                }
                // Rental entities (leased_out on owner side) are allowed for kanban assign
                // per design decision #15: ✅ kanban assigned_bots
            }
        }

        const cardPriority = PRIORITIES.includes(priority) ? priority : 'P2';
        const cardStatus = STATUSES.includes(status) ? status : 'backlog';
        const createdBy = parseInt(entityId || 0);
        let reviewer = reviewerEntityId != null ? parseInt(reviewerEntityId) : null;

        // Org chart: auto-set reviewer from hierarchy if not explicitly set
        if (reviewer == null && orgChart && bots.length > 0) {
            try {
                const orgData = await orgChart.getOrgChart(deviceId);
                if (orgData.options.kanbanReviewer && orgData.hierarchy && orgData.hierarchy.USER) {
                    const superior = orgChart.getSuperior(orgData.hierarchy, bots[0]);
                    if (superior != null && superior !== 'USER' && typeof superior === 'number') {
                        const device = devices[deviceId];
                        if (device && device.entities?.[superior]?.isBound) {
                            reviewer = superior;
                            console.log(`[Kanban] Org chart auto-set reviewer #${reviewer} for card assigned to [${bots.join(',')}]`);
                        }
                    }
                }
            } catch (err) {
                console.error('[Kanban] Org chart reviewer auto-set error:', err.message);
            }
        }

        // Inline automation + schedule support
        const wantAutomation = !!isAutomation;
        let schedEnabled = false, schedType = null, schedCron = null, schedRunAt = null, schedTz = 'Asia/Taipei', schedNextRunAt = null;
        // card_c2635849 per-card usage-skip thresholds. Default to column-level
        // defaults so cards filed without explicit thresholds still gain the
        // standard 85/95 guard. Validated here so bad input rejects 400 instead
        // of silently clamping (matches the PUT /schedule write boundary).
        let schedSkip5h = DEFAULT_SKIP_5H_PCT;
        let schedSkip7d = DEFAULT_SKIP_7D_PCT;

        if (schedule && typeof schedule === 'object') {
            schedType = (schedule.type === 'once' || schedule.type === 'recurring') ? schedule.type : null;
            schedTz = schedule.timezone || 'Asia/Taipei';
            schedEnabled = schedule.enabled !== false && !!schedType;

            if (schedEnabled && schedType === 'once') {
                if (!schedule.runAt) {
                    return res.status(400).json({ success: false, error: 'Missing schedule.runAt for once schedule' });
                }
                schedRunAt = new Date(schedule.runAt);
                if (isNaN(schedRunAt.getTime())) {
                    return res.status(400).json({ success: false, error: 'Invalid schedule.runAt timestamp' });
                }
                schedNextRunAt = schedRunAt;
            }

            if (schedEnabled && schedType === 'recurring') {
                if (!schedule.cron && !schedule.cronExpression) {
                    return res.status(400).json({ success: false, error: 'Missing schedule.cron for recurring schedule' });
                }
                schedCron = schedule.cron || schedule.cronExpression;
                schedNextRunAt = computeNextRun(schedCron, schedTz);
                if (!schedNextRunAt) {
                    return res.status(400).json({ success: false, error: 'Invalid cron expression' });
                }
            }

            // Optional per-card usage-skip thresholds (50–99 inclusive).
            if (schedule.skipIf5hUsagePctOver !== undefined) {
                if (!isValidUsageThreshold(schedule.skipIf5hUsagePctOver)) {
                    return res.status(400).json({
                        success: false,
                        error: 'schedule.skipIf5hUsagePctOver must be an integer in [50, 99]'
                    });
                }
                schedSkip5h = Number(schedule.skipIf5hUsagePctOver);
            }
            if (schedule.skipIf7dUsagePctOver !== undefined) {
                if (!isValidUsageThreshold(schedule.skipIf7dUsagePctOver)) {
                    return res.status(400).json({
                        success: false,
                        error: 'schedule.skipIf7dUsagePctOver must be an integer in [50, 99]'
                    });
                }
                schedSkip7d = Number(schedule.skipIf7dUsagePctOver);
            }
        }

        // recurring schedule → auto-promote to automation
        const finalAutomation = wantAutomation || (schedEnabled && schedType === 'recurring');
        // Screenshot review gate defaults to disabled for all new cards when not explicitly
        // specified. Caller can force `true` to opt in for cards that need evidence review.
        const finalRequiresScreenshot = requiresScreenshotReview === undefined
            ? false  // Default to disabled for all new cards
            : requiresScreenshotReview !== false;

        // Validate dispatch mode
        const finalDispatchMode = (dispatchMode === 'idle_only') ? 'idle_only' : 'immediate';

        // Chat-anchor: pin originating chat message + mind-map coord (Phase 1 — persist
        // only; UI picker + validator enforcement land in follow-up PRs). Auto-cards leave
        // both NULL so the UI renders N/A.
        //
        // The anchor MUST be a real chat_messages UUID (or NULL). Automated card
        // creators (ErrLog/cron, loop-directive, phase4, speakto, …) previously
        // POSTed literal placeholder strings such as "cron-auto" / "cron-auto-generated"
        // here; the mind-map graph projection then grouped every card sharing that
        // value into one bogus "chat #cron-auto" hub node and non-UUID values raised
        // "invalid input syntax for type uuid" on chat joins. Reject non-UUID anchors
        // at the write boundary (store NULL) so the placeholder pollution can't recur.
        const CHAT_ANCHOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const anchorMsgId = (typeof chatAnchorMessageId === 'string'
            && CHAT_ANCHOR_UUID_RE.test(chatAnchorMessageId.trim()))
            ? chatAnchorMessageId.trim()
            : null;
        let anchorCoord = null;
        if (chatAnchorCoord && typeof chatAnchorCoord === 'object') {
            const x = Number(chatAnchorCoord.x);
            const y = Number(chatAnchorCoord.y);
            if (Number.isFinite(x) && Number.isFinite(y)) {
                anchorCoord = { x, y };
            }
        }

        // Phase 3 — chat-anchor validator: human-filed cards (createdBy === 0 / USER)
        // must pin an originating chat message for traceability into 心智/對話.
        // Bots self-filing (createdBy > 0) and cron-spawn children (internal INSERT,
        // never POST /card) are exempt — they render N/A in the UI.
        if (createdBy === 0 && !anchorMsgId) {
            return res.status(400).json({
                success: false,
                error: 'Missing chatAnchorMessageId — human-filed cards must pin an originating chat message.',
                errorKey: 'kb_anchor_required',
            });
        }

        // Auto-inject Self-improvement template if description doesn't already include it.
        // Per Hank 2026-06-12: every parent kanban automation card must carry an OODA-R
        // retro slot. POST /card only creates parent cards (cron-instance children INSERT
        // directly without this path), so unconditional injection is safe.
        const rawDesc = description || '';
        const finalDescription = rawDesc.includes('Self-improvement')
            ? rawDesc
            : (rawDesc.trimEnd() + SI_TEMPLATE_SECTION);

        try {
            const result = await pool.query(
                `INSERT INTO kanban_cards (id, device_id, title, description, priority, status, assigned_bots, created_by, reviewer_entity_id, status_changed_at,
                    is_automation, schedule_enabled, schedule_type, schedule_cron, schedule_run_at, schedule_timezone, schedule_next_run_at, requires_screenshot_review,
                    chat_anchor_message_id, chat_anchor_coord, dispatch_mode,
                    schedule_skip_if_5h_pct_over, schedule_skip_if_7d_pct_over)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NOW(),
                    $10, $11, $12, $13, $14, $15, $16, $17,
                    $18, $19::jsonb, $20,
                    $21, $22)
                 RETURNING *`,
                [newCardId(), deviceId, title.trim(), finalDescription, cardPriority, cardStatus, JSON.stringify(bots), createdBy, reviewer,
                    finalAutomation, schedEnabled, schedType, schedCron, schedRunAt, schedTz, schedNextRunAt, finalRequiresScreenshot,
                    anchorMsgId, anchorCoord ? JSON.stringify(anchorCoord) : null, finalDispatchMode,
                    schedSkip5h, schedSkip7d]
            );

            const card = serializeCard(result.rows[0]);
            await bumpVersion(deviceId);

            // System comment
            await addSystemComment(card.id, deviceId, `📋 卡片建立 — 狀態: ${STATUS_LABELS[cardStatus]}，指派給: ${bots.map(b => `#${b}`).join(', ') || '未指派'}`);

            // Push notify assigned bots if status != backlog
            if (cardStatus !== 'backlog' && bots.length > 0) {
                const lang = await getDeviceLanguage(deviceId);
                const msg = tKanban(lang, 'cardCreated', {
                    priorityIcon: PRIORITY_COLORS[cardPriority],
                    priority: cardPriority,
                    title: title.trim(),
                    status: statusLabel(lang, cardStatus)
                });
                notifyEntities(deviceId, bots, msg, { description, cardId: card.id });
            }

            if (awardEntityXP) {
                try { await awardEntityXP(deviceId, createdBy, 10); } catch (e) { /* ignore */ }
            }

            // P1: log operation for entity status drawer block 2.
            // One row per assigned entity so each can see this in their own log.
            try {
                const entityStatus = require('./entity-status');
                for (const botId of bots) {
                    entityStatus.logOperation(
                        deviceId, botId, 'card_create',
                        `Created task card #${card.id} (${(card.title || '').slice(0, 60)})`,
                        { card_id: card.id, title: card.title, priority: card.priority, status: card.status }
                    );
                }
                if (createdBy && !bots.includes(createdBy)) {
                    entityStatus.logOperation(
                        deviceId, createdBy, 'card_create',
                        `Created task card #${card.id} (${(card.title || '').slice(0, 60)})`,
                        { card_id: card.id, title: card.title, priority: card.priority, status: card.status }
                    );
                }
            } catch (e) { /* fire-and-forget */ }

            res.json({ success: true, card });
        } catch (err) {
            console.error('[Kanban] Create card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /roadmap-status — PUBLIC OODA-R roadmap tracker (no auth, no secrets)
    // ============================================
    // OODA-R Phase 4 #9 (card_5ac74610cbf1f89440427809). Powers the LIVE status
    // badges on /portal/roadmap.html. The old badges were hard-coded; this
    // endpoint joins the editorial manifest (agent-improvement/roadmap-manifest)
    // against kanban_cards.status so the public page reflects real progress.
    //
    // Public by design: it exposes ONLY the curated 9 OODA-R item card IDs +
    // their status + updated_at + the PR links that already appear on the page.
    // No botSecret/deviceSecret required (the page is public). The canonical
    // board is the first ADMIN_DEVICE_IDS entry — the platform team's own board.
    router.get('/roadmap-status', async (req, res) => {
        try {
            const adminDeviceId = (process.env.ADMIN_DEVICE_IDS || '')
                .split(',').map(s => s.trim()).filter(Boolean)[0];
            const cardStatusById = {};
            if (adminDeviceId) {
                const ids = ROADMAP_ITEMS.map(it => it.cardId);
                const result = await pool.query(
                    `SELECT id, status, updated_at FROM kanban_cards
                     WHERE device_id = $1 AND id = ANY($2::text[])`,
                    [adminDeviceId, ids]
                );
                for (const row of result.rows) {
                    cardStatusById[row.id] = { status: row.status, updatedAt: row.updated_at };
                }
            }
            const payload = buildTrackerPayload(cardStatusById);
            // Short cache: the page polls at load; 60s is plenty and shields the DB.
            res.set('Cache-Control', 'public, max-age=60');
            res.json({ success: true, ...payload });
        } catch (err) {
            console.error('[Kanban] roadmap-status error:', err);
            // Degrade gracefully — return manifest fallbacks so the page renders.
            const payload = buildTrackerPayload({});
            res.json({ success: true, degraded: true, ...payload });
        }
    });

    // ============================================
    // GET /cards — List cards
    // ============================================
    router.get('/cards', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const { status: filterStatus, assignedBot, priority: filterPriority, automation, q: searchQuery, since, until, includeComments, includeSubcards, includeArchived, tag: filterTag } = req.query;

        const hasSearch = !!(searchQuery && typeof searchQuery === 'string' && searchQuery.trim());
        // Search auto-includes archived cards (Hank 2026-04-28: 歸檔卡找不回來 = 知識斷掉);
        // ?includeArchived=false explicitly opts out. Outside search context, archived stays excluded.
        const showArchived = hasSearch && includeArchived !== 'false';

        try {
            let query = `
                SELECT c.*,
                    COALESCE(cm.cnt, 0) AS comment_count,
                    COALESCE(n.cnt, 0) AS note_count,
                    COALESCE(f.cnt, 0) AS file_count
                FROM kanban_cards c
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_comments GROUP BY card_id) cm ON cm.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_notes GROUP BY card_id) n ON n.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_files GROUP BY card_id) f ON f.card_id = c.id
                WHERE c.device_id = $1${showArchived ? '' : ' AND c.archived = false'}
            `;
            const params = [deviceId];
            let paramIdx = 2;

            // #1703: Automation filter — default excludes automation cards
            // ?automation=all → show everything (explicit opt-in)
            // ?automation=true → only automation cards
            // ?automation=false or absent → only manual cards (new default)
            if (automation === 'all') {
                // no filter — show everything
            } else if (automation === 'true') {
                query += ` AND c.is_automation = true`;
            } else {
                // Default: exclude automation cards
                query += ` AND (c.is_automation = false OR c.is_automation IS NULL)`;
            }

            if (filterStatus && STATUSES.includes(filterStatus)) {
                query += ` AND c.status = $${paramIdx++}`;
                params.push(filterStatus);
            }

            if (assignedBot !== undefined) {
                query += ` AND c.assigned_bots @> $${paramIdx++}::jsonb`;
                params.push(JSON.stringify([parseInt(assignedBot)]));
            }

            if (filterPriority && PRIORITIES.includes(filterPriority)) {
                query += ` AND c.priority = $${paramIdx++}`;
                params.push(filterPriority);
            }

            if (filterTag && String(filterTag).trim()) {
                const tagSlug = String(filterTag).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._:-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
                query += ` AND c.id IN (
                    SELECT fct.card_id FROM kanban_card_tags fct
                    JOIN kanban_tags ft ON ft.id = fct.tag_id AND ft.device_id = fct.device_id
                    WHERE fct.device_id = $1 AND ft.slug = $${paramIdx++}
                )`;
                params.push(tagSlug);
            }

            // Funnel filters added 2026-04-23:
            // ?q=text  → ILIKE match on title (simple text search)
            //   2026-04-28: ?includeComments=true expands to kanban_comments.text;
            //   ?includeSubcards=true expands to kanban_notes (title+content) and
            //   child cards (title+description) reached via parent_card_id self-ref.
            //   Archived cards auto-included unless ?includeArchived=false.
            // ?since=ISO8601 / ?until=ISO8601  → updated_at range
            if (hasSearch) {
                const pattern = `%${searchQuery.trim()}%`;
                const patternIdx = paramIdx++;
                params.push(pattern);
                const clauses = [`c.title ILIKE $${patternIdx}`, `c.description ILIKE $${patternIdx}`];
                if (includeComments === 'true' || includeComments === '1') {
                    clauses.push(`EXISTS (SELECT 1 FROM kanban_comments kc WHERE kc.card_id = c.id AND kc.text ILIKE $${patternIdx})`);
                }
                if (includeSubcards === 'true' || includeSubcards === '1') {
                    clauses.push(`EXISTS (SELECT 1 FROM kanban_notes kn WHERE kn.card_id = c.id AND (kn.title ILIKE $${patternIdx} OR kn.content ILIKE $${patternIdx}))`);
                    clauses.push(`EXISTS (SELECT 1 FROM kanban_cards child WHERE child.parent_card_id = c.id AND (child.title ILIKE $${patternIdx} OR child.description ILIKE $${patternIdx}))`);
                }
                query += ` AND (${clauses.join(' OR ')})`;
            }
            if (since) {
                const sinceDate = new Date(since);
                if (!isNaN(sinceDate.getTime())) {
                    query += ` AND c.updated_at >= $${paramIdx++}`;
                    params.push(sinceDate);
                }
            }
            if (until) {
                const untilDate = new Date(until);
                if (!isNaN(untilDate.getTime())) {
                    query += ` AND c.updated_at <= $${paramIdx++}`;
                    params.push(untilDate);
                }
            }

            // Order: P0 first, then by status position, then most-recently-updated first.
            // Changed 2026-04-23 from created_at DESC to updated_at DESC so cards move
            // to the top when they receive new comments/notes/status changes.
            query += ` ORDER BY
                CASE c.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 END,
                ${KanbanStatus.priorityOrderSql('c.status')},
                c.updated_at DESC NULLS LAST`;

            const result = await pool.query(query, params);
            const cards = result.rows.map(serializeCard);
            await attachTagsToCards(deviceId, cards);

            // Group by status for kanban view
            const board = {};
            for (const s of STATUSES) board[s] = [];
            for (const card of cards) {
                if (board[card.status]) board[card.status].push(card);
            }

            // #1703: Summary counts for manual vs automation cards
            const summaryResult = await pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE is_automation = true) AS automation_count,
                    COUNT(*) FILTER (WHERE is_automation = false OR is_automation IS NULL) AS manual_count
                FROM kanban_cards WHERE device_id = $1 AND archived = false
            `, [deviceId]);
            const summaryRow = summaryResult.rows[0] || {};
            const byStatus = {};
            for (const s of STATUSES) byStatus[s] = board[s].length;

            res.json({
                success: true, cards, board, total: cards.length,
                summary: {
                    total: cards.length,
                    manual: parseInt(summaryRow.manual_count || 0),
                    automation: parseInt(summaryRow.automation_count || 0),
                    byStatus,
                },
            });
        } catch (err) {
            console.error('[Kanban] List cards error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /cards/projections — Projected run times for automation cards
    // ============================================
    router.get('/cards/projections', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, windowHours } = { ...req.query, ...req.body };
        const hours = Math.min(parseInt(windowHours) || 24, 72);
        const windowStart = Date.now() - 3600000; // 1h ago
        const windowEnd = Date.now() + (hours - 1) * 3600000;

        if (!CronExpressionParser) {
            return res.json({ success: true, projections: {} });
        }

        try {
            const result = await pool.query(
                `SELECT id, schedule_cron, schedule_timezone FROM kanban_cards
                 WHERE device_id = $1 AND is_automation = true AND archived = false
                   AND schedule_enabled = true AND schedule_cron IS NOT NULL
                 LIMIT 100`,
                [deviceId]
            );

            const projections = {};
            for (const row of result.rows) {
                try {
                    const expr = CronExpressionParser.parse(row.schedule_cron, {
                        tz: row.schedule_timezone || 'Asia/Taipei',
                        currentDate: new Date(windowStart),
                    });
                    const times = [];
                    let iter = 0;
                    while (iter++ < 200) {
                        const next = expr.next().toDate();
                        if (next.getTime() > windowEnd) break;
                        times.push(next.getTime());
                    }
                    projections[row.id] = times;
                } catch (e) {
                    projections[row.id] = [];
                }
            }

            res.json({ success: true, projections });
        } catch (err) {
            console.error('[Kanban] Projections error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /cards/summary — Board summary (counts + recent activity)
    // ============================================
    router.get('/cards/summary', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };

        try {
            // Status counts (non-archived)
            const countsResult = await pool.query(
                `SELECT status, COUNT(*) AS cnt
                 FROM kanban_cards
                 WHERE device_id = $1 AND archived = false AND (is_automation = false OR is_automation IS NULL)
                 GROUP BY status`,
                [deviceId]
            );
            const statusCounts = {};
            let totalActive = 0;
            for (const s of STATUSES) statusCounts[s] = 0;
            for (const row of countsResult.rows) {
                statusCounts[row.status] = parseInt(row.cnt);
                totalActive += parseInt(row.cnt);
            }
            console.log('[Kanban] summary statusCounts:', statusCounts);

            // Automation count
            const autoResult = await pool.query(
                `SELECT COUNT(*) AS cnt FROM kanban_cards
                 WHERE device_id = $1 AND archived = false AND is_automation = true`,
                [deviceId]
            );
            const automationCount = parseInt(autoResult.rows[0]?.cnt) || 0;

            // Stale cards (exceeded threshold)
            const staleResult = await pool.query(
                `SELECT COUNT(*) AS cnt FROM kanban_cards
                 WHERE device_id = $1 AND archived = false
                   AND status IN ('todo', 'in_progress', 'review')
                   AND EXTRACT(EPOCH FROM (NOW() - status_changed_at)) * 1000 > stale_threshold_ms`,
                [deviceId]
            );
            const staleCount = parseInt(staleResult.rows[0]?.cnt) || 0;

            // Recent activity (last 5 status changes)
            const recentResult = await pool.query(
                `SELECT id, title, status, priority, assigned_bots, status_changed_at, is_auto_generated
                 FROM kanban_cards
                 WHERE device_id = $1 AND archived = false
                 ORDER BY status_changed_at DESC
                 LIMIT 5`,
                [deviceId]
            );
            const recentActivity = recentResult.rows.map(r => ({
                id: r.id,
                title: r.title,
                status: r.status,
                priority: r.priority,
                assignedBots: r.assigned_bots || [],
                isAutoGenerated: r.is_auto_generated || false,
                statusChangedAt: r.status_changed_at ? new Date(r.status_changed_at).getTime() : null
            }));

            // Archived count (for reference)
            const archivedResult = await pool.query(
                `SELECT COUNT(*) AS cnt FROM kanban_cards WHERE device_id = $1 AND archived = true`,
                [deviceId]
            );
            const archivedCount = parseInt(archivedResult.rows[0]?.cnt) || 0;

            console.log(`[Kanban] summary: active=${totalActive}, automation=${automationCount}, stale=${staleCount}, archived=${archivedCount}`);

            res.json({
                success: true,
                summary: {
                    statusCounts,
                    totalActive,
                    automationCount,
                    staleCount,
                    archivedCount,
                    recentActivity
                }
            });
        } catch (err) {
            console.error('[Kanban] Summary error:', err.message, err.stack);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /mindmap — Live data feed for mission.html mind-map
    // ============================================
    // Projects active kanban cards into the {id,label,sys,tier,status,summary}
    // shape consumed by public/portal/shared/mission-mindmap.js. Edges come
    // from parent_card_id. The 8-system frame (invite/device/i18n/kanban/chat/
    // payment/broadcast/bridge) is preserved as virtual hub nodes so the
    // sys-rail UI keeps working even when zero cards classify into a system.
    //
    // The frontend (mission.html) calls this and falls back to the in-file
    // MOCK_NODES when totalCards < 5 or when this endpoint errors.
    const SYS_KEYWORDS = [
        ['i18n',      /(i18n|locale|翻譯|翻译|hermes|cc_warn)/i],
        ['chat',      /(聊天|chat|引用|chip|popover|embed=1|message|心智圖|mindmap|mind-map)/i],
        ['kanban',    /(看板|kanban|卡片|card|screenshot|note|筆記|comment)/i],
        ['invite',    /(邀請|invite|redeem|tier|funnel|leaderboard|qr)/i],
        ['device',    /(裝置|device|secret|vault|rental|health|switch)/i],
        ['payment',   /(支付|wallet|payment|iap|topup|top-up|storekit|訂閱)/i],
        ['broadcast', /(廣播|broadcast|publisher|twitter|mastodon|wordpress|wp\.com|社群|x \(twitter\))/i],
        ['bridge',    /(橋接|bridge|osascript|u\d{2}|ssh|terminal-bridge|hermes-bridge)/i],
    ];
    // Automation triggers (is_automation=true) anchor to a dedicated subsystem
    // so the lineage (which cron spawned which real cards) becomes navigable.
    // Spawned children keep their content classification — they get a
    // sysHub edge for content + parent edge for lineage = dual-axis.
    function classifySys(title, isAutomation) {
        if (isAutomation) return 'automation';
        const t = String(title || '');
        for (const [sys, rx] of SYS_KEYWORDS) {
            if (rx.test(t)) return sys;
        }
        return 'kanban';
    }
    function tierFor(priority, isAutomation) {
        if (isAutomation) return 'leaf';
        if (priority === 'P0' || priority === 'P1') return 'topic';
        return 'leaf';
    }
    function statusFor(kanbanStatus) {
        if (kanbanStatus === 'done') return 'done';
        if (kanbanStatus === 'backlog') return 'blocked';
        return 'active';
    }
    // DEPRECATED: GET /api/mission/mindmap (PR-A static-mockup feed)
    // Replaced by GET /api/mindmap/graph (PR #2680 force-graph projection;
    // see /portal/mindmap.html). Kept for the legacy dashboard-teaser on
    // mission.html until the teaser is migrated to call /api/mindmap/graph
    // directly. Do not extend; new mindmap consumers must use /api/mindmap/graph.
    router.get('/mindmap', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        try {
            const cardsResult = await pool.query(
                `SELECT id, title, description, priority, status, parent_card_id, is_automation, assigned_bots, chat_anchor_coord
                 FROM kanban_cards
                 WHERE device_id = $1 AND archived = false
                 ORDER BY
                    CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 END,
                    updated_at DESC NULLS LAST
                 LIMIT 80`,
                [deviceId]
            );

            const sysHubs = {
                invite:     { id: 'sys:invite',     label: '邀請',     sys: 'invite',     tier: 'domain', status: 'active', summary: '' },
                device:     { id: 'sys:device',     label: '裝置',     sys: 'device',     tier: 'domain', status: 'active', summary: '' },
                i18n:       { id: 'sys:i18n',       label: 'i18n',     sys: 'i18n',       tier: 'domain', status: 'active', summary: '' },
                kanban:     { id: 'sys:kanban',     label: '看板',     sys: 'kanban',     tier: 'domain', status: 'active', summary: '' },
                chat:       { id: 'sys:chat',       label: '聊天',     sys: 'chat',       tier: 'domain', status: 'active', summary: '' },
                payment:    { id: 'sys:payment',    label: '支付',     sys: 'payment',    tier: 'domain', status: 'active', summary: '' },
                broadcast:  { id: 'sys:broadcast',  label: '廣播',     sys: 'broadcast',  tier: 'domain', status: 'active', summary: '' },
                bridge:     { id: 'sys:bridge',     label: '橋接',     sys: 'bridge',     tier: 'domain', status: 'active', summary: '' },
                automation: { id: 'sys:automation', label: '自動化',   sys: 'automation', tier: 'domain', status: 'active', summary: '' },
            };

            const nodes = [];
            const edges = [];
            const cardIds = new Set();
            const sysCount = {};

            for (const c of cardsResult.rows) {
                const sys = classifySys(c.title, c.is_automation);
                sysCount[sys] = (sysCount[sys] || 0) + 1;
                const summary = (c.description || '').replace(/\s+/g, ' ').trim().slice(0, 120);
                const node = {
                    id: c.id,
                    label: (c.title || '').slice(0, 40),
                    sys,
                    tier: tierFor(c.priority, c.is_automation),
                    status: statusFor(c.status),
                    summary,
                    priority: c.priority,
                    cardStatus: c.status,
                    isAutomation: !!c.is_automation,
                };
                const coord = c.chat_anchor_coord;
                if (coord && Number.isFinite(coord.x) && Number.isFinite(coord.y)) {
                    node.coord = { x: coord.x, y: coord.y };
                }
                nodes.push(node);
                cardIds.add(c.id);
            }

            // Hub nodes: include hubs that own ≥1 card (keeps the rail tidy).
            // Every card gets a hub edge — the parent_card_id edge is added
            // separately below, so cards with parents end up dual-axis
            // (lineage to parent + content/automation to hub).
            for (const sys of Object.keys(sysHubs)) {
                if (sysCount[sys]) {
                    const hub = { ...sysHubs[sys], summary: `${sysCount[sys]} 張卡片` };
                    nodes.unshift(hub);
                    for (const c of cardsResult.rows) {
                        if (classifySys(c.title, c.is_automation) === sys) {
                            edges.push([hub.id, c.id]);
                        }
                    }
                }
            }

            // Parent → child edges (only when both endpoints are in the result set)
            for (const c of cardsResult.rows) {
                if (c.parent_card_id && cardIds.has(c.parent_card_id)) {
                    edges.push([c.parent_card_id, c.id]);
                }
            }

            // Chat embedding telemetry — surface as a hub-level annotation.
            // chat_messages has no card_id link, so we can only report the
            // device-wide count here; per-card linkage will land in a follow-up.
            let messagesWithEmbedding = 0;
            try {
                const embedResult = await pool.query(
                    `SELECT COUNT(*)::int AS n FROM chat_messages
                     WHERE device_id = $1 AND embedding IS NOT NULL`,
                    [deviceId]
                );
                messagesWithEmbedding = embedResult.rows[0]?.n || 0;
                if (messagesWithEmbedding > 0) {
                    const chatHub = nodes.find(n => n.id === 'sys:chat');
                    if (chatHub) {
                        chatHub.summary = `${sysCount.chat || 0} 張卡片 · ${messagesWithEmbedding} 則訊息已嵌入`;
                    }
                }
            } catch (e) {
                // pgvector not installed or column missing — skip silently
            }

            res.json({
                success: true,
                live: true,
                nodes,
                edges,
                stats: {
                    totalCards: cardsResult.rows.length,
                    messagesWithEmbedding,
                    sysCount,
                },
            });
        } catch (err) {
            console.error('[Kanban] Mindmap error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /cards/archived — Archived cards (paginated)
    // ============================================
    router.get('/cards/archived', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        try {
            const countResult = await pool.query(
                `SELECT COUNT(*) FROM kanban_cards WHERE device_id = $1 AND archived = true`,
                [deviceId]
            );
            const total = parseInt(countResult.rows[0].count);

            const result = await pool.query(
                `SELECT c.*,
                    COALESCE(cm.cnt, 0) AS comment_count,
                    COALESCE(n.cnt, 0) AS note_count,
                    COALESCE(f.cnt, 0) AS file_count
                FROM kanban_cards c
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_comments GROUP BY card_id) cm ON cm.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_notes GROUP BY card_id) n ON n.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_files GROUP BY card_id) f ON f.card_id = c.id
                WHERE c.device_id = $1 AND c.archived = true
                ORDER BY c.archived_at DESC NULLS LAST
                LIMIT $2 OFFSET $3`,
                [deviceId, limit, offset]
            );

            res.json({
                success: true,
                cards: await attachTagsToCards(deviceId, result.rows.map(serializeCard)),
                total,
                page,
                pages: Math.ceil(total / limit)
            });
        } catch (err) {
            console.error('[Kanban] Archived cards error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /card/:id — Card detail
    // ============================================
    router.get('/card/:id', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const rawId = req.params.id;

        try {
            // Resolve short-ID prefixes to the full card ID, scoped to this device.
            // Users commonly mention cards in chat with 8-hex shorthand (e.g. `card_7b7dd9e3`);
            // fall back to a prefix match only when the raw id is an obvious shorthand
            // (hex-only, ≤ 12 chars, optionally with a `card_` prefix).
            let cardId = rawId;
            const shortBody = /^card_([a-f0-9]{6,12})$/i.test(rawId)
                ? rawId.slice(5)
                : (/^[a-f0-9]{6,12}$/i.test(rawId) ? rawId : null);
            if (shortBody) {
                const match = await pool.query(
                    `SELECT id FROM kanban_cards
                     WHERE device_id = $1
                       AND (id = $2 OR id LIKE $3 OR id LIKE $4)
                     ORDER BY created_at DESC
                     LIMIT 2`,
                    [deviceId, rawId, shortBody + '%', 'card_' + shortBody + '%']
                );
                if (match.rows.length === 1) cardId = match.rows[0].id;
                // If 2+ cards share this prefix we fall through to the exact-match
                // query below, which will return 404 and force the caller to
                // disambiguate with a longer id.
            }

            const cardResult = await pool.query(
                `SELECT c.*,
                    COALESCE(cm.cnt, 0) AS comment_count,
                    COALESCE(n.cnt, 0) AS note_count,
                    COALESCE(f.cnt, 0) AS file_count
                FROM kanban_cards c
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_comments GROUP BY card_id) cm ON cm.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_notes GROUP BY card_id) n ON n.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_files GROUP BY card_id) f ON f.card_id = c.id
                WHERE c.id = $1 AND c.device_id = $2`,
                [cardId, deviceId]
            );

            if (cardResult.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const card = serializeCard(cardResult.rows[0]);
            await attachTagsToCards(deviceId, [card]);

            // Fetch latest 50 comments (was: oldest 50 — invisible new comments on long cards)
            const commentsResult = await pool.query(
                `SELECT * FROM (
                    SELECT * FROM kanban_comments WHERE card_id = $1 ORDER BY created_at DESC LIMIT 50
                ) sub ORDER BY created_at ASC`,
                [cardId]
            );
            card.comments = commentsResult.rows.map(r => ({
                id: r.id,
                fromEntityId: r.from_entity_id,
                text: r.text,
                isSystem: r.is_system,
                createdAt: new Date(r.created_at).getTime()
            }));

            // Fetch notes
            const notesResult = await pool.query(
                `SELECT * FROM kanban_notes WHERE card_id = $1 ORDER BY created_at DESC`,
                [cardId]
            );
            card.notes = notesResult.rows.map(r => ({
                id: r.id,
                title: r.title,
                content: r.content,
                fromEntityId: r.from_entity_id,
                createdAt: new Date(r.created_at).getTime(),
                updatedAt: new Date(r.updated_at).getTime()
            }));

            // Fetch first-class Mission notes linked to this Kanban card.
            // Notes live in mission_dashboard.notes JSONB; the join table is
            // explicit/device-scoped and supplies reliable force-graph edges.
            try {
                const linkedNotesResult = await pool.query(
                    `SELECT l.note_id, l.created_at AS linked_at, note AS note_json
                     FROM mission_note_card_links l
                     JOIN mission_dashboard md ON md.device_id = l.device_id
                     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(md.notes, '[]'::jsonb)) AS n(note)
                     WHERE l.device_id = $1
                       AND l.card_id = $2
                       AND note->>'id' = l.note_id
                     ORDER BY l.created_at DESC`,
                    [deviceId, cardId]
                );
                card.linkedMissionNotes = linkedNotesResult.rows.map(r => ({
                    id: r.note_id,
                    title: r.note_json.title || '(untitled note)',
                    category: r.note_json.category || 'general',
                    excerpt: String(r.note_json.content || '').slice(0, 160),
                    linkedAt: new Date(r.linked_at).getTime(),
                }));
                card.linkedMissionNoteCount = card.linkedMissionNotes.length;
            } catch (linkedErr) {
                // Backward-compatible: a missing migration should not break card detail.
                console.warn('[Kanban] Linked mission notes query skipped:', linkedErr.message);
                card.linkedMissionNotes = [];
                card.linkedMissionNoteCount = 0;
            }

            // Fetch files — regenerate fresh R2 signed URLs for rows that were
            // stored as fileId refs (stored url in DB is just a legacy cache).
            const filesResult = await pool.query(
                `SELECT * FROM kanban_files WHERE card_id = $1 ORDER BY created_at DESC`,
                [cardId]
            );
            card.files = await Promise.all(filesResult.rows.map(mapCardFileRow));

            // Hydrate linkedPrev/linkedNext payloads so the UI can render workflow-chain
            // chips (Parent/Prev/Next) without a follow-up round-trip per neighbour.
            // See docs/specs/card-link-system.md — this is the "Mechanism A" read side.
            const linkedIds = [card.linkedPrevCardId, card.linkedNextCardId].filter(Boolean);
            if (linkedIds.length > 0) {
                const linked = await pool.query(
                    `SELECT id, title, status, priority, archived
                     FROM kanban_cards
                     WHERE device_id = $1 AND id = ANY($2::text[])`,
                    [deviceId, linkedIds]
                );
                const linkedById = new Map(linked.rows.map(r => [r.id, {
                    id: r.id,
                    title: r.title,
                    status: r.status,
                    priority: r.priority,
                    archived: !!r.archived,
                }]));
                card.linkedPrev = card.linkedPrevCardId ? (linkedById.get(card.linkedPrevCardId) || null) : null;
                card.linkedNext = card.linkedNextCardId ? (linkedById.get(card.linkedNextCardId) || null) : null;
            } else {
                card.linkedPrev = null;
                card.linkedNext = null;
            }

            res.json({ success: true, card });
        } catch (err) {
            console.error('[Kanban] Get card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // PUT /card/:id — Update card fields
    // ============================================
    router.put('/card/:id', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] PUT /card/:id called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, title, description, priority, assignedBots, reviewerEntityId, requiresScreenshotReview, requiresPreflightReview, dispatchMode, requiresPrRework, reworkPrNumber, linkedPrevCardId, linkedNextCardId } = req.body;
        const cardId = req.params.id;

        try {
            // Check card exists and belongs to device
            const existing = await pool.query(
                `SELECT * FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (existing.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            async function normalizeLinkedCardId(raw, fieldName) {
                if (raw === undefined) return undefined;
                const value = raw == null ? '' : String(raw).trim();
                if (!value) return null;
                if (value === cardId) {
                    const err = new Error(`${fieldName} cannot point to the same card`);
                    err.status = 400;
                    throw err;
                }
                const linked = await pool.query(
                    `SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2 LIMIT 1`,
                    [value, deviceId]
                );
                if (linked.rows.length === 0) {
                    const err = new Error(`${fieldName} target card not found`);
                    err.status = 400;
                    throw err;
                }
                return value;
            }

            const updates = [];
            const params = [];
            let paramIdx = 1;

            if (title !== undefined) {
                updates.push(`title = $${paramIdx++}`);
                params.push(title.trim());
            }
            if (description !== undefined) {
                updates.push(`description = $${paramIdx++}`);
                params.push(description);
            }
            if (priority !== undefined && PRIORITIES.includes(priority)) {
                updates.push(`priority = $${paramIdx++}`);
                params.push(priority);
            }
            if (assignedBots !== undefined && Array.isArray(assignedBots)) {
                if (assignedBots.length === 0) {
                    return res.status(400).json({ success: false, error: 'At least one entity must be assigned' });
                }
                // #1700: Validate bind status on update (rental entities allowed)
                const updateDevice = devices[deviceId];
                if (updateDevice) {
                    for (const botId of assignedBots.map(Number)) {
                        const entity = updateDevice.entities?.[botId];
                        if (!entity || !entity.isBound) {
                            return res.status(400).json({ success: false, error: `Entity #${botId} is not bound` });
                        }
                    }
                }
                updates.push(`assigned_bots = $${paramIdx++}::jsonb`);
                params.push(JSON.stringify(assignedBots.map(Number)));
            }
            if (reviewerEntityId !== undefined) {
                updates.push(`reviewer_entity_id = $${paramIdx++}`);
                params.push(reviewerEntityId != null ? parseInt(reviewerEntityId) : null);
            }
            if (requiresScreenshotReview !== undefined) {
                updates.push(`requires_screenshot_review = $${paramIdx++}`);
                params.push(!!requiresScreenshotReview);
            }
            if (requiresPreflightReview !== undefined) {
                updates.push(`requires_preflight_review = $${paramIdx++}`);
                params.push(!!requiresPreflightReview);
            }
            if (dispatchMode !== undefined) {
                const normalizedDispatchMode = dispatchMode === 'idle_only' ? 'idle_only' : (dispatchMode === 'immediate' ? 'immediate' : null);
                if (!normalizedDispatchMode) {
                    return res.status(400).json({ success: false, error: 'dispatchMode must be "immediate" or "idle_only"' });
                }
                updates.push(`dispatch_mode = $${paramIdx++}`);
                params.push(normalizedDispatchMode);
                // Switching back to immediate mode must clear any old queued marker so
                // automation parents do not remain invisible to the scheduler.
                if (normalizedDispatchMode === 'immediate') {
                    updates.push(`pending_dispatch = FALSE`);
                }
            }
            if (requiresPrRework !== undefined) {
                const normalizedRequiresPrRework = requiresPrRework === true || requiresPrRework === 'true' || requiresPrRework === '1';
                updates.push(`requires_pr_rework = $${paramIdx++}`);
                params.push(normalizedRequiresPrRework);
            }
            if (reworkPrNumber !== undefined) {
                const normalizedPr = String(reworkPrNumber || '').trim();
                updates.push(`rework_pr_number = $${paramIdx++}`);
                params.push(normalizedPr || null);
                if (normalizedPr) {
                    updates.push(`requires_pr_rework = TRUE`);
                }
            }
            if (linkedPrevCardId !== undefined) {
                const normalizedPrev = await normalizeLinkedCardId(linkedPrevCardId, 'linkedPrevCardId');
                updates.push(`linked_prev_card_id = $${paramIdx++}`);
                params.push(normalizedPrev);
            }
            if (linkedNextCardId !== undefined) {
                const normalizedNext = await normalizeLinkedCardId(linkedNextCardId, 'linkedNextCardId');
                updates.push(`linked_next_card_id = $${paramIdx++}`);
                params.push(normalizedNext);
            }

            if (updates.length === 0) {
                return res.status(400).json({ success: false, error: 'Nothing to update' });
            }

            updates.push(`updated_at = NOW()`);
            params.push(cardId);
            params.push(deviceId);

            // linkedPrev/Next must keep the A.next=B ⟺ B.prev=A invariant on both sides.
            // When either pointer is being touched, run the primary UPDATE and the
            // reciprocal sync in a single transaction so a crash mid-write cannot leave
            // half-broken chains (see docs/specs/card-link-system.md).
            const needsLinkSync = (linkedPrevCardId !== undefined || linkedNextCardId !== undefined);
            const client = needsLinkSync ? await pool.connect() : null;
            let result;
            try {
                if (client) await client.query('BEGIN');
                const q = client || pool;

                result = await q.query(
                    `UPDATE kanban_cards SET ${updates.join(', ')}
                     WHERE id = $${paramIdx++} AND device_id = $${paramIdx++}
                     RETURNING *`,
                    params
                );

                if (needsLinkSync) {
                    const before = existing.rows[0];
                    const after = result.rows[0];

                    if (linkedNextCardId !== undefined) {
                        const oldNext = before.linked_next_card_id;
                        const newNext = after.linked_next_card_id;
                        // Disconnect the old downstream partner if we are changing target.
                        if (oldNext && oldNext !== newNext) {
                            await client.query(
                                `UPDATE kanban_cards SET linked_prev_card_id = NULL, updated_at = NOW()
                                 WHERE id = $1 AND device_id = $2 AND linked_prev_card_id = $3`,
                                [oldNext, deviceId, cardId]
                            );
                        }
                        if (newNext) {
                            // Detach any other card currently pointing at newNext as its next,
                            // then claim newNext.prev = cardId. Idempotent on repeat calls.
                            await client.query(
                                `UPDATE kanban_cards SET linked_next_card_id = NULL, updated_at = NOW()
                                 WHERE device_id = $1 AND linked_next_card_id = $2 AND id <> $3`,
                                [deviceId, newNext, cardId]
                            );
                            await client.query(
                                `UPDATE kanban_cards SET linked_prev_card_id = $1, updated_at = NOW()
                                 WHERE id = $2 AND device_id = $3`,
                                [cardId, newNext, deviceId]
                            );
                        }
                    }

                    if (linkedPrevCardId !== undefined) {
                        const oldPrev = before.linked_prev_card_id;
                        const newPrev = after.linked_prev_card_id;
                        if (oldPrev && oldPrev !== newPrev) {
                            await client.query(
                                `UPDATE kanban_cards SET linked_next_card_id = NULL, updated_at = NOW()
                                 WHERE id = $1 AND device_id = $2 AND linked_next_card_id = $3`,
                                [oldPrev, deviceId, cardId]
                            );
                        }
                        if (newPrev) {
                            await client.query(
                                `UPDATE kanban_cards SET linked_prev_card_id = NULL, updated_at = NOW()
                                 WHERE device_id = $1 AND linked_prev_card_id = $2 AND id <> $3`,
                                [deviceId, newPrev, cardId]
                            );
                            await client.query(
                                `UPDATE kanban_cards SET linked_next_card_id = $1, updated_at = NOW()
                                 WHERE id = $2 AND device_id = $3`,
                                [cardId, newPrev, deviceId]
                            );
                        }
                    }

                    await client.query('COMMIT');
                }
            } catch (txErr) {
                if (client) {
                    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
                }
                throw txErr;
            } finally {
                if (client) client.release();
            }

            await bumpVersion(deviceId);

            // ── A. Notify on (re)assignment (card_cc20541e) ──
            // When this PUT ADDS new entity ids to assigned_bots, ping ONLY the
            // newly-added ids (not the whole assigned set — that would re-spam
            // unchanged assignees on every edit). Best-effort, fire-and-forget:
            // a notify failure must never break the 200 response. Mirrors the
            // create-path notify (line ~1234) so a card assigned via edit gets
            // the same task brief the create flow would have delivered.
            if (assignedBots !== undefined && Array.isArray(assignedBots)) {
                try {
                    const before = existing.rows[0];
                    const updated = result.rows[0];
                    const prevSet = new Set(
                        (Array.isArray(before.assigned_bots) ? before.assigned_bots : []).map(Number)
                    );
                    const newlyAdded = (Array.isArray(updated.assigned_bots) ? updated.assigned_bots : [])
                        .map(Number)
                        .filter(id => Number.isFinite(id) && !prevSet.has(id));
                    if (newlyAdded.length > 0) {
                        const lang = await getDeviceLanguage(deviceId);
                        const msg = tKanban(lang, 'assignedToYou', { title: updated.title });
                        notifyEntities(deviceId, newlyAdded, msg, {
                            description: updated.description,
                            cardId: updated.id,
                        });
                    }
                } catch (notifyErr) {
                    console.error('[Kanban] assign-notify failed:', notifyErr.message);
                }
            }

            res.json({ success: true, card: serializeCard(result.rows[0]) });
        } catch (err) {
            console.error('[Kanban] Update card error:', err);
            res.status(err.status || 500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // DELETE /card/:id — Archive card
    // ============================================
    router.delete('/card/:id', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] DELETE /card/:id called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId } = { ...req.query, ...req.body };
        const cardId = req.params.id;

        try {
            const result = await pool.query(
                `UPDATE kanban_cards SET archived = true, archived_at = NOW(), updated_at = NOW()
                 WHERE id = $1 AND device_id = $2
                 RETURNING *`,
                [cardId, deviceId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            await addSystemComment(cardId, deviceId, '🗄️ 卡片已歸檔');
            await bumpVersion(deviceId);

            // P1: log operation for entity status drawer
            try {
                const entityStatus = require('./entity-status');
                const archivedCard = result.rows[0] || {};
                const bots = Array.isArray(archivedCard.assigned_bots) ? archivedCard.assigned_bots : [];
                for (const botId of bots) {
                    entityStatus.logOperation(
                        deviceId, Number(botId), 'card_delete',
                        `Archived card #${archivedCard.id} (${(archivedCard.title || '').slice(0, 50)})`,
                        { card_id: archivedCard.id, title: archivedCard.title }
                    );
                }
            } catch (e) { /* fire-and-forget */ }

            res.json({ success: true, message: 'Card archived' });
        } catch (err) {
            console.error('[Kanban] Archive card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });


    // ============================================
    // POST /card/:id/restore — Un-archive a card (bring it back to the board)
    // ============================================
    router.post('/card/:id/restore', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const cardId = req.params.id;

        try {
            // Restore to 'backlog' so it doesn't immediately re-archive if it was 'done'.
            const result = await pool.query(
                `UPDATE kanban_cards
                 SET archived = false, archived_at = NULL, status = 'backlog',
                     status_changed_at = NOW(), updated_at = NOW()
                 WHERE id = $1 AND device_id = $2 AND archived = true
                 RETURNING *`,
                [cardId, deviceId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Archived card not found' });
            }

            await addSystemComment(cardId, deviceId, '♻️ 卡片已還原至 Backlog');
            await bumpVersion(deviceId);

            res.json({ success: true, card: serializeCard(result.rows[0]) });
        } catch (err) {
            console.error('[Kanban] Restore card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });


    // ============================================
    // POST /card/:id/move — Move card status
    // ============================================
    router.post('/card/:id/move', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] POST /card/:id/move called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, newStatus, assignedBots } = req.body;
        const cardId = req.params.id;

        if (!newStatus || !STATUSES.includes(newStatus)) {
            return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${STATUSES.join(', ')}` });
        }

        try {
            const existing = await pool.query(
                `SELECT * FROM kanban_cards WHERE id = $1 AND device_id = $2 AND archived = false`,
                [cardId, deviceId]
            );
            if (existing.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found or archived' });
            }

            const card = existing.rows[0];
            const oldStatus = card.status;

            // Done cards cannot be moved back
            if (oldStatus === 'done') {
                return res.status(400).json({ success: false, error: 'Done cards cannot be moved. Create a new card instead.' });
            }

            // Same status = no-op
            if (oldStatus === newStatus) {
                return res.status(400).json({ success: false, error: 'Card is already in this status' });
            }

            const bots = Array.isArray(assignedBots) ? assignedBots.map(Number) : (card.assigned_bots || []);
            if (bots.length === 0) {
                return res.status(400).json({ success: false, error: 'At least one entity must be assigned' });
            }

            // Reopened PR-linked cards that require PR rework must record the follow-up PR
            // before they can be closed again. Evidence-only reopens should leave
            // requires_pr_rework=false.
            if (newStatus === 'done' && card.requires_pr_rework && !card.rework_pr_number) {
                return res.status(400).json({
                    success: false,
                    error: 'Rework PR number required before moving this reopened card to Done',
                    code: 'REWORK_PR_REQUIRED'
                });
            }

            // Screenshot-review gate: block review/done transitions if no image attached.
            // Skip when card.requires_screenshot_review is explicitly false.
            if ((newStatus === 'review' || newStatus === 'done') && card.requires_screenshot_review !== false) {
                const shot = await pool.query(
                    `SELECT COUNT(*)::int AS cnt FROM kanban_files
                     WHERE card_id = $1 AND mime_type LIKE 'image/%'`,
                    [cardId]
                );
                if ((shot.rows[0]?.cnt || 0) === 0) {
                    return res.status(400).json({
                        success: false,
                        error: 'Screenshot review required',
                        hint: `此卡開啟了「截圖審查」，需先附上任務完成截圖才能移到 ${STATUS_LABELS[newStatus] || newStatus}。請用 POST /api/mission/card/${cardId}/file 帶 { url, filename, mimeType: "image/png" } 上傳 R2 截圖 URL。`,
                        code: 'SCREENSHOT_REQUIRED'
                    });
                }
            }

            // OODA-R Phase 1 #3c (+ #4 harden) — done-evidence gate.
            // Blocks any →done transition when the card has not accumulated
            // a composer-marker preflight comment + a subsequent 6-item
            // evidence comment + a PR link + the required artifact files
            // (jest log always; screenshot for P0/P1 UI cards). Bypass via
            // card.requires_preflight_review === false.
            if (newStatus === 'done' && card.requires_preflight_review !== false) {
                const [csRes, filesRes] = await Promise.all([
                    pool.query(
                        `SELECT text, is_system AS "isSystem", created_at AS "createdAt"
                         FROM kanban_comments
                         WHERE card_id = $1 AND device_id = $2
                         ORDER BY created_at ASC`,
                        [cardId, deviceId]
                    ),
                    pool.query(
                        `SELECT filename, mime_type, created_at
                         FROM kanban_files
                         WHERE card_id = $1 AND device_id = $2
                         ORDER BY created_at ASC`,
                        [cardId, deviceId]
                    ),
                ]);
                // Heuristic painTags via the classifier on title + description
                // so the gate knows whether to require a screenshot.
                let painTags = [];
                try {
                    const classifier = require('./agent-improvement/classifier');
                    painTags = classifier.classifyPainTags(
                        `${card.title || ''}\n\n${card.description || ''}`,
                        undefined,
                    );
                } catch (_) { /* classifier optional; gate falls back */ }
                const { evaluateDoneGate } = require('./agent-improvement/done-gate');
                const verdict = evaluateDoneGate({
                    oldStatus,
                    newStatus,
                    requiresPreflightReview: card.requires_preflight_review !== false,
                    comments: csRes.rows,
                    files: filesRes.rows,
                    severity: (card.priority || 'P2'),
                    painTags,
                });
                if (!verdict.allowed) {
                    return res.status(400).json({
                        success: false,
                        error: verdict.error,
                        hint: verdict.hint,
                        code: verdict.code,
                        missingItems: verdict.missingItems,
                    });
                }
            }

            // gated launch-gate auto-resets when status leaves backlog (only meaningful in backlog).
            const clearGate = oldStatus === 'backlog' && newStatus !== 'backlog' && card.gated === true;

            const result = await pool.query(
                `UPDATE kanban_cards
                 SET status = $1, assigned_bots = $2::jsonb, status_changed_at = NOW(),
                     last_stale_nudge_at = NULL, updated_at = NOW()
                     ${clearGate ? ', gated = FALSE, gate_reason = NULL' : ''}
                 WHERE id = $3 AND device_id = $4
                 RETURNING *`,
                [newStatus, JSON.stringify(bots), cardId, deviceId]
            );

            const updatedCard = serializeCard(result.rows[0]);

            if (clearGate) {
                await addSystemComment(cardId, deviceId,
                    `🔓 launch-gate 已自動關閉（離開 backlog → ${STATUS_LABELS[newStatus] || newStatus}）`);
            }

            // System comment
            const botLabel = bots.map(b => `#${b}`).join(', ') || '未指派';
            await addSystemComment(cardId, deviceId,
                `📌 狀態更新：${STATUS_LABELS[oldStatus]} → ${STATUS_LABELS[newStatus]}，指派給: ${botLabel}`);

            // Push notify new assigned bots
            if (bots.length > 0) {
                const direction = STATUSES.indexOf(newStatus) > STATUSES.indexOf(oldStatus) ? '➡️' : '⬅️';
                const lang = await getDeviceLanguage(deviceId);
                const msg = tKanban(lang, 'statusChanged', {
                    direction,
                    title: card.title,
                    from: statusLabel(lang, oldStatus),
                    to: statusLabel(lang, newStatus)
                });
                notifyEntities(deviceId, bots, msg, { description: card.description, cardId });
            }

            // Notify reviewer on /move → review (card_dfb65748c14680560c7bb873).
            // Auto-done speakTo path notifies reviewer separately via reviewerNotify;
            // manual /move had no reviewer ping, leaving cards in review until 6h escalation.
            if (newStatus === 'review' && updatedCard.reviewerEntityId != null && !bots.includes(updatedCard.reviewerEntityId)) {
                const lang = await getDeviceLanguage(deviceId);
                const reviewerMsg = tKanban(lang, 'reviewerMovedToReview', {
                    title: card.title,
                    from: statusLabel(lang, oldStatus)
                });
                notifyEntities(deviceId, [updatedCard.reviewerEntityId], reviewerMsg, { description: card.description, cardId, role: 'reviewer' });
            }

            // ── Owner-decision inbox auto-surface (子4) — failure-isolated ──
            // A parent-child card moving INTO review/blocked is classified for
            // genuine OWNER-ONLY signals (irreversible data / spend / product
            // direction / legal-PII / security policy / strategic tradeoff /
            // explicit flag). If owner-only AND not already surfaced, ONE
            // record-only「需要你決策」item is opened in the 需要你 inbox with the
            // commander's last comment as whatWasDone + PR/screenshot evidence.
            // The option set RECORDS Hank's choice only — NO auto-execute. Mirrors
            // the OODA-R preflight hook below: self-invoking async IIFE wrapped in
            // try/catch; a classifier or DB error NEVER blocks or fails the move.
            if (card.parent_card_id != null && ['review', 'blocked'].includes(newStatus) && oldStatus !== newStatus) {
                (async () => {
                    try {
                        if (typeof createActionRequest !== 'function') return;

                        // Latest non-system (commander) comment + all comment texts.
                        const cmtRes = await pool.query(
                            `SELECT text, is_system AS "isSystem", created_at AS "createdAt"
                             FROM kanban_comments
                             WHERE card_id = $1 AND device_id = $2
                             ORDER BY created_at ASC`,
                            [cardId, deviceId]
                        );
                        const comments = cmtRes.rows || [];
                        const lastHuman = [...comments].reverse().find(c => !c.isSystem);
                        const whatWasDone = (lastHuman && typeof lastHuman.text === 'string' ? lastHuman.text : '').slice(0, 1000);

                        // Evidence: PR URLs from any comment + image files on the card.
                        const evidence = [];
                        const seenPr = new Set();
                        const PR_RE = /https?:\/\/github\.com\/[^\s)]+\/pull\/\d+/gi;
                        for (const c of comments) {
                            const txt = typeof c.text === 'string' ? c.text : '';
                            let m;
                            while ((m = PR_RE.exec(txt)) !== null) {
                                if (!seenPr.has(m[0])) { seenPr.add(m[0]); evidence.push({ label: 'PR', url: m[0], kind: 'pr' }); }
                            }
                        }
                        const filesRes = await pool.query(
                            `SELECT url, filename FROM kanban_files
                             WHERE card_id = $1 AND device_id = $2 AND mime_type LIKE 'image/%'
                             ORDER BY created_at ASC`,
                            [cardId, deviceId]
                        );
                        for (const f of (filesRes.rows || [])) {
                            evidence.push({ label: f.filename || 'screenshot', url: f.url || null, kind: 'image' });
                        }

                        // painTags (best-effort) so the classifier can short-circuit
                        // a pure UI vision-check card.
                        let painTags = [];
                        try {
                            const classifier = require('./agent-improvement/classifier');
                            painTags = classifier.classifyPainTags(`${card.title || ''}\n\n${card.description || ''}`, undefined);
                        } catch (_) { /* classifier optional */ }

                        const { classifyCardOwnerDecision } = require('./agent-improvement/owner-decision-classifier');
                        const verdict = classifyCardOwnerDecision({
                            title: card.title || '',
                            description: card.description || '',
                            latestComment: whatWasDone,
                            gateReason: card.gate_reason || '',
                            requiresScreenshotReview: card.requires_screenshot_review === true,
                            painTags,
                        });
                        if (!verdict.ownerOnly) return;

                        // Dedup: skip if a pending request already references this card.
                        const dup = await pool.query(
                            `SELECT 1 FROM agent_action_requests
                             WHERE device_id = $1 AND related_card_id = $2 AND status = 'pending'
                             LIMIT 1`,
                            [deviceId, cardId]
                        );
                        if (dup.rows.length > 0) return;

                        // from_entity_id: the card's owner/assignee, else the mover, else 0.
                        const moverId = parseInt(req.body.entityId, 10);
                        const ownerId = (Array.isArray(bots) && bots.length && Number.isInteger(bots[0]))
                            ? bots[0]
                            : (Number.isInteger(moverId) && moverId >= 0 ? moverId : 0);

                        const headline = `需要你決策：「${card.title || cardId}」(${verdict.categories.join(', ') || 'owner-only'})`.slice(0, 2000);
                        await createActionRequest({
                            deviceId,
                            fromEntityId: ownerId,
                            type: 'decision',
                            prompt: headline,
                            options: ['核可', '退回', '延後'], // RECORD-ONLY — no auto-execute
                            relatedCardId: cardId,
                            decisionContext: {
                                whatWasDone,
                                recommendation: whatWasDone,
                                evidence,
                                recommendedOptionIndex: 0,
                            },
                        });
                        console.log(`[Kanban] owner-decision surfaced card=${cardId} cats=${verdict.categories.join(',')}`);
                    } catch (e) {
                        console.error('[Kanban] owner-decision hook error (non-blocking):', e.message);
                    }
                })();
            }

            // ── Owner-decision lifecycle (子6a) — failure-isolated ──
            // When a card LEAVES review/blocked, the surfaced decision is moot:
            // auto-dismiss any pending owner-decision request(s) for it (+ emit the
            // 'dismissed' socket event via the injected helper). Never blocks the move.
            if (typeof dismissActionRequestsForCard === 'function'
                && ['review', 'blocked'].includes(oldStatus)
                && !['review', 'blocked'].includes(newStatus)) {
                (async () => {
                    try {
                        await dismissActionRequestsForCard(deviceId, cardId);
                    } catch (e) {
                        console.error('[Kanban] owner-decision auto-dismiss error (non-blocking):', e.message);
                    }
                })();
            }

            await bumpVersion(deviceId);

            // OODA-R Phase 1 #3b — auto-fire preflight comment on todo→in_progress.
            // Pulls similar prior episodes via the same SQL the /preflight endpoint
            // uses, composes the markdown, and posts it as a system comment.
            // Failure-isolated: never blocks the move, never throws.
            if (oldStatus !== 'in_progress' && newStatus === 'in_progress') {
                (async () => {
                    try {
                        const ai = require('./agent-improvement');
                        const taxonomy = ai.classifyPainTags(
                            `${card.title || ''}\n\n${card.description || ''}`,
                            undefined,
                        );
                        const r = await pool.query(`
                            SELECT card_id AS "cardId", entity_id AS "entityId", task_type AS "taskType",
                                   pain_tags AS "painTags", deliverable, user_visible_result AS "userVisibleResult",
                                   evidence, missed_checks AS "missedChecks", user_feedback AS "userFeedback",
                                   severity, occurred_at AS "occurredAt"
                            FROM agent_improvement_episodes
                            WHERE device_id = $1 AND pain_tags ?| $2::text[]
                            ORDER BY occurred_at DESC LIMIT 100
                        `, [deviceId, taxonomy]);
                        const similar = ai.selectSimilarEpisodes(taxonomy, r.rows, 5);
                        const text = ai.composePreflightComment({
                            cardTitle: card.title || '',
                            cardDescription: card.description || '',
                            similarEpisodes: similar,
                        });
                        await addSystemComment(cardId, deviceId, text);
                    } catch (e) {
                        console.error('[Kanban] OODA-R preflight hook error (non-blocking):', e.message);
                    }
                })();
            }

            // Idle-dispatch hook (PR-B). emit() is a no-op when
            // IDLE_DISPATCH_HOOKS_ENABLED !== 'true'. Synchronous, never
            // throws (wrapped internally), and runs after the DB write +
            // notify so listeners see a durable transition.
            emitKanbanEvent('card_status_changed', {
                cardId,
                fromStatus: oldStatus,
                toStatus: newStatus,
                deviceId,
                entityId: req.body.entityId,
                ts: new Date().toISOString()
            });

            // Award XP for moving to done
            if (newStatus === 'done' && awardEntityXP) {
                for (const bot of bots) {
                    try { await awardEntityXP(deviceId, bot, 25); } catch (e) { /* ignore */ }
                }
            }

            // Smart-queue drain (card_dfe3b8df Phase 2): when a bot completes a
            // card, drain ONE oldest pending_notify entry for them so queued
            // cron-spawn child cards surface one-at-a-time as the bot frees up.
            if (newStatus === 'done') {
                for (const bot of bots) {
                    try {
                        const drained = await drainOnePendingNotify(deviceId, bot);
                        if (drained) {
                            console.log(`[Kanban] Smart-queue: drained one pending notify for bot #${bot} (card ${drained.card_id})`);
                        }
                    } catch (drainErr) {
                        console.error(`[Kanban] Smart-queue drain error for bot #${bot}:`, drainErr.message);
                    }
                }
            }

            // Device-level push: surface card-done events to the owner's web/FCM
            // push channel so completions don't only land in assigned-bot inboxes.
            // `kanban_done_auto` is a separate prefs key so users can mute the
            // chatty cron/auto-generated children without losing manual closures.
            if (newStatus === 'done' && typeof notifyDevice === 'function') {
                const isAuto = !!card.is_auto_generated;
                const doneCategory = isAuto ? 'kanban_done_auto' : 'kanban_done';
                // Stdout breadcrumb so "手機通知沒收到" can be diagnosed from
                // Railway logs: confirms the device-push dispatch path was
                // entered for this owner device + category. The downstream
                // sendWebPush/sendFcm outcomes log to server_logs (DB), so this
                // line is the only stdout evidence that the chain even fired.
                console.log(`[Kanban] move→done device-push dispatch: device=${deviceId} card=${cardId} category=${doneCategory}`);
                notifyDevice(deviceId, {
                    type: 'kanban',
                    category: doneCategory,
                    title: isAuto ? '✅ 自動任務完成' : '✅ 任務完成',
                    body: card.title,
                    link: `/portal/kanban.html?card=${cardId}`,
                    metadata: { cardId, isAuto, fromStatus: oldStatus }
                }).catch((e) => {
                    console.error(`[Kanban] move→done device-push dispatch failed: device=${deviceId} card=${cardId}:`, e.message);
                });
            }

            // If this is an auto-generated child card moving to Done → update parent
            if (newStatus === 'done' && card.is_auto_generated && card.parent_card_id) {
                console.log(`[Kanban] Child card ${cardId} done, updating parent ${card.parent_card_id}`);
                try {
                    const resultSummary = `✅ ${card.title} — Done`;
                    await pool.query(
                        `UPDATE kanban_cards SET 
                            last_run_result = $1, active_child_id = NULL, updated_at = NOW()
                         WHERE id = $2 AND device_id = $3`,
                        [resultSummary, card.parent_card_id, deviceId]
                    );
                    await addSystemComment(card.parent_card_id, deviceId,
                        `✅ 子卡完成: ${card.title}`);
                    console.log(`[Kanban] Parent ${card.parent_card_id} updated: lastRunResult="${resultSummary}", activeChildId=null`);
                } catch (parentErr) {
                    console.error(`[Kanban] Failed to update parent card ${card.parent_card_id}:`, parentErr.message);
                }
            }

            // P1: log operation for entity status drawer
            try {
                const entityStatus = require('./entity-status');
                const bots = Array.isArray(updatedCard.assignedBots) ? updatedCard.assignedBots : [];
                for (const botId of bots) {
                    entityStatus.logOperation(
                        deviceId, Number(botId), 'card_status',
                        `Card #${updatedCard.id} status ${oldStatus} → ${newStatus} (${(updatedCard.title || '').slice(0, 50)})`,
                        { card_id: updatedCard.id, title: updatedCard.title, status: newStatus, from: oldStatus }
                    );
                }
            } catch (e) { /* fire-and-forget */ }

            res.json({ success: true, card: updatedCard, transition: { from: oldStatus, to: newStatus } });
        } catch (err) {
            console.error('[Kanban] Move card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });


    // ============================================
    // POST /card/:id/reopen — Explicit Done-card reopen with reason + audit
    // ============================================
    router.post('/card/:id/reopen', async (req, res) => {
        if (!authenticate(req, res)) return;
        const params = { ...req.query, ...req.body };
        console.log('[Kanban] POST /card/:id/reopen called', { deviceId: params.deviceId, entityId: params.entityId, cardId: req.params?.id });
        const { deviceId, newStatus, reason, requiresPrRework, prNumber, reworkPrNumber } = params;
        const cardId = req.params.id;
        const actorEntityId = Number.parseInt(params.entityId || 0, 10) || 0;
        const hasDeviceSecretAuth = !!params.deviceSecret;
        const targetStatus = String(newStatus || '').trim();
        const reopenReason = String(reason || '').trim();
        const prValue = String(prNumber || reworkPrNumber || '').trim();
        const allowedTargets = STATUSES.filter(s => s !== 'done' && s !== 'backlog');

        if (!allowedTargets.includes(targetStatus)) {
            return res.status(400).json({ success: false, error: `Invalid reopen target. Must be one of: ${allowedTargets.join(', ')}` });
        }
        if (!reopenReason) {
            return res.status(400).json({ success: false, error: 'Reopen reason is required', code: 'REOPEN_REASON_REQUIRED' });
        }

        try {
            const existing = await pool.query(
                `SELECT * FROM kanban_cards WHERE id = $1 AND device_id = $2 AND archived = false`,
                [cardId, deviceId]
            );
            if (existing.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found or archived' });
            }

            const card = existing.rows[0];
            if (card.status !== 'done') {
                return res.status(400).json({ success: false, error: 'Only Done cards can be reopened', code: 'REOPEN_SOURCE_NOT_DONE' });
            }

            const isSupervisor = REOPEN_SUPERVISOR_ENTITY_IDS.has(actorEntityId);
            const isCreator = actorEntityId && Number(card.created_by) === actorEntityId;
            const isReviewer = actorEntityId && card.reviewer_entity_id != null && Number(card.reviewer_entity_id) === actorEntityId;
            const isDeviceOwner = hasDeviceSecretAuth && actorEntityId === 0;
            const requestedRequiresPrRework = requiresPrRework === true || requiresPrRework === 'true' || requiresPrRework === '1';
            const p0OrPrRework = card.priority === 'P0' || !!card.requires_pr_rework || requestedRequiresPrRework || !!prValue;
            const allowedByRole = isDeviceOwner || isSupervisor || isCreator || isReviewer;
            const allowedForStrictCard = isDeviceOwner || isSupervisor || isReviewer;
            if (!allowedByRole || (p0OrPrRework && !allowedForStrictCard)) {
                return res.status(403).json({
                    success: false,
                    error: 'Not authorized to reopen this Done card',
                    code: 'REOPEN_FORBIDDEN'
                });
            }

            const shouldRequirePrRework = requestedRequiresPrRework;
            const result = await pool.query(
                `UPDATE kanban_cards
                 SET status = $1,
                     status_changed_at = NOW(),
                     last_stale_nudge_at = NULL,
                     reopened_at = NOW(),
                     reopened_by = $2,
                     reopen_reason = $3,
                     requires_pr_rework = $4,
                     rework_pr_number = $5,
                     updated_at = NOW()
                 WHERE id = $6 AND device_id = $7
                 RETURNING *`,
                [targetStatus, actorEntityId || null, reopenReason, shouldRequirePrRework, prValue || null, cardId, deviceId]
            );
            const updatedCard = serializeCard(result.rows[0]);

            const actorLabel = actorEntityId ? `#${actorEntityId}` : 'device owner';
            const prText = shouldRequirePrRework
                ? (prValue ? `, requires_pr_rework=true, pr=${prValue}` : ', requires_pr_rework=true')
                : '';
            await addSystemComment(cardId, deviceId,
                `♻️ REOPENED from Done -> ${STATUS_LABELS[targetStatus] || targetStatus} by ${actorLabel}, reason: ${reopenReason}${prText}`);

            const bots = Array.isArray(card.assigned_bots) ? card.assigned_bots : [];
            if (bots.length > 0) {
                notifyEntities(deviceId, bots, `♻️ Card reopened: ${card.title}\nDone → ${STATUS_LABELS[targetStatus] || targetStatus}\nReason: ${reopenReason}`, { description: card.description, cardId });
            }
            if (updatedCard.reviewerEntityId != null && !bots.includes(updatedCard.reviewerEntityId)) {
                notifyEntities(deviceId, [updatedCard.reviewerEntityId], `♻️ Card reopened for review: ${card.title}\nReason: ${reopenReason}`, { description: card.description, cardId, role: 'reviewer' });
            }

            await bumpVersion(deviceId);
            emitKanbanEvent('card_status_changed', {
                cardId,
                fromStatus: 'done',
                toStatus: targetStatus,
                deviceId,
                entityId: actorEntityId,
                ts: new Date().toISOString(),
                reason: reopenReason,
                source: 'reopen'
            });

            res.json({ success: true, card: updatedCard, transition: { from: 'done', to: targetStatus }, reopened: true });
        } catch (err) {
            console.error('[Kanban] Reopen card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /card/:id/comments — List comments
    // ============================================
    router.get('/card/:id/comments', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const cardId = req.params.id;
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
        const offset = Math.max(0, parseInt(req.query.offset) || 0);

        try {
            // Verify card belongs to device
            const cardCheck = await pool.query(
                `SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (cardCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const totalResult = await pool.query(
                `SELECT COUNT(*)::int AS total FROM kanban_comments WHERE card_id = $1`,
                [cardId]
            );
            const total = totalResult.rows[0]?.total ?? 0;

            const result = await pool.query(
                `SELECT * FROM kanban_comments WHERE card_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3`,
                [cardId, limit, offset]
            );

            const comments = result.rows.map(r => ({
                id: r.id,
                fromEntityId: r.from_entity_id,
                text: r.text,
                isSystem: r.is_system,
                createdAt: new Date(r.created_at).getTime()
            }));

            res.json({ success: true, comments, total, limit, offset });
        } catch (err) {
            console.error('[Kanban] List comments error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });


    // ============================================
    // POST /card/:id/comment — Add comment
    // ============================================
    router.post('/card/:id/comment', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] POST /card/:id/comment called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, text, entityId, fromEntityId } = req.body;
        const cardId = req.params.id;
        const eId = parseInt(fromEntityId ?? entityId ?? 0);

        if (!text || !text.trim()) {
            return res.status(400).json({ success: false, error: 'Missing text' });
        }

        try {
            const cardCheck = await pool.query(
                `SELECT id, title, assigned_bots FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (cardCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const result = await pool.query(
                `INSERT INTO kanban_comments (card_id, device_id, from_entity_id, text, is_system)
                 VALUES ($1, $2, $3, $4, false)
                 RETURNING *`,
                [cardId, deviceId, eId, text.trim()]
            );

            // Bump card updated_at so "Recently Updated" sort surfaces the card.
            await pool.query(
                `UPDATE kanban_cards SET updated_at = NOW() WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );

            const comment = {
                id: result.rows[0].id,
                fromEntityId: result.rows[0].from_entity_id,
                text: result.rows[0].text,
                isSystem: false,
                createdAt: new Date(result.rows[0].created_at).getTime()
            };

            await bumpVersion(deviceId);

            res.json({ success: true, comment });

            // ── B. Notify @-mentioned entities (card_cc20541e) ──
            // ANTI-SPAM: only an @-mention triggers a push — a plain comment
            // notifies nobody (the create/move/reopen paths already cover
            // assignment-time pings). Fired AFTER res.json so notify latency
            // never delays the comment response; wrapped so a failure can't
            // surface as an unhandled rejection. The mentioned entity gets the
            // comment text itself as the actionable brief (latestComment).
            try {
                const commentText = result.rows[0].text;
                const mentionedIds = resolveCommentMentions(deviceId, commentText)
                    // Don't ping a bot for its OWN comment.
                    .filter(id => id !== eId);
                if (mentionedIds.length > 0) {
                    const lang = await getDeviceLanguage(deviceId);
                    const msg = tKanban(lang, 'commentMention', { title: cardCheck.rows[0].title });
                    for (const mentionedId of mentionedIds) {
                        notifyEntities(deviceId, [mentionedId], msg, {
                            cardId,
                            latestComment: commentText,
                        });
                    }
                }
            } catch (notifyErr) {
                console.error('[Kanban] comment-mention notify failed:', notifyErr.message);
            }
        } catch (err) {
            console.error('[Kanban] Add comment error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /card/:id/notes — List notes
    // ============================================
    router.get('/card/:id/notes', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const cardId = req.params.id;

        try {
            const cardCheck = await pool.query(
                `SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (cardCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const result = await pool.query(
                `SELECT * FROM kanban_notes WHERE card_id = $1 ORDER BY created_at DESC`,
                [cardId]
            );

            const notes = result.rows.map(r => ({
                id: r.id,
                title: r.title,
                content: r.content,
                fromEntityId: r.from_entity_id,
                createdAt: new Date(r.created_at).getTime(),
                updatedAt: new Date(r.updated_at).getTime()
            }));

            res.json({ success: true, notes });
        } catch (err) {
            console.error('[Kanban] List notes error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });


    // ============================================
    // POST /card/:id/note — Add note
    // ============================================
    router.post('/card/:id/note', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] POST /card/:id/note called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, title, content, entityId, fromEntityId } = req.body;
        const cardId = req.params.id;
        const eId = parseInt(fromEntityId ?? entityId ?? 0);

        if (!content || !content.trim()) {
            return res.status(400).json({ success: false, error: 'Missing content' });
        }

        try {
            const cardCheck = await pool.query(
                `SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (cardCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const result = await pool.query(
                `INSERT INTO kanban_notes (card_id, device_id, title, content, from_entity_id)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING *`,
                [cardId, deviceId, (title || '').trim(), content.trim(), eId]
            );

            // Bump card updated_at so "Recently Updated" sort surfaces the card.
            await pool.query(
                `UPDATE kanban_cards SET updated_at = NOW() WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );

            const note = {
                id: result.rows[0].id,
                title: result.rows[0].title,
                content: result.rows[0].content,
                fromEntityId: result.rows[0].from_entity_id,
                createdAt: new Date(result.rows[0].created_at).getTime(),
                updatedAt: new Date(result.rows[0].updated_at).getTime()
            };

            await bumpVersion(deviceId);
            res.json({ success: true, note });
        } catch (err) {
            console.error('[Kanban] Add note error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /card/:id/files — List files
    // ============================================
    router.get('/card/:id/files', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const cardId = req.params.id;

        try {
            const cardCheck = await pool.query(
                `SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (cardCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const result = await pool.query(
                `SELECT * FROM kanban_files WHERE card_id = $1 ORDER BY created_at DESC`,
                [cardId]
            );

            const files = await Promise.all(result.rows.map(mapCardFileRow));

            res.json({ success: true, files });
        } catch (err) {
            console.error('[Kanban] List files error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });


    // ============================================
    // POST /card/:id/file — Add file (URL-based)
    // ============================================
    router.post('/card/:id/file', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] POST /card/:id/file called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id, fileId: _p.fileId });
        const { deviceId, entityId } = req.body;
        let { fileId, filename, url, mimeType, fileSize } = req.body;
        const cardId = req.params.id;
        const uploadedBy = parseInt(entityId || 0);

        // Preferred path: caller passes fileId from /api/files/upload. Server
        // hydrates filename/mime/size from r2_files so the attachment always
        // resolves via a freshly-signed URL on every read, never an expired one.
        if (fileId) {
            const r2row = await pool.query(
                'SELECT filename, mime_type, size FROM r2_files WHERE file_id = $1 AND device_id = $2 AND expires_at > NOW()',
                [fileId, deviceId]
            );
            if (!r2row.rows.length) {
                return res.status(404).json({ success: false, error: 'fileId not found in r2_files or expired' });
            }
            filename = filename || r2row.rows[0].filename;
            mimeType = mimeType || r2row.rows[0].mime_type;
            fileSize = fileSize || parseInt(r2row.rows[0].size);
            // Stored url is always the opaque cache when file_id is set — any
            // `url` the caller passed (possibly a raw R2 signed URL that would
            // leak) is discarded. GET regenerates from fileId on every read.
            url = `r2:${fileId}`;
        }

        if (!filename || !url) {
            return res.status(400).json({ success: false, error: 'Missing filename or url (or fileId)' });
        }

        try {
            const cardCheck = await pool.query(
                `SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (cardCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const result = await pool.query(
                `INSERT INTO kanban_files (card_id, device_id, filename, url, mime_type, file_size, uploaded_by, file_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING *`,
                [cardId, deviceId, filename, url, mimeType || null, fileSize || null, uploadedBy, fileId || null]
            );

            // Bump card updated_at so "Recently Updated" sort surfaces the card.
            await pool.query(
                `UPDATE kanban_cards SET updated_at = NOW() WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );

            const file = await mapCardFileRow(result.rows[0]);

            await bumpVersion(deviceId);
            res.json({ success: true, file });
        } catch (err) {
            console.error('[Kanban] Add file error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // PUT /card/:id/config — Update thresholds
    // ============================================
    router.put('/card/:id/config', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] PUT /card/:id/config called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, staleThresholdMs, doneRetentionMs, isAutomation } = req.body;
        const cardId = req.params.id;

        try {
            const updates = [];
            const params = [];
            let paramIdx = 1;

            if (staleThresholdMs !== undefined) {
                const val = parseInt(staleThresholdMs);
                if (isNaN(val) || val < 600000) { // min 10 minutes
                    return res.status(400).json({ success: false, error: 'staleThresholdMs must be >= 600000 (10 min)' });
                }
                updates.push(`stale_threshold_ms = $${paramIdx++}`);
                params.push(val);
            }
            if (doneRetentionMs !== undefined) {
                const val = parseInt(doneRetentionMs);
                if (isNaN(val) || val < 3600000) { // min 1 hour
                    return res.status(400).json({ success: false, error: 'doneRetentionMs must be >= 3600000 (1 hr)' });
                }
                updates.push(`done_retention_ms = $${paramIdx++}`);
                params.push(val);
            }
            if (isAutomation !== undefined) {
                updates.push(`is_automation = $${paramIdx++}`);
                params.push(!!isAutomation);
                console.log(`[Kanban] Config: set is_automation=${!!isAutomation} for card ${cardId}`);
            }

            if (updates.length === 0) {
                return res.status(400).json({ success: false, error: 'Nothing to update' });
            }

            updates.push(`updated_at = NOW()`);
            params.push(cardId);
            params.push(deviceId);

            const result = await pool.query(
                `UPDATE kanban_cards SET ${updates.join(', ')}
                 WHERE id = $${paramIdx++} AND device_id = $${paramIdx++}
                 RETURNING *`,
                params
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            res.json({ success: true, card: serializeCard(result.rows[0]) });
        } catch (err) {
            console.error('[Kanban] Config card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // PUT /card/:id/schedule — Set schedule
    // ============================================
    router.put('/card/:id/schedule', async (req, res) => {
        if (!authenticate(req, res)) return;
        const _p = { ...req.query, ...req.body }; console.log('[Kanban] PUT /card/:id/schedule called', { deviceId: _p.deviceId, entityId: _p.entityId, cardId: req.params?.id });
        const { deviceId, enabled, type, cronExpression, runAt, timezone, skipIf5hUsagePctOver, skipIf7dUsagePctOver } = req.body;
        const cardId = req.params.id;

        try {
            const existing = await pool.query(
                `SELECT * FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (existing.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const schedEnabled = enabled !== false;
            const schedType = (type === 'once' || type === 'recurring') ? type : null;
            const tz = timezone || 'Asia/Taipei';

            if (schedEnabled && !schedType) {
                return res.status(400).json({ success: false, error: 'Schedule type must be "once" or "recurring"' });
            }

            let nextRunAt = null;

            if (schedEnabled && schedType === 'once') {
                if (!runAt) {
                    return res.status(400).json({ success: false, error: 'Missing runAt for once schedule' });
                }
                nextRunAt = new Date(runAt);
                if (isNaN(nextRunAt.getTime())) {
                    return res.status(400).json({ success: false, error: 'Invalid runAt timestamp' });
                }
            }

            if (schedEnabled && schedType === 'recurring') {
                if (!cronExpression) {
                    return res.status(400).json({ success: false, error: 'Missing cronExpression for recurring schedule' });
                }
                // Validate cron expression
                nextRunAt = computeNextRun(cronExpression, tz);
                if (!nextRunAt) {
                    return res.status(400).json({ success: false, error: 'Invalid cronExpression' });
                }
            }

            // card_c2635849: per-card usage-quota thresholds. Validate at the
            // write boundary so bad input rejects HTTP 400 instead of silently
            // clamping. Omitted fields keep the existing column value (NULL →
            // falls back to default at fire time via clampUsageThreshold).
            let newSkip5h = existing.rows[0].schedule_skip_if_5h_pct_over;
            let newSkip7d = existing.rows[0].schedule_skip_if_7d_pct_over;
            if (skipIf5hUsagePctOver !== undefined) {
                if (!isValidUsageThreshold(skipIf5hUsagePctOver)) {
                    return res.status(400).json({
                        success: false,
                        error: 'skipIf5hUsagePctOver must be an integer in [50, 99]'
                    });
                }
                newSkip5h = Number(skipIf5hUsagePctOver);
            }
            if (skipIf7dUsagePctOver !== undefined) {
                if (!isValidUsageThreshold(skipIf7dUsagePctOver)) {
                    return res.status(400).json({
                        success: false,
                        error: 'skipIf7dUsagePctOver must be an integer in [50, 99]'
                    });
                }
                newSkip7d = Number(skipIf7dUsagePctOver);
            }

            // recurring schedule → auto-promote to automation card
            const autoPromote = schedEnabled && schedType === 'recurring';

            const result = await pool.query(
                `UPDATE kanban_cards SET
                    schedule_enabled = $1,
                    schedule_type = $2,
                    schedule_cron = $3,
                    schedule_run_at = $4,
                    schedule_timezone = $5,
                    schedule_next_run_at = $6,
                    schedule_skip_if_5h_pct_over = $7,
                    schedule_skip_if_7d_pct_over = $8,
                    ${autoPromote ? 'is_automation = TRUE,' : ''}
                    updated_at = NOW()
                 WHERE id = $9 AND device_id = $10
                 RETURNING *`,
                [
                    schedEnabled,
                    schedType,
                    schedType === 'recurring' ? cronExpression : null,
                    schedType === 'once' ? nextRunAt : null,
                    tz,
                    nextRunAt,
                    newSkip5h,
                    newSkip7d,
                    cardId,
                    deviceId
                ]
            );

            if (autoPromote && !existing.rows[0].is_automation) {
                console.log(`[Kanban] Auto-promoted card ${cardId} to automation (recurring schedule)`);
            }

            const card = serializeCard(result.rows[0]);
            await bumpVersion(deviceId);

            const schedLabel = schedType === 'once'
                ? `一次性排程：${nextRunAt.toISOString()}`
                : `重複排程：${cronExpression} (${tz})`;
            await addSystemComment(cardId, deviceId,
                `🗓️ ${schedEnabled ? '排程已設定' : '排程已停用'} — ${schedEnabled ? schedLabel : ''}`);

            res.json({ success: true, card });
        } catch (err) {
            console.error('[Kanban] Schedule card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // PUT /card/:id/gate — Toggle backlog launch-gate
    // When gated=true, L1/L2/L3 staleness escalation skips this card.
    // App auto-resets gated=false on any status change out of backlog (see /move).
    // ============================================
    router.put('/card/:id/gate', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, enabled, reason } = req.body;
        const cardId = req.params.id;

        try {
            const existing = await pool.query(
                `SELECT * FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (existing.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const gateOn = enabled !== false;

            // Launch-gate is backlog-only by design (suppresses L1/L2/L3 for cards
            // pending launch). Allow enabled=false on any status (so a stale gate
            // can always be cleared), but enabled=true only on backlog cards.
            if (gateOn && existing.rows[0].status !== 'backlog') {
                return res.status(400).json({
                    success: false,
                    error: 'Launch-gate is only available for backlog cards',
                    code: 'GATE_BACKLOG_ONLY',
                    hint: `Current status: ${existing.rows[0].status}. Move the card to backlog before enabling the gate, or clear the gate (enabled=false) without status restriction.`
                });
            }

            const gateReason = gateOn && typeof reason === 'string' && reason.trim()
                ? reason.trim().slice(0, 255)
                : null;

            const result = await pool.query(
                `UPDATE kanban_cards SET
                    gated = $1,
                    gate_reason = $2,
                    updated_at = NOW()
                 WHERE id = $3 AND device_id = $4
                 RETURNING *`,
                [gateOn, gateReason, cardId, deviceId]
            );

            const card = serializeCard(result.rows[0]);
            await bumpVersion(deviceId);

            await addSystemComment(cardId, deviceId,
                gateOn
                    ? `🔒 已啟用 launch-gate — L1/L2/L3 自動升級暫停${gateReason ? `（${gateReason}）` : ''}`
                    : `🔓 已關閉 launch-gate — 恢復自動升級`);

            res.json({ success: true, card });
        } catch (err) {
            console.error('[Kanban] Gate card error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // GET /card/:id/children — List child cards (automation history)
    // ============================================
    router.get('/card/:id/children', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId } = { ...req.query, ...req.body };
        const parentId = req.params.id;

        try {
            const parentCheck = await pool.query(
                `SELECT id, is_automation FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [parentId, deviceId]
            );
            if (parentCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const result = await pool.query(
                `SELECT c.*,
                    COALESCE(cm.cnt, 0) AS comment_count,
                    COALESCE(n.cnt, 0) AS note_count,
                    COALESCE(f.cnt, 0) AS file_count
                FROM kanban_cards c
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_comments GROUP BY card_id) cm ON cm.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_notes GROUP BY card_id) n ON n.card_id = c.id
                LEFT JOIN (SELECT card_id, COUNT(*) AS cnt FROM kanban_files GROUP BY card_id) f ON f.card_id = c.id
                WHERE c.parent_card_id = $1 AND c.device_id = $2
                ORDER BY c.created_at DESC`,
                [parentId, deviceId]
            );

            const children = result.rows.map(serializeCard);
            console.log(`[Kanban] GET /card/${parentId}/children: ${children.length} child cards`);
            res.json({ success: true, children, total: children.length });
        } catch (err) {
            console.error('[Kanban] List children error:', err.message, err.stack);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================
    // Background Timers: Stale Nudge + Auto-Archive + Schedule
    // ============================================

    let bgTimer = null;
    const BG_CHECK_INTERVAL = 5 * 60 * 1000;        // Unified check every 5 minutes
    // Nudge-gap is now per-device (kanban_nudge_interval_minutes, default 3h).

    /**
     * Unified background tick: stale nudge + auto-archive + schedule triggers + pending dispatch retry.
     */
    async function backgroundTick() {
        await checkStaleCards();
        await checkDoneAutoArchive();
        await checkScheduleTriggers();
        await checkPendingDispatch();
    }

    // #1701: Escalation thresholds (can be overridden per-card via config.escalationPolicy)
    const DEFAULT_ESCALATE_MS = 6 * 3600 * 1000;  // 6 hours → priority upgrade
    const DEFAULT_BLOCK_MS = 12 * 3600 * 1000;     // 12 hours → move to blocked

    /**
     * Scan for stale cards (TODO / In Progress / Review) that exceeded staleThresholdMs.
     * #1701: Three escalation levels:
     *   1. Nudge (>staleThreshold, default 3h) — system comment + notification
     *   2. Escalate (>6h) — auto-upgrade priority (P2→P1) + notify reviewer
     *      Severity gate (card_22ab8c3b path #2, follow-up to PR #3564): a P3
     *      card in `backlog` is a design-first draft awaiting launch — do NOT
     *      auto-upgrade it to P2 just because it has been sitting. Returns
     *      false so the card falls through to the L1 nudge path instead.
     *   3. Block (>12h) — move to blocked status + system comment
     *      Severity gate (same card): a P0 card means "fix now, supervisor's
     *      attention" — silently moving it to `blocked` hides it from the
     *      active board. Instead fire a heightened L1 nudge with a P0-stalled
     *      prefix + supervisor notification; state stays in_progress.
     * Also checks for orphaned rental bot assignments.
     */
    // Sort stale cards by user-chosen priority mode (see device_preferences.kanban_nudge_priority_mode).
    function sortCardsByNudgeMode(cards, mode) {
        const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
        const STATUS_RANK = { review: 0, in_progress: 1, todo: 2 };
        const byPri = (a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
        const byStatus = (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
        const byAge = (a, b) => new Date(a.status_changed_at) - new Date(b.status_changed_at);
        if (mode === 'column_first') {
            cards.sort((a, b) => byStatus(a, b) || byAge(a, b));
        } else if (mode === 'column_level') {
            cards.sort((a, b) => byStatus(a, b) || byPri(a, b) || byAge(a, b));
        } else {  // 'priority_first' (default)
            cards.sort((a, b) => byPri(a, b) || byAge(a, b));
        }
        return cards;
    }

    async function checkStaleCards() {
        try {
            // Fetch stale candidates WITHOUT the global nudge-gap filter; we apply
            // per-device nudge interval + status filter (from device_preferences) below.
            // backlog (待排程) is EXCLUDED here: backlog = intentionally parked / "not
            // now", so a parked card must never be flood re-nudged "please continue"
            // (owner-reported zombie nudge, card_3e95f4c1: a parked #6 recurring-driver
            // card and a parked daily-E2E card re-nudged every ~17 min for 7+ hours each).
            // Only actively-worked statuses (todo / in_progress / review) get stale
            // nudges; done + archived are already excluded (status filter + the
            // archived = false guard). This extends the #3781 hygiene that stopped
            // re-nudging archived/done parents — now to parked backlog cards too.
            // Backlog cards stay fully visible on the board; this only stops the active
            // re-nudge pings, not their board presence.
            // Skip recurring-schedule automation parents: their status_changed_at never
            // moves (cron creates child cards instead), so they would always look stale
            // and get escalated to P0 every staleThresholdMs window. Mirrors the same
            // filter used in checkDoneAutoArchive below.
            // Also skip single-shot (type='once') scheduled cards whose run_at is still
            // in the future: those cards are deliberately parked in todo waiting for the
            // scheduled fire time, not stalled. Without this guard, a card scheduled for
            // tomorrow 10:00 starts firing 🚨 P0 stalled the moment status_changed_at
            // crosses stale_threshold_ms (typical 3h), 14h before its actual run time.
            // Once run_at passes (timer fires or window elapses without fire), the card
            // falls back into stale eligibility — preserves L1/L2/L3 safety rails for
            // actually-stuck post-runAt cards.
            const result = await pool.query(`
                SELECT * FROM kanban_cards
                WHERE archived = false
                  AND status IN ('todo', 'in_progress', 'review')
                  AND EXTRACT(EPOCH FROM (NOW() - status_changed_at)) * 1000 > stale_threshold_ms
                  AND (schedule_enabled = false OR schedule_type != 'recurring' OR schedule_enabled IS NULL)
                  AND NOT (
                    schedule_enabled = true
                    AND schedule_type = 'once'
                    AND schedule_run_at IS NOT NULL
                    AND schedule_run_at > NOW()
                  )
                  -- Suppress nudges on orphaned children of a stopped parent:
                  -- if the parent card is archived (any child) or the parent is
                  -- DONE and this is a cron-spawned child (is_auto_generated),
                  -- the work-stream was stopped by the owner — re-nudging the
                  -- entity to finish it just floods the supervisor. The parent's
                  -- own schedule is auto-disabled in checkScheduleTriggers; this
                  -- mirrors that for the already-spawned children.
                  AND NOT EXISTS (
                    SELECT 1 FROM kanban_cards parent
                    WHERE parent.id = kanban_cards.parent_card_id
                      AND (
                        parent.archived = true
                        OR (parent.status = 'done' AND kanban_cards.is_auto_generated = true)
                      )
                  )
            `);

            if (result.rows.length === 0) return;

            // Group candidates by device so each device's prefs (batch size, priority
            // mode, interval) apply uniformly. Escalate/Block (Levels 2/3) run first
            // for every candidate because they are clock-triggered safety rails —
            // batch size only limits standard Level-1 nudges.
            const byDevice = new Map();
            for (const card of result.rows) {
                if (!byDevice.has(card.device_id)) byDevice.set(card.device_id, []);
                byDevice.get(card.device_id).push(card);
            }

            for (const [deviceId, cards] of byDevice) {
                await processDeviceStaleCards(deviceId, cards);
            }
        } catch (err) {
            console.error('[Kanban] Stale check error:', err.message);
        }
    }

    async function processDeviceStaleCards(deviceId, cards) {
        const basePrefs = await devicePrefs.getPrefs(deviceId).catch(() => ({}));
        // Device-wide-only settings (NOT per-entity overridable): batch size + priority sort.
        const batchSize = Math.max(1, Math.min(20, Number(basePrefs.kanban_nudge_batch_size) || 1));
        const priorityMode = basePrefs.kanban_nudge_priority_mode || 'priority_first';
        const baseIntervalMs = Math.max(5, Number(basePrefs.kanban_nudge_interval_minutes) || 180) * 60 * 1000;
        const basePerEntityThrottle = basePrefs.kanban_nudge_per_entity_throttle !== false;
        const baseStopMode = basePrefs.kanban_nudge_stop_mode === true;
        const baseStatuses = new Set(
            Array.isArray(basePrefs.kanban_nudge_statuses) && basePrefs.kanban_nudge_statuses.length
                ? basePrefs.kanban_nudge_statuses
                : KanbanStatus.NUDGE_DEFAULT_STATUSES
        );

        // Auto-escalation toggles (card_a0c2bc798affdf0a6310f5bb / Hank-direct).
        // Master switch defaults true; automation-skip defaults true. Both gate ONLY
        // the clock-triggered L2/L3 ladder below — L1 standard nudges always run so
        // skipped cards are never forgotten.
        const autoEscalateEnabled = basePrefs.kanban_auto_escalate_enabled !== false;            // default true
        const skipAutomationEscalation = basePrefs.kanban_auto_escalate_skip_automation !== false; // default true
        // A card counts as "automation" for escalation-skip if it's a cron母卡
        // (is_automation) OR a cron-spawned child (is_auto_generated, the
        // "[Auto] … (date)" rows). The child INSERT sets is_auto_generated=true but
        // NOT is_automation, and the child cards are the ones flooding the supervisor
        // with "🚨 P0 stalled" pings — so both flags must be checked here.
        const isAutomationCard = (card) => card.is_automation === true || card.is_auto_generated === true;

        // Phase 2 (kanban-nudge-spec.md §6): per-entity overrides.
        // Cached resolution keyed on entityId, computed once per tick.
        const entityPrefsCache = new Map();
        function effectiveFor(entityId) {
            const bid = Number(entityId);
            if (entityPrefsCache.has(bid)) return entityPrefsCache.get(bid);
            const merged = devicePrefs.mergeEntityOverride(basePrefs, bid);
            const ep = {
                intervalMs: Math.max(5, Number(merged.kanban_nudge_interval_minutes) || 180) * 60 * 1000,
                statuses: new Set(
                    Array.isArray(merged.kanban_nudge_statuses) && merged.kanban_nudge_statuses.length
                        ? merged.kanban_nudge_statuses
                        : KanbanStatus.NUDGE_DEFAULT_STATUSES
                ),
                perEntityThrottle: merged.kanban_nudge_per_entity_throttle !== false,
                stopMode: merged.kanban_nudge_stop_mode === true,
            };
            entityPrefsCache.set(bid, ep);
            return ep;
        }

        // Per-card: merge across assigned bots.
        //   intervalMs   = MIN (fastest cadence wins — any bot wanting sooner pulls the card forward)
        //   statuses     = UNION (card eligible if any assigned bot cares about this status)
        //   perEntityThrottle = OR (if any bot wants throttle, throttle to avoid dup pushes)
        // Cards with no assigned_bots fall back to device base.
        function cardEffective(card) {
            const bots = (card.assigned_bots || []).map(Number).filter(Number.isFinite);
            if (bots.length === 0) {
                return {
                    intervalMs: baseIntervalMs,
                    statusEligible: !baseStopMode && baseStatuses.has(card.status),
                    perEntityThrottle: basePerEntityThrottle,
                    recipientBots: [],
                };
            }
            let minInterval = Infinity;
            let statusEligible = false;
            let anyThrottle = false;
            const recipientBots = [];
            for (const bid of bots) {
                const ep = effectiveFor(bid);
                if (ep.stopMode) continue;
                recipientBots.push(bid);
                if (ep.intervalMs < minInterval) minInterval = ep.intervalMs;
                if (ep.statuses.has(card.status)) statusEligible = true;
                if (ep.perEntityThrottle) anyThrottle = true;
            }
            if (recipientBots.length === 0) {
                return {
                    intervalMs: baseIntervalMs,
                    statusEligible: false,
                    perEntityThrottle: basePerEntityThrottle,
                    recipientBots,
                };
            }
            return {
                intervalMs: Number.isFinite(minInterval) ? minInterval : baseIntervalMs,
                statusEligible,
                perEntityThrottle: anyThrottle,
                recipientBots,
            };
        }

        function filterNudgeStoppedRecipients(ids) {
            const seen = new Set();
            const out = [];
            for (const id of ids || []) {
                const n = Number(id);
                if (!Number.isFinite(n) || seen.has(n)) continue;
                seen.add(n);
                if (effectiveFor(n).stopMode) continue;
                out.push(n);
            }
            return out;
        }

        // Status filter applies to ALL levels — if status falls outside every recipient's
        // allowed_statuses (after overrides), no auto-escalation happens either.
        let eligible = cards.filter(c => cardEffective(c).statusEligible);
        if (eligible.length === 0) return;

        // Dependency gating (kanban_card_dependencies): skip cards whose `blocks`-type
        // dependencies point at a blocker still pending (status NOT IN done/archived).
        // Queried live — the dependency_status column's trigger only fires on edits to
        // kanban_card_dependencies, so it goes stale when the blocker card itself moves.
        // Suppresses L1/L2/L3 uniformly so a dependent card never gets nudged or
        // auto-bumped/auto-blocked while its blocker is still in flight.
        //
        // For cards whose blockers are NOW resolved, also reset the effective stale
        // clock to max(status_changed_at, latest blocker resolution time) so the card
        // re-enters the L1 → L2 → L3 cadence from the moment it became actionable,
        // not from the original creation time (#1 review on PR #2904: a card that
        // waited >12h must not skip straight to L3 the moment its blocker finishes).
        const depGating = await loadDependencyGating(deviceId, eligible.map(c => c.id));
        if (depGating.blocked.size > 0) {
            eligible = eligible.filter(c => !depGating.blocked.has(c.id));
            if (eligible.length === 0) return;
        }

        function effectiveStaleSinceMs(card) {
            const cardChangedMs = new Date(card.status_changed_at).getTime();
            const unblockedAtMs = depGating.unblockedSince.get(card.id);
            return unblockedAtMs && unblockedAtMs > cardChangedMs ? unblockedAtMs : cardChangedMs;
        }

        // Split: cards ready for Level 2/3 (time-based) fire regardless of batch size.
        const level1Pending = [];
        for (const card of eligible) {
            const ce = cardEffective(card);
            const intervalMs = ce.intervalMs;
            const elapsedMs = Date.now() - effectiveStaleSinceMs(card);
            const config = card.config || {};
            const esc = config.escalationPolicy || {};
            const escalateAfterMs = esc.escalateAfterMs || DEFAULT_ESCALATE_MS;
            const blockAfterMs = esc.blockAfterMs || DEFAULT_BLOCK_MS;

            // Level 2/3 honor the per-card effective intervalMs to avoid re-firing on the same tick.
            const sinceLast = card.last_stale_nudge_at
                ? Date.now() - new Date(card.last_stale_nudge_at).getTime()
                : Infinity;

            // Auto-escalation gate (card_a0c2bc798affdf0a6310f5bb): suppress the
            // L2/L3 ladder when the master switch is off, or (default) when this is
            // an automation card and skip-automation is on. The card still falls
            // through to the L1 push below so it isn't forgotten — only the
            // priority-bump / P0-stalled-ping / auto-block escalations are skipped.
            const escalationAllowed = autoEscalateEnabled && !(skipAutomationEscalation && isAutomationCard(card));

            if (escalationAllowed) {
                if (elapsedMs >= blockAfterMs && card.status !== 'blocked' && sinceLast > intervalMs) {
                    await fireBlockEscalation(card, filterNudgeStoppedRecipients(buildEscalationRecipients(card)));
                    continue;
                }
                if (elapsedMs >= escalateAfterMs && sinceLast > intervalMs) {
                    const fired = await fireLevelTwoEscalation(card, filterNudgeStoppedRecipients(buildEscalationRecipients(card)));
                    if (fired) continue;
                }
            }
            // Level 1 candidate if enough interval has passed.
            if (sinceLast > intervalMs) level1Pending.push(card);
        }

        if (level1Pending.length === 0) return;

        // Per-entity throttle: skip Level-1 cards whose recipient bots all got
        // nudged within their effective intervalMs (using per-entity overrides).
        const anyThrottleNeeded = level1Pending.some(c => cardEffective(c).perEntityThrottle);
        const lastByEntity = anyThrottleNeeded ? await loadEntityNudgeLog(deviceId) : null;
        const sortedCandidates = sortCardsByNudgeMode(level1Pending, priorityMode);
        const picked = [];
        const willNudgeEntity = new Set();
        for (const card of sortedCandidates) {
            if (picked.length >= batchSize) break;
            const ce = cardEffective(card);
            if (!ce.recipientBots.length) continue;
            const throttleCard = { ...card, assigned_bots: ce.recipientBots };
            if (ce.perEntityThrottle && !cardHasFreshRecipient(throttleCard, lastByEntity, willNudgeEntity, effectiveFor, baseIntervalMs)) {
                continue;
            }
            picked.push({ card, recipients: ce.recipientBots });
            for (const bid of ce.recipientBots) willNudgeEntity.add(Number(bid));
        }

        if (picked.length === 0) return;

        const overrideCount = Object.keys(basePrefs.kanban_nudge_per_entity_overrides || {}).length;
        console.log(`[Kanban] Stale nudge for ${deviceId}: ${picked.length}/${level1Pending.length} (mode=${priorityMode}, batch=${batchSize}, baseInterval=${baseIntervalMs / 60000}m, perEntityOverrides=${overrideCount})`);

        for (const item of picked) {
            await fireLevelOneNudge(item.card, item.recipients);
        }
    }

    async function loadEntityNudgeLog(deviceId) {
        const map = new Map();
        try {
            const r = await pool.query(
                `SELECT entity_id, last_nudged_at FROM kanban_entity_nudge_log WHERE device_id = $1`,
                [deviceId]
            );
            for (const row of r.rows) {
                map.set(Number(row.entity_id), new Date(row.last_nudged_at).getTime());
            }
        } catch (err) {
            console.error('[Kanban] loadEntityNudgeLog error:', err.message);
        }
        return map;
    }

    async function loadDependencyGating(deviceId, cardIds) {
        // Returns { blocked: Set<cardId>, unblockedSince: Map<cardId, msTimestamp> }
        //
        // blocked          — cards with at least one `blocks` dep whose target is
        //                    NOT IN ('done','archived'). Skip nudge entirely.
        // unblockedSince   — for cards whose blockers ARE all resolved, the
        //                    MAX(status_changed_at) of those resolved blockers.
        //                    Used to reset the effective stale clock so a card
        //                    that waited >12h doesn't skip straight to L3 the
        //                    moment its blocker finishes (#1 review on PR #2904).
        const result = { blocked: new Set(), unblockedSince: new Map() };
        if (!Array.isArray(cardIds) || cardIds.length === 0) return result;
        try {
            const r = await pool.query(
                `SELECT d.card_id,
                        BOOL_OR(dep.status NOT IN ('done', 'archived')) AS has_pending,
                        MAX(dep.status_changed_at) FILTER (WHERE dep.status IN ('done', 'archived')) AS latest_resolved_at
                   FROM kanban_card_dependencies d
                   JOIN kanban_cards dep
                     ON dep.id = d.depends_on_card_id
                    AND dep.device_id = d.device_id
                  WHERE d.device_id = $1
                    AND d.dependency_type = 'blocks'
                    AND d.card_id = ANY($2::varchar[])
                  GROUP BY d.card_id`,
                [deviceId, cardIds]
            );
            for (const row of r.rows) {
                if (row.has_pending) {
                    result.blocked.add(row.card_id);
                } else if (row.latest_resolved_at) {
                    result.unblockedSince.set(row.card_id, new Date(row.latest_resolved_at).getTime());
                }
            }
        } catch (err) {
            // Table may not exist on older schemas — fail open (no gating) and log once.
            if (!loadDependencyGating._warned) {
                console.error('[Kanban] loadDependencyGating error (gating disabled):', err.message);
                loadDependencyGating._warned = true;
            }
        }
        return result;
    }

    // `effectiveForOrInterval` may be either:
    //   - a function entityId → {intervalMs}     (per-entity overrides path)
    //   - a number (legacy device-wide intervalMs fallback)
    function cardHasFreshRecipient(card, lastByEntity, willNudgeEntity, effectiveForOrInterval, fallbackIntervalMs) {
        const bots = card.assigned_bots || [];
        if (bots.length === 0) return true;
        const resolveInterval = typeof effectiveForOrInterval === 'function'
            ? (bid) => effectiveForOrInterval(bid).intervalMs || fallbackIntervalMs
            : () => effectiveForOrInterval;
        const now = Date.now();
        return bots.some(bid => {
            const n = Number(bid);
            if (willNudgeEntity.has(n) || willNudgeEntity.has(bid)) return false;
            const last = lastByEntity ? lastByEntity.get(n) : null;
            const intervalMs = resolveInterval(n);
            return !last || (now - last) > intervalMs;
        });
    }

    async function recordEntityNudge(deviceId, entityIds) {
        if (!Array.isArray(entityIds) || entityIds.length === 0) return;
        try {
            const values = entityIds.map((_, i) => `($1, $${i + 2}, NOW())`).join(', ');
            await pool.query(
                `INSERT INTO kanban_entity_nudge_log (device_id, entity_id, last_nudged_at)
                 VALUES ${values}
                 ON CONFLICT (device_id, entity_id) DO UPDATE SET last_nudged_at = NOW()`,
                [deviceId, ...entityIds.map(Number)]
            );
        } catch (err) {
            console.error('[Kanban] recordEntityNudge error:', err.message);
        }
    }

    function buildEscalationRecipients(card) {
        const config = card.config || {};
        const esc = config.escalationPolicy || {};
        const notifyEntityId = esc.notifyEntityId || card.reviewer_entity_id;
        const bots = Array.isArray(card.assigned_bots) ? card.assigned_bots : [];
        const seen = new Set();
        const out = [];
        for (const id of [notifyEntityId, ...bots]) {
            if (id == null) continue;
            const key = String(id);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(id);
        }
        return out;
    }

    async function fireBlockEscalation(card, recipientIds = null) {
        const elapsedHrs = Math.round((Date.now() - new Date(card.status_changed_at).getTime()) / 3600000 * 10) / 10;
        const recipients = Array.isArray(recipientIds) ? recipientIds : buildEscalationRecipients(card);
        // Severity gate (card_22ab8c3b path #2, sibling of PR #3564):
        // P0 cards are "fix now, supervisor's attention". Auto-moving them to
        // `blocked` hides them from the active board and clears the in_progress
        // queue, which is the opposite of what a P0 stall calls for. Instead
        // fire a heightened L1 nudge with a P0-stalled prefix and notify the
        // recipient set (including the supervisor reviewer). State is NOT
        // changed; the card stays in its current column so it remains visible.
        if (card.priority === 'P0') {
            await addSystemComment(card.id, card.device_id,
                `🚨 P0 stalled — 卡片已停滯 ${elapsedHrs} 小時，主管請介入（未自動 blocked，保留 in_progress 可視性）`);
            await pool.query(
                `UPDATE kanban_cards SET last_stale_nudge_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [card.id]
            );
            if (recipients.length > 0) {
                notifyEntities(card.device_id, recipients,
                    `🚨 P0 stalled 卡片「${card.title}」停滯 ${elapsedHrs}h，主管請介入`,
                    { cardId: card.id });
            }
            if (serverLog) serverLog('warn', 'kanban', `[Stale] P0 card ${card.id} stalled ${elapsedHrs}h — heightened L1 (no auto-block)`, { deviceId: card.device_id });
            return;
        }
        await pool.query(
            `UPDATE kanban_cards SET status = 'blocked', status_changed_at = NOW(), last_stale_nudge_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [card.id]
        );
        await addSystemComment(card.id, card.device_id,
            `🚫 自動封鎖：此卡片已停滯 ${elapsedHrs} 小時，已自動移至「blocked」，請人工介入`);
        if (recipients.length > 0) {
            notifyEntities(card.device_id, recipients,
                `🚫 卡片「${card.title}」已停滯 ${elapsedHrs}h，自動 blocked，需人工介入`,
                { cardId: card.id });
        }
        if (serverLog) serverLog('warn', 'kanban', `[Stale] Card ${card.id} auto-blocked after ${elapsedHrs}h`, { deviceId: card.device_id });
    }

    async function fireLevelTwoEscalation(card, recipientIds = null) {
        const elapsedHrs = Math.round((Date.now() - new Date(card.status_changed_at).getTime()) / 3600000 * 10) / 10;
        const recipients = Array.isArray(recipientIds) ? recipientIds : buildEscalationRecipients(card);
        // Severity gate (card_22ab8c3b path #2): P3 cards in `backlog` are
        // design-first drafts awaiting launch — they sit there on purpose and
        // must NOT be silently bumped to P2 by clock alone. Skip L2; the L1
        // nudge cadence still applies if the device opts backlog into nudges.
        if (card.priority === 'P3' && card.status === 'backlog') return false;
        const PRIORITY_UPGRADE = { P3: 'P2', P2: 'P1', P1: 'P0', P0: 'P0' };
        const newPriority = PRIORITY_UPGRADE[card.priority] || card.priority;
        if (newPriority === card.priority) return false;
        await pool.query(
            `UPDATE kanban_cards SET priority = $1, last_stale_nudge_at = NOW(), updated_at = NOW() WHERE id = $2`,
            [newPriority, card.id]
        );
        await addSystemComment(card.id, card.device_id,
            `⬆️ 自動升級：停滯 ${elapsedHrs} 小時，優先級 ${card.priority} → ${newPriority}`);
        if (recipients.length > 0) {
            notifyEntities(card.device_id, recipients,
                `⬆️ 卡片「${card.title}」停滯 ${elapsedHrs}h，已自動升級至 ${newPriority}`,
                { cardId: card.id });
            // Reaching L2 means the L1 nudges didn't move the card — credit each
            // recipient with a kanban_nudge_no_reply tick so the avatar drawer
            // counter surfaces unresponsive bots.
            try {
                const entityStatus = require('./entity-status');
                for (const eid of recipients) {
                    entityStatus.incrementCounter(card.device_id, eid, 'kanban_nudge_no_reply');
                }
            } catch (_) { /* fire-and-forget */ }
        }
        if (serverLog) serverLog('info', 'kanban', `[Stale] Card ${card.id} escalated ${card.priority}→${newPriority}`, { deviceId: card.device_id });
        return true;
    }

    async function fireLevelOneNudge(card, recipientIds = null) {
        const bots = Array.isArray(recipientIds) ? recipientIds : (card.assigned_bots || []);
        const cardStatusLabel = STATUS_LABELS[card.status] || card.status;
        const elapsedMs = Date.now() - new Date(card.status_changed_at).getTime();
        const elapsedHrs = Math.round(elapsedMs / 3600000 * 10) / 10;

        await addSystemComment(card.id, card.device_id,
            `⏰ 催促：此卡片已在「${cardStatusLabel}」停留 ${elapsedHrs} 小時，請 ${bots.map(b => `#${b}`).join(', ') || '負責人'} 繼續推進`);
        await pool.query(
            `UPDATE kanban_cards SET last_stale_nudge_at = NOW() WHERE id = $1`,
            [card.id]
        );
        if (bots.length > 0) {
            const lang = await getDeviceLanguage(card.device_id);
            const msg = tKanban(lang, 'staleNudge', {
                title: card.title,
                status: statusLabel(lang, card.status),
                hours: elapsedHrs
            });
            notifyEntities(card.device_id, bots, msg, { description: card.description, cardId: card.id });
            await recordEntityNudge(card.device_id, bots);
        }
        console.log(`[Kanban] Nudged card ${card.id} (${card.title}) — ${elapsedHrs}h in ${card.status}`);
    }

    /**
     * Scan for Done cards that exceeded doneRetentionMs → auto-archive.
     * Recurring schedule cards in Done are NOT auto-archived (they restart on next trigger).
     */
    async function checkDoneAutoArchive() {
        try {
            const result = await pool.query(`
                SELECT * FROM kanban_cards
                WHERE archived = false
                  AND status = 'done'
                  AND EXTRACT(EPOCH FROM (NOW() - status_changed_at)) * 1000 > done_retention_ms
                  AND (schedule_enabled = false OR schedule_type != 'recurring' OR schedule_enabled IS NULL)
            `);

            if (result.rows.length === 0) return;

            console.log(`[Kanban] Auto-archive: ${result.rows.length} done card(s) expired`);

            for (const card of result.rows) {
                await pool.query(
                    `UPDATE kanban_cards SET archived = true, archived_at = NOW(), updated_at = NOW()
                     WHERE id = $1`,
                    [card.id]
                );

                await addSystemComment(card.id, card.device_id,
                    `🗄️ 自動歸檔 — Done 超過保留時間（${Math.round(parseInt(card.done_retention_ms) / 3600000)}h）`);

                try { await bumpVersion(card.device_id); } catch (e) { /* ignore */ }

                console.log(`[Kanban] Auto-archived card ${card.id} (${card.title})`);
            }
        } catch (err) {
            console.error('[Kanban] Auto-archive check error:', err.message);
        }
    }

    /**
     * Scan for schedule-enabled cards whose next_run_at has passed → trigger them.
     * - once: push notify + move to in_progress, then disable schedule
     * - recurring: push notify + system comment, move Done→TODO if needed, compute next run
     */
    async function checkScheduleTriggers() {
        try {
            // NOTE: archived cards are intentionally INCLUDED here (no
            // `archived = false` filter) so the self-heal guard below can
            // auto-disable their stale schedules. Without that, an archived
            // card keeps schedule_enabled=true + a past schedule_next_run_at
            // forever, and every consumer (UI badge / external cron watcher)
            // keeps seeing it as "due" → endless re-nudge.
            const result = await pool.query(`
                SELECT * FROM kanban_cards
                WHERE schedule_enabled = true
                  AND schedule_next_run_at IS NOT NULL
                  AND schedule_next_run_at <= NOW()
            `);

            if (result.rows.length === 0) return;

            console.log(`[Kanban] Schedule triggers: ${result.rows.length} card(s) due`);

            for (const card of result.rows) {
                // Self-heal: a scheduled card that has been archived (any type),
                // or a cron母卡/once card the owner marked done, must STOP firing.
                // Disable the schedule once, log + record it, and skip — this is
                // the server-side fix for the re-nudge loop (owner directive:
                // "if a cron's parent card is archived, the cron schedule should
                // auto-disable and log it, not keep firing").
                const disableReason = scheduleAutoDisableReason(card);
                if (disableReason) {
                    await pool.query(
                        `UPDATE kanban_cards SET schedule_enabled = false, updated_at = NOW() WHERE id = $1`,
                        [card.id]
                    );
                    try {
                        await addSystemComment(card.id, card.device_id,
                            `🛑 排程自動停用 — 卡片已${disableReason === 'archived' ? '封存' : '完成'}，停止觸發 (schedule auto-disabled: ${disableReason})`);
                    } catch (e) { /* best-effort: comment on an archived card is non-critical */ }
                    console.log(`[Kanban] Schedule auto-disabled: card ${card.id} (${card.title}) is ${disableReason} → schedule_enabled=false (re-nudge loop broken)`);
                    continue;
                }

                const bots = card.assigned_bots || [];
                const schedType = card.schedule_type;

                if (schedType === 'recurring') {
                    const fireDecision = getRecurringScheduleFireDecision(card);
                    if (!fireDecision.shouldFire) {
                        if (fireDecision.realignTo) {
                            await pool.query(
                                `UPDATE kanban_cards SET schedule_next_run_at = $1, updated_at = NOW() WHERE id = $2`,
                                [fireDecision.realignTo, card.id]
                            );
                        }
                        console.log(`[Kanban] Schedule realign: ${card.id} (${card.title}) skipped (${fireDecision.reason}), next: ${fireDecision.realignTo?.toISOString?.() || 'unchanged'}`);
                        continue;
                    }
                }

                if (schedType === 'once') {
                    // One-time: move to in_progress if in backlog/todo, notify, disable schedule
                    let newStatus = card.status;
                    if (card.status === 'backlog' || card.status === 'todo') {
                        newStatus = 'in_progress';
                    }

                    await pool.query(
                        `UPDATE kanban_cards SET 
                            status = $1, status_changed_at = NOW(),
                            schedule_enabled = false, schedule_last_run_at = NOW(),
                            last_stale_nudge_at = NULL, updated_at = NOW()
                         WHERE id = $2`,
                        [newStatus, card.id]
                    );

                    await addSystemComment(card.id, card.device_id,
                        `🗓️ 排程觸發（一次性）— 狀態: ${STATUS_LABELS[card.status]} → ${STATUS_LABELS[newStatus]}`);

                    if (bots.length > 0) {
                        const lang = await getDeviceLanguage(card.device_id);
                        const msg = tKanban(lang, 'scheduleOnce', { title: card.title });
                        notifyEntities(card.device_id, bots, msg, { description: card.description, cardId: card.id, perDeviceCron: true });
                    }

                    try { await bumpVersion(card.device_id); } catch (e) { /* ignore */ }
                    console.log(`[Kanban] Once-trigger: ${card.id} (${card.title}) → ${newStatus}`);

                } else if (schedType === 'recurring' && card.is_automation) {
                    // ── Automation card: spawn child card ──
                    console.log(`[Kanban] Automation trigger: ${card.id} (${card.title}), checking active child`);

                    // Check if there's already an active child (not done, not archived)
                    if (card.active_child_id) {
                        const activeCheck = await pool.query(
                            `SELECT id, status, archived FROM kanban_cards WHERE id = $1`,
                            [card.active_child_id]
                        );
                        const activeChild = activeCheck.rows[0];
                        if (activeChild && activeChild.status !== 'done' && !activeChild.archived) {
                            // Skip — active child still running
                            const nextRun = computeNextRun(card.schedule_cron, card.schedule_timezone);
                            await pool.query(
                                `UPDATE kanban_cards SET schedule_last_run_at = NOW(), schedule_next_run_at = $1, updated_at = NOW() WHERE id = $2`,
                                [nextRun, card.id]
                            );
                            await addSystemComment(card.id, card.device_id,
                                `⏭️ 排程觸發跳過 — 子卡 ${card.active_child_id} 仍在執行中（${activeChild.status}）`);
                            console.log(`[Kanban] Automation skip: active child ${card.active_child_id} still ${activeChild.status}`);
                            continue;
                        }
                    }

                    // card_c2635849 (parent card_ad507345): per-card usage-quota
                    // guard. If ANY assigned entity's rolling 5h / 7d usage% is
                    // above the per-card threshold, skip child dispatch this
                    // tick. We advance schedule_next_run_at to the next cron
                    // slot (so the row doesn't fire-spin every poll loop —
                    // the scheduler scans WHERE next_run_at <= NOW()) but do
                    // NOT bump schedule_last_run_at — the audit trail should
                    // show the last *successful* dispatch, not the skip.
                    const usageBots = card.assigned_bots || [];
                    const usageDecision = await evaluateUsageSkipDecision(card, usageBots);
                    if (usageDecision.skip) {
                        const nextRun = computeNextRun(card.schedule_cron, card.schedule_timezone);
                        await pool.query(
                            `UPDATE kanban_cards SET schedule_next_run_at = $1, updated_at = NOW() WHERE id = $2`,
                            [nextRun, card.id]
                        );
                        await addSystemComment(card.id, card.device_id,
                            `⏭️ 排程觸發跳過 — Entity #${usageDecision.entityId} ${usageDecision.window} 用量 ${usageDecision.pct}% > ${usageDecision.limit}%（下次嘗試: ${nextRun ? nextRun.toISOString() : '未知'}）`);
                        console.log(`[CronSkip] card_${card.id} entity_${usageDecision.entityId} usage_${usageDecision.window}=${usageDecision.pct}% > ${usageDecision.limit}% — child dispatch skipped`);
                        continue;
                    }

                    // Check idle dispatch mode before creating child card
                    const dispatchMode = card.dispatch_mode || 'immediate';
                    if (dispatchMode === 'idle_only') {
                        console.log(`[Kanban] Automation ${card.id}: checking entity idle status (dispatch_mode=idle_only)`);

                        // Check if target entities are idle (no active tasks)
                        const bots = card.assigned_bots || [];
                        let hasActiveEntity = false;
                        let activeEntityInfo = '';

                        for (const botId of bots) {
                            try {
                                const workloadCheck = await pool.query(`
                                    SELECT COUNT(*) as active_count
                                    FROM kanban_cards
                                    WHERE device_id = $1
                                      AND assigned_bots @> to_jsonb($2::int)
                                      AND archived = false
                                      AND status IN ('scheduled', 'todo', 'in_progress', 'review')
                                `, [card.device_id, botId]);

                                const activeCount = parseInt(workloadCheck.rows[0]?.active_count || 0);
                                if (activeCount > 0) {
                                    hasActiveEntity = true;
                                    activeEntityInfo += `Entity ${botId}: ${activeCount} 項任務; `;
                                    console.log(`[Kanban] Entity ${botId} busy: ${activeCount} active tasks`);
                                }
                            } catch (err) {
                                console.error(`[Kanban] Workload check error for entity ${botId}:`, err.message);
                                // On error, assume entity is available to avoid blocking
                            }
                        }

                        if (hasActiveEntity) {
                            // Entities are busy, mark as pending dispatch
                            await pool.query(
                                `UPDATE kanban_cards SET pending_dispatch = true, updated_at = NOW() WHERE id = $1`,
                                [card.id]
                            );

                            const nextRun = computeNextRun(card.schedule_cron, card.schedule_timezone);
                            await pool.query(
                                `UPDATE kanban_cards SET schedule_last_run_at = NOW(), schedule_next_run_at = $1, updated_at = NOW() WHERE id = $2`,
                                [nextRun, card.id]
                            );

                            await addSystemComment(card.id, card.device_id,
                                `⏸️ 閒置派發暫停 — 目標實體忙碌中：${activeEntityInfo.trim()}`);
                            console.log(`[Kanban] Idle dispatch deferred: ${card.id}, entities busy: ${activeEntityInfo}`);
                            continue;
                        } else {
                            // All entities idle, proceed with dispatch
                            console.log(`[Kanban] All entities idle, proceeding with child card creation`);
                            // Clear pending_dispatch flag if previously set
                            await pool.query(
                                `UPDATE kanban_cards SET pending_dispatch = false WHERE id = $1`,
                                [card.id]
                            );
                        }
                    }

                    // Generate timestamp for child title
                    const now = new Date();
                    const tz = card.schedule_timezone || 'Asia/Taipei';
                    let timeLabel;
                    try {
                        timeLabel = now.toLocaleString('en-US', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
                    } catch (e) {
                        timeLabel = now.toISOString().slice(5, 16).replace('T', ' ');
                    }
                    const childTitle = `[Auto] ${card.title} (${timeLabel})`;

                    // Create child card (inherit reviewerEntityId + requires_screenshot_review from parent).
                    // Mom-card editing surfaces a toggle so Hank can flip per-cron whether the
                    // automated runs need an evidence screenshot before the screenshot-gate
                    // releases /move to done. Passing the column through verbatim (NULL→NULL,
                    // TRUE→TRUE, FALSE→FALSE) keeps child semantics aligned with the mom UI:
                    // the helper's `!== false` rule treats NULL as "gate active" for both.
                    const inheritScreenshot = card.requires_screenshot_review;
                    const childResult = await pool.query(
                        `INSERT INTO kanban_cards (id, device_id, title, description, priority, status, assigned_bots, created_by,
                            status_changed_at, stale_threshold_ms, done_retention_ms, parent_card_id, is_auto_generated, reviewer_entity_id,
                            requires_screenshot_review)
                         VALUES ($1, $2, $3, $4, $5, 'todo', $6::jsonb, $7, NOW(), $8, $9, $10, true, $11, $12)
                         RETURNING *`,
                        [newCardId(), card.device_id, childTitle, card.description || '', card.priority,
                         JSON.stringify(bots), card.created_by,
                         card.stale_threshold_ms, card.done_retention_ms, card.id,
                         card.reviewer_entity_id || null, inheritScreenshot]
                    );
                    const childCard = childResult.rows[0];
                    console.log(`[Kanban] Automation child created: ${childCard.id} (${childTitle})`);

                    // Update parent: lastRunAt, nextRunAt, activeChildId
                    const nextRun = computeNextRun(card.schedule_cron, tz);
                    await pool.query(
                        `UPDATE kanban_cards SET 
                            schedule_last_run_at = NOW(), schedule_next_run_at = $1,
                            active_child_id = $2, updated_at = NOW()
                         WHERE id = $3`,
                        [nextRun, childCard.id, card.id]
                    );

                    // System comments
                    await addSystemComment(card.id, card.device_id,
                        `🗓️ 排程觸發 — 建立子卡: ${childTitle}，下次執行: ${nextRun ? nextRun.toISOString() : '未知'}`);
                    await addSystemComment(childCard.id, card.device_id,
                        `📋 由自動化母卡 [${card.title}] 自動建立`);

                    // Smart-queue notify (card_dfe3b8df Phase 2 — supersedes the
                    // kanban_cron_spawn_notify boolean gate). Per assigned bot: if the
                    // bot has any active todo/in_progress card, enqueue silently into
                    // kanban_pending_notify; otherwise push immediately. One queued
                    // entry drains per move-to-done event for that bot, so the bot
                    // sees at most one new-task ping at a time without losing the
                    // wakeup chain. Spec: docs/mission-v2-kanban-spec.md §十一
                    // "通知 gates（smart per-bot queue）".
                    if (bots.length > 0) {
                        // Layer 1 — Cron-spawn jitter (0–CRON_NOTIFY_JITTER_MS, default 30s).
                        // Same-minute mom crons used to push 5+ notifies into one bot lane
                        // in ≤7s, wedging the chat queue (card_a19dc866). Random delay
                        // before notify, combined with the serial-await spawn loop,
                        // staggers same-tick siblings naturally without delaying the
                        // child card INSERT or the user-visible nextRunAt.
                        // Parse with Number.isFinite guard so explicit 0 stays 0 (`|| 30000`
                        // would coerce 0 back to default — flagged by #1 cross-review).
                        const jitterMaxRaw = Number(process.env.CRON_NOTIFY_JITTER_MS);
                        const jitterMaxMs = Number.isFinite(jitterMaxRaw) && jitterMaxRaw >= 0 ? jitterMaxRaw : 30000;
                        const jitterMs = jitterMaxMs > 0 ? Math.floor(Math.random() * jitterMaxMs) : 0;
                        if (jitterMs > 0) {
                            console.log(`[Kanban] Automation child ${childCard.id}: jitter ${jitterMs}ms before notify`);
                            await new Promise(r => setTimeout(r, jitterMs));
                        }

                        const lang = await getDeviceLanguage(card.device_id);
                        const msg = tKanban(lang, 'automationTrigger', {
                            title: card.title,
                            childTitle
                        });
                        const payload = { description: card.description, cardId: childCard.id };
                        // Same Number.isFinite guard so threshold=0 (= always backpressure)
                        // is a valid escape hatch and doesn't silently coerce to 5.
                        const backpressureRaw = Number(process.env.CRON_NOTIFY_BACKPRESSURE_THRESHOLD);
                        const backpressureThreshold = Number.isFinite(backpressureRaw) && backpressureRaw >= 0 ? backpressureRaw : 5;
                        for (const botId of bots) {
                            try {
                                const hasPending = await botHasPendingNotify(card.device_id, botId);
                                // Layer 2 — Lane backpressure (card_a19dc866). When the bot's
                                // active workload (todo/in_progress/review) crosses threshold,
                                // downgrade immediate push to the smart queue so the bot drains
                                // one task at a time instead of receiving N concurrent chats.
                                const workload = await botActiveWorkload(card.device_id, botId);
                                const backpressure = workload >= backpressureThreshold;
                                if (hasPending || backpressure) {
                                    await enqueuePendingNotify(card.device_id, botId, childCard.id, msg, payload);
                                    console.log(`[Kanban] Smart-queue: enqueued notify for bot #${botId} card ${childCard.id} (hasPending=${hasPending}, workload=${workload}, backpressure=${backpressure})`);
                                } else {
                                    await notifyEntities(card.device_id, [botId], msg, { ...payload, perDeviceCron: true });
                                    console.log(`[Kanban] Smart-queue: pushed immediate notify for bot #${botId} card ${childCard.id} (workload=${workload})`);
                                }
                            } catch (notifyErr) {
                                console.error(`[Kanban] Smart-queue notify failed for bot #${botId}:`, notifyErr.message);
                            }
                        }
                    }

                    try { await bumpVersion(card.device_id); } catch (e) { /* ignore */ }
                    console.log(`[Kanban] Automation-trigger: ${card.id} → child ${childCard.id}, next: ${nextRun?.toISOString()}`);

                } else if (schedType === 'recurring') {
                    // ── Normal recurring card: move self ──
                    let newStatus = card.status;
                    if (card.status === 'done') {
                        newStatus = 'todo';
                    }

                    const nextRun = computeNextRun(card.schedule_cron, card.schedule_timezone);

                    await pool.query(
                        `UPDATE kanban_cards SET 
                            status = $1, status_changed_at = NOW(),
                            schedule_last_run_at = NOW(), schedule_next_run_at = $2,
                            last_stale_nudge_at = NULL, updated_at = NOW()
                         WHERE id = $3`,
                        [newStatus, nextRun, card.id]
                    );

                    const statusMsg = card.status !== newStatus
                        ? `狀態: ${STATUS_LABELS[card.status]} → ${STATUS_LABELS[newStatus]}，`
                        : '';
                    await addSystemComment(card.id, card.device_id,
                        `🗓️ 排程觸發（重複）— ${statusMsg}下次執行: ${nextRun ? nextRun.toISOString() : '未知'}`);

                    // Gated by kanban_cron_recurring_notify (default true) — these
                    // are typically lower-frequency self-recurring母卡 (no子卡 spawn),
                    // so user usually wants the ping. Allow opt-out for noisy crons.
                    const recurringPrefs = await devicePrefs.getPrefs(card.device_id).catch(() => ({}));
                    if (bots.length > 0 && recurringPrefs.kanban_cron_recurring_notify !== false) {
                        const lang = await getDeviceLanguage(card.device_id);
                        const msg = card.status !== newStatus
                            ? tKanban(lang, 'scheduleRecurringWithStatus', {
                                title: card.title,
                                from: statusLabel(lang, card.status),
                                to: statusLabel(lang, newStatus)
                            })
                            : tKanban(lang, 'scheduleRecurring', { title: card.title });
                        notifyEntities(card.device_id, bots, msg, { description: card.description, cardId: card.id, perDeviceCron: true });
                    }

                    try { await bumpVersion(card.device_id); } catch (e) { /* ignore */ }
                    console.log(`[Kanban] Recurring-trigger: ${card.id} (${card.title}) → ${newStatus}, next: ${nextRun?.toISOString()}`);
                }
            }
        } catch (err) {
            console.error('[Kanban] Schedule trigger error:', err.message);
        }
    }

    /**
     * Check pending dispatch cards and retry if target entities are now idle.
     */
    async function checkPendingDispatch() {
        try {
            const result = await pool.query(`
                SELECT * FROM kanban_cards
                WHERE pending_dispatch = true
                  AND is_automation = true
                  AND archived = false
                  AND dispatch_mode = 'idle_only'
                ORDER BY updated_at ASC
            `);

            if (result.rows.length === 0) return;
            console.log(`[Kanban] Pending dispatch check: ${result.rows.length} card(s) waiting`);

            for (const card of result.rows) {
                console.log(`[Kanban] Checking pending dispatch: ${card.id} (${card.title})`);

                // Check if target entities are idle now
                const bots = card.assigned_bots || [];
                let hasActiveEntity = false;
                let activeEntityInfo = '';

                for (const botId of bots) {
                    try {
                        const workloadCheck = await pool.query(`
                            SELECT COUNT(*) as active_count
                            FROM kanban_cards
                            WHERE device_id = $1
                              AND assigned_bots @> to_jsonb($2::int)
                              AND archived = false
                              AND status IN ('scheduled', 'todo', 'in_progress', 'review')
                        `, [card.device_id, botId]);

                        const activeCount = parseInt(workloadCheck.rows[0]?.active_count || 0);
                        if (activeCount > 0) {
                            hasActiveEntity = true;
                            activeEntityInfo += `Entity ${botId}: ${activeCount} 項任務; `;
                        }
                    } catch (err) {
                        console.error(`[Kanban] Pending workload check error for entity ${botId}:`, err.message);
                    }
                }

                if (!hasActiveEntity) {
                    // All entities are now idle, trigger the dispatch
                    console.log(`[Kanban] Entities now idle, triggering pending dispatch: ${card.id}`);

                    // Generate timestamp for child title
                    const now = new Date();
                    const tz = card.schedule_timezone || 'Asia/Taipei';
                    let timeLabel;
                    try {
                        timeLabel = now.toLocaleString('en-US', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
                    } catch (e) {
                        timeLabel = now.toISOString().slice(5, 16).replace('T', ' ');
                    }
                    const childTitle = `[Auto] ${card.title} (${timeLabel})`;

                    // Create child card with inherited settings
                    const inheritScreenshot = card.requires_screenshot_review;
                    const childResult = await pool.query(
                        `INSERT INTO kanban_cards (id, device_id, title, description, priority, status, assigned_bots, created_by,
                            status_changed_at, stale_threshold_ms, done_retention_ms, parent_card_id, is_auto_generated, reviewer_entity_id,
                            requires_screenshot_review)
                         VALUES ($1, $2, $3, $4, $5, 'todo', $6::jsonb, $7, NOW(), $8, $9, $10, true, $11, $12)
                         RETURNING *`,
                        [newCardId(), card.device_id, childTitle, card.description || '', card.priority,
                         JSON.stringify(bots), card.created_by,
                         card.stale_threshold_ms, card.done_retention_ms, card.id,
                         card.reviewer_entity_id || null, inheritScreenshot]
                    );
                    const childCard = childResult.rows[0];

                    // Update parent card: clear pending_dispatch, set active_child_id
                    await pool.query(
                        `UPDATE kanban_cards SET
                            pending_dispatch = false,
                            active_child_id = $1,
                            last_run_result = '閒置派發成功',
                            updated_at = NOW()
                         WHERE id = $2`,
                        [childCard.id, card.id]
                    );

                    await addSystemComment(card.id, card.device_id,
                        `✅ 閒置派發成功 — 子卡 ${childCard.id} 已創建（實體現已閒置）`);

                    // Notify assigned entities
                    if (bots.length > 0) {
                        const lang = await getDeviceLanguage(card.device_id);
                        const msg = tKanban(lang, 'automationTrigger', {
                            title: card.title,
                            childId: childCard.id
                        });
                        notifyEntities(card.device_id, bots, msg, {
                            description: card.description,
                            cardId: childCard.id,
                            parentCardId: card.id,
                            perDeviceCron: true
                        });
                    }

                    try { await bumpVersion(card.device_id); } catch (e) { /* ignore */ }
                    console.log(`[Kanban] Pending dispatch completed: ${card.id} → child ${childCard.id}`);
                } else {
                    console.log(`[Kanban] Still waiting for idle: ${card.id}, busy entities: ${activeEntityInfo}`);
                }
            }
        } catch (err) {
            console.error('[Kanban] Pending dispatch error:', err.message);
        }
    }

    /**
     * Start background timer (unified). Call after DB init.
     */
    function startBackgroundTimers() {
        if (bgTimer) return; // Already running

        // Run initial check after 30s (let server fully start)
        setTimeout(backgroundTick, 30000);

        bgTimer = setInterval(backgroundTick, BG_CHECK_INTERVAL);
        console.log(`[Kanban] Background timer started (interval: ${BG_CHECK_INTERVAL / 1000}s — stale + archive + schedule)`);
    }

    /**
     * Stop background timer (for graceful shutdown).
     */
    function stopBackgroundTimers() {
        if (bgTimer) { clearInterval(bgTimer); bgTimer = null; }
        console.log('[Kanban] Background timer stopped');
    }

    /**
     * Auto-move active child cards to "done" when Bot transforms with non-BUSY state.
     * Called from index.js transform handler and channel-api.js channel transform.
     *
     * Targeting:
     *   - When `aboutCardId` is provided, only that specific card is considered (still
     *     gated by the same eligibility filter — assigned to caller, todo/in_progress,
     *     auto-generated or reviewer-tagged).
     *   - When `aboutCardId` is omitted, the legacy multi-eligible scan runs but only
     *     proceeds when exactly ONE card matches. Multi-match short-circuits with a
     *     warn log so an unrelated speakTo (consultation, chat, status update) can no
     *     longer batch-close every cron child + reviewer card the bot is assigned to.
     *     History: an unrelated speakTo on 2026-05-02/03 silently closed in-flight
     *     cron cards (card_82d541f9, card_ec140240) and stuffed unrelated reply text
     *     into their completion comments. See card_5b6654e6 RCA.
     *
     * @param {string} deviceId
     * @param {number} entityId - the bot that just replied
     * @param {string} [transformMessage] - the bot's transform reply text
     * @param {string} [aboutCardId] - optional kanban card_<id> the bot is reporting on
     */
    async function autoReviewOnTransform(deviceId, entityId, transformMessage, aboutCardId) {
        try {
            // aboutCardId is now required. Without it, we skip entirely — the
            // previous "exactly one eligible card" fallback would close cards
            // whose title had nothing to do with the IDLE message content
            // (e.g. a bot reporting completion of task X while only task Y was
            // eligible for auto-close on its board would close Y by mistake).
            // See card_393752f8 / card_819d50f1 RCA for a real instance.
            //
            // Defensive inference: if the bot explicitly typed `card_<hex>` in the
            // transform message and exactly one unique id is mentioned, treat it as
            // an implicit aboutCardId. This is safer than the legacy fallback
            // because the id comes from the bot's own text (so it's about THIS
            // reply), not from a board scan that could match an unrelated card.
            if (!aboutCardId && typeof transformMessage === 'string' && transformMessage.length > 0) {
                const matches = transformMessage.match(/\bcard_[a-f0-9]{8,}\b/gi);
                if (matches && matches.length > 0) {
                    const unique = Array.from(new Set(matches.map(m => m.toLowerCase())));
                    if (unique.length === 1) {
                        aboutCardId = unique[0];
                        console.log(`[Kanban] autoReviewOnTransform inferred aboutCardId=${aboutCardId} from entity ${entityId} message text`);
                    } else {
                        console.debug(`[Kanban] autoReviewOnTransform skipped: entity ${entityId} mentioned ${unique.length} distinct card_ids in message but no explicit aboutCardId — pass {aboutCardId:"card_..."} to disambiguate`);
                        return;
                    }
                }
            }
            if (!aboutCardId) {
                console.debug(`[Kanban] autoReviewOnTransform skipped: no aboutCardId provided by entity ${entityId} — pass {aboutCardId:"card_..."} in transform body to auto-close a specific card`);
                return;
            }
            // Find active card assigned to this entity that is in todo/in_progress.
            // Supports both auto-generated child cards AND manually created cards with reviewer.
            const result = await pool.query(
                `SELECT c.id, c.title, c.status, c.parent_card_id, c.assigned_bots, c.reviewer_entity_id, c.requires_screenshot_review
                 FROM kanban_cards c
                 WHERE c.id = $1
                   AND c.device_id = $2
                   AND (c.is_auto_generated = true OR c.reviewer_entity_id IS NOT NULL)
                   AND c.archived = false
                   AND c.status IN ('todo', 'in_progress')
                   AND c.assigned_bots::jsonb @> $3::jsonb`,
                [aboutCardId, deviceId, JSON.stringify([entityId])]
            );

            if (result.rows.length === 0) return;

            for (const card of result.rows) {
                const reviewerId = card.reviewer_entity_id;

                // Screenshot-review gate: mirror the /move endpoint gate (see L1086).
                // When gate is on and no image is attached, do NOT auto-close.
                // Instead, leave the card in its current status, post a system comment,
                // and nudge the bot to attach a screenshot before its next IDLE transform.
                if (card.requires_screenshot_review !== false) {
                    const shot = await pool.query(
                        `SELECT COUNT(*)::int AS cnt FROM kanban_files
                         WHERE card_id = $1 AND mime_type LIKE 'image/%'`,
                        [card.id]
                    );
                    if ((shot.rows[0]?.cnt || 0) === 0) {
                        const nudge = `⏸️ Bot #${entityId} 已回報完成，但此卡開啟「截圖審查」且尚無完成截圖 — 不自動結案。請用 POST /api/mission/card/${card.id}/file 附上 image/png R2 URL 後，再讓 bot 重送 IDLE transform。`;
                        await addSystemComment(card.id, deviceId, nudge);
                        console.log(`[Kanban] Auto-close blocked by screenshot gate: card ${card.id} (${card.title}) by entity ${entityId} — awaiting screenshot`);
                        try {
                            notifyEntities(deviceId, [entityId],
                                `⏸️ 「${card.title}」需附上完成截圖才能自動結案。請先 POST /api/mission/card/${card.id}/file 附 image/png，再重送 IDLE transform。`,
                                { cardId: card.id });
                        } catch (_) { /* notify best-effort */ }
                        continue;
                    }
                }

                // Move directly to done (not review) — avoids blocking next schedule trigger
                await pool.query(
                    `UPDATE kanban_cards
                     SET status = 'done', status_changed_at = NOW(),
                         last_stale_nudge_at = NULL, updated_at = NOW()
                     WHERE id = $1 AND device_id = $2`,
                    [card.id, deviceId]
                );

                // Add system comment with the bot's reply
                const msgPreview = transformMessage ? `\n回覆內容：${transformMessage.slice(0, 200)}` : '';
                await addSystemComment(card.id, deviceId,
                    `✅ Bot #${entityId} 已回報完成，自動結案${msgPreview}`);

                console.log(`[Kanban] Auto-done: child card ${card.id} (${card.title}) marked done by entity ${entityId}${reviewerId != null ? `, reviewer: #${reviewerId}` : ''}`);

                // Auto-close bypasses /move, so notifyDevice fires here too.
                // Always classified as kanban_done_auto since this branch only
                // runs for bot-reported IDLE auto-completions.
                if (typeof notifyDevice === 'function') {
                    console.log(`[Kanban] auto-done device-push dispatch: device=${deviceId} card=${card.id} category=kanban_done_auto closedBy=${entityId}`);
                    notifyDevice(deviceId, {
                        type: 'kanban',
                        category: 'kanban_done_auto',
                        title: '✅ 自動任務完成',
                        body: card.title,
                        link: `/portal/kanban.html?card=${card.id}`,
                        metadata: { cardId: card.id, isAuto: true, autoClosedBy: entityId }
                    }).catch((e) => {
                        console.error(`[Kanban] auto-done device-push dispatch failed: device=${deviceId} card=${card.id}:`, e.message);
                    });
                }

                // Award XP for completing task
                if (awardEntityXP) {
                    try { await awardEntityXP(deviceId, entityId, 25); } catch (e) { /* ignore */ }
                }

                // Notify reviewer if set — send the bot's reply for review
                if (reviewerId != null) {
                    const lang = await getDeviceLanguage(deviceId);
                    const reply = transformMessage
                        ? `\n${transformMessage.slice(0, 300)}`
                        : tKanban(lang, 'reviewerNoReply');
                    const reviewMsg = tKanban(lang, 'reviewerNotify', {
                        title: card.title,
                        entityId,
                        reply
                    });
                    notifyEntities(deviceId, [reviewerId], reviewMsg, { cardId: card.id });
                    console.log(`[Kanban] Notified reviewer #${reviewerId} for card ${card.id}`);
                }
            }
        } catch (err) {
            console.error(`[Kanban] autoReviewOnTransform error:`, err.message);
        }
    }

    // ============================================
    // GET /card/:id/messages — List associated historical messages
    // ============================================
    router.get('/card/:id/messages', async (req, res) => {
        if (!authenticate(req, res)) return;
        const { deviceId, entityId } = { ...req.query, ...req.body };
        const cardId = req.params.id;
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = Math.max(0, parseInt(req.query.offset) || 0);

        try {
            // Verify card belongs to device
            const cardCheck = await pool.query(
                `SELECT id, title, created_at FROM kanban_cards WHERE id = $1 AND device_id = $2`,
                [cardId, deviceId]
            );
            if (cardCheck.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }

            const card = cardCheck.rows[0];
            const cardCreatedAt = new Date(card.created_at);
            const timeWindowStart = new Date(cardCreatedAt.getTime() - 30 * 60 * 1000); // 30 minutes before
            const timeWindowEnd = new Date(cardCreatedAt.getTime() + 30 * 60 * 1000);   // 30 minutes after

            const messages = [];

            // 1. Get kanban comments for this card
            const commentsResult = await pool.query(
                `SELECT id, from_entity_id as entity_id, text, is_system, created_at, 'comment' as type
                 FROM kanban_comments
                 WHERE card_id = $1
                 ORDER BY created_at DESC
                 LIMIT $2 OFFSET $3`,
                [cardId, limit, offset]
            );
            messages.push(...commentsResult.rows);

            // 2. Get kanban notifications for this card
            const notificationsResult = await pool.query(
                `SELECT id, bot_entity_id as entity_id, msg as text, created_at, 'notification' as type
                 FROM kanban_pending_notify
                 WHERE card_id = $1 AND device_id = $2
                 ORDER BY created_at DESC
                 LIMIT $2`,
                [cardId, deviceId, limit]
            );
            messages.push(...notificationsResult.rows);

            // 3. Get chat messages that mention this card ID or are within time window
            const chatResult = await pool.query(
                `SELECT id, entity_id, text, source, is_from_user, is_from_bot, created_at, 'chat' as type
                 FROM chat_messages
                 WHERE device_id = $1
                   AND (text LIKE $2 OR (created_at >= $3 AND created_at <= $4))
                 ORDER BY created_at DESC
                 LIMIT $5`,
                [deviceId, `%${cardId}%`, timeWindowStart, timeWindowEnd, limit]
            );
            messages.push(...chatResult.rows);

            // Sort all messages by creation time (newest first) and apply limit
            const allMessages = messages
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
                .slice(0, limit)
                .map(msg => ({
                    id: msg.id,
                    type: msg.type,
                    sender: {
                        entityId: msg.entity_id || null,
                        isUser: msg.is_from_user || false,
                        isBot: msg.is_from_bot || false,
                        isSystem: msg.is_system || false
                    },
                    content: msg.text || msg.msg,
                    timestamp: new Date(msg.created_at).getTime(),
                    source: msg.source || (msg.type === 'comment' ? 'kanban_comments' :
                                          msg.type === 'notification' ? 'kanban_pending_notify' : 'chat_messages')
                }));

            const totalCount = allMessages.length;
            const hasMore = totalCount >= limit;

            res.json({
                success: true,
                cardId,
                messages: allMessages,
                totalCount,
                hasMore,
                timeWindow: {
                    start: timeWindowStart.getTime(),
                    end: timeWindowEnd.getTime(),
                    cardCreated: cardCreatedAt.getTime()
                }
            });
        } catch (err) {
            console.error('[Kanban] Get card messages error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Debug endpoint to trace screenshot review default logic
    router.get('/debug/screenshot-review-default', (req, res) => {
        const { title = "Sample Card", requiresScreenshotReview } = req.query;

        // Simulate the logic from POST /card
        const finalRequiresScreenshot = requiresScreenshotReview === undefined
            ? false  // Default to disabled for all new cards
            : requiresScreenshotReview !== 'false';

        res.json({
            debug: true,
            input: {
                title,
                requiresScreenshotReview: requiresScreenshotReview || 'undefined'
            },
            logic: {
                step1: 'requiresScreenshotReview === undefined',
                step1Result: requiresScreenshotReview === undefined,
                step2: 'requiresScreenshotReview === undefined ? false : requiresScreenshotReview !== "false"',
                finalResult: finalRequiresScreenshot
            },
            output: {
                requiresScreenshotReview: finalRequiresScreenshot
            },
            codeVersion: 'abf74108-debug',
            timestamp: new Date().toISOString()
        });
    });

    return { router, initKanbanDatabase, startBackgroundTimers, stopBackgroundTimers, autoReviewOnTransform };
}

module.exports = createKanbanModule;
module.exports._private = {
    computeCronNextRun,
    computeCronPreviousRun,
    getRecurringScheduleFireDecision,
    scheduleAutoDisableReason,
    SCHEDULE_LATE_FIRE_GRACE_MS,
    // card_c2635849 cron usage-threshold skip
    isValidUsageThreshold,
    clampUsageThreshold,
    readClaudeLivePct,
    readCodexLivePct,
    evaluateUsageSkipDecision,
    SCHEDULE_USAGE_THRESHOLD_MIN,
    SCHEDULE_USAGE_THRESHOLD_MAX,
    DEFAULT_SKIP_5H_PCT,
    DEFAULT_SKIP_7D_PCT,
};
