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
const safeEqual = require('./safe-equal');
const { newContractId } = require('./entity-id');
const { detectFamily } = require('./pricing-advisor');

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

/** Listing soft-pause defaults: degraded health pauses new rentals without changing status='listed'. */
const LISTING_SOFT_PAUSE_REASON_HEALTH_DEGRADED = 'health_degraded';
const LISTING_SOFT_PAUSE_DEFAULT_MINUTES = 60;
const LISTING_HEALTH_DEGRADED_THRESHOLD_MS = 60 * 60 * 1000;
const LISTING_HEALTH_OK_RECOVERY_STREAK = 5;

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
    TERMINATED_BY_REBIND: 'terminated_by_rebind',
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

function nonNegativeBigInt(value, fallback = 0n) {
    if (value === null || value === undefined) return fallback;
    try {
        const parsed = BigInt(value);
        return parsed > 0n ? parsed : 0n;
    } catch (_) {
        return fallback;
    }
}

function safeMliNumber(value, name) {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (value > max) throw new Error(`${name}_too_large`);
    return Number(value);
}

function computeRebindRefundMli({ depositMli, remainingSec, totalDurationSec }) {
    const deposit = nonNegativeBigInt(depositMli);
    const total = nonNegativeBigInt(totalDurationSec);
    if (deposit === 0n || total === 0n) return 0;
    let remaining = nonNegativeBigInt(remainingSec);
    if (remaining > total) remaining = total;
    return safeMliNumber((deposit * remaining) / total, 'rebind_refund_mli');
}

function isListingSoftPaused(listing, now = new Date()) {
    if (!listing || !listing.soft_pause_until) return false;
    const until = listing.soft_pause_until instanceof Date
        ? listing.soft_pause_until
        : new Date(listing.soft_pause_until);
    return Number.isFinite(until.getTime()) && until.getTime() > now.getTime();
}

function serializeSoftPauseFields(listing, now = new Date()) {
    if (!listing) return listing;
    const active = isListingSoftPaused(listing, now);
    listing.is_soft_paused = active;
    if (listing.soft_pause_until instanceof Date) {
        listing.soft_pause_until = listing.soft_pause_until.toISOString();
    }
    return listing;
}

function buildListingSoftPausedError(listing) {
    const err = new Error('listing_soft_paused');
    err.code = 'LISTING_SOFT_PAUSED';
    err.httpStatus = 503;
    err.resumeEta = listing?.soft_pause_until || null;
    err.reason = listing?.soft_pause_reason || LISTING_SOFT_PAUSE_REASON_HEALTH_DEGRADED;
    return err;
}

function normalizeSoftPauseReason(reason) {
    const raw = String(reason || LISTING_SOFT_PAUSE_REASON_HEALTH_DEGRADED).trim();
    const safe = raw.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64);
    return safe || LISTING_SOFT_PAUSE_REASON_HEALTH_DEGRADED;
}

function toDateOrNull(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
}

function percentileDisc(sortedValues, fraction) {
    if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
    const rank = Math.max(1, Math.ceil(sortedValues.length * fraction));
    return sortedValues[Math.min(sortedValues.length - 1, rank - 1)];
}

