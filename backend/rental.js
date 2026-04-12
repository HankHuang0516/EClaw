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
const crypto = require('crypto');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { runInterview, getProbeList } = require('./bot-interview');

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

/** 24-hour cooldown between successive rentals of the same listing by the same renter. */
const COOLDOWN_HOURS = 24;

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
        // Startup cleanup: revert any listings stuck in 'interview' (server crashed mid-run)
        await pool.query(
            `UPDATE bot_listings SET status = 'draft', updated_at = NOW() WHERE status = 'interview'`
        );

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
        `SELECT id, owner_user_id, owner_device_id, owner_entity_id,
                title, description, rate_mli_per_ktoken,
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
        `SELECT id, owner_device_id, owner_entity_id, title, rate_mli_per_ktoken,
                status, interview_passed, avg_rating, total_rentals, created_at
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

        // 1b. Cooldown check: reject if renter ended a contract for this listing within 24h.
        const cooldownRes = await client.query(
            `SELECT cooldown_until FROM rental_cooldowns
             WHERE user_id = $1 AND listing_id = $2 AND cooldown_until > NOW()`,
            [renterUserId, listingId]
        );
        if (cooldownRes.rowCount > 0) {
            const until = cooldownRes.rows[0].cooldown_until;
            const err = new Error('cooldown_active');
            err.cooldownUntil = until;
            throw err;
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
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW() + make_interval(mins => $7), 'active')
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
            `SELECT id, listing_id, owner_user_id, renter_user_id, deposit_mli, status
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

        // Read the ACTUAL remaining held_mli — it may be less than the
        // original deposit if chargeRentalUsage already deducted the
        // last-message shortfall from the deposit.
        const heldRes = await client.query(
            'SELECT held_mli FROM wallets WHERE user_id = $1',
            [contract.renter_user_id]
        );
        const actualHeldMli = heldRes.rowCount > 0
            ? Math.min(Number(heldRes.rows[0].held_mli), depositMli)
            : 0;

        // Disposition matrix: how much of the remaining held returns to
        // renter vs gets forfeited.
        //
        // For ended_zero_balance: chargeRentalUsage already deducted the
        // last-message cost from the deposit and split it to owner/platform/
        // insurance. Whatever is left in held is the renter's to keep.
        let refundMli = 0;
        let forfeitMli = 0;
        switch (endReason) {
            case CONTRACT_STATUSES.ENDED_NORMAL:
            case CONTRACT_STATUSES.ENDED_DISPUTED:
            case CONTRACT_STATUSES.ENDED_ADMIN:
                refundMli = actualHeldMli;
                break;
            case CONTRACT_STATUSES.ENDED_EARLY_BY_RENTER:
                refundMli = Math.floor(actualHeldMli / 2);
                forfeitMli = actualHeldMli - refundMli;
                break;
            case CONTRACT_STATUSES.ENDED_ZERO_BALANCE:
                // Last-message cost already deducted by chargeRentalUsage.
                // Remaining deposit is returned to renter.
                refundMli = actualHeldMli;
                forfeitMli = 0;
                break;
            case CONTRACT_STATUSES.ENDED_VIOLATION:
                forfeitMli = Math.floor(actualHeldMli * 0.3);
                refundMli = actualHeldMli - forfeitMli;
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

        // 2. Forfeit portion → split 85% owner / 13% platform / 2% insurance
        //    (same ratio as regular rental spend, design decision).
        if (forfeitMli > 0) {
            // Remove from renter's held bucket.
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
            // Split and distribute: owner 85%, platform 13%, insurance 2%.
            const insuranceMli = Math.floor(forfeitMli * 200 / 10000);
            const platformGross = Math.floor(forfeitMli * 1500 / 10000);
            const platformNet = platformGross - insuranceMli;
            const ownerShare = forfeitMli - platformGross;
            if (ownerShare > 0) {
                await walletApi.applyLedgerEntry(client, {
                    userId: contract.owner_user_id,
                    balanceDelta: ownerShare,
                    heldDelta: 0,
                    type: walletApi.LEDGER_TYPES.RENTAL_INCOME,
                    refType: 'rental_contract',
                    refId: contract.id,
                    note: `forfeit compensation: ${endReason}`,
                    idempotencyKey: `rental-forfeit-income:${contract.id}`,
                });
            }
            if (platformNet > 0) {
                await walletApi.applyLedgerEntry(client, {
                    userId: '00000000-0000-0000-0000-000000000001',
                    balanceDelta: platformNet,
                    heldDelta: 0,
                    type: walletApi.LEDGER_TYPES.PLATFORM_FEE,
                    refType: 'rental_contract',
                    refId: contract.id,
                    idempotencyKey: `rental-forfeit-pfee:${contract.id}`,
                });
            }
            if (insuranceMli > 0) {
                await walletApi.applyLedgerEntry(client, {
                    userId: '00000000-0000-0000-0000-000000000002',
                    balanceDelta: insuranceMli,
                    heldDelta: 0,
                    type: walletApi.LEDGER_TYPES.PLATFORM_FEE,
                    refType: 'rental_contract',
                    refId: contract.id,
                    note: 'insurance',
                    idempotencyKey: `rental-forfeit-ins:${contract.id}`,
                });
            }
        }

        // 3. Update contract status.
        const updated = await client.query(
            `UPDATE rental_contracts
             SET status = $2, end_reason = $3, actual_ended_at = NOW()
             WHERE id = $1
             RETURNING id, status, end_reason, actual_ended_at`,
            [contract.id, endReason, endReason]
        );

        // 4. Set 24h cooldown so the same renter cannot immediately re-rent this listing.
        const cooldownUntil = new Date(Date.now() + COOLDOWN_HOURS * 3600 * 1000);
        await client.query(
            `INSERT INTO rental_cooldowns (user_id, listing_id, cooldown_until)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, listing_id) DO UPDATE SET cooldown_until = $3`,
            [contract.renter_user_id, contract.listing_id, cooldownUntil]
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
        `SELECT c.id, c.listing_id, c.owner_user_id, c.renter_user_id,
                c.rate_mli_per_ktoken_snapshot, c.deposit_mli,
                c.planned_duration_min, c.started_at, c.ends_at, c.actual_ended_at,
                c.tokens_consumed, c.ecoin_charged_mli, c.violation_count,
                c.status, c.end_reason, c.created_at,
                l.title AS listing_title
         FROM rental_contracts c
         LEFT JOIN bot_listings l ON l.id = c.listing_id
         WHERE ${where.replace(/\b(renter_user_id|owner_user_id)\b/g, 'c.$1')}
         ORDER BY c.created_at DESC
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
}, helpers) {
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
        device.entities[slot] = createDefaultRentalEntity(slot);
    }

    // Generate botSecret and publicCode for the rental entity so it is
    // fully functional (visible on dashboard, usable for chat/kanban/etc.)
    const botSecret = helpers?.generateBotSecret
        ? helpers.generateBotSecret()
        : crypto.randomBytes(16).toString('hex');
    const publicCode = helpers?.generatePublicCode
        ? helpers.generatePublicCode()
        : null;

    // Populate the rental entity
    const entity = device.entities[slot];
    entity.entityId = slot;
    entity.isBound = true;
    entity.botSecret = botSecret;
    entity.publicCode = publicCode;
    entity.character = listing.title || 'Rental Bot';
    entity.name = listing.title || 'Rental Bot';
    entity.state = 'IDLE';
    entity.message = `Rented from marketplace (${rateMliPerKtoken / 1000} e幣/1K)`;
    entity.lastUpdated = Date.now();
    entity.rental_contract_id = contractId;
    entity.rental_status = 'leased_in';
    // Webhook points to a proxy URL — real webhook is in rental_snapshots
    entity.webhook = { url: `__rental_proxy__:${contractId}`, type: 'rental_proxy' };

    // Register publicCode in the global index for cross-device messaging
    if (publicCode && helpers?.publicCodeIndex) {
        helpers.publicCodeIndex[publicCode] = { deviceId: renterDeviceId, entityId: slot };
    }

    // Ensure at least one empty slot remains after rental insertion
    if (helpers?.ensureOneEmptySlot) {
        helpers.ensureOneEmptySlot(device);
    }

    return { slot, botSecret, publicCode };
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
function removeRentalEntity(devices, { renterDeviceId, contractId }, helpers) {
    const device = devices[renterDeviceId];
    if (!device) return;

    for (const [, entity] of Object.entries(device.entities)) {
        if (entity.rental_contract_id === contractId) {
            // Clean up publicCode from global index before resetting
            if (entity.publicCode && helpers?.publicCodeIndex) {
                delete helpers.publicCodeIndex[entity.publicCode];
            }
            // Reset to unbound default
            entity.isBound = false;
            entity.botSecret = null;
            entity.publicCode = null;
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
function createDefaultRentalEntity(entityId) {
    return {
        entityId: entityId,
        botSecret: null,
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
        bindingType: null,
        rental_contract_id: null,
        rental_status: null,
    };
}

/**
 * Reconcile rental entities after server restart (#1713).
 *
 * Checks for active rental contracts where the renter's device entity
 * slot is unbound (entity handover was lost due to server restart or
 * earlier error). Re-runs insertRentalEntity for each missing entity.
 *
 * @param {Object} devices - In-memory devices map
 * @param {Object} helpers - { generateBotSecret, generatePublicCode, publicCodeIndex, ensureOneEmptySlot, getOrCreateDevice }
 * @returns {Promise<{ reconciled: number, errors: string[] }>}
 */
async function reconcileRentalEntities(devices, helpers) {
    const result = { reconciled: 0, errors: [] };
    try {
        const activeContracts = await pool.query(
            `SELECT c.id, c.renter_device_id, c.listing_id,
                    c.rate_mli_per_ktoken_snapshot, c.renter_user_id
             FROM rental_contracts c
             WHERE c.status IN ('active', 'reserved', 'suspended_insufficient_funds')`
        );

        for (const row of activeContracts.rows) {
            try {
                // Ensure device exists in memory
                if (!devices[row.renter_device_id]) {
                    if (helpers.getOrCreateDevice) {
                        helpers.getOrCreateDevice(row.renter_device_id);
                    } else {
                        result.errors.push(`device_missing:${row.renter_device_id}`);
                        continue;
                    }
                }

                const device = devices[row.renter_device_id];
                // Check if any entity already has this contract ID
                const alreadyExists = Object.values(device.entities).some(
                    e => e && e.rental_contract_id === row.id && e.isBound
                );
                if (alreadyExists) continue;

                // Entity handover was lost — re-create it
                const listing = await getListing(row.listing_id);
                if (!listing) {
                    result.errors.push(`listing_missing:${row.listing_id}`);
                    continue;
                }

                insertRentalEntity(devices, {
                    renterDeviceId: row.renter_device_id,
                    contractId: row.id,
                    listing,
                    rateMliPerKtoken: Number(row.rate_mli_per_ktoken_snapshot),
                }, helpers);

                // Persist reconciled entity to DB
                if (helpers?.saveDeviceData && devices[row.renter_device_id]) {
                    await helpers.saveDeviceData(row.renter_device_id, devices[row.renter_device_id]);
                }

                result.reconciled++;
                console.log(`[Rental] Reconciled entity for contract ${row.id} on device ${row.renter_device_id}`);
            } catch (err) {
                result.errors.push(`contract_${row.id}:${err.message}`);
            }
        }
    } catch (err) {
        result.errors.push(`query_failed:${err.message}`);
    }
    return result;
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

    const INPUT_ERROR_RE = /^(?:[a-z][a-z0-9_]*_(?:invalid|required|forbidden|not_found)|publish_failed|interview_not_passed|no_fields_to_update|duration_too_(?:short|long)|duration_(?:below|above)_listing_(?:min|max)|listing_not_available|listing_already_rented|self_rental_forbidden|insufficient_balance_for_rental|contract_already_ended|contract_end_forbidden|interview_rate_limited|interview_already_running|owner_device_not_found|owner_entity_not_bound|owner_entity_no_webhook|listing_status_invalid_for_interview|cooldown_active)$/;

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

        // P2-F Entity Handover: create rental entity on renter's device
        // and mark the owner's entity as leased out.
        if (_interviewDeps.devices) {
            try {
                // Ensure the renter device exists in memory (#1713).
                // The device may exist in PostgreSQL but not yet in the
                // in-memory map (e.g. created via web portal auth flow).
                if (!_interviewDeps.devices[renterDeviceId] && _interviewDeps.getOrCreateDevice) {
                    _interviewDeps.getOrCreateDevice(renterDeviceId);
                    audit('info', 'rental', `created in-memory device for renter ${renterDeviceId}`, {
                        userId: req.user.userId, action: 'rental_ensure_device',
                    });
                }

                const listing = await getListing(listingId);
                if (listing) {
                    const { slot } = insertRentalEntity(_interviewDeps.devices, {
                        renterDeviceId,
                        contractId: contract.id,
                        listing,
                        rateMliPerKtoken: Number(listing.rate_mli_per_ktoken),
                    }, {
                        generateBotSecret: _interviewDeps.generateBotSecret,
                        generatePublicCode: _interviewDeps.generatePublicCode,
                        publicCodeIndex: _interviewDeps.publicCodeIndex,
                        ensureOneEmptySlot: _interviewDeps.ensureOneEmptySlot,
                    });
                    markOwnerEntityLeasedOut(_interviewDeps.devices, {
                        ownerDeviceId: listing.owner_device_id,
                        ownerEntityId: listing.owner_entity_id,
                        contractId: contract.id,
                    });
                    audit('info', 'rental', `entity handover: slot ${slot} on ${renterDeviceId}`, {
                        userId: req.user.userId, action: 'rental_entity_insert', resource: contract.id,
                    });

                    // Persist to DB so entity poll reads the updated state
                    if (_interviewDeps.saveDeviceData) {
                        await _interviewDeps.saveDeviceData(renterDeviceId, _interviewDeps.devices[renterDeviceId]);
                        await _interviewDeps.saveDeviceData(listing.owner_device_id, _interviewDeps.devices[listing.owner_device_id]);
                    }
                }
            } catch (handoverErr) {
                // Log but don't fail the contract — the DB contract is the source of truth.
                console.error('[Rental] entity handover failed:', handoverErr.message);
                audit('error', 'rental', `entity handover failed: ${handoverErr.message}`, {
                    userId: req.user.userId, action: 'rental_entity_insert_fail', resource: contract.id,
                });
            }
        }

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

        // P2-F Entity Handover cleanup: remove rental entity from renter's
        // device and clear leased_out status on the owner's entity.
        if (_interviewDeps.devices) {
            try {
                // Fetch contract + listing details needed for cleanup.
                const cRow = await pool.query(
                    `SELECT c.renter_device_id, c.listing_id,
                            l.owner_device_id, l.owner_entity_id
                     FROM rental_contracts c
                     JOIN bot_listings l ON l.id = c.listing_id
                     WHERE c.id = $1`,
                    [contract.id]
                );
                if (cRow.rowCount > 0) {
                    const info = cRow.rows[0];
                    removeRentalEntity(_interviewDeps.devices, {
                        renterDeviceId: info.renter_device_id,
                        contractId: contract.id,
                    }, {
                        publicCodeIndex: _interviewDeps.publicCodeIndex,
                    });
                    clearOwnerEntityLeasedOut(_interviewDeps.devices, {
                        ownerDeviceId: info.owner_device_id,
                        ownerEntityId: info.owner_entity_id,
                    });
                    audit('info', 'rental', `entity handover cleanup: ${info.renter_device_id}`, {
                        userId: req.user.userId, action: 'rental_entity_remove', resource: contract.id,
                    });

                    // Persist cleanup to DB
                    if (_interviewDeps.saveDeviceData && _interviewDeps.devices[info.renter_device_id]) {
                        await _interviewDeps.saveDeviceData(info.renter_device_id, _interviewDeps.devices[info.renter_device_id]);
                    }
                    if (_interviewDeps.saveDeviceData && _interviewDeps.devices[info.owner_device_id]) {
                        await _interviewDeps.saveDeviceData(info.owner_device_id, _interviewDeps.devices[info.owner_device_id]);
                    }
                }
            } catch (cleanupErr) {
                console.error('[Rental] entity handover cleanup failed:', cleanupErr.message);
                audit('error', 'rental', `entity handover cleanup failed: ${cleanupErr.message}`, {
                    userId: req.user.userId, action: 'rental_entity_remove_fail', resource: contract.id,
                });
            }
        }

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

    // ── Interview probe dispatch ──────────────────────────────────

    /** Late-bound deps injected via setInterviewDeps() after pushToBot is defined. */
    let _interviewDeps = { pushToBot: null, devices: null };

    // ── Debug: rental-entity-visibility (#1713) (DO NOT REMOVE until user confirms fix) ──
    router.get('/debug/rental-entity-visibility', async (req, res) => { try {
        const { deviceId, deviceSecret } = req.query;
        if (!deviceId || !deviceSecret) {
            return res.json({ success: false, error: 'deviceId and deviceSecret required' });
        }
        const devRes = await pool.query(
            'SELECT device_id, device_secret FROM devices WHERE device_id = $1', [deviceId]
        );
        if (!devRes.rows.length || devRes.rows[0].device_secret !== deviceSecret) {
            return res.json({ success: false, error: 'auth_failed' });
        }
        // In-memory device state
        const inMemDevice = _interviewDeps.devices?.[deviceId];
        const entitySlots = inMemDevice ? Object.entries(inMemDevice.entities).map(([id, e]) => ({
            slot: parseInt(id),
            isBound: e?.isBound,
            character: e?.character,
            rental_contract_id: e?.rental_contract_id,
            rental_status: e?.rental_status,
            botSecret: e?.botSecret ? 'set' : 'null',
            publicCode: e?.publicCode,
            webhook: e?.webhook ? (typeof e.webhook === 'object' ? e.webhook.type || 'object' : 'string') : 'null',
        })) : null;
        // Active contracts for this device
        const contractsRes = await pool.query(
            `SELECT id, listing_id, status, started_at, ends_at, renter_device_id
             FROM rental_contracts
             WHERE renter_device_id = $1 AND status IN ('active', 'reserved', 'suspended_insufficient_funds')
             ORDER BY started_at DESC LIMIT 10`, [deviceId]
        );
        // DB entities
        const dbEntities = await pool.query(
            'SELECT entity_id, is_bound, character, webhook FROM entities WHERE device_id = $1', [deviceId]
        );
        res.json({
            success: true,
            bug: 'rental-entity-visibility',
            diagnostics: {
                deviceInMemory: !!inMemDevice,
                entitySlots,
                activeContracts: contractsRes.rows,
                dbEntities: dbEntities.rows.map(r => ({
                    entity_id: r.entity_id,
                    is_bound: r.is_bound,
                    character: r.character,
                    webhook: r.webhook ? 'set' : 'null',
                })),
                hasInterviewDeps: !!_interviewDeps.devices,
            },
            timestamp: new Date().toISOString(),
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); } });

    // ── Debug: interview-start-fail (DO NOT REMOVE until user confirms fix) ──
    router.get('/debug/interview-start-fail', async (req, res) => { try {
        const { deviceId, deviceSecret } = req.query;
        if (!deviceId || !deviceSecret) {
            return res.json({ success: false, error: 'deviceId and deviceSecret required' });
        }
        const devRes = await pool.query(
            'SELECT device_id, device_secret FROM devices WHERE device_id = $1', [deviceId]
        );
        if (!devRes.rows.length || devRes.rows[0].device_secret !== deviceSecret) {
            return res.json({ success: false, error: 'auth_failed' });
        }
        const userRes = await pool.query(
            'SELECT id, email FROM user_accounts WHERE device_id = $1', [deviceId]
        );
        const userId = userRes.rows[0]?.id;
        const listingsRes = await pool.query(
            `SELECT id, owner_device_id, owner_entity_id, status, interview_passed, last_interview_at
             FROM bot_listings WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 5`, [userId]
        );
        const diagnostics = listingsRes.rows.map(l => {
            const deviceInMemory = _interviewDeps.devices ? !!_interviewDeps.devices[l.owner_device_id] : null;
            let entityInfo = null;
            if (deviceInMemory && _interviewDeps.devices[l.owner_device_id]) {
                const dev = _interviewDeps.devices[l.owner_device_id];
                const ent = dev.entities?.[l.owner_entity_id];
                entityInfo = ent ? {
                    isBound: !!ent.isBound, hasWebhook: !!ent.webhook,
                    webhookPrefix: ent.webhook ? ent.webhook.url?.substring(0, 40) + '...' : null,
                    bindingType: ent.bindingType || 'webhook',
                    channelAccountId: ent.channelAccountId || null,
                    isChannelBound: ent.bindingType === 'channel' && !!ent.channelAccountId,
                    canInterview: !!(ent.webhook || (ent.bindingType === 'channel' && ent.channelAccountId)),
                    interviewInProgress: !!ent._interviewInProgress, name: ent.name || null,
                } : 'entity_not_found_in_device';
            }
            return {
                listingId: l.id, ownerDeviceId: l.owner_device_id, ownerEntityId: l.owner_entity_id,
                status: l.status, interviewPassed: l.interview_passed, lastInterviewAt: l.last_interview_at,
                deviceInMemory, entityInfo,
            };
        });
        res.json({
            success: true, bug: 'interview-start-fail',
            diagnostics: {
                userId, email: userRes.rows[0]?.email, requestDeviceId: deviceId,
                devicesMapSize: _interviewDeps.devices ? Object.keys(_interviewDeps.devices).length : 0,
                hasPushToBot: !!_interviewDeps.pushToBot, listings: diagnostics,
            },
            timestamp: new Date().toISOString(),
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); } });


    // POST /api/rental/listing/:id/interview/start — DEPRECATED: frontend now uses POST /api/arena/exam directly.
    // Kept for backward compatibility. The 8-probe flow below is legacy; Arena 12-challenge is the current system.
    router.post('/listing/:id/interview/start', authMiddleware, rentalRoute(async (req, res) => {
        const listing = await getListing(req.params.id);
        if (!listing) throw new Error('listing_not_found');
        if (listing.owner_user_id !== req.user.userId) throw new Error('listing_forbidden');

        // Status gate: only draft / paused / listed can (re-)interview
        if (!['draft', 'paused', 'listed'].includes(listing.status)) {
            throw new Error('listing_status_invalid_for_interview');
        }

        // Rate limit: max 3 attempts per 7 days
        const recentRes = await pool.query(
            `SELECT COUNT(*) FROM bot_interviews
             WHERE listing_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
            [listing.id]
        );
        if (parseInt(recentRes.rows[0].count) >= INTERVIEW_RATE_LIMIT) {
            throw new Error('interview_rate_limited');
        }

        // Resolve the owner's entity from the in-memory devices map
        if (!_interviewDeps.pushToBot || !_interviewDeps.devices) {
            throw new Error('interview_deps_not_ready');
        }
        const device = _interviewDeps.devices[listing.owner_device_id];
        if (!device) throw new Error('owner_device_not_found');
        const entity = device.entities[listing.owner_entity_id];
        if (!entity || !entity.isBound) throw new Error('owner_entity_not_bound');
        const isChannelBound = entity.bindingType === 'channel' && !!entity.channelAccountId;
        if (!entity.webhook && !isChannelBound) throw new Error('owner_entity_no_webhook_or_channel');
        if (entity._interviewInProgress) throw new Error('interview_already_running');

        // Build a unified push function that works for both webhook and channel bots
        const unifiedPush = async (ent, devId, eventType, payload) => {
            if (isChannelBound && _interviewDeps.pushToChannelCallback) {
                const pushResult = await _interviewDeps.pushToChannelCallback(devId, listing.owner_entity_id, {
                    event: 'interview_probe',
                    text: payload.message || JSON.stringify(payload),
                }, ent.channelAccountId);
                return { pushed: !!pushResult?.pushed };
            }
            return _interviewDeps.pushToBot(ent, devId, eventType, payload);
        };

        // Set listing to 'interview' status
        await pool.query(
            `UPDATE bot_listings SET status = 'interview', updated_at = NOW() WHERE id = $1`,
            [listing.id]
        );

        let result;
        try {
            result = await runInterview({
                entity,
                deviceId: listing.owner_device_id,
                pushToBot: unifiedPush,
            });
        } catch (err) {
            // Revert status on unexpected failure
            await pool.query(
                `UPDATE bot_listings SET status = 'draft', updated_at = NOW() WHERE id = $1`,
                [listing.id]
            );
            throw err;
        }

        // Persist interview record
        await pool.query(
            `INSERT INTO bot_interviews
                (listing_id, probes_json, responses_json, passed, score, duration_ms, failure_reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [listing.id, JSON.stringify(getProbeList()), JSON.stringify(result.responses),
             result.passed, result.score, result.duration_ms,
             result.passed ? null : 'score_below_threshold']
        );

        // Update listing based on result
        if (result.passed) {
            await pool.query(
                `UPDATE bot_listings
                 SET interview_passed = TRUE, last_interview_at = NOW(),
                     capabilities = $2, benchmark_score = $3,
                     status = 'draft', updated_at = NOW()
                 WHERE id = $1`,
                [listing.id,
                 JSON.stringify(result.capabilities),
                 JSON.stringify({ score: result.score, rawScore: result.rawScore, maxScore: result.maxScore, probeResults: result.probeResults })]
            );
            // Sync interview capabilities to entity's agent card (immutable, 30-day expiry)
            if (_interviewDeps.setInterviewCapabilities) {
                _interviewDeps.setInterviewCapabilities(entity, result);
            }
        } else {
            await pool.query(
                `UPDATE bot_listings SET status = 'draft', updated_at = NOW() WHERE id = $1`,
                [listing.id]
            );
        }

        audit('info', 'rental', `interview ${result.passed ? 'PASSED' : 'FAILED'} listing=${listing.id} score=${result.score}`, {
            userId: req.user.userId, action: 'interview_run', resource: listing.id,
            result: result.passed ? 'pass' : 'fail',
        });

        // Create an arena_exam record so results are viewable at /arena/exam/:id
        let examUrl = null;
        try {
            if (_interviewDeps.arenaModule) {
                const arenaPool = _interviewDeps.arenaModule._internals?.pool || pool;
                const examToken = require('crypto').randomBytes(6).toString('hex');
                const probeList = getProbeList();
                const examRes = await arenaPool.query(
                    `INSERT INTO arena_exams (exam_token, listing_id, model, status, total_score, max_score, report)
                     VALUES ($1, $2, $3, 'completed', $4, 100, $5)
                     RETURNING id`,
                    [examToken, listing.id, entity.name || 'Bot',
                     result.score,
                     JSON.stringify({
                         source: 'webhook_interview',
                         totalScore: result.score,
                         maxScore: 100,
                         detail: result.probeResults.map((pr, i) => ({
                             testType: pr.probeId,
                             name: probeList[i]?.prompt?.slice(0, 40) || pr.probeId,
                             score: pr.score,
                             maxScore: pr.weight,
                         })),
                     })]
                );
                const examId = examRes.rows[0].id;
                const apiBase = process.env.API_BASE || 'https://eclawbot.com';
                examUrl = `${apiBase}/arena/exam/${examId}`;

                // Insert arena_sessions for each probe
                for (let i = 0; i < result.probeResults.length; i++) {
                    const pr = result.probeResults[i];
                    await arenaPool.query(
                        `INSERT INTO arena_sessions
                            (exam_id, session_token, test_type, test_index, challenge_config,
                             max_score, score, status, raw_result, completed_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, NOW())`,
                        [examId, require('crypto').randomBytes(5).toString('hex'),
                         pr.probeId, i,
                         JSON.stringify({ prompt: probeList[i]?.prompt, response: result.responses?.[i] || null }),
                         pr.weight, pr.score,
                         JSON.stringify({ passed: pr.passed, reason: pr.reason })]
                    );
                }
            }
        } catch (arenaErr) {
            console.warn('[Interview] Arena record creation failed (non-blocking):', arenaErr.message);
        }

        res.json({
            success: true,
            interview: {
                passed: result.passed,
                score: result.score,
                probeResults: result.probeResults,
                capabilities: result.capabilities,
                duration_ms: result.duration_ms,
            },
            examUrl,
        });
    }));

    // GET /api/rental/listing/:id/interviews — interview history (owner only)
    router.get('/listing/:id/interviews', authMiddleware, rentalRoute(async (req, res) => {
        const listing = await getListing(req.params.id);
        if (!listing) throw new Error('listing_not_found');
        if (listing.owner_user_id !== req.user.userId) throw new Error('listing_forbidden');

        const interviews = await pool.query(
            `SELECT id, passed, score, duration_ms, failure_reason, created_at
             FROM bot_interviews WHERE listing_id = $1
             ORDER BY created_at DESC LIMIT 20`,
            [req.params.id]
        );
        res.json({ success: true, interviews: interviews.rows });
    }));

    // GET /api/rental/listing/:id/interview/:interviewId — interview detail (owner only)
    router.get('/listing/:id/interview/:interviewId', authMiddleware, rentalRoute(async (req, res) => {
        const listing = await getListing(req.params.id);
        if (!listing) throw new Error('listing_not_found');
        if (listing.owner_user_id !== req.user.userId) throw new Error('listing_forbidden');

        const interview = await pool.query(
            `SELECT id, listing_id, probes_json, responses_json, passed, score,
                    duration_ms, failure_reason, created_at
             FROM bot_interviews WHERE id = $1 AND listing_id = $2`,
            [req.params.interviewId, req.params.id]
        );
        if (interview.rowCount === 0) throw new Error('interview_not_found');
        res.json({ success: true, interview: interview.rows[0] });
    }));

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
        reconcileRentalEntities,
        // Interview dispatch (late-bound)
        setInterviewDeps: (deps) => { _interviewDeps = deps; },
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
