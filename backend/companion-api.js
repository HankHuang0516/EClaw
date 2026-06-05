/**
 * Companion API — Petdx 伙伴瀏覽器 / 社群伙伴貢獻系統
 *
 * Mounted at: /api/companion
 *
 * Spec: docs/specs/petdx-backend-api-spec.md (v0.2)
 * Stage 1: read endpoints — list + detail.
 * Stage 2: favorites + select + current
 * Stage 3: ratings + comments
 * Stage 4 (this file): + submit + pending + review + delete (creator/owner gated)
 *
 * Auth: deviceId + botSecret + entityId — same triple as /api/bot/*.
 * The factory caller injects `authenticateBot(deviceId, entityId, botSecret)`
 * so we don't reach into the global `devices` map directly.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { syncPetdexCatalog } = require('./petdex-bridge');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

const ALLOWED_SORTS = new Set(['popular', 'recent', 'rating', 'favorites']);
const ALLOWED_SCOPES = new Set(['all', 'system', 'community', 'mine']);
const ALLOWED_ASSET_TYPES = new Set(['procedural', 'spritesheet', 'vector']);
const ALLOWED_CATEGORIES = new Set(['animal', 'human', 'robot', 'mascot', 'custom']);
const ALLOWED_SELECT_SOURCES = new Set(['portal', 'app', 'api']);
const ALLOWED_LICENSES = new Set([
    'EClaw-default', 'CC0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT',
]);
// Ten lowercase substrings — enough to block accidental copy-paste of slurs in
// public companion names/tags. Real moderation is the device-owner review step.
const PROFANITY_BLOCKLIST = [
    'fuck', 'shit', 'bitch', 'asshole', 'retard',
    '幹你', '幹妳', '操你', '操妳', '操他媽',
];
const SUBMIT_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const SUBMIT_RATE_LIMIT_MAX = 5;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const STATE_RE = /^[A-Z][A-Z0-9_]{1,15}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function parsePositiveInt(value, fallback, max) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return max != null ? Math.min(n, max) : n;
}

function parseTags(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    return String(raw).split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
}

// Returns null on success or a string error code on rejection. Used by
// POST /submit. Order matches the user-facing error precedence: id → name →
// version → assetType → states → license → category → tags → profanity.
function validateSubmittedDescriptor(body) {
    if (!body || typeof body !== 'object') return 'invalid_body';
    const id = body.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) return 'invalid_companion_id';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 40) return 'invalid_name';
    const version = body.version || '1.0.0';
    if (typeof version !== 'string' || !SEMVER_RE.test(version)) return 'invalid_version';
    if (!body.descriptor || typeof body.descriptor !== 'object' || Array.isArray(body.descriptor)) {
        return 'invalid_descriptor';
    }
    if (typeof body.descriptor.id === 'string' && body.descriptor.id !== id) {
        return 'descriptor_id_mismatch';
    }
    if (!ALLOWED_ASSET_TYPES.has(body.assetType)) return 'invalid_asset_type';
    const states = Array.isArray(body.supportedStates) ? body.supportedStates : null;
    if (!states || states.length < 1 || states.length > 12) return 'invalid_supported_states';
    for (const s of states) {
        if (typeof s !== 'string' || !STATE_RE.test(s)) return 'invalid_supported_states';
    }
    const license = body.license || 'EClaw-default';
    if (!ALLOWED_LICENSES.has(license)) return 'invalid_license';
    if (body.category != null && !ALLOWED_CATEGORIES.has(body.category)) return 'invalid_category';
    if (body.tags != null) {
        if (!Array.isArray(body.tags) || body.tags.length > 10) return 'invalid_tags';
        for (const t of body.tags) {
            if (typeof t !== 'string' || t.length < 1 || t.length > 30) return 'invalid_tags';
        }
    }
    // Profanity scan: name + tags + descriptor.description.
    const haystacks = [name, ...(body.tags || [])];
    if (typeof body.descriptor.description === 'string') haystacks.push(body.descriptor.description);
    const lower = haystacks.join(' ').toLowerCase();
    for (const bad of PROFANITY_BLOCKLIST) {
        if (lower.includes(bad)) return 'profanity_detected';
    }
    return null;
}

function rowToCompanionCard(row) {
    const card = {
        id: row.id,
        name: row.name,
        version: row.version,
        avatarUrl: row.avatar_url,
        thumbnailUrl: row.thumbnail_url,
        author: row.author_entity_id != null
            ? { entityId: row.author_entity_id }
            : null,
        tags: row.tags || [],
        mood: row.mood,
        color: row.color,
        category: row.category,
        assetType: row.asset_type,
        supportedStates: row.supported_states || ['IDLE'],
        stats: {
            downloads: row.download_count,
            favorites: row.favorite_count,
            rating: row.rating_avg,
            ratingCount: row.rating_count,
            commentCount: row.comment_count,
        },
        scope: row.scope,
    };
    // Spritesheet companions need the asset URL + frame metadata on the grid
    // so cards can animate without a follow-up /:id fetch per tile. Procedural
    // cards already work off the renderer-key heuristic in petdx-browser.html.
    if (row.asset_type === 'spritesheet') {
        card.assetUrl = row.asset_url;
        const d = row.descriptor || {};
        if (d.asset) card.asset = d.asset;
        if (d.stateAssets) card.stateAssets = d.stateAssets;
    }
    return card;
}

function rowToCompanionDetail(row) {
    return {
        ...rowToCompanionCard(row),
        descriptor: row.descriptor,
        assetUrl: row.asset_url,
        license: row.license,
        i18nData: row.i18n_data,
        publishedAt: row.published_at,
        status: row.status,
    };
}

async function initCompanionDatabase(serverLog = console.log) {
    try {
        const schemaPath = path.join(__dirname, 'companion_schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');

        const statements = [];
        let current = '';
        for (const line of schema.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('--')) continue;
            current += line + '\n';
            if (trimmed.endsWith(';')) {
                const stmt = current.trim();
                if (stmt && stmt !== ';') statements.push(stmt);
                current = '';
            }
        }
        if (current.trim()) statements.push(current.trim());

        for (const statement of statements) {
            try {
                await pool.query(statement);
            } catch (err) {
                if (!err.message.includes('already exists') &&
                    !err.message.includes('duplicate key')) {
                    serverLog('warn', 'companion', `[Companion] Schema warning: ${err.message}`);
                }
            }
        }
        serverLog('info', 'companion', '[Companion] Schema initialized');

        // Petdex 公開 gallery mirror — fire-and-forget so a network blip
        // can't block server startup. Re-runs on every init are upserts.
        if (process.env.PETDEX_SYNC_ON_BOOT !== '0') {
            syncPetdexCatalog(pool, serverLog).catch((err) => {
                serverLog('warn', 'petdex-bridge', `[Petdex] background sync failed: ${err.message}`);
            });
        }
    } catch (err) {
        serverLog('error', 'companion', `[Companion] Schema init failed: ${err.message}`);
    }
}

module.exports = function companionFactory({ authenticateBot, authenticateDeviceOrBot, serverLog, createPetdxPhase0Io } = {}) {
    if (typeof authenticateBot !== 'function') {
        throw new Error('companionFactory requires authenticateBot');
    }
    const log = serverLog || (() => {});
    // Optional: if not injected (e.g. some unit tests), /api/companion/select
    // falls back to the legacy log-only path. The §0.4a invariant only holds
    // when the IO factory is wired in (production + jest integration tests).
    const petdxIoFactory = typeof createPetdxPhase0Io === 'function' ? createPetdxPhase0Io : null;
    const router = express.Router();

    // Submit rate-limit: per-entity sliding window, factory-scoped so unit
    // tests automatically get a fresh limiter per `companionFactory(...)` call.
    // Map<entityId, number[]> — values are timestamps within the window.
    const submitLog = new Map();
    function checkSubmitRateLimit(entityId) {
        const now = Date.now();
        const cutoff = now - SUBMIT_RATE_LIMIT_WINDOW_MS;
        const arr = (submitLog.get(entityId) || []).filter(t => t > cutoff);
        if (arr.length >= SUBMIT_RATE_LIMIT_MAX) return false;
        arr.push(now);
        submitLog.set(entityId, arr);
        return true;
    }

    // Read endpoints accept either device-owner (deviceSecret) or bot
    // (botSecret+entityId) auth so portal pages with deviceSecret in
    // localStorage can browse the catalog without holding per-bot secrets.
    // `req.botAuth.entityId` may be null on device-only auth — `scope=mine`
    // still requires botSecret because it filters by author entity.
    function authReader(req, res, next) {
        const deviceId = req.query.deviceId || req.body?.deviceId;
        const deviceSecret = req.query.deviceSecret || req.body?.deviceSecret;
        const botSecret = req.query.botSecret || req.body?.botSecret;
        const entityIdRaw = req.query.entityId || req.body?.entityId;
        const entityId = entityIdRaw != null ? parseInt(entityIdRaw, 10) : null;

        if (!deviceId || (!deviceSecret && !botSecret)) {
            return res.status(400).json({ success: false, error: 'deviceId + (deviceSecret | botSecret+entityId) required' });
        }
        let ok = false;
        if (typeof authenticateDeviceOrBot === 'function') {
            ok = authenticateDeviceOrBot({
                deviceId, deviceSecret, botSecret,
                entityId: Number.isFinite(entityId) ? entityId : undefined,
            });
        } else if (botSecret && Number.isFinite(entityId)) {
            ok = authenticateBot(deviceId, entityId, botSecret);
        }
        if (!ok) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        req.botAuth = {
            deviceId,
            botSecret: botSecret || null,
            entityId: Number.isFinite(entityId) ? entityId : null,
            authMode: deviceSecret ? 'device' : 'bot',
        };
        next();
    }

    // ── GET /api/companion/list ───────────────────────────────────
    // Query: category, mood, color, q, tags, sort, scope, assetType,
    //        page, limit, author
    router.get('/list', authReader, async (req, res) => {
        const { category, mood, color, q, sort, scope, assetType, author } = req.query;
        const tags = parseTags(req.query.tags);
        const page = parsePositiveInt(req.query.page, 1);
        const limit = parsePositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
        const offset = (page - 1) * limit;

        const sortKey = ALLOWED_SORTS.has(sort) ? sort : 'popular';
        const scopeKey = ALLOWED_SCOPES.has(scope) ? scope : 'all';

        if (assetType && !ALLOWED_ASSET_TYPES.has(assetType)) {
            return res.status(400).json({ success: false, error: 'invalid_asset_type' });
        }
        if (category && !ALLOWED_CATEGORIES.has(category)) {
            return res.status(400).json({ success: false, error: 'invalid_category' });
        }

        const conds = ["status = 'published'"];
        const params = [];
        // bind(value) → returns the next "$N" placeholder string
        const bind = (val) => { params.push(val); return '$' + params.length; };

        if (scopeKey === 'system')    conds.push("scope = 'system'");
        if (scopeKey === 'community') conds.push("scope = 'community'");
        if (scopeKey === 'mine') {
            if (req.botAuth.entityId == null) {
                return res.status(400).json({ success: false, error: 'scope_mine_requires_entity' });
            }
            conds.push(`author_entity_id = ${bind(req.botAuth.entityId)}`);
            conds.push(`device_id = ${bind(req.botAuth.deviceId)}`);
        }
        if (category)  conds.push(`category = ${bind(category)}`);
        if (mood)      conds.push(`mood = ${bind(mood)}`);
        if (color)     conds.push(`color = ${bind(color)}`);
        if (assetType) conds.push(`asset_type = ${bind(assetType)}`);
        if (author) {
            const authorId = parseInt(author, 10);
            if (Number.isFinite(authorId)) conds.push(`author_entity_id = ${bind(authorId)}`);
        }
        if (q) {
            const term = '%' + String(q).replace(/[\\%_]/g, c => '\\' + c).slice(0, 80) + '%';
            const p1 = bind(term);
            const p2 = bind(term);
            conds.push(`(name ILIKE ${p1} OR (descriptor->>'description') ILIKE ${p2})`);
        }
        if (tags.length) {
            conds.push(`tags @> ${bind(JSON.stringify(tags))}::jsonb`);
        }

        const orderBy = {
            popular:   'download_count DESC, published_at DESC',
            recent:    'published_at DESC NULLS LAST',
            rating:    'rating_avg DESC NULLS LAST, rating_count DESC',
            favorites: 'favorite_count DESC, published_at DESC',
        }[sortKey];

        const where = conds.join(' AND ');
        const listSql = `
            SELECT id, name, version, author_entity_id, descriptor, asset_type, asset_url,
                   avatar_url, thumbnail_url, supported_states, scope, status, license,
                   category, mood, color, tags, i18n_data,
                   download_count, favorite_count, rating_avg, rating_count, comment_count,
                   published_at
              FROM companions
             WHERE ${where}
             ORDER BY ${orderBy}
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;
        const countSql = `SELECT COUNT(*)::int AS total FROM companions WHERE ${where}`;

        try {
            const [listRes, countRes] = await Promise.all([
                pool.query(listSql, [...params, limit, offset]),
                pool.query(countSql, params),
            ]);
            res.json({
                success: true,
                page,
                limit,
                total: countRes.rows[0]?.total || 0,
                companions: listRes.rows.map(rowToCompanionCard),
            });
        } catch (err) {
            log('error', 'companion', `[Companion] list query failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'query_failed' });
        }
    });

    // ── GET /api/companion/current ────────────────────────────────
    // Returns the caller's current selected companion + favorite ids.
    // Owner key: (deviceId, entityId|null) — so device-only auth gets the
    // device-level selection bucket, and bot auth gets per-entity.
    router.get('/current', authReader, async (req, res) => {
        const ownerEntity = req.botAuth.entityId; // may be null
        try {
            // Latest select_log row for (device, entity) → joined to companions
            // for the descriptor payload. LEFT JOIN so a deleted companion
            // returns selection=null instead of erroring.
            const selectSql = `
                SELECT s.companion_id, s.selected_at, s.source,
                       c.id, c.name, c.version, c.author_entity_id, c.descriptor,
                       c.asset_type, c.asset_url, c.avatar_url, c.thumbnail_url,
                       c.supported_states, c.scope, c.status, c.license,
                       c.category, c.mood, c.color, c.tags, c.i18n_data,
                       c.download_count, c.favorite_count, c.rating_avg,
                       c.rating_count, c.comment_count, c.published_at
                  FROM companion_select_log s
             LEFT JOIN companions c ON c.id = s.companion_id
                 WHERE s.device_id = $1
                   AND s.entity_id IS NOT DISTINCT FROM $2
              ORDER BY s.selected_at DESC
                 LIMIT 1
            `;
            const favSql = `
                SELECT companion_id, created_at
                  FROM companion_favorites
                 WHERE device_id = $1
                   AND entity_id IS NOT DISTINCT FROM $2
              ORDER BY created_at DESC
                 LIMIT 200
            `;
            const [selRes, favRes] = await Promise.all([
                pool.query(selectSql, [req.botAuth.deviceId, ownerEntity]),
                pool.query(favSql,    [req.botAuth.deviceId, ownerEntity]),
            ]);

            let selection = null;
            if (selRes.rowCount > 0 && selRes.rows[0].id) {
                const r = selRes.rows[0];
                selection = {
                    selectedAt: Number(r.selected_at),
                    source: r.source,
                    companion: rowToCompanionDetail(r),
                };
            }
            res.json({
                success: true,
                selection,
                favorites: favRes.rows.map(r => ({
                    companionId: r.companion_id,
                    favoritedAt: Number(r.created_at),
                })),
            });
        } catch (err) {
            log('error', 'companion', `[Companion] current query failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'query_failed' });
        }
    });

    // ── POST /api/companion/select ────────────────────────────────
    // Body: { companionId, source? }
    //
    // Spec: docs/specs/petdx-uiux-spec-amendment-2026-05-31-phase-0-4a.md §0.4a.
    //
    // Atomic write across two state layers:
    //   1. companion_select_log row (with origin='user-selected' — the new
    //      audit column from the 2026-05-30-companion-origin migration).
    //   2. Vault keys PETDX_CURRENT_<id>, PETDX_AVATAR_<id>, PETDX_SOURCE_<id>
    //      via createPetdxPhase0Io().setDeviceVars (the same factory the bind
    //      hook uses, so write semantics stay consistent).
    //
    // The spec invariant is "no partial success." Implementation:
    //   a. Resolve the avatar URL from the companions row BEFORE any write
    //      opens, so the write phase only does writes.
    //   b. Snapshot prior vault values for the three keys (so we can restore
    //      on a downstream log-tx failure).
    //   c. Open a tx on a client checked out from the local pool. INSERT
    //      the log row, but DO NOT commit yet.
    //   d. Write the vault keys. If that throws, ROLLBACK the log tx and
    //      return 500 {layer:'vault'}.
    //   e. Try to COMMIT the log tx. If COMMIT throws, restore the prior
    //      vault values and return 500 {layer:'log'}.
    //   f. On success, both layers are consistent: vault matches the latest
    //      log row, and the §0.4 resolver chain can read either.
    //
    // The vault and log writes use different pg pools (the IO factory has its
    // own chatPool; the log uses companion-api's local pool). True
    // cross-pool 2PC is not on the table — instead the write order plus
    // explicit vault restore on log COMMIT failure gives the same observable
    // guarantee: either both layers reflect the new selection, or neither
    // does. The only window where they can disagree is between vault write
    // and log COMMIT, and the restore step closes that window unless the
    // restore itself throws (logged loudly, then the route returns 500).
    router.post('/select', authReader, async (req, res) => {
        const companionId = req.body?.companionId;
        const source = req.body?.source || 'portal';
        if (!companionId || !/^[a-z0-9-]{1,80}$/i.test(companionId)) {
            return res.status(400).json({ success: false, error: 'invalid_companion_id' });
        }
        if (!ALLOWED_SELECT_SOURCES.has(source)) {
            return res.status(400).json({ success: false, error: 'invalid_source' });
        }

        const deviceId = req.botAuth.deviceId;
        const entityId = req.botAuth.entityId;
        const currentKey = `PETDX_CURRENT_${entityId}`;
        const avatarKey  = `PETDX_AVATAR_${entityId}`;
        const sourceKey  = `PETDX_SOURCE_${entityId}`;
        const origin     = 'user-selected';

        let cRow;
        try {
            const cRes = await pool.query(
                `SELECT id, status, scope, device_id, author_entity_id,
                        avatar_url, descriptor
                   FROM companions
                  WHERE id = $1`,
                [companionId]
            );
            if (cRes.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }
            cRow = cRes.rows[0];
            const isOwner = req.botAuth.authMode === 'device'
                ? cRow.device_id === deviceId
                : (cRow.author_entity_id === entityId
                    && cRow.device_id === deviceId);
            if (cRow.status !== 'published' && cRow.scope !== 'system' && !isOwner) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }
        } catch (err) {
            log('error', 'companion', `[Companion] select lookup failed: ${err.message}`);
            return res.status(500).json({ success: false, error: 'query_failed' });
        }

        const resolvedAvatarUrl = resolveCompanionAvatarUrl(cRow, companionId);
        const now = Date.now();

        // Vault mirror is per-entity. Device-secret auth (no botSecret) carries
        // no entity context, so there's no PETDX_*_<id> to mirror — fall through
        // to the legacy log-only path. Without this guard the vault would
        // accumulate PETDX_CURRENT_null / PETDX_AVATAR_null / PETDX_SOURCE_null
        // dead keys on every device-secret select, which the §0.4 resolver
        // chain never reads but they pollute /api/device-vars output.
        if (!petdxIoFactory || entityId == null) {
            try {
                await pool.query(
                    `INSERT INTO companion_select_log
                        (device_id, entity_id, companion_id, selected_at, source, origin)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [deviceId, entityId, companionId, now, source, origin]
                );
                return res.json({
                    success: true,
                    selection: { companionId, selectedAt: now, source },
                });
            } catch (err) {
                log('error', 'companion', `[Companion] select (legacy path) failed: ${err.message}`);
                return res.status(500).json({ success: false, error: 'query_failed' });
            }
        }

        const io = petdxIoFactory();
        let priorVault;
        try {
            priorVault = {
                [currentKey]: await io.getDeviceVar(deviceId, currentKey),
                [avatarKey]:  await io.getDeviceVar(deviceId, avatarKey),
                [sourceKey]:  await io.getDeviceVar(deviceId, sourceKey),
            };
        } catch (err) {
            log('error', 'companion', `[Companion] select vault snapshot failed: ${err.message}`);
            return res.status(500).json({ success: false, layer: 'vault', error: 'vault_read_failed' });
        }

        const client = await pool.connect();
        let txOpened = false;
        let vaultWritten = false;
        try {
            await client.query('BEGIN');
            txOpened = true;

            await client.query(
                `INSERT INTO companion_select_log
                    (device_id, entity_id, companion_id, selected_at, source, origin)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [deviceId, entityId, companionId, now, source, origin]
            );

            try {
                await io.setDeviceVars(deviceId, {
                    [currentKey]: companionId,
                    [avatarKey]:  resolvedAvatarUrl,
                    [sourceKey]:  origin,
                });
                vaultWritten = true;
            } catch (vErr) {
                await client.query('ROLLBACK');
                txOpened = false;
                log('error', 'companion', `[Companion] select vault write failed: ${vErr.message}`);
                return res.status(500).json({ success: false, layer: 'vault', error: 'vault_write_failed' });
            }

            try {
                await client.query('COMMIT');
                txOpened = false;
            } catch (cErr) {
                log('error', 'companion', `[Companion] select log commit failed: ${cErr.message}`);
                try {
                    await io.setDeviceVars(deviceId, priorVault);
                } catch (restoreErr) {
                    log('error', 'companion', `[Companion] vault restore failed after log COMMIT error: ${restoreErr.message}`);
                }
                return res.status(500).json({ success: false, layer: 'log', error: 'log_commit_failed' });
            }

            return res.json({
                success: true,
                selection: {
                    companionId,
                    selectedAt: now,
                    source,
                    avatarUrl: resolvedAvatarUrl,
                    origin,
                },
            });
        } catch (err) {
            if (txOpened) {
                try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
            }
            if (vaultWritten) {
                try { await io.setDeviceVars(deviceId, priorVault); }
                catch (restoreErr) {
                    log('error', 'companion', `[Companion] vault restore failed after late error: ${restoreErr.message}`);
                }
            }
            log('error', 'companion', `[Companion] select failed: ${err.message}`);
            return res.status(500).json({ success: false, layer: 'log', error: 'query_failed' });
        } finally {
            client.release();
        }
    });

    // Resolve the avatar URL for the vault write. Preference order matches
    // the §0.4 frontend resolver: explicit avatar_url column wins; otherwise
    // try descriptor.avatar.url (set by marketplace submit), then fall back
    // to the Phase 0 static-path convention. This is the value that the
    // dashboard's fast-paint mirror will read until AvatarPetdx.preload()
    // resolves on the next page load.
    function resolveCompanionAvatarUrl(row, companionId) {
        if (row && typeof row.avatar_url === 'string' && row.avatar_url.trim()) {
            return row.avatar_url.trim();
        }
        const descriptor = row && row.descriptor;
        if (descriptor && typeof descriptor === 'object') {
            const url = descriptor.avatar && descriptor.avatar.url;
            if (typeof url === 'string' && url.trim()) return url.trim();
        }
        return `/static/companions/${companionId}/avatar.png`;
    }

    // ── POST /api/companion/:id/favorite ──────────────────────────
    // Body: { action: 'add' | 'remove' | 'toggle' (default) }
    // Single row per (device, entity, companion). favorite_count on companions
    // is kept in sync with INSERT/DELETE side-effects (best-effort, not a
    // trigger — Stage 2 trades strict consistency for fewer DB primitives).
    router.post('/:id/favorite', authReader, async (req, res) => {
        const { id } = req.params;
        if (!/^[a-z0-9-]{1,80}$/i.test(id)) {
            return res.status(400).json({ success: false, error: 'invalid_companion_id' });
        }
        const action = req.body?.action || 'toggle';
        if (!['add', 'remove', 'toggle'].includes(action)) {
            return res.status(400).json({ success: false, error: 'invalid_action' });
        }
        try {
            const cRes = await pool.query(
                `SELECT id, status, scope, device_id, author_entity_id, favorite_count
                   FROM companions WHERE id = $1`,
                [id]
            );
            if (cRes.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }
            const c = cRes.rows[0];
            const isOwner = req.botAuth.authMode === 'device'
                ? c.device_id === req.botAuth.deviceId
                : (c.author_entity_id === req.botAuth.entityId
                    && c.device_id === req.botAuth.deviceId);
            if (c.status !== 'published' && c.scope !== 'system' && !isOwner) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }

            const existsRes = await pool.query(
                `SELECT 1 FROM companion_favorites
                  WHERE device_id = $1
                    AND entity_id IS NOT DISTINCT FROM $2
                    AND companion_id = $3`,
                [req.botAuth.deviceId, req.botAuth.entityId, id]
            );
            const already = existsRes.rowCount > 0;
            const wantFavorited = action === 'toggle' ? !already : action === 'add';

            if (wantFavorited && !already) {
                await pool.query(
                    `INSERT INTO companion_favorites
                        (device_id, entity_id, companion_id, created_at)
                     VALUES ($1, $2, $3, $4)`,
                    [req.botAuth.deviceId, req.botAuth.entityId, id, Date.now()]
                );
                await pool.query(
                    `UPDATE companions SET favorite_count = favorite_count + 1 WHERE id = $1`,
                    [id]
                );
            } else if (!wantFavorited && already) {
                await pool.query(
                    `DELETE FROM companion_favorites
                      WHERE device_id = $1
                        AND entity_id IS NOT DISTINCT FROM $2
                        AND companion_id = $3`,
                    [req.botAuth.deviceId, req.botAuth.entityId, id]
                );
                await pool.query(
                    `UPDATE companions
                        SET favorite_count = GREATEST(favorite_count - 1, 0)
                      WHERE id = $1`,
                    [id]
                );
            }

            // Re-read fresh count for accurate client state.
            const fresh = await pool.query(
                `SELECT favorite_count FROM companions WHERE id = $1`,
                [id]
            );
            res.json({
                success: true,
                favorited: wantFavorited,
                companionId: id,
                favoriteCount: fresh.rows[0]?.favorite_count ?? c.favorite_count,
            });
        } catch (err) {
            log('error', 'companion', `[Companion] favorite failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'query_failed' });
        }
    });

    // ── GET /api/companion/:id/rating ─────────────────────────────
    // Caller's own rating (used to pre-fill the star UI). 200 + stars=null
    // when caller hasn't rated yet — distinct from 404 (companion missing).
    router.get('/:id/rating', authReader, async (req, res) => {
        const { id } = req.params;
        if (!/^[a-z0-9-]{1,80}$/i.test(id)) {
            return res.status(400).json({ success: false, error: 'invalid_companion_id' });
        }
        try {
            const exists = await pool.query(
                `SELECT 1 FROM companions WHERE id = $1`,
                [id]
            );
            if (exists.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }
            const r = await pool.query(
                `SELECT stars, created_at, updated_at
                   FROM companion_ratings
                  WHERE companion_id = $1
                    AND device_id = $2
                    AND entity_id IS NOT DISTINCT FROM $3`,
                [id, req.botAuth.deviceId, req.botAuth.entityId]
            );
            res.json({
                success: true,
                companionId: id,
                stars: r.rowCount > 0 ? r.rows[0].stars : null,
                createdAt: r.rowCount > 0 ? Number(r.rows[0].created_at) : null,
                updatedAt: r.rowCount > 0 ? Number(r.rows[0].updated_at) : null,
            });
        } catch (err) {
            log('error', 'companion', `[Companion] rating get failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'query_failed' });
        }
    });

    // ── POST /api/companion/:id/rating ────────────────────────────
    // Body: { stars: 1..5 }. Upsert per (device, entity). Recompute
    // companions.rating_avg + rating_count atomically (well, two queries —
    // good enough for v1; trigger upgrade can come with comment moderation).
    router.post('/:id/rating', authReader, async (req, res) => {
        const { id } = req.params;
        if (!/^[a-z0-9-]{1,80}$/i.test(id)) {
            return res.status(400).json({ success: false, error: 'invalid_companion_id' });
        }
        const stars = parseInt(req.body?.stars, 10);
        if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
            return res.status(400).json({ success: false, error: 'invalid_stars' });
        }
        try {
            const cRes = await pool.query(
                `SELECT id, status, scope, device_id, author_entity_id
                   FROM companions WHERE id = $1`,
                [id]
            );
            if (cRes.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }
            const c = cRes.rows[0];
            const isOwner = req.botAuth.authMode === 'device'
                ? c.device_id === req.botAuth.deviceId
                : (c.author_entity_id === req.botAuth.entityId
                    && c.device_id === req.botAuth.deviceId);
            if (c.status !== 'published' && c.scope !== 'system' && !isOwner) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }

            const now = Date.now();
            const existsRes = await pool.query(
                `SELECT id FROM companion_ratings
                  WHERE companion_id = $1
                    AND device_id = $2
                    AND entity_id IS NOT DISTINCT FROM $3`,
                [id, req.botAuth.deviceId, req.botAuth.entityId]
            );
            if (existsRes.rowCount > 0) {
                await pool.query(
                    `UPDATE companion_ratings
                        SET stars = $1, updated_at = $2
                      WHERE id = $3`,
                    [stars, now, existsRes.rows[0].id]
                );
            } else {
                await pool.query(
                    `INSERT INTO companion_ratings
                        (device_id, entity_id, companion_id, stars, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $5)`,
                    [req.botAuth.deviceId, req.botAuth.entityId, id, stars, now]
                );
            }

            const aggRes = await pool.query(
                `SELECT COUNT(*)::int AS n, AVG(stars)::real AS avg
                   FROM companion_ratings WHERE companion_id = $1`,
                [id]
            );
            const { n, avg } = aggRes.rows[0];
            await pool.query(
                `UPDATE companions
                    SET rating_count = $1, rating_avg = $2
                  WHERE id = $3`,
                [n, avg, id]
            );

            res.json({
                success: true,
                companionId: id,
                stars,
                ratingAvg: avg,
                ratingCount: n,
            });
        } catch (err) {
            log('error', 'companion', `[Companion] rating post failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'query_failed' });
        }
    });

    // ── GET /api/companion/:id/comments?page&limit ────────────────
    // Public read (all callers see the same list). Excludes soft-deleted rows.
    router.get('/:id/comments', authReader, async (req, res) => {
        const { id } = req.params;
        if (!/^[a-z0-9-]{1,80}$/i.test(id)) {
            return res.status(400).json({ success: false, error: 'invalid_companion_id' });
        }
        const page = parsePositiveInt(req.query.page, 1);
        const limit = parsePositiveInt(req.query.limit, 30, 100);
        const offset = (page - 1) * limit;
        try {
            const exists = await pool.query(
                `SELECT 1 FROM companions WHERE id = $1`,
                [id]
            );
            if (exists.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }
            const [listRes, countRes] = await Promise.all([
                pool.query(
                    `SELECT id, entity_id, text, created_at
                       FROM companion_comments
                      WHERE companion_id = $1 AND deleted_at IS NULL
                   ORDER BY created_at DESC
                      LIMIT $2 OFFSET $3`,
                    [id, limit, offset]
                ),
                pool.query(
                    `SELECT COUNT(*)::int AS n
                       FROM companion_comments
                      WHERE companion_id = $1 AND deleted_at IS NULL`,
                    [id]
                ),
            ]);
            res.json({
                success: true,
                page,
                limit,
                total: countRes.rows[0]?.n || 0,
                comments: listRes.rows.map(r => ({
                    id: String(r.id),
                    author: r.entity_id != null ? { entityId: r.entity_id } : null,
                    text: r.text,
                    createdAt: Number(r.created_at),
                })),
            });
        } catch (err) {
            log('error', 'companion', `[Companion] comments list failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'query_failed' });
        }
    });

    // ── POST /api/companion/:id/comment ───────────────────────────
    // Body: { text }. 1-500 chars after trim. Bumps companions.comment_count.
    router.post('/:id/comment', authReader, async (req, res) => {
        const { id } = req.params;
        if (!/^[a-z0-9-]{1,80}$/i.test(id)) {
            return res.status(400).json({ success: false, error: 'invalid_companion_id' });
        }
        const text = String(req.body?.text || '').trim();
        if (text.length < 1 || text.length > 500) {
            return res.status(400).json({ success: false, error: 'invalid_comment_text' });
        }
        try {
            const cRes = await pool.query(
                `SELECT id, status, scope, device_id, author_entity_id
                   FROM companions WHERE id = $1`,
                [id]
            );
            if (cRes.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }
            const c = cRes.rows[0];
            const isOwner = req.botAuth.authMode === 'device'
                ? c.device_id === req.botAuth.deviceId
                : (c.author_entity_id === req.botAuth.entityId
                    && c.device_id === req.botAuth.deviceId);
            if (c.status !== 'published' && c.scope !== 'system' && !isOwner) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }

            const ins = await pool.query(
                `INSERT INTO companion_comments
                    (device_id, entity_id, companion_id, text, created_at)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, created_at`,
                [req.botAuth.deviceId, req.botAuth.entityId, id, text, Date.now()]
            );
            await pool.query(
                `UPDATE companions
                    SET comment_count = comment_count + 1
                  WHERE id = $1`,
                [id]
            );

            const r = ins.rows[0];
            res.json({
                success: true,
                comment: {
                    id: String(r.id),
                    companionId: id,
                    author: req.botAuth.entityId != null
                        ? { entityId: req.botAuth.entityId }
                        : null,
                    text,
                    createdAt: Number(r.created_at),
                },
            });
        } catch (err) {
            log('error', 'companion', `[Companion] comment post failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'query_failed' });
        }
    });

    // ── DELETE /api/companion/comment/:cid ────────────────────────
    // Author or companion owner can soft-delete. We do NOT cascade through
    // /:id because the comment id is globally unique and the path looks
    // cleaner for portal UIs that already hold the comment id.
    router.delete('/comment/:cid', authReader, async (req, res) => {
        const cid = parseInt(req.params.cid, 10);
        if (!Number.isFinite(cid) || cid < 1) {
            return res.status(400).json({ success: false, error: 'invalid_comment_id' });
        }
        try {
            const r = await pool.query(
                `SELECT c.id, c.companion_id, c.device_id, c.entity_id, c.deleted_at,
                        co.device_id AS owner_device_id, co.author_entity_id AS owner_entity_id
                   FROM companion_comments c
              LEFT JOIN companions co ON co.id = c.companion_id
                  WHERE c.id = $1`,
                [cid]
            );
            if (r.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'comment_not_found' });
            }
            const row = r.rows[0];
            if (row.deleted_at != null) {
                return res.status(404).json({ success: false, error: 'comment_not_found' });
            }
            const isAuthor = row.device_id === req.botAuth.deviceId
                && (row.entity_id == null || row.entity_id === req.botAuth.entityId);
            const isCompanionOwner = row.owner_device_id === req.botAuth.deviceId
                && (req.botAuth.authMode === 'device'
                    || row.owner_entity_id === req.botAuth.entityId);
            if (!isAuthor && !isCompanionOwner) {
                return res.status(403).json({ success: false, error: 'forbidden' });
            }
            await pool.query(
                `UPDATE companion_comments SET deleted_at = $1 WHERE id = $2`,
                [Date.now(), cid]
            );
            await pool.query(
                `UPDATE companions
                    SET comment_count = GREATEST(comment_count - 1, 0)
                  WHERE id = $1`,
                [row.companion_id]
            );
            res.json({ success: true, commentId: String(cid) });
        } catch (err) {
            log('error', 'companion', `[Companion] comment delete failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'query_failed' });
        }
    });

    // ── POST /api/companion/submit ────────────────────────────────
    // Body: full descriptor payload (see validateSubmittedDescriptor). Inserts
    // a row with status='pending_review' + scope='community' attributed to the
    // caller's (deviceId, entityId). Pure bot auth — deviceSecret-only callers
    // have no authoring entity, so they're rejected with 400.
    router.post('/submit', authReader, async (req, res) => {
        if (req.botAuth.entityId == null) {
            return res.status(400).json({ success: false, error: 'submit_requires_entity' });
        }
        const err = validateSubmittedDescriptor(req.body);
        if (err) return res.status(400).json({ success: false, error: err });

        if (!checkSubmitRateLimit(req.botAuth.entityId)) {
            return res.status(429).json({ success: false, error: 'rate_limit_exceeded' });
        }

        const body = req.body;
        const id = body.id;
        const name = body.name.trim();
        const version = body.version || '1.0.0';
        const license = body.license || 'EClaw-default';
        const supportedStates = body.supportedStates;
        const tags = body.tags || [];
        try {
            const exists = await pool.query(
                `SELECT 1 FROM companions WHERE id = $1`, [id]
            );
            if (exists.rowCount > 0) {
                return res.status(409).json({ success: false, error: 'companion_id_exists' });
            }
            const now = Date.now();
            await pool.query(
                `INSERT INTO companions
                    (id, name, version, author_entity_id, device_id, descriptor,
                     asset_type, asset_url, avatar_url, thumbnail_url,
                     supported_states, scope, status, license,
                     category, mood, color, tags, i18n_data,
                     created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6,
                         $7, $8, $9, $10,
                         $11::jsonb, 'community', 'pending_review', $12,
                         $13, $14, $15, $16::jsonb, $17,
                         $18, $18)`,
                [
                    id, name, version, req.botAuth.entityId, req.botAuth.deviceId,
                    body.descriptor,
                    body.assetType, body.assetUrl || null, body.avatarUrl || null, body.thumbnailUrl || null,
                    JSON.stringify(supportedStates), license,
                    body.category || null, body.mood || null, body.color || null,
                    JSON.stringify(tags), body.i18nData || null,
                    now,
                ]
            );
            res.status(201).json({
                success: true,
                companion: {
                    id, name, version, status: 'pending_review',
                    scope: 'community', author: { entityId: req.botAuth.entityId },
                    createdAt: now,
                },
            });
        } catch (e) {
            log('error', 'companion', `[Companion] submit failed: ${e.message}`);
            res.status(500).json({ success: false, error: 'query_failed' });
        }
    });

    // ── GET /api/companion/pending ────────────────────────────────
    // Device-owner-only review queue. Lists pending_review companions on
    // this device (creator's deviceId == caller's deviceId). Bot auth is
    // explicitly rejected because the review action mutates global state
    // and we don't want sub-bots auto-publishing each other's submissions.
    router.get('/pending', authReader, async (req, res) => {
        if (req.botAuth.authMode !== 'device') {
            return res.status(403).json({ success: false, error: 'device_owner_only' });
        }
        const page = parsePositiveInt(req.query.page, 1);
        const limit = parsePositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
        const offset = (page - 1) * limit;
        try {
            const [listRes, countRes] = await Promise.all([
                pool.query(
                    `SELECT id, name, version, author_entity_id, device_id, descriptor,
                            asset_type, asset_url, avatar_url, thumbnail_url,
                            supported_states, scope, status, license,
                            category, mood, color, tags, i18n_data,
                            download_count, favorite_count, rating_avg, rating_count,
                            comment_count, published_at, created_at
                       FROM companions
                      WHERE status = 'pending_review' AND device_id = $1
                   ORDER BY created_at DESC
                      LIMIT $2 OFFSET $3`,
                    [req.botAuth.deviceId, limit, offset]
                ),
                pool.query(
                    `SELECT COUNT(*)::int AS n FROM companions
                      WHERE status = 'pending_review' AND device_id = $1`,
                    [req.botAuth.deviceId]
                ),
            ]);
            res.json({
                success: true,
                page, limit,
                total: countRes.rows[0]?.n || 0,
                companions: listRes.rows.map(rowToCompanionDetail),
            });
        } catch (e) {
            log('error', 'companion', `[Companion] pending list failed: ${e.message}`);
            res.status(500).json({ success: false, error: 'query_failed' });
        }
    });

    // ── POST /api/companion/:id/review ────────────────────────────
    // Body: { decision: 'approve'|'reject', reason? }. Device-owner-only.
    // Approve flips status→published + sets published_at. Reject stores
    // reject_reason (truncated to 500). Only pending_review rows are
    // reviewable; published / rejected / hidden return 409.
    router.post('/:id/review', authReader, async (req, res) => {
        if (req.botAuth.authMode !== 'device') {
            return res.status(403).json({ success: false, error: 'device_owner_only' });
        }
        const { id } = req.params;
        if (!ID_RE.test(id)) {
            return res.status(400).json({ success: false, error: 'invalid_companion_id' });
        }
        const decision = req.body?.decision;
        if (decision !== 'approve' && decision !== 'reject') {
            return res.status(400).json({ success: false, error: 'invalid_decision' });
        }
        const reason = decision === 'reject'
            ? String(req.body?.reason || '').slice(0, 500) || null
            : null;
        try {
            const cRes = await pool.query(
                `SELECT id, status, device_id FROM companions WHERE id = $1`, [id]
            );
            if (cRes.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }
            const c = cRes.rows[0];
            if (c.device_id !== req.botAuth.deviceId) {
                return res.status(403).json({ success: false, error: 'forbidden' });
            }
            if (c.status !== 'pending_review') {
                return res.status(409).json({ success: false, error: 'not_pending_review' });
            }
            const now = Date.now();
            if (decision === 'approve') {
                await pool.query(
                    `UPDATE companions
                        SET status = 'published',
                            published_at = $1,
                            updated_at = $1,
                            rejected_at = NULL,
                            reject_reason = NULL
                      WHERE id = $2`,
                    [now, id]
                );
                res.json({
                    success: true,
                    companion: { id, status: 'published', publishedAt: now },
                });
            } else {
                await pool.query(
                    `UPDATE companions
                        SET status = 'rejected',
                            rejected_at = $1,
                            updated_at = $1,
                            reject_reason = $2
                      WHERE id = $3`,
                    [now, reason, id]
                );
                res.json({
                    success: true,
                    companion: { id, status: 'rejected', rejectedAt: now, rejectReason: reason },
                });
            }
        } catch (e) {
            log('error', 'companion', `[Companion] review failed: ${e.message}`);
            res.status(500).json({ success: false, error: 'query_failed' });
        }
    });

    // ── DELETE /api/companion/:id ─────────────────────────────────
    // Hard delete pending_review rows only. Authorized for: (a) creator —
    // (deviceId, entityId) match the row's; (b) device owner — deviceSecret
    // auth on the row's device. Published rows are hidden via review path,
    // not deleted, so their stats history survives.
    router.delete('/:id', authReader, async (req, res) => {
        const { id } = req.params;
        if (!ID_RE.test(id)) {
            return res.status(400).json({ success: false, error: 'invalid_companion_id' });
        }
        try {
            const cRes = await pool.query(
                `SELECT id, status, device_id, author_entity_id
                   FROM companions WHERE id = $1`,
                [id]
            );
            if (cRes.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }
            const c = cRes.rows[0];
            if (c.status !== 'pending_review') {
                return res.status(409).json({ success: false, error: 'not_pending_review' });
            }
            const isOwner = req.botAuth.authMode === 'device'
                && c.device_id === req.botAuth.deviceId;
            const isCreator = req.botAuth.authMode === 'bot'
                && c.device_id === req.botAuth.deviceId
                && c.author_entity_id === req.botAuth.entityId;
            if (!isOwner && !isCreator) {
                return res.status(403).json({ success: false, error: 'forbidden' });
            }
            await pool.query(`DELETE FROM companions WHERE id = $1`, [id]);
            res.json({ success: true, companionId: id });
        } catch (e) {
            log('error', 'companion', `[Companion] delete failed: ${e.message}`);
            res.status(500).json({ success: false, error: 'query_failed' });
        }
    });

    // ── GET /api/companion/:id ────────────────────────────────────
    router.get('/:id', authReader, async (req, res) => {
        const { id } = req.params;
        if (!/^[a-z0-9-]{1,80}$/i.test(id)) {
            return res.status(400).json({ success: false, error: 'invalid_companion_id' });
        }
        try {
            const r = await pool.query(
                `SELECT id, name, version, author_entity_id, device_id, descriptor, asset_type,
                        asset_url, avatar_url, thumbnail_url, supported_states, scope, status,
                        license, category, mood, color, tags, i18n_data,
                        download_count, favorite_count, rating_avg, rating_count, comment_count,
                        published_at
                   FROM companions
                  WHERE id = $1`,
                [id]
            );
            if (r.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }
            const row = r.rows[0];
            const isOwner = req.botAuth.authMode === 'device'
                ? row.device_id === req.botAuth.deviceId
                : (row.author_entity_id === req.botAuth.entityId
                    && row.device_id === req.botAuth.deviceId);
            if (row.status !== 'published' && row.scope !== 'system' && !isOwner) {
                return res.status(404).json({ success: false, error: 'companion_not_found' });
            }
            res.json({ success: true, companion: rowToCompanionDetail(row) });
        } catch (err) {
            log('error', 'companion', `[Companion] detail query failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'query_failed' });
        }
    });

    // ── POST /petdex-sync — manual Petdex catalog refresh ──────────
    // deviceSecret-auth (owner-only) on top of authReader's `deviceSecret`
    // branch; runs the same upsert as boot-time init. Cheap to retry, the
    // bridge is idempotent.
    router.post('/petdex-sync', authReader, async (req, res) => {
        if (req.botAuth.authMode !== 'device') {
            return res.status(403).json({ success: false, error: 'deviceSecret_required' });
        }
        try {
            const result = await syncPetdexCatalog(pool, log);
            res.json({ success: true, ...result });
        } catch (err) {
            log('error', 'companion', `[Companion] petdex-sync failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'sync_failed' });
        }
    });

    // ── POST /petdex-recover — backfill orphan-slug companions ─────
    // The manifest-driven sync only touches rows whose slug still appears
    // upstream. Six EClaw entity companions reference older catalog slugs
    // that were rotated out of the manifest, so they never get caught by
    // the regular sync and stay needs_recovery=true forever. This route
    // walks the companions table itself, tries to re-fetch each orphan's
    // existing upstream asset_url with the bridge's Referer trick, and
    // promotes the row to the EClaw R2 proxy URL when it succeeds.
    //
    // deviceSecret-auth (owner-only). Idempotent via the bridge's R2 HEAD.
    const {
        fetchAndUploadSprite,
        spriteProxyUrl,
        R2_KEY_PREFIX,
        PROXY_PATH_PREFIX,
    } = require('./petdex-bridge');
    router.post('/petdex-recover', authReader, async (req, res) => {
        if (req.botAuth.authMode !== 'device') {
            return res.status(403).json({ success: false, error: 'deviceSecret_required' });
        }
        const limit = Math.max(1, Math.min(parseInt(req.body && req.body.limit, 10) || 50, 500));
        const apiBase = process.env.PUBLIC_BASE_URL
            || process.env.BASE_URL
            || process.env.API_BASE
            || 'https://eclawbot.com';

        let r2;
        try {
            const { S3Client } = require('@aws-sdk/client-s3');
            r2 = new S3Client({
                region: 'auto',
                endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
                credentials: {
                    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
                    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
                },
            });
        } catch (err) {
            return res.status(500).json({ success: false, error: 'r2_init_failed' });
        }
        const bucket = process.env.R2_BUCKET_NAME || 'eclaw-files';

        try {
            // Targets: rows that still point upstream (not yet on the proxy)
            // OR were flagged needs_recovery by an earlier sync attempt.
            const rows = (await pool.query(
                `SELECT id, asset_url, descriptor
                   FROM companions
                  WHERE asset_type = 'spritesheet'
                    AND (needs_recovery = TRUE OR asset_url NOT LIKE $1)
                    AND id LIKE 'petdex-%'
                  ORDER BY updated_at DESC
                  LIMIT $2`,
                [`%${PROXY_PATH_PREFIX}/%`, limit],
            )).rows;

            let promoted = 0;
            let stillBroken = 0;
            const errors = [];

            for (const row of rows) {
                const slug = row.id.replace(/^petdex-/, '');
                const upstreamUrl = row.asset_url;
                if (!slug || !upstreamUrl) {
                    stillBroken++;
                    continue;
                }
                const upload = await fetchAndUploadSprite({
                    r2, bucket, slug, upstreamUrl, log,
                });
                if (!upload.ok) {
                    stillBroken++;
                    if (errors.length < 5) errors.push({ slug, reason: upload.reason });
                    continue;
                }
                const newUrl = spriteProxyUrl(apiBase, slug);
                // Rewrite the descriptor.asset.url to match — the renderer
                // reads from the descriptor, not the companions columns.
                let descriptor = row.descriptor;
                if (typeof descriptor === 'string') {
                    try { descriptor = JSON.parse(descriptor); } catch (_) { descriptor = null; }
                }
                if (descriptor && descriptor.asset) descriptor.asset.url = newUrl;
                await pool.query(
                    `UPDATE companions
                        SET asset_url = $1,
                            avatar_url = $1,
                            thumbnail_url = $1,
                            descriptor = COALESCE($2::jsonb, descriptor),
                            needs_recovery = FALSE,
                            updated_at = $3
                      WHERE id = $4`,
                    [newUrl, descriptor ? JSON.stringify(descriptor) : null, Date.now(), row.id],
                );
                promoted++;
            }

            res.json({ success: true, scanned: rows.length, promoted, stillBroken, errors });
        } catch (err) {
            log('error', 'companion', `[Companion] petdex-recover failed: ${err.message}`);
            res.status(500).json({ success: false, error: 'recover_failed', detail: err.message });
        }
    });

    return { router, initCompanionDatabase: () => initCompanionDatabase(log) };
};

module.exports.initCompanionDatabase = initCompanionDatabase;
module.exports._test = {
    parseTags, parsePositiveInt, rowToCompanionCard, rowToCompanionDetail,
    validateSubmittedDescriptor,
};
