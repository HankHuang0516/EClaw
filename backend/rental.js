/**
 * Bot Rental Marketplace Module — Phase 1 foundation.
 *
 * Mounted at: /api/rental
 *
 * Responsibilities (this PR):
 *   - Listing CRUD + publish/pause/delist lifecycle
 *   - Marketplace search (public catalog of listings that passed interview)
 *   - Contract state machine stubs (reserve/start/end — fleshed out in P2)
 *
 * Deferred to follow-up PRs:
 *   - bot-interview.js integration (interview probe runner)
 *   - rental-proxy.js token metering (P2)
 *   - Dispute + review endpoints (P3)
 *
 * Design decisions are locked in memory/project_bot_rental_system.md.
 * Key constants shared with wallet.js: 1 e幣 = 1000 厘, deposit formula =
 * rate × 20 (20,000 tokens).
 */

const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

// ============================================
// Constants (mirror wallet.js)
// ============================================

const ECOIN_TO_MLI = 1000;

/** Deposit = rate × 20 (covers ~20,000 tokens of buffer). */
const DEPOSIT_TOKEN_MULTIPLIER = 20;

/** Rental duration bounds. */
const MIN_RENTAL_MINUTES = 30;
const MAX_RENTAL_MINUTES = 7 * 24 * 60;  // 7 days

/** Interview gate: listings need score >= 60 to publish. */
const INTERVIEW_PASS_SCORE = 60;

/** Interview rate limit: 3 attempts per listing per 7 days. */
const INTERVIEW_RATE_LIMIT = 3;

const LISTING_STATUSES = Object.freeze({
    DRAFT: 'draft',
    INTERVIEW: 'interview',
    LISTED: 'listed',
    PAUSED: 'paused',
    DELISTED: 'delisted',
});

const CONTRACT_STATUSES = Object.freeze({
    RESERVED: 'reserved',
    ACTIVE: 'active',
    SUSPENDED: 'suspended_insufficient_funds',
    ENDED_NORMAL: 'ended_normal',
    ENDED_EARLY_BY_RENTER: 'ended_early_by_renter',
    ENDED_ZERO_BALANCE: 'ended_zero_balance',
    ENDED_DISPUTED: 'ended_disputed',
    ENDED_VIOLATION: 'ended_violation',
    ENDED_ADMIN: 'ended_admin',
});

// ============================================
// Helpers
// ============================================

function computeDepositMli(rateMliPerKtoken) {
    return Number(rateMliPerKtoken) * DEPOSIT_TOKEN_MULTIPLIER;
}

function assertString(name, value, { max = 500 } = {}) {
    if (typeof value !== 'string' || value.length === 0 || value.length > max) {
        throw new Error(`${name}_invalid`);
    }
}