function normalizeRateMli(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function refreshPricingMarketSnapshots({
    snapshotAt = new Date(),
    client = pool,
} = {}) {
    const at = toDateOrNull(snapshotAt) || new Date();
    const marketRows = await client.query(
        `SELECT bl.id,
                bl.model_detected,
                bl.rate_mli_per_ktoken,
                COUNT(c.id)::int AS started_contracts,
                COUNT(c.id) FILTER (WHERE c.status = 'ended_normal')::int AS successful_contracts
           FROM bot_listings bl
           LEFT JOIN rental_contracts c ON c.listing_id = bl.id
          WHERE bl.status = 'listed'
            AND bl.interview_passed = TRUE
            AND bl.rate_mli_per_ktoken > 0
            AND (bl.soft_pause_until IS NULL OR bl.soft_pause_until <= NOW())
          GROUP BY bl.id, bl.model_detected, bl.rate_mli_per_ktoken`
    );

    const byFamily = new Map();
    for (const row of marketRows.rows || []) {
        const rate = normalizeRateMli(row.rate_mli_per_ktoken);
        if (rate == null) continue;
        const family = detectFamily(row.model_detected);
        if (!byFamily.has(family)) {
            byFamily.set(family, { rates: [], started: 0, successful: 0 });
        }
        const bucket = byFamily.get(family);
        bucket.rates.push(rate);
        bucket.started += Number.parseInt(row.started_contracts, 10) || 0;
        bucket.successful += Number.parseInt(row.successful_contracts, 10) || 0;
    }

    const rows = [];
    for (const [family, bucket] of [...byFamily.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        bucket.rates.sort((a, b) => a - b);
        const rentalSuccessRate = bucket.started > 0
            ? Number((bucket.successful / bucket.started).toFixed(3))
            : null;
        const snapshotRow = {
            modelFamily: family,
            listingCount: bucket.rates.length,
            rateP25Mli: percentileDisc(bucket.rates, 0.25),
            rateP50Mli: percentileDisc(bucket.rates, 0.50),
            rateP75Mli: percentileDisc(bucket.rates, 0.75),
            rateP95Mli: percentileDisc(bucket.rates, 0.95),
            rentalSuccessRate,
        };
        await client.query(
            `INSERT INTO pricing_market_snapshots
                (snapshot_at, model_family, listing_count,
                 rate_p25_mli, rate_p50_mli, rate_p75_mli, rate_p95_mli,
                 rental_success_rate)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                at,
                snapshotRow.modelFamily,
                snapshotRow.listingCount,
                snapshotRow.rateP25Mli,
                snapshotRow.rateP50Mli,
                snapshotRow.rateP75Mli,
                snapshotRow.rateP95Mli,
                snapshotRow.rentalSuccessRate,
            ]
        );
        rows.push(snapshotRow);
    }

    return {
        snapshotAt: at.toISOString(),
        familyCount: rows.length,
        listingCount: rows.reduce((sum, row) => sum + row.listingCount, 0),
        rows,
    };
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
        // Add newer listing columns if missing (startup compatibility for older deployments).
        try {
            await pool.query(`ALTER TABLE bot_listings ADD COLUMN IF NOT EXISTS avatar_url TEXT`);
            await pool.query(`ALTER TABLE bot_listings ADD COLUMN IF NOT EXISTS soft_pause_until TIMESTAMPTZ NULL`);
            await pool.query(`ALTER TABLE bot_listings ADD COLUMN IF NOT EXISTS soft_pause_reason VARCHAR(64) NULL`);
            await pool.query(`CREATE INDEX IF NOT EXISTS idx_listings_soft_pause_active
                ON bot_listings(soft_pause_until)
                WHERE status = 'listed' AND soft_pause_until IS NOT NULL`);
        } catch (_) { /* column/index may already exist */ }
        try {
            await pool.query(`ALTER TABLE rental_contracts ALTER COLUMN id SET DEFAULT ('contract_' || encode(gen_random_bytes(12), 'hex'))`);
        } catch (err) {
            console.warn('[Rental] Schema warning: rental_contracts.id default:', err.message);
        }
        // P0 card_68242d883b51c3b6ceda09cb: live bot_listings.id lost its DEFAULT
        // during an earlier schema migration. CREATE TABLE IF NOT EXISTS at the
        // top of this file does nothing on existing tables, so the VARCHAR(48)
        // DEFAULT in the schema definition never reached prod. INSERT without
        // explicit id then hits 23502 not_null_violation. Mirror the
        // rental_contracts fix above so every startup re-asserts the DEFAULT.
        try {
            await pool.query(`ALTER TABLE bot_listings ALTER COLUMN id SET DEFAULT ('listing_' || encode(gen_random_bytes(12), 'hex'))`);
        } catch (err) {
            console.warn('[Rental] Schema warning: bot_listings.id default:', err.message);
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
    avatarUrl = null,
    boundRebindCount = 0,
}) {
    assertString('owner_user_id', ownerUserId, { max: 64 });
    assertString('owner_device_id', ownerDeviceId, { max: 64 });
    assertNonNegativeInt('owner_entity_id', ownerEntityId);
    assertString('title', title, { max: 120 });
    if (description !== null) assertString('description', description, { max: 2000 });
    // Interview gate (Hank 2026-04-24): pricing is locked at creation — draft rows
    // always start at rate=0. Owner must pass interview before PATCH /listing/:id
    // can set a real rate. Prevents "list for rent + set price" shortcut that
    // bypasses the arena exam.
    rateMliPerKtoken = 0;
    if (minRentalMinutes < MIN_RENTAL_MINUTES) throw new Error('min_rental_minutes_invalid');
    if (maxRentalMinutes > MAX_RENTAL_MINUTES) throw new Error('max_rental_minutes_invalid');
    if (minRentalMinutes > maxRentalMinutes) throw new Error('rental_duration_range_invalid');

    // BUG-M2: Prevent duplicate listings for the same owner+entity combination.
    // Only one active (draft/listed/paused/interview) listing allowed per entity.
    const existingRes = await pool.query(
        `SELECT id, status FROM bot_listings
         WHERE owner_device_id = $1 AND owner_entity_id = $2
           AND status IN ('draft', 'listed', 'paused', 'interview')
         ORDER BY created_at DESC LIMIT 1`,
        [ownerDeviceId, ownerEntityId]
    );
    if (existingRes.rowCount > 0) {
        const err = new Error('duplicate_listing');
        err.existingListingId = existingRes.rows[0].id;
        err.existingStatus = existingRes.rows[0].status;
        throw err;
    }

    // Avatar is passed from the route handler where _interviewDeps is in scope

    const res = await pool.query(
        `INSERT INTO bot_listings
            (owner_user_id, owner_device_id, owner_entity_id, title, description,
             rate_mli_per_ktoken, min_rental_minutes, max_rental_minutes, avatar_url, status,
             bound_rebind_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10)
         RETURNING id, status, created_at, bound_rebind_count`,
        [ownerUserId, ownerDeviceId, ownerEntityId, title, description,
         rateMliPerKtoken, minRentalMinutes, maxRentalMinutes, avatarUrl || null,
         Number.isInteger(boundRebindCount) && boundRebindCount >= 0 ? boundRebindCount : 0]
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
    // Interview gate (Hank 2026-04-24): commercial fields — rate and duration
    // limits — can only be mutated after the listing's interview has passed.
    // Bare 'title' and 'description' edits are always allowed.
    const commercialCols = new Set([
        'rate_mli_per_ktoken', 'min_rental_minutes', 'max_rental_minutes', 'availability_windows',
    ]);
    const wantsCommercial = Object.keys(patch || {}).some(k => {
        const col = k.replace(/[A-Z]/g, m => '_' + m.toLowerCase());
        return commercialCols.has(col);
    });
    if (wantsCommercial) {
        const gate = await pool.query(
            `SELECT interview_passed FROM bot_listings WHERE id = $1 AND owner_user_id = $2`,
            [listingId, ownerUserId]
        );
        if (gate.rowCount === 0) throw new Error('listing_not_found');
        if (!gate.rows[0].interview_passed) throw new Error('interview_required_before_pricing');
    }
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
    // V5 fix: only draft/paused can be published — prevents delisted resurrection
    // Hank 2026-04-24: also block publish when rate is still the 0 placeholder,
    // so a user can't click publish before doing the rate-setting step.
    const res = await pool.query(
        `UPDATE bot_listings SET status = 'listed', updated_at = NOW()
         WHERE id = $1 AND owner_user_id = $2 AND interview_passed = TRUE
           AND rate_mli_per_ktoken > 0
           AND status IN ('draft', 'paused')
         RETURNING id, status`,
        [listingId, ownerUserId]
    );
    if (res.rowCount === 0) {
        const check = await pool.query(
            `SELECT interview_passed, owner_user_id, status, rate_mli_per_ktoken FROM bot_listings WHERE id = $1`,
            [listingId]
        );
        if (check.rowCount === 0) throw new Error('listing_not_found');
        if (check.rows[0].owner_user_id !== ownerUserId) throw new Error('listing_forbidden');
        if (!check.rows[0].interview_passed) throw new Error('interview_not_passed');
        if (!check.rows[0].rate_mli_per_ktoken || Number(check.rows[0].rate_mli_per_ktoken) === 0) {
            throw new Error('rate_not_set');
        }
        if (check.rows[0].status === 'listed') throw new Error('already_listed');
        if (check.rows[0].status === 'delisted') throw new Error('listing_permanently_delisted');
        if (check.rows[0].status === 'interview') throw new Error('interview_in_progress');
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

/**
 * P0 Phase 3: when an entity slot is rebound to a different bot, every active
 * listing pointing at that slot is now stale. Auto-pause them so the
 * marketplace stops booking the slot, while leaving the row in place so the
 * owner can decide to re-list (after a fresh interview) or delist permanently.
 *
 * Statuses we touch: 'draft', 'interview', 'listed'.
 * Statuses we leave alone: 'paused' (already safe), 'delisted' (terminal).
 *
 * Returns the affected listing IDs for caller logging. Errors are caught
 * and logged — a DB hiccup must not abort the rebind itself.
 */
async function pauseListingsOnRebind(deviceId, entityId) {
    if (!deviceId || !Number.isInteger(entityId)) return [];
    try {
        const res = await pool.query(
            `UPDATE bot_listings
                SET status = 'paused', updated_at = NOW()
              WHERE owner_device_id = $1
                AND owner_entity_id = $2
                AND status IN ('draft', 'interview', 'listed')
            RETURNING id, status`,
            [deviceId, entityId]
        );
        return res.rows.map((r) => r.id);
    } catch (err) {
        console.error('[Rental] pauseListingsOnRebind error:', err.message);
        return [];
    }
}

/**
 * P0 Phase 4: when an entity slot is rebound, every active rental contract
 * pointing at that slot is now serving a different bot from what the renter
 * agreed to. Terminate active contracts in one strict wallet transaction and
 * make the renter whole with a per-second owner-paid rebind refund.
 *
 * Strict Phase 4 rules:
 *   1. Only `status = 'active'` is eligible. Reserved/suspended/terminal rows
 *      are skipped so stale non-active rows cannot receive money.
 *   2. The whole cascade runs inside one walletApi.withTransaction callback.
 *      Contract rows and participating wallet rows are locked with
 *      SELECT ... FOR UPDATE, and DB NOW() is used for remaining time.
 *   3. Refund = floor(deposit_mli × remaining_sec / total_duration_sec).
 *      If the owner cannot cover all refunds, the function rejects and the
 *      transaction rolls back (no partial contract status or wallet changes).
 *   4. The renter's currently held deposit (up to deposit_mli) is released,
 *      the owner-paid refund is recorded in wallet_ledger, the contract status
 *      becomes `terminated_by_rebind`, and rental_rebind_audit_log records the
 *      rental-side audit trail.
 */
async function terminateActiveContractsOnRebind(deviceId, entityId, walletApi) {
    if (!deviceId || !Number.isInteger(entityId)) return [];
    if (!walletApi || typeof walletApi.withTransaction !== 'function' ||
        typeof walletApi.applyLedgerEntry !== 'function') return [];

    return walletApi.withTransaction(async (client) => {
        const res = await client.query(
            `SELECT c.id, c.listing_id, c.owner_user_id, c.renter_user_id,
                    c.deposit_mli, c.planned_duration_min,
                    COALESCE(
                        c.total_duration_sec,
                        GREATEST(0::bigint, COALESCE(FLOOR(EXTRACT(EPOCH FROM (c.ends_at - c.started_at)))::bigint, 0)),
                        (c.planned_duration_min::bigint * 60)
                    ) AS total_duration_sec,
                    GREATEST(0::bigint, COALESCE(FLOOR(EXTRACT(EPOCH FROM (c.ends_at - NOW())))::bigint, 0)) AS remaining_sec,
                    c.started_at, c.ends_at, c.status, NOW() AS terminated_at
               FROM rental_contracts c
               JOIN bot_listings l ON l.id = c.listing_id
              WHERE l.owner_device_id = $1
                AND l.owner_entity_id = $2
                AND c.status = 'active'
              ORDER BY c.id
              FOR UPDATE OF c`,
            [deviceId, entityId]
        );
        const contracts = res.rows;
        if (contracts.length === 0) return [];

        const planned = contracts.map((c) => {
            const depositBi = nonNegativeBigInt(c.deposit_mli);
            const totalSecBi = nonNegativeBigInt(c.total_duration_sec);
            let remainingSecBi = nonNegativeBigInt(c.remaining_sec);
            if (totalSecBi > 0n && remainingSecBi > totalSecBi) remainingSecBi = totalSecBi;
            const refundMli = computeRebindRefundMli({
                depositMli: depositBi,
                remainingSec: remainingSecBi,
                totalDurationSec: totalSecBi,
            });
            return {
                contract: c,
                depositMli: safeMliNumber(depositBi, 'deposit_mli'),
                totalDurationSec: safeMliNumber(totalSecBi, 'total_duration_sec'),
                remainingSec: safeMliNumber(remainingSecBi, 'remaining_sec'),
                refundMli,
                releaseMli: 0,
            };
        });

        // Lock every wallet in a stable order before deciding whether the
        // cascade can proceed. Missing wallets are treated as zero balance/held.
        const userIds = [...new Set(planned.flatMap((p) => [
            p.contract.owner_user_id,
            p.contract.renter_user_id,
        ]))].sort();
        const wallets = new Map(userIds.map((id) => [id, { balance_mli: 0, held_mli: 0 }]));
        if (userIds.length > 0) {
            const walletRes = await client.query(
                `SELECT user_id, balance_mli, held_mli
                   FROM wallets
                  WHERE user_id = ANY($1::uuid[])
                  ORDER BY user_id
                  FOR UPDATE`,
                [userIds]
            );
            for (const row of walletRes.rows) {
                wallets.set(String(row.user_id), {
                    balance_mli: safeMliNumber(nonNegativeBigInt(row.balance_mli), 'wallet_balance_mli'),
                    held_mli: safeMliNumber(nonNegativeBigInt(row.held_mli), 'wallet_held_mli'),
                });
            }
        }

        const requiredRefundByOwner = new Map();
        for (const p of planned) {
            const ownerId = p.contract.owner_user_id;
            requiredRefundByOwner.set(ownerId, (requiredRefundByOwner.get(ownerId) || 0) + p.refundMli);

            const renterWallet = wallets.get(p.contract.renter_user_id) || { balance_mli: 0, held_mli: 0 };
            p.releaseMli = Math.min(renterWallet.held_mli, p.depositMli);
            renterWallet.held_mli -= p.releaseMli;
            wallets.set(p.contract.renter_user_id, renterWallet);
        }

        for (const [ownerId, requiredMli] of requiredRefundByOwner.entries()) {
            const ownerWallet = wallets.get(ownerId) || { balance_mli: 0, held_mli: 0 };
            if (ownerWallet.balance_mli < requiredMli) {
                const err = new Error('owner_insufficient_balance_for_rebind_refund');
                err.details = {
                    owner_user_id: ownerId,
                    required_mli: String(requiredMli),
                    current_mli: String(ownerWallet.balance_mli),
                };
                throw err;
            }
        }

        const outcomes = [];
        for (const p of planned) {
            const c = p.contract;
            const releaseKey = `rebind-deposit-release:${c.id}`;
            const debitKey = `rebind-refund-debit:${c.id}`;
            const creditKey = `rebind-refund-credit:${c.id}`;

            if (p.releaseMli > 0) {
                await walletApi.applyLedgerEntry(client, {
                    userId: c.renter_user_id,
                    balanceDelta: p.releaseMli,
                    heldDelta: -p.releaseMli,
                    type: walletApi.LEDGER_TYPES.DEPOSIT_RELEASE,
                    refType: 'rental_contract',
                    refId: c.id,
                    counterpartyUserId: c.owner_user_id,
                    note: `rebind termination deposit release: ${c.id}`,
                    idempotencyKey: releaseKey,
                });
            }

            if (p.refundMli > 0) {
                await walletApi.applyLedgerEntry(client, {
                    userId: c.owner_user_id,
                    balanceDelta: -p.refundMli,
                    heldDelta: 0,
                    type: walletApi.LEDGER_TYPES.REFUND,
                    refType: 'rental_contract',
                    refId: c.id,
                    counterpartyUserId: c.renter_user_id,
                    note: `rebind refund debit: ${c.id}`,
                    idempotencyKey: debitKey,
                });
                await walletApi.applyLedgerEntry(client, {
                    userId: c.renter_user_id,
                    balanceDelta: p.refundMli,
                    heldDelta: 0,
                    type: walletApi.LEDGER_TYPES.REFUND,
                    refType: 'rental_contract',
                    refId: c.id,
                    counterpartyUserId: c.owner_user_id,
                    note: `rebind refund credit: ${c.id}`,
                    idempotencyKey: creditKey,
                });
            }

            const updated = await client.query(
                `UPDATE rental_contracts
                    SET status = $2,
                        end_reason = $2,
                        actual_ended_at = NOW()
                  WHERE id = $1
                    AND status = 'active'
                  RETURNING id, status, end_reason, actual_ended_at`,
                [c.id, CONTRACT_STATUSES.TERMINATED_BY_REBIND]
            );
            if (updated.rowCount === 0) throw new Error('contract_not_active');

            await client.query(
                `INSERT INTO rental_rebind_audit_log
                    (contract_id, listing_id, owner_device_id, owner_entity_id,
                     owner_user_id, renter_user_id, status_from, status_to,
                     deposit_mli, deposit_release_mli, refund_mli,
                     remaining_sec, total_duration_sec,
                     wallet_release_idempotency_key, wallet_debit_idempotency_key,
                     wallet_credit_idempotency_key)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                         $9, $10, $11, $12, $13, $14, $15, $16)
                 ON CONFLICT (contract_id) DO NOTHING`,
                [
                    c.id, c.listing_id, deviceId, entityId,
                    c.owner_user_id, c.renter_user_id, c.status,
                    CONTRACT_STATUSES.TERMINATED_BY_REBIND,
                    p.depositMli, p.releaseMli, p.refundMli,
                    p.remainingSec, p.totalDurationSec,
                    p.releaseMli > 0 ? releaseKey : null,
                    p.refundMli > 0 ? debitKey : null,
                    p.refundMli > 0 ? creditKey : null,
                ]
            );

            outcomes.push({
                contractId: c.id,
                renterUserId: c.renter_user_id,
                ownerUserId: c.owner_user_id,
                releasedDepositMli: p.releaseMli,
                refundMli: p.refundMli,
                remainingSec: p.remainingSec,
                totalDurationSec: p.totalDurationSec,
                status: updated.rows[0].status,
                actualEndedAt: updated.rows[0].actual_ended_at,
            });
        }
        return outcomes;
    });
}

async function getListing(listingId) {
    const res = await pool.query(
        `SELECT id, owner_user_id, owner_device_id, owner_entity_id,
                title, description, rate_mli_per_ktoken,
                min_rental_minutes, max_rental_minutes, availability_windows,
                model_detected, capabilities, benchmark_score, interview_passed,
                last_interview_at, avg_rating, total_rentals, uptime_pct, status,
                soft_pause_until, soft_pause_reason,
                created_at, updated_at
         FROM bot_listings WHERE id = $1`,
        [listingId]
    );
    return serializeSoftPauseFields(res.rows[0] || null);
}

async function listMyListings(ownerUserId) {
    assertString('owner_user_id', ownerUserId, { max: 64 });
    const res = await pool.query(
        `SELECT id, owner_device_id, owner_entity_id, title, rate_mli_per_ktoken,
                status, interview_passed, avg_rating, total_rentals,
                soft_pause_until, soft_pause_reason, created_at
         FROM bot_listings WHERE owner_user_id = $1
         ORDER BY created_at DESC`,
        [ownerUserId]
    );
    return res.rows.map((row) => serializeSoftPauseFields(row));
}

async function softPauseListing(listingId, {
    reason = LISTING_SOFT_PAUSE_REASON_HEALTH_DEGRADED,
    resumeAt = null,
    resumeMinutes = LISTING_SOFT_PAUSE_DEFAULT_MINUTES,
    client = pool,
} = {}) {
    assertString('listing_id', listingId, { max: 64 });
    const until = resumeAt ? toDateOrNull(resumeAt) : new Date(Date.now() + Math.max(1, parseInt(resumeMinutes, 10) || LISTING_SOFT_PAUSE_DEFAULT_MINUTES) * 60 * 1000);
    if (!until) throw new Error('soft_pause_until_invalid');
    const res = await client.query(
        `UPDATE bot_listings
            SET soft_pause_until = $2,
                soft_pause_reason = $3,
                updated_at = NOW()
          WHERE id = $1 AND status = 'listed'
          RETURNING id, status, soft_pause_until, soft_pause_reason`,
        [listingId, until.toISOString(), normalizeSoftPauseReason(reason)]
    );
    if (res.rowCount === 0) throw new Error('listing_not_found_or_not_listed');
    return serializeSoftPauseFields(res.rows[0]);
}

async function clearListingSoftPause(listingId, { ownerUserId = null, client = pool } = {}) {
    assertString('listing_id', listingId, { max: 64 });
    const params = [listingId];
    let ownerClause = '';
    if (ownerUserId) {
        assertString('owner_user_id', ownerUserId, { max: 64 });
        params.push(ownerUserId);
        ownerClause = ` AND owner_user_id = $${params.length}`;
    }
    const res = await client.query(
        `UPDATE bot_listings
            SET soft_pause_until = NULL,
                soft_pause_reason = NULL,
                updated_at = NOW()
          WHERE id = $1${ownerClause}
          RETURNING id, status, soft_pause_until, soft_pause_reason`,
        params
    );
    if (res.rowCount === 0) throw new Error(ownerUserId ? 'listing_not_found_or_forbidden' : 'listing_not_found');
    return serializeSoftPauseFields(res.rows[0]);
}

async function recordListingHealthSample({
    listingId,
    status,
    reason = LISTING_SOFT_PAUSE_REASON_HEALTH_DEGRADED,
    degradedSince = null,
    okStreak = 0,
    now = new Date(),
    resumeMinutes = LISTING_SOFT_PAUSE_DEFAULT_MINUTES,
    client = pool,
} = {}) {
    assertString('listing_id', listingId, { max: 64 });
    const normalizedStatus = String(status || '').toLowerCase();
    const nowDate = toDateOrNull(now) || new Date();
    if (['degraded', 'down'].includes(normalizedStatus)) {
        const since = toDateOrNull(degradedSince);
        const degradedMs = since ? nowDate.getTime() - since.getTime() : 0;
        if (degradedMs >= LISTING_HEALTH_DEGRADED_THRESHOLD_MS) {
            const listing = await softPauseListing(listingId, {
                reason,
                resumeAt: new Date(nowDate.getTime() + Math.max(1, parseInt(resumeMinutes, 10) || LISTING_SOFT_PAUSE_DEFAULT_MINUTES) * 60 * 1000),
                client,
            });
            return { changed: true, action: 'soft_paused', listing };
        }
        return { changed: false, action: 'degraded_observed', degradedMs };
    }
    if (['ok', 'recovered'].includes(normalizedStatus)) {
        if ((parseInt(okStreak, 10) || 0) >= LISTING_HEALTH_OK_RECOVERY_STREAK) {
            const listing = await clearListingSoftPause(listingId, { client });
            return { changed: true, action: 'soft_pause_cleared', listing };
        }
        return { changed: false, action: 'ok_observed', okStreak: parseInt(okStreak, 10) || 0 };
    }
    throw new Error('health_status_invalid');
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
    const where = [`bl.status = 'listed'`, `bl.interview_passed = TRUE`, `(bl.soft_pause_until IS NULL OR bl.soft_pause_until <= NOW())`];

    if (minRateMli != null) {
        params.push(minRateMli);
        where.push(`bl.rate_mli_per_ktoken >= $${params.length}`);
    }
    if (maxRateMli != null) {
        params.push(maxRateMli);
        where.push(`bl.rate_mli_per_ktoken <= $${params.length}`);
    }
    if (capability) {
        params.push(capability);
        where.push(`bl.capabilities ? $${params.length}`);
    }

    let orderBy;
    switch (sort) {
        case 'rate_asc':  orderBy = 'rate_mli_per_ktoken ASC'; break;
        case 'rate_desc': orderBy = 'rate_mli_per_ktoken DESC'; break;
        case 'newest':    orderBy = 'bl_created_at DESC'; break;
        case 'rating':
        default:          orderBy = 'avg_rating DESC, total_rentals DESC'; break;
    }

    params.push(safeLimit);
    params.push(safeOffset);
    // BUG-M3: Check ANY active contract (reserved/active/suspended), not just
    // the current user's. Use EXISTS subquery to avoid duplicate rows.
    // BUG-M2: Deduplicate by owner+entity — only show the most recent listing
    // per owner_device_id + owner_entity_id combination using DISTINCT ON.
    const res = await pool.query(
        `SELECT * FROM (
            SELECT DISTINCT ON (bl.owner_device_id, bl.owner_entity_id)
                bl.id, bl.title, bl.description, bl.rate_mli_per_ktoken,
                bl.min_rental_minutes, bl.max_rental_minutes,
                bl.model_detected, bl.capabilities, bl.benchmark_score,
                bl.avg_rating, bl.total_rentals, bl.uptime_pct,
                bl.owner_device_id, bl.owner_entity_id,
                bl.avatar_url,
                bl.bound_rebind_count,
                bl.soft_pause_until, bl.soft_pause_reason,
                bl.created_at AS bl_created_at,
                EXISTS (
                    SELECT 1 FROM rental_contracts ac
                    JOIN bot_listings sib ON sib.id = ac.listing_id
                    WHERE sib.owner_device_id = bl.owner_device_id
                      AND sib.owner_entity_id = bl.owner_entity_id
                      AND ac.status IN ('reserved', 'active', 'suspended_insufficient_funds')
                ) AS has_active_contract
            FROM bot_listings bl
            WHERE ${where.join(' AND ')}
            ORDER BY bl.owner_device_id, bl.owner_entity_id, bl.created_at DESC
         ) deduped
         ORDER BY ${orderBy}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return res.rows;
}

/**
 * P0 Phase 2: drop listings whose live entity rebindCount has drifted past
 * bound_rebind_count (snapshot at listing creation). A drifted listing
 * silently points at a different bot than the renter expects, so we hide it
 * from public search but leave it in the DB — owner sees it in /my-rentals
 * and can either re-publish (resnap) or delist.
 *
 * Fail-open semantics: if the in-memory devices map is unavailable (early
 * boot, test harness), skip the filter and return all listings unchanged.
 * The DB-level snapshot still records bound_rebind_count, so retroactive
 * filtering works once the map is wired in.
 */
function filterDriftedListings(listings, devicesMap) {
    if (!Array.isArray(listings)) return listings;
    if (!devicesMap || typeof devicesMap !== 'object') return listings;
    return listings.filter((l) => {
        const dev = devicesMap[l.owner_device_id];
        const ent = dev?.entities?.[l.owner_entity_id];
        if (!ent) return false; // entity slot vanished → definitely drifted
        const liveCount = Number.isInteger(ent.rebindCount) ? ent.rebindCount : 0;
        const boundCount = Number.isFinite(Number(l.bound_rebind_count))
            ? Number(l.bound_rebind_count) : 0;
        return liveCount === boundCount;
    });
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
                    status, interview_passed, soft_pause_until, soft_pause_reason
             FROM bot_listings WHERE id = $1 FOR UPDATE`,
            [listingId]
        );
        if (listingRes.rowCount === 0) throw new Error('listing_not_found');
        const listing = listingRes.rows[0];
        if (listing.status !== 'listed') throw new Error('listing_not_available');
        if (!listing.interview_passed) throw new Error('interview_not_passed');
        if (isListingSoftPaused(listing)) throw buildListingSoftPausedError(listing);
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
        const contractId = newContractId();
        const contractRes = await client.query(
            `INSERT INTO rental_contracts
                (id, listing_id, owner_user_id, renter_user_id, renter_device_id,
                 rate_mli_per_ktoken_snapshot, deposit_mli,
                 planned_duration_min, total_duration_sec, started_at, ends_at, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW() + make_interval(mins => $8), 'active')
             RETURNING id, status, started_at, ends_at, deposit_mli, total_duration_sec`,
            [contractId, listingId, listing.owner_user_id, renterUserId, renterDeviceId,
             rateSnapshot, depositMli, durationMinutes, durationMinutes * 60]
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
    // BUG-D1: Copy the owner's avatar so rental entity displays correctly on dashboard
    // Fallback to owner entity's avatar if listing has none
    let rentalAvatar = listing.avatar_url || null;
    if (!rentalAvatar && devices) {
        const ownerEnt = devices[listing.owner_device_id]?.entities?.[listing.owner_entity_id];
        if (ownerEnt?.avatar) rentalAvatar = ownerEnt.avatar;
    }
    entity.avatar = rentalAvatar;
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
async function removeRentalEntity(devices, { renterDeviceId, contractId }, helpers) {
    const device = devices[renterDeviceId];
    if (!device) return;

    for (const [slotId, entity] of Object.entries(device.entities)) {
        if (entity.rental_contract_id === contractId) {
            // Persist to entity_trash BEFORE tombstoning publicCode so that
            // loadTombstonesFromTrash() can reseed the tombstone on restart.
            if (helpers?.saveToEntityTrash) {
                try { await helpers.saveToEntityTrash(renterDeviceId, parseInt(slotId), entity); }
                catch (_) { /* best-effort, continue */ }
            }
            // Clean up publicCode from global index (fires tombstone trap)
            if (entity.publicCode && helpers?.publicCodeIndex) {
                delete helpers.publicCodeIndex[entity.publicCode];
            }
            // BUG-D3: Delete the rental entity slot entirely instead of
            // resetting to unbound defaults. Resetting left a ghost entity
            // visible on the renter's dashboard after contract end.
            delete device.entities[slotId];
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

/**
 * Reconcile rental entities on server startup.
 * Four phases handle both cleanup AND restoration:
 *   Phase 1: Remove renter entities whose contracts have ended (ghost cleanup)
 *   Phase 2: Remove legacy ghost entities without rental metadata (title matching)
 *   Phase 3: Clear stale leased_out on owner entities
 *   Phase 4: Restore missing renter entities for active contracts (handover recovery)
 */
async function reconcileRentalEntities(devices, helpers) {
    const result = { reconciled: 0, errors: [] };
    const ACTIVE = ['reserved', 'active', 'suspended_insufficient_funds'];

    // ── Phase 1: Reconcile RENTER entities (delete if contract ended,
    //              backfill rental_status='leased_in' if contract active) ──
    // CRITICAL: this phase must NOT delete owner-side entities. Before taking
    // any action, we identify ownership by joining the contract to its listing
    // — if the entity lives on the contract's renter_device_id and the slot
    // has rental proxy signals, it's a renter entity. Owner entities (on the
    // listing's owner_device_id at owner_entity_id) must only have their
    // status cleared (Phase 3), never deleted — losing an owner entity
    // destroys the user's bot slot (identity, channel binding, chat history).
    for (const [deviceId, device] of Object.entries(devices)) {
        if (!device?.entities) continue;
        for (const [slotId, entity] of Object.entries(device.entities)) {
            // Hard guard: owner-side leased_out entity — never touched here.
            if (entity.rental_status === 'leased_out') continue;

            let contractId = entity.rental_contract_id;
            const hasRentalProxyWebhook = entity.webhook?.url?.startsWith('__rental_proxy__:');
            if (!contractId && hasRentalProxyWebhook) {
                contractId = entity.webhook.url.split(':').slice(1).join(':');
                entity.rental_contract_id = contractId;
            }
            if (!contractId && entity.rental_status !== 'leased_in') continue;
            if (!contractId) continue;

            try {
                // Resolve contract + owner info so we can distinguish owner
                // entities (which happen to still have rental_contract_id set
                // from stale persistence) from true renter entities.
                const res = await pool.query(
                    `SELECT c.status, c.renter_device_id, l.owner_device_id, l.owner_entity_id
                     FROM rental_contracts c
                     LEFT JOIN bot_listings l ON l.id = c.listing_id
                     WHERE c.id = $1`,
                    [contractId]
                );
                const row = res.rows[0] || {};
                const status = row.status;
                // If this entity is the contract's owner entity, do NOT treat
                // it as a renter entity here — leave it to Phase 3.
                const isOwnerSlot = row.owner_device_id === deviceId
                    && Number(row.owner_entity_id) === Number(slotId);
                if (isOwnerSlot) continue;

                if (!status || !ACTIVE.includes(status)) {
                    if (helpers?.saveToEntityTrash) {
                        try { await helpers.saveToEntityTrash(deviceId, parseInt(slotId), entity); }
                        catch (_) { /* best-effort */ }
                    }
                    if (entity.publicCode && helpers?.publicCodeIndex) delete helpers.publicCodeIndex[entity.publicCode];
                    delete device.entities[slotId];
                    result.reconciled++;
                    if (helpers?.saveDeviceData) await helpers.saveDeviceData(deviceId, device);
                } else if (!entity.rental_status) {
                    entity.rental_status = 'leased_in';
                    if (helpers?.saveDeviceData) await helpers.saveDeviceData(deviceId, device);
                }
            } catch (e) { result.errors.push(`p1:${deviceId}/${slotId}:${e.message}`); }
        }
    }

    // ── Phase 2: Remove legacy ghost entities (no rental metadata, match by title) ──
    try {
        const activeTitles = new Set();
        const activeRes = await pool.query(
            `SELECT bl.title FROM rental_contracts c JOIN bot_listings bl ON bl.id = c.listing_id WHERE c.status IN ('reserved','active','suspended_insufficient_funds')`
        );
        for (const r of activeRes.rows) activeTitles.add(r.title);
        const allTitles = new Set();
        const allRes = await pool.query(`SELECT DISTINCT title FROM bot_listings`);
        for (const r of allRes.rows) allTitles.add(r.title);
        for (const [deviceId, device] of Object.entries(devices)) {
            if (!device?.entities) continue;
            for (const [slotId, entity] of Object.entries(device.entities)) {
                if (!entity.isBound || entity.rental_contract_id || entity.rental_status) continue;
                const name = entity.name || entity.character || '';
                if (!allTitles.has(name) || activeTitles.has(name)) continue;
                if (helpers?.saveToEntityTrash) {
                    try { await helpers.saveToEntityTrash(deviceId, parseInt(slotId), entity); }
                    catch (_) { /* best-effort */ }
                }
                if (entity.publicCode && helpers?.publicCodeIndex) delete helpers.publicCodeIndex[entity.publicCode];
                delete device.entities[slotId];
                result.reconciled++;
                if (helpers?.saveDeviceData) await helpers.saveDeviceData(deviceId, device);
            }
        }
    } catch (e) { result.errors.push(`p2:${e.message}`); }

    // ── Phase 3: Clear stale leased_out on owner entities ──
    for (const [deviceId, device] of Object.entries(devices)) {
        if (!device?.entities) continue;
        for (const [slotId, entity] of Object.entries(device.entities)) {
            if (entity.rental_status !== 'leased_out' || !entity.rental_contract_id) continue;
            try {
                const res = await pool.query(`SELECT status FROM rental_contracts WHERE id = $1`, [entity.rental_contract_id]);
                const status = res.rows[0]?.status;
                if (!status || !ACTIVE.includes(status)) {
                    entity.rental_status = null;
                    entity.rental_contract_id = null;
                    if (helpers?.saveDeviceData) await helpers.saveDeviceData(deviceId, device);
                    result.reconciled++;
                }
            } catch (e) { result.errors.push(`p3:${deviceId}/${slotId}:${e.message}`); }
        }
    }

    // ── Phase 4: Restore missing renter entities for active contracts ──
    try {
        const activeContracts = await pool.query(
            `SELECT c.id, c.renter_device_id, c.listing_id, c.rate_mli_per_ktoken_snapshot
             FROM rental_contracts c WHERE c.status IN ('active','reserved','suspended_insufficient_funds')`
        );
        for (const row of activeContracts.rows) {
            try {
                if (!devices[row.renter_device_id]) {
                    if (helpers?.getOrCreateDevice) helpers.getOrCreateDevice(row.renter_device_id);
                    else { result.errors.push(`p4:device_missing:${row.renter_device_id}`); continue; }
                }
                const device = devices[row.renter_device_id];
                const exists = Object.values(device.entities).some(e => e?.rental_contract_id === row.id && e.isBound);
                if (!exists) {
                    const listing = await getListing(row.listing_id);
                    if (!listing) { result.errors.push(`p4:listing_missing:${row.listing_id}`); continue; }
                    insertRentalEntity(devices, {
                        renterDeviceId: row.renter_device_id, contractId: row.id,
                        listing, rateMliPerKtoken: Number(row.rate_mli_per_ktoken_snapshot),
                    }, helpers);
                    if (helpers?.saveDeviceData) await helpers.saveDeviceData(row.renter_device_id, device);
                    result.reconciled++;
                }
                // Ensure owner entity is marked leased_out
                const listing = await getListing(row.listing_id);
                if (listing) {
                    markOwnerEntityLeasedOut(devices, {
                        ownerDeviceId: listing.owner_device_id,
                        ownerEntityId: listing.owner_entity_id, contractId: row.id,
                    });
                }
            } catch (e) { result.errors.push(`p4:contract_${row.id}:${e.message}`); }
        }
    } catch (e) { result.errors.push(`p4:query:${e.message}`); }

    return result;
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

// NOTE: reconcileRentalEntities is defined above (line ~1015) with all 4 phases merged.
// The duplicate that was here (#1713) has been removed to fix Jest SyntaxError.

// ============================================
// Express factory
// ============================================

module.exports = function rentalFactory({ authMiddleware, softAuthMiddleware, adminMiddleware, walletModule, serverLog } = {}) {
    if (typeof authMiddleware !== 'function') {
        throw new Error('rental: authMiddleware is required');
    }
    if (!walletModule || typeof walletModule.withTransaction !== 'function') {
        throw new Error('rental: walletModule is required');
    }
    const router = express.Router();
    const audit = serverLog || (() => {});
    const optionalAuthMiddleware = typeof softAuthMiddleware === 'function'
        ? softAuthMiddleware
        : (_req, _res, next) => next();

    const INPUT_ERROR_RE = /^(?:[a-z][a-z0-9_]*_(?:invalid|required|forbidden|not_found)|publish_failed|interview_not_passed|no_fields_to_update|duration_too_(?:short|long)|duration_(?:below|above)_listing_(?:min|max)|listing_not_available|listing_already_rented|self_rental_forbidden|insufficient_balance_for_rental|contract_already_ended|contract_end_forbidden|interview_rate_limited|interview_already_running|owner_device_not_found|owner_entity_not_bound|owner_entity_no_webhook|listing_status_invalid_for_interview|cooldown_active|duplicate_listing)$/;

    function rentalRoute(fn) {
        return async (req, res) => {
            try {
                if (!req.user || !req.user.userId) {
                    return res.status(401).json({ success: false, error: 'unauthenticated' });
                }
                await fn(req, res);
            } catch (err) {
                if (err.message === 'listing_soft_paused' || err.code === 'LISTING_SOFT_PAUSED') {
                    return res.status(503).json({
                        success: false,
                        error: 'listing_soft_paused',
                        code: 'LISTING_SOFT_PAUSED',
                        resumeEta: err.resumeEta || null,
                        reason: err.reason || LISTING_SOFT_PAUSE_REASON_HEALTH_DEGRADED,
                    });
                }
                if (INPUT_ERROR_RE.test(err.message)) {
                    const code = /forbidden/.test(err.message) ? 403
                               : /not_found/.test(err.message) ? 404
                               : 400;
                    const body = { success: false, error: err.message };
                    if (err.existingListingId) body.existing_listing_id = err.existingListingId;
                    if (err.existingStatus) body.existing_status = err.existingStatus;
                    if (err.cooldownUntil) body.cooldown_until = err.cooldownUntil;
                    if (err.details) body.details = err.details;
                    return res.status(code).json(body);
                }
                console.error('[Rental] handler error:', err);
                // P0 card_68242d883b51c3b6ceda09cb: surface Pg-level details to
                // audit log so internal_error responses can be diagnosed from
                // /api/logs?category=rental&level=error without Railway stdout.
                try {
                    audit('error', 'rental', `handler error ${req.method} ${req.originalUrl || req.path}: ${err.message || 'unknown'}`, {
                        userId: req.user?.userId,
                        action: 'handler_error',
                        resource: req.originalUrl || req.path,
                        result: 'failure',
                        metadata: {
                            errMessage: err.message || null,
                            errCode: err.code || null,
                            errConstraint: err.constraint || null,
                            errDetail: err.detail || null,
                            errTable: err.table || null,
                            errColumn: err.column || null,
                            errRoutine: err.routine || null,
                            errStackHead: (err.stack || '').split('\n').slice(0, 3).join(' | '),
                        },
                    });
                } catch (_) { /* never let audit failure cascade */ }
                res.status(500).json({ success: false, error: 'internal_error' });
            }
        };
    }

    async function diagnoseStartRentalDryRun({ listingId, renterUserId, renterDeviceId, durationMinutes }) {
        const steps = [];
        const client = await pool.connect();
        let failedStep = null;

        const step = async (name, fn) => {
            failedStep = name;
            const value = await fn();
            steps.push({ name, ok: true });
            return value;
        };

        try {
            await client.query('BEGIN');

            const listing = await step('lock_listing', async () => {
                const listingRes = await client.query(
                    `SELECT id, owner_user_id, rate_mli_per_ktoken,
                            min_rental_minutes, max_rental_minutes,
                            status, interview_passed, soft_pause_until, soft_pause_reason
                       FROM bot_listings WHERE id = $1 FOR UPDATE`,
                    [listingId]
                );
                if (listingRes.rowCount === 0) throw new Error('listing_not_found');
                return listingRes.rows[0];
            });

            await step('validate_listing', async () => {
                if (listing.status !== 'listed') throw new Error('listing_not_available');
                if (!listing.interview_passed) throw new Error('interview_not_passed');
                if (isListingSoftPaused(listing)) throw buildListingSoftPausedError(listing);
                if (listing.owner_user_id === renterUserId) throw new Error('self_rental_forbidden');
                if (durationMinutes < listing.min_rental_minutes) throw new Error('duration_below_listing_min');
                if (durationMinutes > listing.max_rental_minutes) throw new Error('duration_above_listing_max');
            });

            await step('check_cooldown', async () => {
                const cooldownRes = await client.query(
                    `SELECT cooldown_until FROM rental_cooldowns
                       WHERE user_id = $1 AND listing_id = $2 AND cooldown_until > NOW()`,
                    [renterUserId, listingId]
                );
                if (cooldownRes.rowCount > 0) throw new Error('cooldown_active');
            });

            await step('check_active_contract', async () => {
                const activeRes = await client.query(
                    `SELECT id FROM rental_contracts
                       WHERE listing_id = $1
                         AND status IN ('reserved', 'active', 'suspended_insufficient_funds')`,
                    [listingId]
                );
                if (activeRes.rowCount > 0) throw new Error('listing_already_rented');
            });

            const rateSnapshot = Number(listing.rate_mli_per_ktoken);
            const depositMli = computeDepositMli(rateSnapshot);
            const bufferMli = rateSnapshot * 60;
            const requiredMli = depositMli + bufferMli;

            await step('check_wallet_balance', async () => {
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
            });

            const contractId = newContractId();
            const contract = await step('insert_contract', async () => {
                const contractRes = await client.query(
                    `INSERT INTO rental_contracts
                        (id, listing_id, owner_user_id, renter_user_id, renter_device_id,
                         rate_mli_per_ktoken_snapshot, deposit_mli,
                         planned_duration_min, total_duration_sec, started_at, ends_at, status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW() + make_interval(mins => $8), 'active')
                     RETURNING id, status, started_at, ends_at, deposit_mli, total_duration_sec`,
                    [contractId, listingId, listing.owner_user_id, renterUserId, renterDeviceId,
                     rateSnapshot, depositMli, durationMinutes, durationMinutes * 60]
                );
                return contractRes.rows[0];
            });

            await step('insert_snapshot', async () => {
                await client.query(
                    `INSERT INTO rental_snapshots
                        (contract_id, identity, rules, skills, webhook_url, allowed_vars)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [contract.id, null, null, null, null, '[]']
                );
            });

            await step('hold_deposit', async () => {
                await walletModule.applyLedgerEntry(client, {
                    userId: renterUserId,
                    balanceDelta: -depositMli,
                    heldDelta: depositMli,
                    type: walletModule.LEDGER_TYPES.DEPOSIT_HOLD,
                    refType: 'rental_contract',
                    refId: contract.id,
                    note: `dry-run rental deposit: ${listingId}`,
                    idempotencyKey: `rental-dry-run:${contract.id}`,
                });
            });

            await client.query('ROLLBACK');
            return { ok: true, steps, contractIdPreview: contract.id };
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch { /* ignore */ }
            steps.push({
                name: failedStep || 'unknown',
                ok: false,
                error: {
                    message: err.message,
                    code: err.code || null,
                    detail: err.detail || null,
                    constraint: err.constraint || null,
                    table: err.table || null,
                    column: err.column || null,
                    details: err.details || null,
                },
            });
            return { ok: false, failedStep: failedStep || 'unknown', steps };
        } finally {
            client.release();
        }
    }

    // POST /api/rental/listing — create a draft listing
    router.post('/listing', authMiddleware, rentalRoute(async (req, res) => {
        const { ownerDeviceId, ownerEntityId, title, description,
                rateMliPerKtoken, minRentalMinutes, maxRentalMinutes } = req.body || {};
        // BUG-M1: capture entity avatar for marketplace display
        let avatarUrl = null;
        // P0: snapshot rebindCount so we can detect identity drift after a rebind
        let boundRebindCount = 0;
        if (_interviewDeps?.devices && ownerDeviceId) {
            const dev = _interviewDeps.devices[ownerDeviceId];
            const ent = dev?.entities?.[ownerEntityId];
            if (ent?.avatar && (ent.avatar.startsWith('http') || ent.avatar.length <= 4)) {
                avatarUrl = ent.avatar;
            }
            if (ent && Number.isInteger(ent.rebindCount)) {
                boundRebindCount = ent.rebindCount;
            }
        }
        const listing = await createListing({
            ownerUserId: req.user.userId,
            ownerDeviceId, ownerEntityId, title, description, rateMliPerKtoken,
            minRentalMinutes, maxRentalMinutes, avatarUrl, boundRebindCount,
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

    // POST /api/rental/listing/:id/resume — owner-only manual soft-pause clear.
    router.post('/listing/:id/resume', authMiddleware, rentalRoute(async (req, res) => {
        const listing = await clearListingSoftPause(req.params.id, { ownerUserId: req.user.userId });
        audit('info', 'rental', `listing soft-pause resumed ${listing.id}`, {
            userId: req.user.userId, action: 'listing_resume', resource: listing.id,
        });
        res.json({ success: true, listing });
    }));

    // DELETE /api/rental/listing/:id — delist
    router.delete('/listing/:id', authMiddleware, rentalRoute(async (req, res) => {
        const listing = await delistListing(req.params.id, req.user.userId);
        res.json({ success: true, listing });
    }));

    // GET /api/rental/listing/:id — public view; owner fields are included only for the owner.
    router.get('/listing/:id', optionalAuthMiddleware, async (req, res) => {
        try {
            const listing = await getListing(req.params.id);
            if (!listing) return res.status(404).json({ success: false, error: 'listing_not_found' });
            serializeSoftPauseFields(listing);
            // BUG-M8: Match by userId OR deviceId (Device-login has userId=null)
            const isOwner = req.user && (
                (req.user.userId && listing.owner_user_id === req.user.userId) ||
                (req.user.deviceId && listing.owner_device_id === req.user.deviceId)
            );
            if (!isOwner) {
                delete listing.owner_user_id;
            }
            // Availability: check for active contract
            const acRes = await pool.query(
                `SELECT id FROM rental_contracts WHERE listing_id = $1 AND status LIKE 'active%' LIMIT 1`,
                [listing.id]
            );
            listing.has_active_contract = acRes.rows.length > 0;
            // Interview score from latest completed exam
            const ivRes = await pool.query(
                `SELECT total_score, max_score FROM arena_exams
                 WHERE listing_id = $1 AND status = 'completed'
                 ORDER BY created_at DESC LIMIT 1`,
                [listing.id]
            );
            if (ivRes.rows.length > 0) {
                listing.interview_score = parseInt(ivRes.rows[0].total_score, 10) || 0;
                listing.interview_max_score = parseInt(ivRes.rows[0].max_score, 10) || 0;
            }
            res.json({ success: true, listing });
        } catch (err) {
            console.error('[Rental] /listing/:id error:', err);
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // GET /api/rental/my-listings — owner's own listings
    router.get('/my-listings', authMiddleware, rentalRoute(async (req, res) => {
        const listings = await listMyListings(req.user.userId);
        // Enrich with current entity display info (name/character/avatar) so
        // the portal "我的上架" tab can show the bot the listing currently
        // points at — this drifts after a rebind, which is exactly why this
        // tab lives outside the agent card.
        const devices = _interviewDeps?.devices;
        if (devices) {
            for (const l of listings) {
                const ent = devices[l.owner_device_id]?.entities?.[l.owner_entity_id];
                if (ent) {
                    l.entity_name = ent.name || null;
                    l.entity_character = ent.character || null;
                    l.entity_is_bound = !!ent.isBound;
                }
            }
        }
        res.json({ success: true, listings });
    }));

    // POST /api/rental/contract (and legacy alias /create) — start a new rental.
    async function createRentalContractHandler(req, res) {
        const { listingId, renterDeviceId, durationMinutes } = req.body || {};
        const contract = await startRental({
            listingId,
            renterUserId: req.user.userId,
            renterDeviceId,
            durationMinutes: parseInt(durationMinutes, 10),
        }, walletModule);

        // P2-F Entity Handover: create rental entity on renter's device
        // and mark the owner's entity as leased out.
        if (_interviewDeps && _interviewDeps.devices) {
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
    }
    router.post('/contract', authMiddleware, rentalRoute(createRentalContractHandler));
    router.post('/create', authMiddleware, rentalRoute(createRentalContractHandler));

    // Shared post-endRental cleanup: removes renter entity + clears owner
    // leased_out status + persists both. Called by both the HTTP handler and
    // the cron (rental-proxy.expireContracts / expireGracePeriods) so that
    // cron-expired contracts don't leave stale owner leased_out state (which
    // Phase 1 reconcile could then mis-interpret and delete the owner's entity).
    async function runContractCleanup(contractId, auditCtx = {}) {
        if (!_interviewDeps || !_interviewDeps.devices) return;
        try {
            const cRow = await pool.query(
                `SELECT c.renter_device_id, c.listing_id,
                        l.owner_device_id, l.owner_entity_id
                 FROM rental_contracts c
                 JOIN bot_listings l ON l.id = c.listing_id
                 WHERE c.id = $1`,
                [contractId]
            );
            if (cRow.rowCount === 0) return;
            const info = cRow.rows[0];
            await removeRentalEntity(_interviewDeps.devices, {
                renterDeviceId: info.renter_device_id,
                contractId,
            }, {
                publicCodeIndex: _interviewDeps.publicCodeIndex,
                saveToEntityTrash: _interviewDeps.saveToEntityTrash,
            });
            clearOwnerEntityLeasedOut(_interviewDeps.devices, {
                ownerDeviceId: info.owner_device_id,
                ownerEntityId: info.owner_entity_id,
            });
            audit('info', 'rental', `entity handover cleanup: ${info.renter_device_id}`, {
                ...auditCtx, action: 'rental_entity_remove', resource: contractId,
            });

            if (_interviewDeps.saveDeviceData) {
                if (_interviewDeps.devices[info.renter_device_id]) {
                    await _interviewDeps.saveDeviceData(info.renter_device_id, _interviewDeps.devices[info.renter_device_id]);
                }
                if (_interviewDeps.devices[info.owner_device_id]) {
                    await _interviewDeps.saveDeviceData(info.owner_device_id, _interviewDeps.devices[info.owner_device_id]);
                }
            }
        } catch (cleanupErr) {
            console.error('[Rental] runContractCleanup error:', cleanupErr.message);
            audit('error', 'rental', `contract cleanup failed: ${cleanupErr.message}`, {
                ...auditCtx, action: 'rental_entity_remove_fail', resource: contractId,
            });
        }
    }

    // POST /api/rental/contract/:id/end — end a contract (by renter or owner)
    router.post('/contract/:id/end', authMiddleware, rentalRoute(async (req, res) => {
        const { endReason } = req.body || {};
        const contract = await endRental({
            contractId: req.params.id,
            endReason: endReason || CONTRACT_STATUSES.ENDED_NORMAL,
            requesterUserId: req.user.userId,
        }, walletModule);

        await runContractCleanup(contract.id, { userId: req.user.userId });

        audit('info', 'rental', `contract ended ${contract.id} reason=${contract.end_reason}`, {
            userId: req.user.userId, action: 'contract_end', resource: contract.id, result: contract.end_reason,
        });
        res.json({ success: true, contract });
    }));


    // GET /api/rental/health-status?ownerEntityId=N
    // UI/state hook for renter health indicator. The daily probe writer lives in
    // card_a3aface0; until it is unblocked, this endpoint derives active rental
    // rows and supports an explicit mock status for UI/E2E wiring.
    router.get('/health-status', authMiddleware, rentalRoute(async (req, res) => {
        const ownerEntityId = req.query.ownerEntityId != null ? parseInt(req.query.ownerEntityId, 10) : null;
        if (req.query.ownerEntityId != null && !Number.isInteger(ownerEntityId)) {
            throw new Error('owner_entity_id_invalid');
        }

        const mockStatusRaw = String(req.query.mockStatus || req.query.mock || process.env.ECLAW_RENTAL_HEALTH_MOCK || '').toLowerCase();
        const mockStatus = ['ok', 'degraded', 'down', 'recovered'].includes(mockStatusRaw) ? mockStatusRaw : null;
        const mockKind = mockStatus === 'down' ? 'engine_crash_loop'
            : mockStatus === 'recovered' || mockStatus === 'ok' ? 'recovered'
            : 'response_timeout';
        const normalizedMockStatus = mockStatus === 'recovered' ? 'ok' : (mockStatus || 'ok');

        const params = [req.user.userId];
        let ownerClause = '';
        if (ownerEntityId !== null) {
            params.push(ownerEntityId);
            ownerClause = `AND l.owner_entity_id = $${params.length}`;
        }

        const result = await pool.query(
            `SELECT c.id AS rental_id,
                    c.listing_id,
                    c.renter_device_id,
                    c.renter_entity_slot,
                    c.status AS contract_status,
                    c.started_at,
                    c.created_at,
                    l.owner_device_id,
                    l.owner_entity_id,
                    l.title AS renter_name
               FROM rental_contracts c
               JOIN bot_listings l ON l.id = c.listing_id
              WHERE c.owner_user_id = $1
                AND c.status IN ('reserved', 'active', 'suspended_insufficient_funds')
                ${ownerClause}
              ORDER BY c.started_at DESC NULLS LAST, c.created_at DESC
              LIMIT 100`,
            params
        );

        const nowIso = new Date().toISOString();
        const shouldApplySoftPause = ['1', 'true', 'yes'].includes(String(req.query.applySoftPause || req.query.softPause || '').toLowerCase());
        const statuses = await Promise.all(result.rows.map(async (row) => {
            const renterEntityId = row.renter_entity_slot != null ? Number(row.renter_entity_slot) : null;
            const ownerSlot = Number(row.owner_entity_id);
            const entity = row.renter_device_id && renterEntityId != null
                ? _interviewDeps?.devices?.[row.renter_device_id]?.entities?.[renterEntityId]
                : null;
            const inferredDown = entity && (entity.state === 'ERROR' || /crash|timeout|unavailable|degraded/i.test(entity.message || ''));
            const status = mockStatus ? normalizedMockStatus : (inferredDown ? 'degraded' : 'ok');
            const eventKind = mockStatus ? mockKind : (inferredDown ? 'response_timeout' : 'ok');
            const msg = status === 'ok'
                ? `${row.renter_name || 'Renter'} health probe recovered / OK`
                : `${row.renter_name || 'Renter'} recent 1hr response timeout x3`;
            let listingSoftPause = null;
            if (shouldApplySoftPause && row.listing_id) {
                try {
                    const degradedSince = req.query.degradedSince
                        || (req.query.degradedMinutes ? new Date(Date.now() - (parseInt(req.query.degradedMinutes, 10) || 0) * 60 * 1000).toISOString() : null);
                    listingSoftPause = await recordListingHealthSample({
                        listingId: row.listing_id,
                        status,
                        reason: req.query.reason || LISTING_SOFT_PAUSE_REASON_HEALTH_DEGRADED,
                        degradedSince,
                        okStreak: parseInt(req.query.okStreak || '0', 10) || 0,
                    });
                } catch (err) {
                    listingSoftPause = { changed: false, action: 'error', error: err.message };
                }
            }
            return {
                rentalId: row.rental_id,
                listingId: row.listing_id,
                ownerEntityId: ownerSlot,
                renterEntityId,
                renterName: row.renter_name || entity?.name || entity?.character || `Entity #${renterEntityId ?? ownerSlot}`,
                status,
                lastProbeAt: nowIso,
                listingSoftPause,
                recentEvents: [{
                    eventId: `${row.rental_id}:${eventKind}:${nowIso.slice(0, 16)}`,
                    kind: eventKind,
                    ts: nowIso,
                    msg,
                }],
            };
        }));

        // E2E/dev convenience: allow UI validation before a rental contract exists.
        if (statuses.length === 0 && mockStatus) {
            const fallbackEntityId = ownerEntityId ?? parseInt(req.query.renterEntityId || '0', 10);
            statuses.push({
                rentalId: 'mock_rental_health',
                ownerEntityId: Number.isInteger(fallbackEntityId) ? fallbackEntityId : null,
                renterEntityId: Number.isInteger(fallbackEntityId) ? fallbackEntityId : null,
                renterName: req.query.renterName || 'Mac_E',
                status: normalizedMockStatus,
                lastProbeAt: nowIso,
                recentEvents: [{
                    eventId: `mock_rental_health:${mockKind}:${nowIso.slice(0, 16)}`,
                    kind: mockKind,
                    ts: nowIso,
                    msg: normalizedMockStatus === 'ok'
                        ? 'Mac_E health probe recovered / OK'
                        : 'Mac_E recent 1hr response timeout x3',
                }],
            });
        }

        res.json({ success: true, statuses });
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
            // P0 Phase 2: hide listings whose entity slot has been rebound since
            // the listing was created (silent identity drift). Owner still sees
            // them in /my-rentals so they can re-publish or delist explicitly.
            const filtered = filterDriftedListings(listings, _interviewDeps?.devices);
            const devicesMap = _interviewDeps?.devices;
            const enriched = filtered.map((l) => {
                const ent = devicesMap?.[l.owner_device_id]?.entities?.[l.owner_entity_id];
                return ent?.publicCode ? { ...l, owner_public_code: ent.publicCode } : l;
            });
            res.json({ success: true, listings: enriched });
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
        if (!devRes.rows.length || !safeEqual(devRes.rows[0].device_secret, deviceSecret)) {
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

    // ── Debug: ghost entity cleanup (BUG-D3) ──
    router.post('/debug/cleanup-ghosts', authMiddleware, async (req, res) => { try {
        const deviceId = req.user?.deviceId || req.body?.deviceId;
        if (!deviceId) return res.json({ success: false, error: 'deviceId required' });
        const dev = _interviewDeps.devices?.[deviceId];
        if (!dev) return res.status(404).json({ success: false, error: 'device_not_found' });
        // Find all listing titles (active and inactive)
        const allTitles = new Set();
        const activeTitles = new Set();
        const allRes = await pool.query(`SELECT DISTINCT title FROM bot_listings`);
        for (const r of allRes.rows) allTitles.add(r.title);
        const activeRes = await pool.query(
            `SELECT bl.title FROM rental_contracts c JOIN bot_listings bl ON bl.id = c.listing_id
             WHERE c.status IN ('reserved','active','suspended_insufficient_funds')`
        );
        for (const r of activeRes.rows) activeTitles.add(r.title);
        const removed = [];
        const kept = [];
        for (const [slotId, entity] of Object.entries(dev.entities)) {
            if (!entity.isBound) continue;
            const name = entity.name || entity.character || '';
            const isRental = entity.rental_status || entity.rental_contract_id ||
                entity.webhook?.url?.startsWith('__rental_proxy__') || allTitles.has(name);
            if (!isRental) continue;
            if (activeTitles.has(name)) { kept.push({ slot: slotId, name, reason: 'active_contract' }); continue; }
            if (_interviewDeps.saveToEntityTrash) {
                try { await _interviewDeps.saveToEntityTrash(deviceId, parseInt(slotId), entity); }
                catch (_) { /* best-effort */ }
            }
            if (entity.publicCode && _interviewDeps.publicCodeIndex) delete _interviewDeps.publicCodeIndex[entity.publicCode];
            delete dev.entities[slotId];
            removed.push({ slot: slotId, name });
        }
        if (removed.length > 0 && _interviewDeps.saveDeviceData) {
            await _interviewDeps.saveDeviceData(deviceId, dev);
        }
        res.json({ success: true, removed, kept, allTitles: [...allTitles], activeTitles: [...activeTitles] });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); } });

    // ── Debug: clear cooldowns for E2E testing ──
    router.post('/debug/clear-cooldown', authMiddleware, async (req, res) => { try {
        const userId = req.user?.userId;
        if (!userId) return res.status(400).json({ success: false, error: 'userId required (use email login)' });
        const result = await pool.query(`DELETE FROM rental_cooldowns WHERE user_id = $1`, [userId]);
        res.json({ success: true, cleared: result.rowCount });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); } });

    // ── Debug: contract-start-fail (#2263) (DO NOT REMOVE until user confirms fix) ──
    router.get('/debug/contract-start-fail', async (req, res) => { try {
        const { deviceId, deviceSecret, listingId, renterDeviceId } = req.query;
        const durationMinutes = parseInt(req.query.durationMinutes || '30', 10);
        if (!deviceId || !deviceSecret) {
            return res.json({ success: false, error: 'deviceId and deviceSecret required' });
        }
        if (!listingId || !renterDeviceId) {
            return res.json({ success: false, error: 'listingId and renterDeviceId required' });
        }
        const devRes = await pool.query(
            'SELECT device_id, device_secret FROM devices WHERE device_id = $1',
            [deviceId]
        );
        if (!devRes.rows.length || !safeEqual(devRes.rows[0].device_secret, deviceSecret)) {
            return res.json({ success: false, error: 'auth_failed' });
        }

        const requesterUserRes = await pool.query(
            'SELECT id, email, device_id FROM user_accounts WHERE device_id = $1',
            [deviceId]
        );
        const renterUserRes = await pool.query(
            'SELECT id, email, device_id FROM user_accounts WHERE device_id = $1',
            [renterDeviceId]
        );
        const listingRes = await pool.query(
            `SELECT id, owner_user_id, owner_device_id, owner_entity_id,
                    title, status, interview_passed, rate_mli_per_ktoken,
                    min_rental_minutes, max_rental_minutes, updated_at
             FROM bot_listings WHERE id = $1`,
            [listingId]
        );

        const listing = listingRes.rows[0] || null;
        const renterUser = renterUserRes.rows[0] || null;
        let cooldownRows = [];
        let activeContractRows = [];
        let walletRow = null;
        let renterEntityRows = [];
        let prediction = {
            deposit_mli: null,
            buffer_mli: null,
            required_mli: null,
            current_mli: null,
            affordable: null,
            predicted_error: null,
        };

        if (renterUser && listing) {
            const cooldownRes = await pool.query(
                `SELECT cooldown_until FROM rental_cooldowns
                 WHERE user_id = $1 AND listing_id = $2 AND cooldown_until > NOW()`,
                [renterUser.id, listingId]
            );
            cooldownRows = cooldownRes.rows;

            const activeRes = await pool.query(
                `SELECT id, status, started_at, ends_at
                 FROM rental_contracts
                 WHERE listing_id = $1
                   AND status IN ('reserved', 'active', 'suspended_insufficient_funds')
                 ORDER BY started_at DESC NULLS LAST LIMIT 10`,
                [listingId]
            );
            activeContractRows = activeRes.rows;

            const walletRes = await pool.query(
                'SELECT balance_mli, held_mli FROM wallets WHERE user_id = $1',
                [renterUser.id]
            );
            walletRow = walletRes.rows[0] || null;

            const entitiesRes = await pool.query(
                'SELECT entity_id, is_bound, character, webhook FROM entities WHERE device_id = $1 ORDER BY entity_id ASC',
                [renterDeviceId]
            );
            renterEntityRows = entitiesRes.rows;

            const rateSnapshot = Number(listing.rate_mli_per_ktoken || 0);
            const depositMli = computeDepositMli(rateSnapshot);
            const bufferMli = rateSnapshot * 60;
            const requiredMli = depositMli + bufferMli;
            const currentMli = BigInt(walletRow?.balance_mli || 0);
            let predictedError = null;
            if (listing.status !== 'listed') predictedError = 'listing_not_available';
            else if (!listing.interview_passed) predictedError = 'interview_not_passed';
            else if (listing.owner_user_id === renterUser.id) predictedError = 'self_rental_forbidden';
            else if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) predictedError = 'duration_minutes_invalid';
            else if (durationMinutes < MIN_RENTAL_MINUTES) predictedError = 'duration_too_short';
            else if (durationMinutes > MAX_RENTAL_MINUTES) predictedError = 'duration_too_long';
            else if (durationMinutes < Number(listing.min_rental_minutes)) predictedError = 'duration_below_listing_min';
            else if (durationMinutes > Number(listing.max_rental_minutes)) predictedError = 'duration_above_listing_max';
            else if (cooldownRows.length > 0) predictedError = 'cooldown_active';
            else if (activeContractRows.length > 0) predictedError = 'listing_already_rented';
            else if (currentMli < BigInt(requiredMli)) predictedError = 'insufficient_balance_for_rental';

            prediction = {
                deposit_mli: String(depositMli),
                buffer_mli: String(bufferMli),
                required_mli: String(requiredMli),
                current_mli: String(currentMli),
                affordable: currentMli >= BigInt(requiredMli),
                predicted_error: predictedError,
            };
        } else if (!listing) {
            prediction.predicted_error = 'listing_not_found';
        } else if (!renterUser) {
            prediction.predicted_error = 'renter_user_not_found';
        }

        const ownerMemoryDevice = listing ? _interviewDeps.devices?.[listing.owner_device_id] : null;
        const ownerMemoryEntity = ownerMemoryDevice && listing
            ? ownerMemoryDevice.entities?.[listing.owner_entity_id]
            : null;
        const renterMemoryDevice = _interviewDeps.devices?.[renterDeviceId] || null;
        const dryRunStart = renterUser && listing
            ? await diagnoseStartRentalDryRun({
                listingId,
                renterUserId: renterUser.id,
                renterDeviceId,
                durationMinutes,
            })
            : null;

        res.json({
            success: true,
            bug: 'contract-start-fail',
            diagnostics: {
                requester: {
                    device_id: requesterUserRes.rows[0]?.device_id || null,
                    user_id: requesterUserRes.rows[0]?.id || null,
                    email: requesterUserRes.rows[0]?.email || null,
                },
                renter: renterUser ? {
                    device_id: renterUser.device_id,
                    user_id: renterUser.id,
                    email: renterUser.email,
                } : null,
                listing: listing ? {
                    id: listing.id,
                    owner_user_id: listing.owner_user_id,
                    owner_device_id: listing.owner_device_id,
                    owner_entity_id: listing.owner_entity_id,
                    title: listing.title,
                    status: listing.status,
                    interview_passed: listing.interview_passed,
                    rate_mli_per_ktoken: listing.rate_mli_per_ktoken,
                    min_rental_minutes: listing.min_rental_minutes,
                    max_rental_minutes: listing.max_rental_minutes,
                    updated_at: listing.updated_at,
                } : null,
                requested: { listingId, renterDeviceId, durationMinutes },
                economics: prediction,
                cooldowns: cooldownRows,
                activeContracts: activeContractRows,
                renterWallet: walletRow ? {
                    balance_mli: String(walletRow.balance_mli),
                    held_mli: String(walletRow.held_mli),
                } : null,
                dryRunStart,
                renterDbEntities: renterEntityRows.map(r => ({
                    entity_id: r.entity_id,
                    is_bound: r.is_bound,
                    character: r.character,
                    webhook: r.webhook ? 'set' : 'null',
                })),
                memory: {
                    hasInterviewDeps: !!_interviewDeps.devices,
                    ownerDeviceInMemory: !!ownerMemoryDevice,
                    renterDeviceInMemory: !!renterMemoryDevice,
                    ownerEntity: ownerMemoryEntity ? {
                        isBound: !!ownerMemoryEntity.isBound,
                        character: ownerMemoryEntity.character || null,
                        name: ownerMemoryEntity.name || null,
                        rental_status: ownerMemoryEntity.rental_status || null,
                        rental_contract_id: ownerMemoryEntity.rental_contract_id || null,
                        hasWebhook: !!ownerMemoryEntity.webhook,
                        bindingType: ownerMemoryEntity.bindingType || 'webhook',
                        channelAccountId: ownerMemoryEntity.channelAccountId || null,
                    } : null,
                },
            },
            timestamp: new Date().toISOString(),
        });
    } catch (err) {
        console.error('[Rental] /debug/contract-start-fail error:', err);
        res.status(500).json({ success: false, error: err.message });
    } });

    // ── Debug: interview-start-fail (DO NOT REMOVE until user confirms fix) ──
    router.get('/debug/interview-start-fail', async (req, res) => { try {
        const { deviceId, deviceSecret } = req.query;
        if (!deviceId || !deviceSecret) {
            return res.json({ success: false, error: 'deviceId and deviceSecret required' });
        }
        const devRes = await pool.query(
            'SELECT device_id, device_secret FROM devices WHERE device_id = $1', [deviceId]
        );
        if (!devRes.rows.length || !safeEqual(devRes.rows[0].device_secret, deviceSecret)) {
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

        // V6 fix: block interview if listing has active contracts
        const activeContractCheck = await pool.query(
            `SELECT id FROM rental_contracts
             WHERE listing_id = $1 AND status IN ('active','reserved','suspended_insufficient_funds')
             LIMIT 1`,
            [listing.id]
        );
        if (activeContractCheck.rowCount > 0) {
            throw new Error('interview_blocked_active_contract');
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
        if (!_interviewDeps || !_interviewDeps.pushToBot || !_interviewDeps.devices) {
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
        pauseListingsOnRebind,
        terminateActiveContractsOnRebind,
        getListing,
        listMyListings,
        searchMarketplace,
        refreshPricingMarketSnapshots,
        filterDriftedListings,
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
        runContractCleanup,
        // Interview dispatch (late-bound)
        setInterviewDeps: (deps) => { _interviewDeps = deps; },
        // Helpers + constants
        isListingSoftPaused,
        serializeSoftPauseFields,
        softPauseListing,
        clearListingSoftPause,
        recordListingHealthSample,
        computeDepositMli,
        DEPOSIT_TOKEN_MULTIPLIER,
        MIN_RENTAL_MINUTES,
        MAX_RENTAL_MINUTES,
        INTERVIEW_PASS_SCORE,
        INTERVIEW_RATE_LIMIT,
        LISTING_SOFT_PAUSE_REASON_HEALTH_DEGRADED,
        LISTING_SOFT_PAUSE_DEFAULT_MINUTES,
        LISTING_HEALTH_DEGRADED_THRESHOLD_MS,
        LISTING_HEALTH_OK_RECOVERY_STREAK,
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

module.exports.isListingSoftPaused = isListingSoftPaused;
module.exports.refreshPricingMarketSnapshots = refreshPricingMarketSnapshots;
module.exports.LISTING_SOFT_PAUSE_REASON_HEALTH_DEGRADED = LISTING_SOFT_PAUSE_REASON_HEALTH_DEGRADED;
module.exports.LISTING_HEALTH_OK_RECOVERY_STREAK = LISTING_HEALTH_OK_RECOVERY_STREAK;
