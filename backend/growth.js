/**
 * Growth Metrics API — public-read aggregate stats for owner-admin bots
 *
 * Mounted at: /api/growth
 *
 * Endpoints:
 *   GET /daily — today's aggregate growth metrics
 *
 * Auth chain (all must pass):
 *   1. botSecret matches devices[deviceId].entities[entityId].botSecret
 *   2. user_accounts.is_admin = TRUE for the user owning that deviceId
 *   3. Per-bot rate limit: 60 requests / hour
 *
 * Response is aggregate-only (no PII, no user IDs, no IPs). Even if a
 * botSecret leaks, an attacker can only read site-wide totals already
 * implied by the public landing page.
 */

const express = require('express');
const { Pool } = require('pg');
const safeEqual = require('./safe-equal');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 60;
const rateBuckets = new Map();

function checkRate(botSecret) {
    const now = Date.now();
    const bucket = rateBuckets.get(botSecret) || { count: 0, resetAt: now + RATE_WINDOW_MS };
    if (now > bucket.resetAt) {
        bucket.count = 0;
        bucket.resetAt = now + RATE_WINDOW_MS;
    }
    bucket.count += 1;
    rateBuckets.set(botSecret, bucket);
    return bucket.count <= RATE_MAX;
}

function findEntity(devices, deviceId, entityId, botSecret) {
    const device = devices[deviceId];
    if (!device) return null;
    const entity = (device.entities || {})[entityId];
    if (!entity || !safeEqual(entity.botSecret, botSecret)) return null;
    return entity;
}

async function isOwnerAdmin(deviceId) {
    const r = await pool.query(
        'SELECT is_admin FROM user_accounts WHERE device_id = $1',
        [deviceId]
    );
    return r.rows.length > 0 && r.rows[0].is_admin === true;
}

