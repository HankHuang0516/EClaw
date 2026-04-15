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

async function fetchTodaySignups() {
    const r = await pool.query(
        `SELECT COUNT(*)::int AS c FROM user_accounts
         WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1
           AND created_at <  (date_trunc('day', NOW() AT TIME ZONE $1) + INTERVAL '1 day') AT TIME ZONE $1`,
        [TZ]
    );
    return r.rows[0].c;
}

async function fetchRetention7d() {
    const r = await pool.query(
        `WITH today_start AS (
           SELECT date_trunc('day', NOW() AT TIME ZONE $1) AS d
         ),
         cohort AS (
           SELECT id FROM user_accounts, today_start
           WHERE created_at >= (d - INTERVAL '7 days') AT TIME ZONE $1
             AND created_at <  (d - INTERVAL '6 days') AT TIME ZONE $1
         ),
         active AS (
           SELECT c.id FROM cohort c
           JOIN user_accounts u ON u.id = c.id, today_start
           WHERE u.last_login_at >= d AT TIME ZONE $1
             AND u.last_login_at <  (d + INTERVAL '1 day') AT TIME ZONE $1
         )
         SELECT (SELECT COUNT(*) FROM cohort)::int AS cohort_size,
                (SELECT COUNT(*) FROM active)::int AS active_size`,
        [TZ]
    );
    const { cohort_size, active_size } = r.rows[0];
    if (cohort_size === 0) return { cohort_size: 0, active_size: 0, pct: null };
    return {
        cohort_size,
        active_size,
        pct: Math.round((active_size / cohort_size) * 1000) / 10
    };
}

async function fetchPlazaNewListed() {
    const r = await pool.query(
        `SELECT COUNT(*)::int AS c FROM bot_listings
         WHERE status = 'listed'
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1
           AND created_at <  (date_trunc('day', NOW() AT TIME ZONE $1) + INTERVAL '1 day') AT TIME ZONE $1`,
        [TZ]
    );
    return r.rows[0].c;
}

module.exports = function(devices) {
    const router = express.Router();

    router.get('/daily', async (req, res) => {
        const { deviceId, botSecret, entityId } = req.query;

        if (!deviceId || !botSecret || !entityId) {
            return res.status(400).json({ success: false, error: 'Missing deviceId, botSecret, or entityId' });
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
            const [today_signups, retention_7d, plaza_new_listed_today] = await Promise.all([
                fetchTodaySignups(),
                fetchRetention7d(),
                fetchPlazaNewListed()
            ]);
            return res.json({
                success: true,
                date: new Date().toISOString().slice(0, 10),
                today_signups,
                retention_7d,
                plaza_new_listed_today,
                follow_ups: [
                    'source_channel: schema lacks signup_source column',
                    'visitor_to_signup_conversion: page_views has no FK to user_accounts',
                    'plaza_new_listed_today: counts created_at not status_changed_at (bot_listings has no listed_at column)'
                ]
            });
        } catch (err) {
            console.error('[Growth] query error:', err);
            return res.status(500).json({ success: false, error: 'Query failed' });
        }
    });

    return {
        router,
        _internal: { checkRate, findEntity, isOwnerAdmin, fetchTodaySignups, fetchRetention7d, fetchPlazaNewListed, rateBuckets }
    };
};