function assertNonNegativeInt(name, value) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name}_invalid`);
    }
}

function assertRateMli(value) {
    if (!Number.isInteger(value) || value <= 0 || value > 1_000_000_000) {
        throw new Error('rate_mli_per_ktoken_invalid');
    }
}

// ============================================
// Schema init (mirrors auth.js / wallet.js pattern)
// ============================================
async function initRentalDatabase() {
    try {
        const schemaPath = path.join(__dirname, 'rental_schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        const statements = [];
        let current = '';
        let inDollarBlock = false;
        for (const line of schema.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('--')) continue;
            current += line + '\n';
            const dollarCount = (line.match(/\$\$/g) || []).length;
            if (dollarCount % 2 === 1) inDollarBlock = !inDollarBlock;
            if (!inDollarBlock && trimmed.endsWith(';')) {
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
                    console.warn('[Rental] Schema warning:', err.message);
                }
            }
        }
        console.log('[Rental] Database initialized');
    } catch (error) {
        console.error('[Rental] Failed to init database:', error);
    }
}

// ============================================
// Listing CRUD
// ============================================

async function createListing({
    ownerUserId, ownerDeviceId, ownerEntityId,
    title, description = null, rateMliPerKtoken,
    minRentalMinutes = MIN_RENTAL_MINUTES,
    maxRentalMinutes = MAX_RENTAL_MINUTES,
}) {
    assertString('owner_user_id', ownerUserId, { max: 64 });
    assertString('owner_device_id', ownerDeviceId, { max: 64 });
    assertNonNegativeInt('owner_entity_id', ownerEntityId);
    assertString('title', title, { max: 120 });
    if (description !== null) assertString('description', description, { max: 2000 });
    assertRateMli(rateMliPerKtoken);
    if (minRentalMinutes < MIN_RENTAL_MINUTES) throw new Error('min_rental_minutes_invalid');
    if (maxRentalMinutes > MAX_RENTAL_MINUTES) throw new Error('max_rental_minutes_invalid');
    if (minRentalMinutes > maxRentalMinutes) throw new Error('rental_duration_range_invalid');

    const res = await pool.query(
        `INSERT INTO bot_listings
            (owner_user_id, owner_device_id, owner_entity_id, title, description,
             rate_mli_per_ktoken, min_rental_minutes, max_rental_minutes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
         RETURNING id, status, created_at`,
        [ownerUserId, ownerDeviceId, ownerEntityId, title, description,
         rateMliPerKtoken, minRentalMinutes, maxRentalMinutes]
    );
    return res.rows[0];
}

async function updateListing(listingId, ownerUserId, patch) {
    assertString('listing_id', listingId, { max: 64 });
    assertString('owner_user_id', ownerUserId, { max: 64 });

    // Whitelist mutable fields — capabilities/benchmark_score/model_detected
    // are LOCKED after interview and cannot be edited via this API.
    const allowed = ['title', 'description', 'rate_mli_per_ktoken',
                     'min_rental_minutes', 'max_rental_minutes', 'availability_windows'];
    const sets = [];
    const params = [listingId, ownerUserId];
    for (const [key, value] of Object.entries(patch || {})) {
        const col = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
        if (!allowed.includes(col)) continue;
        if (col === 'rate_mli_per_ktoken') assertRateMli(value);
        if (col === 'title') assertString('title', value, { max: 120 });
        if (col === 'description' && value !== null) assertString('description', value, { max: 2000 });
        params.push(value);
        sets.push(`${col} = $${params.length}`);
    }
    if (sets.length === 0) throw new Error('no_fields_to_update');
    sets.push('updated_at = NOW()');

    const res = await pool.query(
        `UPDATE bot_listings SET ${sets.join(', ')}
         WHERE id = $1 AND owner_user_id = $2
         RETURNING id, status, updated_at`,
        params
    );
    if (res.rowCount === 0) throw new Error('listing_not_found_or_forbidden');
    return res.rows[0];
}

async function publishListing(listingId, ownerUserId) {
    assertString('listing_id', listingId, { max: 64 });
    const res = await pool.query(
        `UPDATE bot_listings SET status = 'listed', updated_at = NOW()
         WHERE id = $1 AND owner_user_id = $2 AND interview_passed = TRUE
         RETURNING id, status`,
        [listingId, ownerUserId]
    );
    if (res.rowCount === 0) {
        // Check whether the listing exists at all to give a precise error.
        const check = await pool.query(
            `SELECT interview_passed, owner_user_id FROM bot_listings WHERE id = $1`,
            [listingId]
        );
        if (check.rowCount === 0) throw new Error('listing_not_found');
        if (check.rows[0].owner_user_id !== ownerUserId) throw new Error('listing_forbidden');
        if (!check.rows[0].interview_passed) throw new Error('interview_not_passed');
        throw new Error('publish_failed');
    }
    return res.rows[0];
}

async function pauseListing(listingId, ownerUserId) {
    const res = await pool.query(
        `UPDATE bot_listings SET status = 'paused', updated_at = NOW()
         WHERE id = $1 AND owner_user_id = $2 AND status = 'listed'
         RETURNING id, status`,
        [listingId, ownerUserId]
    );
    if (res.rowCount === 0) throw new Error('listing_not_found_or_forbidden');
    return res.rows[0];
}

async function delistListing(listingId, ownerUserId) {
    const res = await pool.query(
        `UPDATE bot_listings SET status = 'delisted', updated_at = NOW()
         WHERE id = $1 AND owner_user_id = $2
         RETURNING id, status`,
        [listingId, ownerUserId]
    );
    if (res.rowCount === 0) throw new Error('listing_not_found_or_forbidden');
    return res.rows[0];
}

async function getListing(listingId) {
    const res = await pool.query(
        `SELECT id, owner_user_id, title, description, rate_mli_per_ktoken,
                min_rental_minutes, max_rental_minutes, availability_windows,
                model_detected, capabilities, benchmark_score, interview_passed,
                last_interview_at, avg_rating, total_rentals, uptime_pct, status,
                created_at, updated_at
         FROM bot_listings WHERE id = $1`,
        [listingId]
    );
    return res.rows[0] || null;
}

async function listMyListings(ownerUserId) {
    assertString('owner_user_id', ownerUserId, { max: 64 });
    const res = await pool.query(
        `SELECT id, title, rate_mli_per_ktoken, status, interview_passed,
                avg_rating, total_rentals, created_at
         FROM bot_listings WHERE owner_user_id = $1
         ORDER BY created_at DESC`,
        [ownerUserId]
    );
    return res.rows;
}

/**
 * Marketplace search — only shows listings that are currently listed
 * and have passed interview.
 */
async function searchMarketplace({
    minRateMli = null, maxRateMli = null,
    capability = null,
    sort = 'rating',    // 'rating' | 'rate_asc' | 'rate_desc' | 'newest'
    limit = 20, offset = 0,
} = {}) {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const params = [];
    const where = [`status = 'listed'`, `interview_passed = TRUE`];

    if (minRateMli != null) {
        params.push(minRateMli);
        where.push(`rate_mli_per_ktoken >= $${params.length}`);
    }
    if (maxRateMli != null) {
        params.push(maxRateMli);
        where.push(`rate_mli_per_ktoken <= $${params.length}`);
    }
    if (capability) {
        params.push(capability);
        where.push(`capabilities ? $${params.length}`);
    }

    let orderBy;
    switch (sort) {
        case 'rate_asc':  orderBy = 'rate_mli_per_ktoken ASC'; break;
        case 'rate_desc': orderBy = 'rate_mli_per_ktoken DESC'; break;
        case 'newest':    orderBy = 'created_at DESC'; break;
        case 'rating':
        default:          orderBy = 'avg_rating DESC, total_rentals DESC'; break;
    }

    params.push(safeLimit);
    params.push(safeOffset);
    const res = await pool.query(
        `SELECT id, title, description, rate_mli_per_ktoken,
                min_rental_minutes, max_rental_minutes,
                model_detected, capabilities, benchmark_score,
                avg_rating, total_rentals, uptime_pct
         FROM bot_listings
         WHERE ${where.join(' AND ')}
         ORDER BY ${orderBy}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return res.rows;
}

