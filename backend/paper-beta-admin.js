'use strict';

const express = require('express');
const APP_ID = 'paper-flick-soldiers';
const PAGE_SIZE = 50;
const MAX_ID = 9223372036854775807n;

// One snapshot of the existing intake table; no replication or schema writes.
const READ_SQL = `WITH scoped AS (
    SELECT id, rating, continuation, comment, app_version, platform, created_at
    FROM app_portfolio_beta_feedback WHERE app_id = $1
), page AS (
    SELECT id, rating, continuation, comment, app_version, platform, created_at
    FROM scoped WHERE ($2::bigint IS NULL OR id < $2::bigint)
    ORDER BY id DESC LIMIT $3
)
SELECT (SELECT COUNT(*)::text FROM scoped) AS total,
    (SELECT ROUND(AVG(rating), 2)::text FROM scoped) AS average,
    (SELECT COUNT(*)::text FROM scoped WHERE continuation = 'yes') AS yes,
    (SELECT COUNT(*)::text FROM scoped WHERE continuation = 'maybe') AS maybe,
    (SELECT COUNT(*)::text FROM scoped WHERE continuation = 'no') AS no,
    COALESCE((SELECT json_agg(json_build_object(
        'receiptId', id::text, 'rating', rating, 'continuation', continuation,
        'comment', comment, 'version', app_version, 'platform', platform,
        'createdAt', created_at) ORDER BY id DESC) FROM page), '[]'::json) AS items`;

function validCursor(value) {
    return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= MAX_ID;
}

function createRouter(getPool, authMiddleware, adminMiddleware) {
    const router = express.Router();
    router.use((req, res, next) => {
        res.set('Cache-Control', 'private, no-store');
        res.vary('Cookie');
        res.vary('Authorization');
        next();
    }, authMiddleware, adminMiddleware);
    router.get('/', async (req, res) => {
        if (Object.keys(req.query).some(key => key !== 'before') ||
            (req.query.before !== undefined && !validCursor(req.query.before))) {
            return res.status(400).json({ success: false, error: 'invalid_pagination' });
        }
        try {
            const result = await getPool().query(READ_SQL, [APP_ID, req.query.before || null, PAGE_SIZE + 1]);
            const row = result.rows[0];
            if (!row || !Array.isArray(row.items)) throw new Error('Invalid feedback query result');
            // Explicit output projection also strips unexpected driver/test fields.
            const items = row.items.slice(0, PAGE_SIZE).map(item => ({
                receiptId: String(item.receiptId), rating: item.rating, continuation: item.continuation,
                comment: String(item.comment || '').slice(0, 500), version: String(item.version || '').slice(0, 32),
                platform: String(item.platform || '').slice(0, 32), createdAt: item.createdAt
            }));
            res.json({ success: true, appId: APP_ID,
                summary: { total: String(row.total), averageRating: row.average === null ? null : Number(row.average),
                    continuation: { yes: String(row.yes), maybe: String(row.maybe), no: String(row.no) } },
                items, nextCursor: row.items.length > PAGE_SIZE ? items[items.length - 1].receiptId : null });
        } catch {
            res.status(503).json({ success: false, error: 'beta_feedback_unavailable' });
        }
    });
    return router;
}

// Reuse the same private reader for local diagnostics; never expose a second
// raw-feedback export or bypass the existing account administrator gate.
function createDebugRouter(getPool, authMiddleware, adminMiddleware) {
    const router = express.Router();
    router.use((req, res, next) => {
        if (process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production') {
            return res.status(404).json({ success: false, error: 'not_found' });
        }
        next();
    });
    router.use(createRouter(getPool, authMiddleware, adminMiddleware));
    return router;
}

module.exports = { createRouter, createDebugRouter, validCursor, READ_SQL };
