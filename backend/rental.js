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
/* @brm-crossref: ④⑦ Bot Interview (listing CRUD) + Contract Management + Marketplace
 * Design doc: docs/plans/2026-04-10-bot-rental-marketplace-design.md
 * Roadmap:    /portal/roadmap.html
 * If this module is updated, also update the roadmap page status and the design doc §10 delivery tracker. */

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

function assertPositiveInt(name, value) {
    if (!Number.isInteger(value) || value <= 0) {
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
// Rental contract lifecycle
// ============================================

/**
 * Atomic "rent this bot" — hold deposit, snapshot listing, insert contract,
 * all inside a single wallet transaction. Returns the new contract.
 *
 * Skips the intermediate 'reserved' status for simplicity: the contract
 * goes directly to 'active'. Entity handover (inserting the rental bot
 * into the renter's device slot) is a follow-up PR concern; this function
 * only handles the financial + record-keeping side.
 */
async function startRental({
    listingId, renterUserId, renterDeviceId, durationMinutes,
}, walletApi) {
    assertString('listing_id', listingId, { max: 64 });
    assertString('renter_user_id', renterUserId, { max: 64 });
    assertString('renter_device_id', renterDeviceId, { max: 64 });
    assertPositiveInt('duration_minutes', durationMinutes);
    if (durationMinutes < MIN_RENTAL_MINUTES) {
        throw new Error('duration_too_short');
    }
    if (durationMinutes > MAX_RENTAL_MINUTES) {
        throw new Error('duration_too_long');
    }

    return walletApi.withTransaction(async (client) => {
        // 1. Lock the listing row and validate.
        const listingRes = await client.query(
            `SELECT id, owner_user_id, rate_mli_per_ktoken,
                    min_rental_minutes, max_rental_minutes,
                    status, interview_passed
             FROM bot_listings WHERE id = $1 FOR UPDATE`,
            [listingId]
        );
        if (listingRes.rowCount === 0) throw new Error('listing_not_found');
        const listing = listingRes.rows[0];
        if (listing.status !== 'listed') throw new Error('listing_not_available');
        if (!listing.interview_passed) throw new Error('interview_not_passed');
        if (listing.owner_user_id === renterUserId) throw new Error('self_rental_forbidden');
        if (durationMinutes < listing.min_rental_minutes) {
            throw new Error('duration_below_listing_min');
        }
        if (durationMinutes > listing.max_rental_minutes) {
            throw new Error('duration_above_listing_max');
        }

        // 2. Exclusivity check: the UNIQUE partial index enforces this at the
        //    DB layer, but we explicit-check here to return a friendlier error.
        const activeRes = await client.query(
            `SELECT id FROM rental_contracts
             WHERE listing_id = $1
               AND status IN ('reserved', 'active', 'suspended_insufficient_funds')`,
            [listingId]
        );
        if (activeRes.rowCount > 0) throw new Error('listing_already_rented');

        // 3. Snapshot economics at this instant.
        const rateSnapshot = Number(listing.rate_mli_per_ktoken);
        const depositMli = computeDepositMli(rateSnapshot);
        // Required minimum balance = deposit + ~60K tokens of buffer (≈1h typical chat).
        const bufferMli = rateSnapshot * 60;
        const requiredMli = depositMli + bufferMli;

        // 4. Verify renter has sufficient spendable balance (not including held).
        const balRes = await client.query(
            `SELECT balance_mli FROM wallets WHERE user_id = $1`,
            [renterUserId]
        );
        const currentBalance = balRes.rowCount > 0 ? BigInt(balRes.rows[0].balance_mli) : 0n;
        if (currentBalance < BigInt(requiredMli)) {
            const err = new Error('insufficient_balance_for_rental');
            err.details = {
                required_mli: String(requiredMli),
                current_mli: String(currentBalance),
                deposit_mli: String(depositMli),
                buffer_mli: String(bufferMli),
            };
            throw err;
        }

        // 5. Create the contract row. Computed ends_at lets the cron find
        //    expiring contracts without recomputing.
        const contractRes = await client.query(
            `INSERT INTO rental_contracts
                (listing_id, owner_user_id, renter_user_id, renter_device_id,
                 rate_mli_per_ktoken_snapshot, deposit_mli,
                 planned_duration_min, started_at, ends_at, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW() + ($7 || ' minutes')::interval, 'active')
             RETURNING id, status, started_at, ends_at, deposit_mli`,
            [listingId, listing.owner_user_id, renterUserId, renterDeviceId,
             rateSnapshot, depositMli, durationMinutes]
        );
        const contract = contractRes.rows[0];

        // 6. Freeze the listing into rental_snapshots so owner edits
        //    cannot affect this in-flight contract.
        await client.query(
            `INSERT INTO rental_snapshots
                (contract_id, identity, rules, skills, webhook_url, allowed_vars)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [contract.id, null, null, null, null, '[]']
        );

        // 7. Hold the deposit (moves balance → held in the renter's wallet).
        await walletApi.applyLedgerEntry(client, {
            userId: renterUserId,
            balanceDelta: -depositMli,
            heldDelta: depositMli,
            type: walletApi.LEDGER_TYPES.DEPOSIT_HOLD,
            refType: 'rental_contract',
            refId: contract.id,
            note: `rental deposit: ${listingId}`,
            idempotencyKey: `rental-hold:${contract.id}`,
        });

        return contract;
    });
}

/**
 * End a rental contract. `endReason` drives deposit disposition:
 *   - 'ended_normal'            → full refund
 *   - 'ended_early_by_renter'   → 50% refund (50% forfeit to platform)
 *   - 'ended_zero_balance'      → full forfeit
 *   - 'ended_violation'         → 30% forfeit, 70% refund
 *   - 'ended_admin' | 'ended_disputed' → full refund
 *
 * Only the renter, owner, or admin can end a contract. Caller is
 * responsible for validating the requester's identity before calling.
 */
async function endRental({ contractId, endReason, requesterUserId }, walletApi) {
    assertString('contract_id', contractId, { max: 64 });
    assertString('end_reason', endReason, { max: 40 });
    assertString('requester_user_id', requesterUserId, { max: 64 });

    const ALLOWED = new Set([
        CONTRACT_STATUSES.ENDED_NORMAL,
        CONTRACT_STATUSES.ENDED_EARLY_BY_RENTER,
        CONTRACT_STATUSES.ENDED_ZERO_BALANCE,
        CONTRACT_STATUSES.ENDED_DISPUTED,
        CONTRACT_STATUSES.ENDED_VIOLATION,
        CONTRACT_STATUSES.ENDED_ADMIN,
    ]);
    if (!ALLOWED.has(endReason)) throw new Error('end_reason_invalid');

    return walletApi.withTransaction(async (client) => {
        const res = await client.query(
            `SELECT id, owner_user_id, renter_user_id, deposit_mli, status
             FROM rental_contracts WHERE id = $1 FOR UPDATE`,
            [contractId]
        );
        if (res.rowCount === 0) throw new Error('contract_not_found');
        const contract = res.rows[0];
        if (!contract.status.startsWith('active') && contract.status !== 'suspended_insufficient_funds' && contract.status !== 'reserved') {
            throw new Error('contract_already_ended');
        }
        if (contract.renter_user_id !== requesterUserId &&
            contract.owner_user_id !== requesterUserId) {
            // Admin path is caller's responsibility to gate upstream.
            throw new Error('contract_end_forbidden');
        }

        const depositMli = Number(contract.deposit_mli);

        // Disposition matrix: how much of the deposit returns to renter
        // vs gets forfeited (to the platform wallet or insurance pool).
        let refundMli = 0;
        let forfeitMli = 0;
        switch (endReason) {
            case CONTRACT_STATUSES.ENDED_NORMAL:
            case CONTRACT_STATUSES.ENDED_DISPUTED:
            case CONTRACT_STATUSES.ENDED_ADMIN:
                refundMli = depositMli;
                break;
            case CONTRACT_STATUSES.ENDED_EARLY_BY_RENTER:
                refundMli = Math.floor(depositMli / 2);
                forfeitMli = depositMli - refundMli;
                break;
            case CONTRACT_STATUSES.ENDED_ZERO_BALANCE:
                forfeitMli = depositMli;
                break;
            case CONTRACT_STATUSES.ENDED_VIOLATION:
                forfeitMli = Math.floor(depositMli * 0.3);
                refundMli = depositMli - forfeitMli;
                break;
        }

        // 1. Release refund portion (held → balance).
        if (refundMli > 0) {
            await walletApi.applyLedgerEntry(client, {
                userId: contract.renter_user_id,
                balanceDelta: refundMli,
                heldDelta: -refundMli,
                type: walletApi.LEDGER_TYPES.DEPOSIT_RELEASE,
                refType: 'rental_contract',
                refId: contract.id,
                note: `refund on ${endReason}`,
                idempotencyKey: `rental-release:${contract.id}`,
            });
        }

        // 2. Forfeit portion (held → void; caller can credit platform
        //    wallet in a follow-up entry if desired).
        if (forfeitMli > 0) {
            await walletApi.applyLedgerEntry(client, {
                userId: contract.renter_user_id,
                balanceDelta: 0,
                heldDelta: -forfeitMli,
                type: walletApi.LEDGER_TYPES.DEPOSIT_FORFEIT,
                refType: 'rental_contract',
                refId: contract.id,
                note: `forfeit on ${endReason}`,
                idempotencyKey: `rental-forfeit:${contract.id}`,
            });
        }

        // 3. Update contract status.
        const updated = await client.query(
            `UPDATE rental_contracts
             SET status = $2, end_reason = $3, actual_ended_at = NOW()
             WHERE id = $1
             RETURNING id, status, end_reason, actual_ended_at`,
            [contract.id, endReason, endReason]
        );
        return {
            ...updated.rows[0],
            refund_mli: refundMli,
            forfeit_mli: forfeitMli,
        };
    });
}

/**
 * Fetch contracts where the user is either renter or owner.
 * `role` filters to one side ('renter' | 'owner'); omit for both.
 */
async function getMyContracts(userId, { role = null, limit = 50, offset = 0 } = {}) {
    assertString('user_id', userId, { max: 64 });
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    let where;
    const params = [userId];
    if (role === 'renter') {
        where = 'renter_user_id = $1';
    } else if (role === 'owner') {
        where = 'owner_user_id = $1';
    } else {
        where = '(renter_user_id = $1 OR owner_user_id = $1)';
    }
    params.push(safeLimit);
    params.push(safeOffset);

    const res = await pool.query(
        `SELECT id, listing_id, owner_user_id, renter_user_id,
                rate_mli_per_ktoken_snapshot, deposit_mli,
                planned_duration_min, started_at, ends_at, actual_ended_at,
                tokens_consumed, ecoin_charged_mli, violation_count,
                status, end_reason, created_at
         FROM rental_contracts
         WHERE ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return res.rows;
}

// ============================================
// P2-E: Rental entity guardrails
// ============================================

/**
 * Blocked operations on rental entities. These checks are intended to
 * be called from index.js entity routes before allowing the action.
 *
 * Design decision #15: ✅ speakTo, broadcast, kanban
 *                      ❌ rename, delete, identity update, sub-lease
 *
 * @brm-crossref: P2-E A2A Collaboration Bridging
 */

/** Check if an entity is a rental entity (has an active rental contract). */
function isRentalEntity(entity) {
    return !!(entity && entity.rental_contract_id);
}

/**
 * List of entity route path fragments that are BLOCKED for rental entities.
 * Used by `rentalEntityGuard` middleware.
 */
const BLOCKED_RENTAL_OPERATIONS = Object.freeze([
    '/rename',
    '/permanent',          // permanent delete
    '/identity',           // PUT /api/entity/identity
]);

/**
 * Express middleware factory: blocks certain operations on rental entities.
 * Attach AFTER auth middleware on entity-scoped routes.
 *
 * Usage in index.js:
 *   app.use('/api/device/entity', rentalEntityGuard(devices));
 *   app.use('/api/entity', rentalEntityGuard(devices));
 */
function createRentalEntityGuard(devices) {
    return (req, res, next) => {
        // Extract entity from request
        const deviceId = req.body?.deviceId || req.query?.deviceId || req.params?.deviceId;
        const entityId = req.body?.entityId ?? req.query?.entityId ?? req.params?.entityId;
        if (!deviceId || entityId == null) return next();

        const device = devices[deviceId];
        if (!device) return next();

        const entity = device.entities[parseInt(entityId, 10)];
        if (!entity || !isRentalEntity(entity)) return next();

        // Check if the current route is blocked (use originalUrl for full path)
        const fullPath = (req.originalUrl || req.path || '').toLowerCase();
        const method = req.method.toUpperCase();

        for (const blocked of BLOCKED_RENTAL_OPERATIONS) {
            if (fullPath.includes(blocked)) {
                return res.status(403).json({
                    success: false,
                    error: 'rental_entity_operation_blocked',
                    message: `This operation is not allowed on rental entities: ${blocked}`,
                    rental_contract_id: entity.rental_contract_id,
                });
            }
        }

        // Block sub-leasing: rental entity cannot create a new listing
        if (fullPath.includes('/rental/listing') && method === 'POST') {
            return res.status(403).json({
                success: false,
                error: 'rental_sub_lease_forbidden',
                message: 'Rental entities cannot be sub-leased',
            });
        }

        next();
    };
}

/** Rate limit constant for rental entities: 30 requests per minute. */
const RENTAL_RATE_LIMIT_RPM = 30;

/**
 * Simple in-memory rate limiter for rental entity operations.
 * Keyed by contract_id. Returns { allowed, remaining, resetAt }.
 */
const _rentalRateBuckets = new Map();

function checkRentalRateLimit(contractId) {
    const now = Date.now();
    const window = 60_000; // 1 minute

    let bucket = _rentalRateBuckets.get(contractId);
    if (!bucket || now > bucket.resetAt) {
        bucket = { count: 0, resetAt: now + window };
        _rentalRateBuckets.set(contractId, bucket);
    }

    bucket.count++;
    const allowed = bucket.count <= RENTAL_RATE_LIMIT_RPM;
    return {
        allowed,
        remaining: Math.max(0, RENTAL_RATE_LIMIT_RPM - bucket.count),
        resetAt: bucket.resetAt,
    };
}

// Periodic cleanup of stale rate-limit buckets (every 5 min)
setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of _rentalRateBuckets) {
        if (now > bucket.resetAt + 60_000) _rentalRateBuckets.delete(key);
    }
}, 5 * 60_000).unref();

// ============================================
// P2-F: Entity handover
// ============================================

/**
 * Insert a rental entity into the renter's device. Called after
 * startRental() succeeds financially.
 *
 * @param {Object} devices - The in-memory devices map from index.js
 * @param {Object} params
 * @param {string} params.renterDeviceId
 * @param {string} params.contractId
 * @param {Object} params.listing - The bot_listings row
 * @param {number} params.rateMliPerKtoken
 * @returns {{ slot: number }} The entity slot assigned to the rental
 *
 * @brm-crossref: P2-F Entity Handover (⑨ Handover System)
 */
function insertRentalEntity(devices, {
    renterDeviceId, contractId, listing, rateMliPerKtoken,
}) {
    const device = devices[renterDeviceId];
    if (!device) throw new Error('renter_device_not_found');

    // Find the next empty (unbound) slot, or create a new one
    let slot = null;
    for (const [id, entity] of Object.entries(device.entities)) {
        if (!entity.isBound) {
            slot = parseInt(id, 10);
            break;
        }
    }
    if (slot === null) {
        // Auto-expand: find max existing + 1
        const maxId = Math.max(-1, ...Object.keys(device.entities).map(Number));
        slot = maxId + 1;
        device.entities[slot] = createDefaultRentalEntity();
    }

    // Populate the rental entity
    const entity = device.entities[slot];
    entity.isBound = true;
    entity.character = listing.title || 'Rental Bot';
    entity.name = listing.title || 'Rental Bot';
    entity.state = 'IDLE';
    entity.message = `Rented from marketplace (${rateMliPerKtoken / 1000} e幣/1K)`;
    entity.lastUpdated = Date.now();
    entity.rental_contract_id = contractId;
    entity.rental_status = 'leased_in';
    // Webhook points to a proxy URL — real webhook is in rental_snapshots
    entity.webhook = { url: `__rental_proxy__:${contractId}`, type: 'rental_proxy' };

    return { slot };
}

/**
 * Mark the owner's entity as leased out.
 */
function markOwnerEntityLeasedOut(devices, { ownerDeviceId, ownerEntityId, contractId }) {
    const device = devices[ownerDeviceId];
    if (!device) return;
    const entity = device.entities[ownerEntityId];
    if (!entity) return;

    entity.rental_status = 'leased_out';
    entity.rental_contract_id = contractId;
}

/**
 * Remove a rental entity from the renter's device (contract end).
 */
function removeRentalEntity(devices, { renterDeviceId, contractId }) {
    const device = devices[renterDeviceId];
    if (!device) return;

    for (const [, entity] of Object.entries(device.entities)) {
        if (entity.rental_contract_id === contractId) {
            // Reset to unbound default
            entity.isBound = false;
            entity.character = '🤖';
            entity.name = null;
            entity.state = 'IDLE';
            entity.message = '';
            entity.webhook = null;
            entity.rental_contract_id = null;
            entity.rental_status = null;
            break;
        }
    }
}

/**
 * Clear the leased_out status on the owner's entity (contract end).
 */
function clearOwnerEntityLeasedOut(devices, { ownerDeviceId, ownerEntityId }) {
    const device = devices[ownerDeviceId];
    if (!device) return;
    const entity = device.entities[ownerEntityId];
    if (!entity) return;

    entity.rental_status = null;
    entity.rental_contract_id = null;
}

/** Minimal entity stub for a new rental slot. */
function createDefaultRentalEntity() {
    return {
        character: '🤖',
        state: 'IDLE',
        message: '',
        parts: {},
        batteryLevel: 100,
        lastUpdated: Date.now(),
        messageQueue: [],
        isBound: false,
        webhook: null,
        xp: 0,
        level: 1,
        avatar: null,
        publicCode: null,
        rental_contract_id: null,
        rental_status: null,
    };
}

// ============================================
// Express factory
// ============================================

module.exports = function rentalFactory({ authMiddleware, adminMiddleware, walletModule, serverLog } = {}) {
    if (typeof authMiddleware !== 'function') {
        throw new Error('rental: authMiddleware is required');
    }
    if (!walletModule || typeof walletModule.withTransaction !== 'function') {
        throw new Error('rental: walletModule is required');
    }
    const router = express.Router();
    const audit = serverLog || (() => {});

    const INPUT_ERROR_RE = /^(?:[a-z][a-z0-9_]*_(?:invalid|required|forbidden|not_found)|publish_failed|interview_not_passed|no_fields_to_update|duration_too_(?:short|long)|duration_(?:below|above)_listing_(?:min|max)|listing_not_available|listing_already_rented|self_rental_forbidden|insufficient_balance_for_rental|contract_already_ended|contract_end_forbidden)$/;

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

    // POST /api/rental/contract — start a new rental (atomic: deposit + contract + snapshot)
    router.post('/contract', authMiddleware, rentalRoute(async (req, res) => {
        const { listingId, renterDeviceId, durationMinutes } = req.body || {};
        const contract = await startRental({
            listingId,
            renterUserId: req.user.userId,
            renterDeviceId,
            durationMinutes: parseInt(durationMinutes, 10),
        }, walletModule);
        audit('info', 'rental', `contract started ${contract.id}`, {
            userId: req.user.userId, action: 'contract_start', resource: contract.id,
        });
        res.json({ success: true, contract });
    }));

    // POST /api/rental/contract/:id/end — end a contract (by renter or owner)
    router.post('/contract/:id/end', authMiddleware, rentalRoute(async (req, res) => {
        const { endReason } = req.body || {};
        const contract = await endRental({
            contractId: req.params.id,
            endReason: endReason || CONTRACT_STATUSES.ENDED_NORMAL,
            requesterUserId: req.user.userId,
        }, walletModule);
        audit('info', 'rental', `contract ended ${contract.id} reason=${contract.end_reason}`, {
            userId: req.user.userId, action: 'contract_end', resource: contract.id, result: contract.end_reason,
        });
        res.json({ success: true, contract });
    }));

    // GET /api/rental/my-contracts?role=renter|owner
    router.get('/my-contracts', authMiddleware, rentalRoute(async (req, res) => {
        const role = req.query.role || null;
        const contracts = await getMyContracts(req.user.userId, {
            role,
            limit: req.query.limit,
            offset: req.query.offset,
        });
        res.json({ success: true, contracts });
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
        startRental,
        endRental,
        getMyContracts,
        // P2-E: Guardrails
        isRentalEntity,
        createRentalEntityGuard,
        checkRentalRateLimit,
        RENTAL_RATE_LIMIT_RPM,
        BLOCKED_RENTAL_OPERATIONS,
        // P2-F: Handover
        insertRentalEntity,
        markOwnerEntityLeasedOut,
        removeRentalEntity,
        clearOwnerEntityLeasedOut,
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
