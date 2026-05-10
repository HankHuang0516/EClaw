/**
 * Companion API — Petdx 伙伴瀏覽器 / 社群伙伴貢獻系統
 *
 * Mounted at: /api/companion
 *
 * Spec: docs/specs/petdx-backend-api-spec.md (v0.2)
 * Stage 1 (this file): read endpoints only — list + detail.
 *   Stage 2: favorites + select + current
 *   Stage 3: ratings + comments
 *   Stage 4: submit + draft + review (creator + device-owner gated)
 *
 * Auth: deviceId + botSecret + entityId — same triple as /api/bot/*.
 * The factory caller injects `authenticateBot(deviceId, entityId, botSecret)`
 * so we don't reach into the global `devices` map directly.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

const ALLOWED_SORTS = new Set(['popular', 'recent', 'rating', 'favorites']);
const ALLOWED_SCOPES = new Set(['all', 'system', 'community', 'mine']);
const ALLOWED_ASSET_TYPES = new Set(['procedural', 'spritesheet', 'vector']);
const ALLOWED_CATEGORIES = new Set(['animal', 'human', 'robot', 'mascot', 'custom']);

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

function rowToCompanionCard(row) {
    return {
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
    } catch (err) {
        serverLog('error', 'companion', `[Companion] Schema init failed: ${err.message}`);
    }
}

module.exports = function companionFactory({ authenticateBot, authenticateDeviceOrBot, serverLog } = {}) {
    if (typeof authenticateBot !== 'function') {
        throw new Error('companionFactory requires authenticateBot');
    }
    const log = serverLog || (() => {});
    const router = express.Router();

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

    return { router, initCompanionDatabase: () => initCompanionDatabase(log) };
};

module.exports.initCompanionDatabase = initCompanionDatabase;
module.exports._test = { parseTags, parsePositiveInt, rowToCompanionCard, rowToCompanionDetail };