// ============================================
// Express factory
// ============================================

module.exports = function rentalFactory({ authMiddleware, adminMiddleware, serverLog } = {}) {
    if (typeof authMiddleware !== 'function') {
        throw new Error('rental: authMiddleware is required');
    }
    const router = express.Router();
    const audit = serverLog || (() => {});

    const INPUT_ERROR_RE = /^(?:[a-z][a-z0-9_]*_(?:invalid|required|forbidden|not_found)|publish_failed|interview_not_passed|no_fields_to_update)$/;

    function rentalRoute(fn) {
        return async (req, res) => {
            try {
                if (!req.user || !req.user.userId) {
                    return res.status(401).json({ success: false, error: 'unauthenticated' });
                }
                await fn(req, res);
            } catch (err) {
                if (INPUT_ERROR_RE.test(err.message)) {
                    const code = /forbidden/.test(err.message) ? 403
                               : /not_found/.test(err.message) ? 404
                               : 400;
                    return res.status(code).json({ success: false, error: err.message });
                }
                console.error('[Rental] handler error:', err);
                res.status(500).json({ success: false, error: 'internal_error' });
            }
        };
    }

    // POST /api/rental/listing — create a draft listing
    router.post('/listing', authMiddleware, rentalRoute(async (req, res) => {
        const { ownerDeviceId, ownerEntityId, title, description,
                rateMliPerKtoken, minRentalMinutes, maxRentalMinutes } = req.body || {};
        const listing = await createListing({
            ownerUserId: req.user.userId,
            ownerDeviceId, ownerEntityId, title, description, rateMliPerKtoken,
            minRentalMinutes, maxRentalMinutes,
        });
        audit('info', 'rental', `listing created ${listing.id} by ${req.user.userId}`, {
            userId: req.user.userId, action: 'listing_create', resource: listing.id,
        });
        res.json({ success: true, listing });
    }));

    // PATCH /api/rental/listing/:id
    router.patch('/listing/:id', authMiddleware, rentalRoute(async (req, res) => {
        const listing = await updateListing(req.params.id, req.user.userId, req.body || {});
        res.json({ success: true, listing });
    }));

    // POST /api/rental/listing/:id/publish
    router.post('/listing/:id/publish', authMiddleware, rentalRoute(async (req, res) => {
        const listing = await publishListing(req.params.id, req.user.userId);
        audit('info', 'rental', `listing published ${listing.id}`, {
            userId: req.user.userId, action: 'listing_publish', resource: listing.id,
        });
        res.json({ success: true, listing });
    }));

    // POST /api/rental/listing/:id/pause
    router.post('/listing/:id/pause', authMiddleware, rentalRoute(async (req, res) => {
        const listing = await pauseListing(req.params.id, req.user.userId);
        res.json({ success: true, listing });
    }));

    // DELETE /api/rental/listing/:id — delist
    router.delete('/listing/:id', authMiddleware, rentalRoute(async (req, res) => {
        const listing = await delistListing(req.params.id, req.user.userId);
        res.json({ success: true, listing });
    }));

    // GET /api/rental/listing/:id — public view
    router.get('/listing/:id', rentalRoute(async (req, res) => {
        const listing = await getListing(req.params.id);
        if (!listing) throw new Error('listing_not_found');
        // Hide owner identity for non-owner viewers (design decision #14).
        if (!req.user || listing.owner_user_id !== req.user.userId) {
            delete listing.owner_user_id;
        }
        res.json({ success: true, listing });
    }));

    // GET /api/rental/my-listings — owner's own listings
    router.get('/my-listings', authMiddleware, rentalRoute(async (req, res) => {
        const listings = await listMyListings(req.user.userId);
        res.json({ success: true, listings });
    }));

    // GET /api/rental/marketplace — public search (no auth required)
    router.get('/marketplace', async (req, res) => {
        try {
            const listings = await searchMarketplace({
                minRateMli: req.query.minRateMli ? parseInt(req.query.minRateMli, 10) : null,
                maxRateMli: req.query.maxRateMli ? parseInt(req.query.maxRateMli, 10) : null,
                capability: req.query.capability || null,
                sort: req.query.sort || 'rating',
                limit: req.query.limit,
                offset: req.query.offset,
            });
            res.json({ success: true, listings });
        } catch (err) {
            console.error('[Rental] /marketplace error:', err);
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // adminMiddleware is currently unused but accepted for future P3
    // endpoints (force-delist, admin listing audit, etc).
    void adminMiddleware;

    return {
        router,
        initRentalDatabase,
        // Primitives
        createListing,
        updateListing,
        publishListing,
        pauseListing,
        delistListing,
        getListing,
        listMyListings,
        searchMarketplace,
        // Helpers + constants
        computeDepositMli,
        DEPOSIT_TOKEN_MULTIPLIER,
        MIN_RENTAL_MINUTES,
        MAX_RENTAL_MINUTES,
        INTERVIEW_PASS_SCORE,
        INTERVIEW_RATE_LIMIT,
        LISTING_STATUSES,
        CONTRACT_STATUSES,
        ECOIN_TO_MLI,
        _internals: { pool },
    };
};

module.exports.LISTING_STATUSES = LISTING_STATUSES;
module.exports.CONTRACT_STATUSES = CONTRACT_STATUSES;
module.exports.computeDepositMli = computeDepositMli;
module.exports.DEPOSIT_TOKEN_MULTIPLIER = DEPOSIT_TOKEN_MULTIPLIER;
module.exports.INTERVIEW_PASS_SCORE = INTERVIEW_PASS_SCORE;