const TZ = 'Asia/Taipei';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function taipeiTodayISO() {
    // Asia/Taipei is UTC+8 with no DST — shift and slice.
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function isValidDateStr(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

async function fetchSignupsForDate(dateStr) {
    const r = await pool.query(
        `SELECT COUNT(*)::int AS c FROM user_accounts
         WHERE created_at >= ($2::date::timestamp) AT TIME ZONE $1
           AND created_at <  (($2::date + INTERVAL '1 day')::timestamp) AT TIME ZONE $1`,
        [TZ, dateStr]
    );
    return r.rows[0].c;
}

async function fetchSignupSourceForDate(dateStr) {
    const r = await pool.query(
        `SELECT COALESCE(NULLIF(signup_source, ''), 'unknown') AS source,
                COUNT(*)::int AS count
         FROM user_accounts
         WHERE created_at >= ($2::date::timestamp) AT TIME ZONE $1
           AND created_at <  (($2::date + INTERVAL '1 day')::timestamp) AT TIME ZONE $1
         GROUP BY 1
         ORDER BY count DESC, source ASC
         LIMIT 20`,
        [TZ, dateStr]
    );
    return r.rows.map(row => ({ source: row.source || 'unknown', count: Number(row.count) || 0 }));
}

async function fetchRetention7dForDate(dateStr) {
    const r = await pool.query(
        `WITH anchor AS (
           SELECT $2::date AS d
         ),
         cohort AS (
           SELECT id FROM user_accounts, anchor
           WHERE created_at >= ((d - INTERVAL '7 days')::timestamp) AT TIME ZONE $1
             AND created_at <  ((d - INTERVAL '6 days')::timestamp) AT TIME ZONE $1
         ),
         active AS (
           SELECT c.id FROM cohort c
           JOIN user_accounts u ON u.id = c.id, anchor
           WHERE u.last_login_at >= (d::timestamp) AT TIME ZONE $1
             AND u.last_login_at <  ((d + INTERVAL '1 day')::timestamp) AT TIME ZONE $1
         )
         SELECT (SELECT COUNT(*) FROM cohort)::int AS cohort_size,
                (SELECT COUNT(*) FROM active)::int AS active_size`,
        [TZ, dateStr]
    );
    const { cohort_size, active_size } = r.rows[0];
    if (cohort_size === 0) return { cohort_size: 0, active_size: 0, pct: null };
    return {
        cohort_size,
        active_size,
        pct: Math.round((active_size / cohort_size) * 1000) / 10
    };
}

async function fetchPlazaNewListedForDate(dateStr) {
    const r = await pool.query(
        `SELECT COUNT(*)::int AS c FROM bot_listings
         WHERE status = 'listed'
           AND created_at >= ($2::date::timestamp) AT TIME ZONE $1
           AND created_at <  (($2::date + INTERVAL '1 day')::timestamp) AT TIME ZONE $1`,
        [TZ, dateStr]
    );
    return r.rows[0].c;
}

async function fetchInviteConversion() {
    // Viral-loop conversion: count from invite_codes directly because the live
    // POST /api/invite/redeem endpoint (index.js) writes to
    // invite_codes.used_by_device_id + used_at and never touches the Phase-5
    // invite_redemptions table (whose router in backend/invite.js is not
    // mounted as of 2026-04-20). Counting from invite_redemptions previously
    // pinned this metric at 0 indefinitely. When the Phase-5 router lands
    // and dual-writes to both tables, this query stays correct as long as
    // used_by_device_id is also populated.
    const r = await pool.query(
        `SELECT COUNT(*)::int AS total_codes,
                COUNT(*) FILTER (WHERE used_by_device_id IS NOT NULL)::int AS redeemed_codes
         FROM invite_codes`
    );
    const { total_codes, redeemed_codes } = r.rows[0];
    if (total_codes === 0) return { total_codes: 0, redeemed_codes: 0, pct: null };
    return {
        total_codes,
        redeemed_codes,
        pct: Math.round((redeemed_codes / total_codes) * 1000) / 10
    };
}

async function fetchInviteClicksForDate(anchorDate) {
    const r = await pool.query(
        `SELECT COUNT(*)::int AS total_clicks,
                COUNT(DISTINCT ic.ip_hash)::int AS unique_clicks,
                COALESCE(ic.source, 'direct') AS source
         FROM invite_clicks ic
         WHERE DATE(ic.clicked_at AT TIME ZONE $1) = $2::date
         GROUP BY COALESCE(ic.source, 'direct')
         ORDER BY total_clicks DESC`,
        [TZ, anchorDate]
    );
    const totalRow = r.rows.reduce((acc, row) => ({
        total_clicks: acc.total_clicks + row.total_clicks,
        unique_clicks: acc.unique_clicks + row.unique_clicks,
    }), { total_clicks: 0, unique_clicks: 0 });
    return {
        total: totalRow,
        by_source: r.rows.map(row => ({
            source: row.source,
            clicks: row.total_clicks,
            unique_clicks: row.unique_clicks,
        }))
    };
}

async function fetchPortalFunnel(since, until) {
    // Returns counts by action × meta->>'source' × meta->>'channel'
    // from portal_beacons table (no auth required for read — auth is at API layer)
    const r = await pool.query(
        `SELECT
            action,
            COALESCE(meta->>'source', 'direct') AS source,
            COALESCE(meta->>'channel', 'unknown') AS channel,
            COUNT(*)::int AS event_count
         FROM portal_beacons
         WHERE created_at >= $1::timestamptz
           AND created_at < ($2::timestamptz + INTERVAL '1 day')
         GROUP BY action, COALESCE(meta->>'source', 'direct'), COALESCE(meta->>'channel', 'unknown')
         ORDER BY action, event_count DESC`,
        [since, until]
    );

    // Aggregate into: { action -> { total, by_source: [{source, channel, count}] }
    const funnel = {};
    for (const row of r.rows) {
        if (!funnel[row.action]) {
            funnel[row.action] = { total: 0, by_source: [] };
        }
        funnel[row.action].total += row.event_count;
        funnel[row.action].by_source.push({
            source: row.source,
            channel: row.channel,
            count: row.event_count
        });
    }
    return funnel;
}


module.exports = function(devices) {
    const router = express.Router();

    router.get('/daily', async (req, res) => {
        const { deviceId, botSecret, entityId, date } = req.query;

        if (!deviceId || !botSecret || !entityId) {
            return res.status(400).json({ success: false, error: 'Missing deviceId, botSecret, or entityId' });
        }

        let anchorDate;
        if (date === undefined || date === '') {
            anchorDate = taipeiTodayISO();
        } else if (isValidDateStr(date)) {
            anchorDate = date;
        } else {
            return res.status(400).json({ success: false, error: 'Invalid date — expected YYYY-MM-DD' });
        }

        const entity = findEntity(devices, deviceId, parseInt(entityId), botSecret);
        if (!entity) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        if (!checkRate(botSecret)) {
            return res.status(429).json({ success: false, error: 'Rate limit exceeded (60/hour)' });
        }

        let admin;
        try {
            admin = await isOwnerAdmin(deviceId);
        } catch (err) {
            console.error('[Growth] admin check error:', err);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
        if (!admin) {
            return res.status(403).json({ success: false, error: 'Owner is not admin' });
        }

        try {
            const [today_signups, retention_7d, plaza_new_listed_today, invite_conversion, invite_clicks, source_channel] = await Promise.all([
                fetchSignupsForDate(anchorDate),
                fetchRetention7dForDate(anchorDate),
                fetchPlazaNewListedForDate(anchorDate),
                fetchInviteConversion(),
                fetchInviteClicksForDate(anchorDate),
                fetchSignupSourceForDate(anchorDate)
            ]);
            return res.json({
                success: true,
                date: anchorDate,
                today_signups,
                source_channel,
                retention_7d,
                plaza_new_listed_today,
                invite_conversion,
                invite_clicks,
                follow_ups: [
                    'visitor_to_signup_conversion: page_views has no FK to user_accounts',
                    'plaza_new_listed_today: counts created_at not status_changed_at (bot_listings has no listed_at column)',
                    'invite_conversion is cumulative-to-now (not date-scoped); needs invite_codes.used_at filter for historical k-value by day'
                ]
            });
        } catch (err) {
            console.error('[Growth] query error:', err);
            return res.status(500).json({ success: false, error: 'Query failed' });
        }
    });


    // GET /api/growth/funnel — portal beacon funnel counts by action × source × channel
    router.get('/funnel', async (req, res) => {
        const { deviceId, botSecret, entityId, since, until } = req.query;

        if (!deviceId || !botSecret || !entityId) {
            return res.status(400).json({ success: false, error: 'Missing deviceId, botSecret, or entityId' });
        }
        if (!since || !until) {
            return res.status(400).json({ success: false, error: 'since and until (YYYY-MM-DD) are required' });
        }
        if (!isValidDateStr(since) || !isValidDateStr(until)) {
            return res.status(400).json({ success: false, error: 'Invalid date — expected YYYY-MM-DD' });
        }

        const entity = findEntity(devices, deviceId, parseInt(entityId), botSecret);
        if (!entity) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        if (!checkRate(botSecret)) {
            return res.status(429).json({ success: false, error: 'Rate limit exceeded (60/hour)' });
        }

        try {
            const funnel = await fetchPortalFunnel(since, until);
            return res.json({ success: true, since, until, funnel });
        } catch (err) {
            console.error('[Growth] funnel error:', err);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    return {
        router,
        _internal: { checkRate, findEntity, isOwnerAdmin, fetchSignupsForDate, fetchSignupSourceForDate, fetchRetention7dForDate, fetchPlazaNewListedForDate, fetchInviteConversion, fetchInviteClicksForDate, fetchPortalFunnel, isValidDateStr, taipeiTodayISO, rateBuckets }
    };
};
