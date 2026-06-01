/**
 * Wallet Module — e-coin primitives for the bot rental marketplace.
 *
 * Mounted at: /api/wallet
 *
 * Units: all amounts stored in 厘 (mli), where 1 e幣 = 1000 厘 (avoids
 * floating-point drift during fractional rental token charges).
 * Exchange: 1 TWD = 100 e幣 = 100,000 厘 (fixed, see USD_TO_MLI).
 *
 * Every mutation flows through `applyLedgerEntry`, which writes a
 * double-entry row to `wallet_ledger` and locks the wallet row with
 * `SELECT ... FOR UPDATE`. Each call must supply `idempotencyKey`;
 * duplicate keys silently dedupe and return the original entry.
 */
/* @brm-crossref: ①②③ Wallet + Top-up + Transaction Systems
 * Design doc: docs/plans/2026-04-10-bot-rental-marketplace-design.md
 * Roadmap:    /portal/roadmap.html
 * If this module is updated, also update the roadmap page status and the design doc §10 delivery tracker. */

const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

// ============================================
// Constants
// ============================================

/** 1 USD converts to 3,000,000 厘 (mli) = 3,000 e幣. */
const USD_TO_MLI = 3_000_000;

/** 1 e幣 = 1000 厘. */
const ECOIN_TO_MLI = 1000;

/** Platform commission in basis points (15% = 1500 bps). */
const PLATFORM_FEE_BPS = 1500;

/** Portion of platform fee routed to insurance pool (2% of transaction). */
const INSURANCE_POOL_BPS = 200;

/** Well-known virtual user UUIDs for platform-owned wallets. */
const PLATFORM_WALLET_USER_ID = '00000000-0000-0000-0000-000000000001';
const INSURANCE_POOL_USER_ID  = '00000000-0000-0000-0000-000000000002';

/** Google Play package name (must match the Android app's applicationId). */
const GOOGLE_PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE || 'com.hank.clawlive';
/** OAuth access-token cache TTL (conservative under Google's 3600s lifetime). */
const GOOGLE_TOKEN_CACHE_MS = 55 * 60 * 1000;
/** Google Play API scope — read + acknowledge purchases. */
const GOOGLE_ANDROIDPUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
/** OAuth token exchange endpoint. */
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** androidpublisher v3 REST API base. */
const GOOGLE_ANDROIDPUBLISHER_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

/**
 * All ledger type values. Keep in sync with wallet_schema.sql comment.
 * Exported so other modules can reference by name instead of hard-coding.
 */
const LEDGER_TYPES = Object.freeze({
    TOPUP:           'topup',
    RENTAL_INCOME:   'rental_income',
    RENTAL_SPEND:    'rental_spend',
    PLATFORM_FEE:    'platform_fee',
    DEPOSIT_HOLD:    'deposit_hold',
    DEPOSIT_RELEASE: 'deposit_release',
    DEPOSIT_FORFEIT: 'deposit_forfeit',
    REFERRAL_BONUS:          'referral_bonus',
    SIGNUP_BONUS:            'signup_bonus',
    SUBSCRIPTION_GRANT:     'subscription_grant',
    INVITE_FIRST_TOPUP_BONUS:'invite_first_topup_bonus',
    REFUND:                  'refund',
    ADMIN_ADJUST:            'admin_adjust',
    WITHDRAW:                'withdraw',
});

const ALLOWED_LEDGER_TYPES = new Set(Object.values(LEDGER_TYPES));

/**
 * Top-up tier catalog. Key is the Google Play / Apple IAP product ID,
 * value is the credit amount in 厘. Frozen so it cannot be mutated at
 * runtime — pricing changes require a code change + deploy.
 */
const TOPUP_TIERS = Object.freeze({
    'ec.topup.small': {
        priceUsd: 1,                              // $1
        baseMli: 1 * USD_TO_MLI,                  // 3,000 e幣
        bonusMli: 0,
    },
    'ec.topup.starter': {
        priceUsd: 3,                              // $3
        baseMli: 3 * USD_TO_MLI,                  // 9,000 e幣
        bonusMli: 450 * ECOIN_TO_MLI,             // +5% (450 e幣)
    },
    'ec.topup.standard': {
        priceUsd: 5,                              // $5
        baseMli: 5 * USD_TO_MLI,                  // 15,000 e幣
        bonusMli: 1200 * ECOIN_TO_MLI,            // +8%
    },
    'ec.topup.advanced': {
        priceUsd: 10,                             // $10
        baseMli: 10 * USD_TO_MLI,                 // 30,000 e幣
        bonusMli: 3600 * ECOIN_TO_MLI,            // +12%
    },
    'ec.topup.premium': {
        priceUsd: 20,                             // $20
        baseMli: 20 * USD_TO_MLI,                 // 60,000 e幣
        bonusMli: 9000 * ECOIN_TO_MLI,            // +15%
    },
});

function getTopupTier(productId) {
    return TOPUP_TIERS[productId] || null;
}

// ============================================
// Helpers
// ============================================

function usdToMli(usd) {
    if (!Number.isFinite(usd) || usd < 0) throw new Error('invalid_usd');
    return Math.round(usd) * USD_TO_MLI;
}

function ecoinToMli(ecoin) {
    if (!Number.isFinite(ecoin) || ecoin < 0) throw new Error('invalid_ecoin');
    return Math.round(ecoin * ECOIN_TO_MLI);
}

function mliToEcoin(mli) {
    return Number(mli) / ECOIN_TO_MLI;
}

function assertPositiveInt(name, value) {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name}_must_be_positive_integer`);
    }
}

function assertUuidLike(name, value) {
    if (typeof value !== 'string' || value.length < 16 || value.length > 64) {
        throw new Error(`${name}_invalid`);
    }
}

/** Looser check for external reference IDs (order IDs, contract IDs). */
function assertRefString(name, value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
        throw new Error(`${name}_invalid`);
    }
}

function assertIdempotencyKey(key) {
    if (typeof key !== 'string' || key.length < 4 || key.length > 128) {
        throw new Error('idempotency_key_invalid');
    }
}

function assertLedgerType(type) {
    if (!ALLOWED_LEDGER_TYPES.has(type)) {
        throw new Error(`unknown_ledger_type:${type}`);
    }
}

// ============================================
// Schema initialization (mirrors auth.js pattern)
// ============================================
async function initWalletDatabase() {
    try {
        const schemaPath = path.join(__dirname, 'wallet_schema.sql');
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
                    console.warn('[Wallet] Schema warning:', err.message);
                }
            }
        }
        // Seed virtual system users (platform + insurance) into user_accounts
        // so the FK constraint on wallets.user_id is satisfied.
        const virtualUsers = [
            { id: PLATFORM_WALLET_USER_ID, email: 'system+platform@eclawbot.com', deviceId: 'system-platform-wallet' },
            { id: INSURANCE_POOL_USER_ID,  email: 'system+insurance@eclawbot.com', deviceId: 'system-insurance-pool' },
        ];
        for (const vu of virtualUsers) {
            try {
                await pool.query(
                    `INSERT INTO user_accounts (id, email, password_hash, device_id, device_secret)
                     VALUES ($1, $2, 'SYSTEM_NO_LOGIN', $3, 'SYSTEM_NO_LOGIN')
                     ON CONFLICT (id) DO NOTHING`,
                    [vu.id, vu.email, vu.deviceId]
                );
            } catch (err) {
                // Ignore duplicate key on email/device_id unique constraints
                if (!err.message.includes('duplicate key') && !err.message.includes('already exists')) {
                    console.warn(`[Wallet] Virtual user ${vu.id} seed warning:`, err.message);
                }
            }
        }
        // Ensure wallet rows exist for virtual users
        for (const vu of virtualUsers) {
            try {
                await pool.query(
                    `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
                    [vu.id]
                );
            } catch (err) {
                if (!err.message.includes('duplicate key') && !err.message.includes('already exists')) {
                    console.warn(`[Wallet] Virtual wallet ${vu.id} seed warning:`, err.message);
                }
            }
        }

        console.log('[Wallet] Database initialized');

        const __gsa = _getServiceAccount();
        const __pkg = GOOGLE_PACKAGE_NAME;
        const __pkgFromEnv = !!process.env.GOOGLE_PLAY_PACKAGE;
        if (__gsa) {
            console.log(`[Wallet] Google Play IAP ready: package=${__pkg}${__pkgFromEnv ? '' : ' (default — set GOOGLE_PLAY_PACKAGE to silence)'} gsa_client_email=${__gsa.client_email}`);
        } else {
            const __raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
            const __reason = !__raw ? 'env unset' : (typeof __raw !== 'string' ? 'not a string' : 'malformed JSON or missing client_email/private_key');
            console.warn(`[Wallet] Google Play IAP DISABLED: GOOGLE_PLAY_SERVICE_ACCOUNT ${__reason}. /topup/verify-google will 402 unless GOOGLE_PLAY_ALLOW_UNVERIFIED=1.`);
        }
    } catch (error) {
        console.error('[Wallet] Failed to init database:', error);
    }
}

// ============================================
// Core transactional primitives
// ============================================

/**
 * Ensure a wallet row exists for the given user, inside an open transaction.
 * Uses ON CONFLICT DO NOTHING so concurrent inserts are safe.
 */
async function ensureWalletRow(client, userId) {
    await client.query(
        `INSERT INTO wallets (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
    );
}

/**
 * Apply an atomic balance + held delta to a wallet row and append a ledger
 * entry. Must be called inside a BEGIN/COMMIT — caller owns the client.
 *
 * Returns the inserted ledger row, or the existing row if the
 * idempotency_key was already consumed (in which case the wallet is NOT
 * mutated).
 */
async function applyLedgerEntry(client, {
    userId,
    balanceDelta,      // signed int in mli (can be 0 for pure held changes)
    heldDelta,         // signed int in mli (can be 0)
    type,
    refType = null,
    refId = null,
    counterpartyUserId = null,
    note = null,
    idempotencyKey,
}) {
    assertUuidLike('user_id', userId);
    assertLedgerType(type);
    assertIdempotencyKey(idempotencyKey);

    if (!Number.isInteger(balanceDelta) || !Number.isInteger(heldDelta)) {
        throw new Error('delta_must_be_integer');
    }

    // Idempotency: if this key was already used, return the existing row
    // without mutating the wallet. This makes retry-safe.
    const existing = await client.query(
        `SELECT id, user_id, delta_mli, held_delta_mli, balance_after_mli, held_after_mli,
                type, ref_type, ref_id, counterparty_user_id, note, created_at
         FROM wallet_ledger
         WHERE idempotency_key = $1`,
        [idempotencyKey]
    );
    if (existing.rowCount > 0) {
        return { ...existing.rows[0], deduped: true };
    }

    await ensureWalletRow(client, userId);

    // Lock the wallet row to serialize concurrent mutations.
    const walletRes = await client.query(
        `SELECT balance_mli, held_mli FROM wallets
         WHERE user_id = $1 FOR UPDATE`,
        [userId]
    );
    if (walletRes.rowCount === 0) {
        throw new Error('wallet_not_found');
    }
    const current = walletRes.rows[0];
    const newBalance = BigInt(current.balance_mli) + BigInt(balanceDelta);
    const newHeld = BigInt(current.held_mli) + BigInt(heldDelta);

    if (newBalance < 0n) throw new Error('insufficient_balance');
    if (newHeld < 0n) throw new Error('insufficient_held');

    // Update wallet aggregates.
    const lifetimeEarnedInc = balanceDelta > 0 ? balanceDelta : 0;
    const lifetimeSpentInc = balanceDelta < 0 ? -balanceDelta : 0;

    await client.query(
        `UPDATE wallets
         SET balance_mli = $1,
             held_mli = $2,
             lifetime_earned_mli = lifetime_earned_mli + $3,
             lifetime_spent_mli = lifetime_spent_mli + $4,
             updated_at = NOW()
         WHERE user_id = $5`,
        [newBalance.toString(), newHeld.toString(), lifetimeEarnedInc, lifetimeSpentInc, userId]
    );

    const ledgerRes = await client.query(
        `INSERT INTO wallet_ledger
            (user_id, delta_mli, held_delta_mli, balance_after_mli, held_after_mli,
             type, ref_type, ref_id, counterparty_user_id, note, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, created_at`,
        [
            userId,
            balanceDelta,
            heldDelta,
            newBalance.toString(),
            newHeld.toString(),
            type,
            refType,
            refId,
            counterpartyUserId,
            note,
            idempotencyKey,
        ]
    );

    return {
        id: ledgerRes.rows[0].id,
        balance_after_mli: newBalance.toString(),
        held_after_mli: newHeld.toString(),
        created_at: ledgerRes.rows[0].created_at,
        deduped: false,
    };
}

/**
 * Run a function inside BEGIN/COMMIT. Rollback on throw.
 */
async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (rbErr) {
            console.warn('[Wallet] ROLLBACK failed:', rbErr.message);
        }
        throw err;
    } finally {
        client.release();
    }
}

// ============================================
// Public API
// ============================================

/**
 * Credit a top-up order to a user's wallet.
 *
 * Called by Google Play purchase verification (or TapPay / admin grant).
 * Inserts a ledger row of type `topup` and increases balance.
 */
async function creditTopup({ userId, amountMli, orderId, channel, idempotencyKey, note = null }) {
    assertPositiveInt('amount_mli', amountMli);
    assertRefString('order_id', orderId);
    return withTransaction(client => applyLedgerEntry(client, {
        userId,
        balanceDelta: amountMli,
        heldDelta: 0,
        type: LEDGER_TYPES.TOPUP,
        refType: 'topup_order',
        refId: orderId,
        note: note || `topup:${channel}`,
        idempotencyKey,
    }));
}

/**
 * Grant monthly subscription e-coins to a user.
 * Called from subscription.js when a plan is activated or renewed.
 * Uses idempotent key based on userId + planId + month to prevent double-grant.
 */
async function grantSubscriptionEcoin(userId, planId, ecoinAmount) {
    const amountMli = ecoinAmount * ECOIN_TO_MLI;
    const monthKey = new Date().toISOString().slice(0, 7); // e.g. "2026-04"
    const idemKey = `sub-grant:${userId}:${planId}:${monthKey}`;

    return withTransaction(client => applyLedgerEntry(client, {
        userId,
        balanceDelta: amountMli,
        heldDelta: 0,
        type: LEDGER_TYPES.SUBSCRIPTION_GRANT,
        refType: 'subscription',
        refId: planId,
        note: `Monthly ${planId} grant: ${ecoinAmount} e幣`,
        idempotencyKey: idemKey,
    }));
}

/**
 * Atomically transfer e-coin from one user to another.
 * Inserts two ledger rows (one debit on sender, one credit on receiver)
 * linked by the same idempotency_key prefix.
 *
 * Does NOT apply platform fee — callers that need fee splitting should
 * call this twice (once receiver-gets-net, once platform-gets-fee).
 */
async function transferEcoin({
    fromUserId, toUserId, amountMli, type, refType = null, refId = null,
    note = null, idempotencyKey,
}) {
    assertPositiveInt('amount_mli', amountMli);
    assertLedgerType(type);
    assertIdempotencyKey(idempotencyKey);
    if (fromUserId === toUserId) throw new Error('self_transfer_forbidden');

    return withTransaction(async (client) => {
        // Lock both rows in a deterministic order to avoid deadlocks.
        const [firstId, secondId] = [fromUserId, toUserId].sort();
        await ensureWalletRow(client, firstId);
        await ensureWalletRow(client, secondId);
        await client.query(
            `SELECT user_id FROM wallets WHERE user_id = ANY($1::uuid[]) ORDER BY user_id FOR UPDATE`,
            [[firstId, secondId]]
        );

        const debit = await applyLedgerEntry(client, {
            userId: fromUserId,
            balanceDelta: -amountMli,
            heldDelta: 0,
            type,
            refType,
            refId,
            counterpartyUserId: toUserId,
            note,
            idempotencyKey: `${idempotencyKey}:debit`,
        });
        const credit = await applyLedgerEntry(client, {
            userId: toUserId,
            balanceDelta: amountMli,
            heldDelta: 0,
            type,
            refType,
            refId,
            counterpartyUserId: fromUserId,
            note,
            idempotencyKey: `${idempotencyKey}:credit`,
        });
        return { debit, credit };
    });
}

/**
 * Move spendable balance into the held (deposit escrow) bucket.
 * Used when renter confirms a rental — deposit is frozen for the contract.
 */
async function holdDeposit({ userId, amountMli, contractId, idempotencyKey, note = null }) {
    assertPositiveInt('amount_mli', amountMli);
    return withTransaction(client => applyLedgerEntry(client, {
        userId,
        balanceDelta: -amountMli,
        heldDelta: amountMli,
        type: LEDGER_TYPES.DEPOSIT_HOLD,
        refType: 'rental_contract',
        refId: contractId || null,
        note,
        idempotencyKey,
    }));
}

/**
 * Move held deposit back to spendable balance. Used on successful rental
 * end (full refund) or partial refund on early termination.
 */
async function releaseDeposit({ userId, amountMli, contractId, idempotencyKey, note = null }) {
    assertPositiveInt('amount_mli', amountMli);
    return withTransaction(client => applyLedgerEntry(client, {
        userId,
        balanceDelta: amountMli,
        heldDelta: -amountMli,
        type: LEDGER_TYPES.DEPOSIT_RELEASE,
        refType: 'rental_contract',
        refId: contractId || null,
        note,
        idempotencyKey,
    }));
}

/**
 * Remove held deposit entirely (violation fine / insurance pool contribution).
 * The deposit amount leaves the renter's held bucket and does NOT return
 * to their spendable balance. Caller is responsible for crediting a
 * destination (e.g. insurance pool) in a separate call if needed.
 */
async function forfeitDeposit({ userId, amountMli, contractId, idempotencyKey, note = null }) {
    assertPositiveInt('amount_mli', amountMli);
    return withTransaction(client => applyLedgerEntry(client, {
        userId,
        balanceDelta: 0,
        heldDelta: -amountMli,
        type: LEDGER_TYPES.DEPOSIT_FORFEIT,
        refType: 'rental_contract',
        refId: contractId || null,
        note,
        idempotencyKey,
    }));
}

/**
 * Admin manual balance adjustment. Always audited via ledger.
 * `delta` is signed — positive credits, negative debits.
 */
async function adminAdjust({ userId, deltaMli, reason, adminUserId, idempotencyKey }) {
    if (!Number.isInteger(deltaMli) || deltaMli === 0) {
        throw new Error('delta_mli_must_be_nonzero_integer');
    }
    if (!reason || typeof reason !== 'string') {
        throw new Error('reason_required');
    }
    return withTransaction(client => applyLedgerEntry(client, {
        userId,
        balanceDelta: deltaMli,
        heldDelta: 0,
        type: LEDGER_TYPES.ADMIN_ADJUST,
        refType: 'admin_action',
        refId: adminUserId || null,
        note: `admin:${reason}`,
        idempotencyKey,
    }));
}

// ============================================
// Top-up order lifecycle
// ============================================

/**
 * Insert a new topup_orders row and return its ID. Idempotent on
 * (channel, external_txn_id) — if the same transaction is verified
 * twice, returns the existing row instead of duplicating.
 */
async function createTopupOrder({
    userId, channel, priceUsd, baseMli, bonusMli, externalTxnId, externalRaw = null,
}) {
    assertUuidLike('user_id', userId);
    if (!channel || typeof channel !== 'string') throw new Error('channel_invalid');
    if (!Number.isInteger(priceUsd) || priceUsd < 0) throw new Error('price_usd_invalid');
    assertPositiveInt('base_mli', baseMli);
    if (!Number.isInteger(bonusMli) || bonusMli < 0) throw new Error('bonus_mli_invalid');

    // Dedupe on external_txn_id when present.
    if (externalTxnId) {
        const existing = await pool.query(
            `SELECT id, status, ecoin_total_mli FROM topup_orders
             WHERE channel = $1 AND external_txn_id = $2`,
            [channel, externalTxnId]
        );
        if (existing.rowCount > 0) {
            return { ...existing.rows[0], deduped: true };
        }
    }

    const totalMli = baseMli + bonusMli;
    const res = await pool.query(
        `INSERT INTO topup_orders
            (user_id, channel, amount_twd, ecoin_base_mli, ecoin_bonus_mli, ecoin_total_mli,
             status, external_txn_id, external_raw)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
         RETURNING id, status, ecoin_total_mli`,
        [userId, channel, priceUsd, baseMli, bonusMli, totalMli, externalTxnId || null, externalRaw]
    );
    return { ...res.rows[0], deduped: false };
}

/**
 * Mark a topup_order paid and credit the wallet in a single transaction.
 * Throws `order_not_found` if the order does not exist (distinct from
 * already-paid, which is a no-op idempotent path).
 */
async function markTopupPaid({ orderId, userId, amountMli, channel }) {
    assertRefString('order_id', orderId);
    assertUuidLike('user_id', userId);
    assertPositiveInt('amount_mli', amountMli);

    return withTransaction(async (client) => {
        const ord = await client.query(
            `SELECT id, status FROM topup_orders WHERE id = $1 FOR UPDATE`,
            [orderId]
        );
        if (ord.rowCount === 0) {
            throw new Error('order_not_found');
        }
        if (ord.rows[0].status !== 'paid') {
            await client.query(
                `UPDATE topup_orders SET status = 'paid', paid_at = NOW() WHERE id = $1`,
                [orderId]
            );
        }
        return applyLedgerEntry(client, {
            userId,
            balanceDelta: amountMli,
            heldDelta: 0,
            type: LEDGER_TYPES.TOPUP,
            refType: 'topup_order',
            refId: orderId,
            note: `topup:${channel}`,
            idempotencyKey: `topup:${orderId}`,
        });
    });
}

// ============================================
// Read APIs
// ============================================

async function getBalance(userId) {
    assertUuidLike('user_id', userId);
    const res = await pool.query(
        `SELECT balance_mli, held_mli, lifetime_earned_mli, lifetime_spent_mli
         FROM wallets WHERE user_id = $1`,
        [userId]
    );
    if (res.rowCount === 0) {
        return {
            balance_mli: '0', held_mli: '0',
            lifetime_earned_mli: '0', lifetime_spent_mli: '0',
            balance_ecoin: 0, held_ecoin: 0,
        };
    }
    const row = res.rows[0];
    return {
        balance_mli: String(row.balance_mli),
        held_mli: String(row.held_mli),
        lifetime_earned_mli: String(row.lifetime_earned_mli),
        lifetime_spent_mli: String(row.lifetime_spent_mli),
        balance_ecoin: mliToEcoin(row.balance_mli),
        held_ecoin: mliToEcoin(row.held_mli),
    };
}

/**
 * Reconciliation — verify every wallet's cached balance + held matches
 * the signed sum of its ledger rows. Returns a list of discrepancies.
 *
 * Expected to report an empty array. Any drift indicates a bug in
 * `applyLedgerEntry` or a direct write that bypassed the ledger — both
 * should page the team.
 *
 * Can be called periodically (daily cron) or on-demand from an admin
 * endpoint. Runs a single SQL query so cost is O(rows in ledger) on
 * the DB side; holds no state in Node.
 */
async function reconcileBalances({ limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000);
    const res = await pool.query(
        `WITH agg AS (
            SELECT user_id,
                   COALESCE(SUM(delta_mli), 0)       AS ledger_balance_mli,
                   COALESCE(SUM(held_delta_mli), 0)  AS ledger_held_mli
            FROM wallet_ledger
            GROUP BY user_id
        )
        SELECT w.user_id,
               w.balance_mli        AS cached_balance_mli,
               w.held_mli           AS cached_held_mli,
               COALESCE(a.ledger_balance_mli, 0) AS expected_balance_mli,
               COALESCE(a.ledger_held_mli, 0)    AS expected_held_mli
        FROM wallets w
        LEFT JOIN agg a ON a.user_id = w.user_id
        WHERE w.balance_mli <> COALESCE(a.ledger_balance_mli, 0)
           OR w.held_mli    <> COALESCE(a.ledger_held_mli, 0)
        LIMIT $1`,
        [safeLimit]
    );
    return {
        discrepancies: res.rows.map(r => ({
            userId: r.user_id,
            cachedBalanceMli: String(r.cached_balance_mli),
            cachedHeldMli: String(r.cached_held_mli),
            expectedBalanceMli: String(r.expected_balance_mli),
            expectedHeldMli: String(r.expected_held_mli),
            deltaMli: String(BigInt(r.cached_balance_mli) - BigInt(r.expected_balance_mli)),
        })),
        ok: res.rowCount === 0,
    };
}

async function getLedger(userId, { limit = 50, offset = 0, type = null } = {}) {
    assertUuidLike('user_id', userId);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
    const params = [userId];
    let where = 'user_id = $1';
    if (type) {
        assertLedgerType(type);
        params.push(type);
        where += ` AND type = $${params.length}`;
    }
    params.push(safeLimit);
    params.push(safeOffset);
    const res = await pool.query(
        `SELECT id, delta_mli, held_delta_mli, balance_after_mli, held_after_mli,
                type, ref_type, ref_id, counterparty_user_id, note, created_at
         FROM wallet_ledger
         WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return res.rows;
}

// ============================================
// Google Play purchase verification (androidpublisher v3)
// ============================================
//
// Security posture: FAIL-CLOSED. If GOOGLE_PLAY_SERVICE_ACCOUNT is missing
// or unparseable, /topup/verify-google rejects with purchase_not_verified
// instead of falling back to the legacy trust-token path. Rationale: this
// route credits real money into wallets; an env-misconfiguration should
// NOT open the door to forged purchaseTokens. To intentionally disable
// verification (e.g. during a rollback), set env
// `GOOGLE_PLAY_ALLOW_UNVERIFIED=1` — the flip is explicit + audited.
//
// No GSA field (private_key, private_key_id, full JSON) is ever logged.
// Only `client_email` and `project_id` may appear in audit records.

/**
 * Singleton GSA env parser. Returns the parsed service account object
 * on first call and caches it. Returns null if env is missing OR malformed.
 * Never throws — caller decides how to handle missing creds.
 */
let _gsaCache = undefined;  // undefined = not parsed yet; null = parsed but absent/invalid
function _getServiceAccount() {
    if (_gsaCache !== undefined) return _gsaCache;
    const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
    if (!raw || typeof raw !== 'string') {
        _gsaCache = null;
        return _gsaCache;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            _gsaCache = null;
            return _gsaCache;
        }
        // Required fields: client_email + private_key. Do NOT log the key.
        if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
            _gsaCache = null;
            return _gsaCache;
        }
        _gsaCache = parsed;
        return _gsaCache;
    } catch (_err) {
        // JSON parse failed — treat as missing. Don't log the raw value
        // (may contain the private key even if malformed).
        _gsaCache = null;
        return _gsaCache;
    }
}

/** Reset the GSA + access-token caches. For tests only. */
function _resetGoogleCache() {
    _gsaCache = undefined;
    _accessTokenCache = { token: null, expiresAt: 0, inflight: null };
}

/**
 * Single-flight OAuth access-token cache.
 * - `expiresAt`: epoch-ms at which the cached token becomes stale.
 * - `inflight`: if a fetch is already in progress, concurrent callers await
 *   the same promise instead of re-signing a JWT + hammering the token endpoint.
 */
let _accessTokenCache = { token: null, expiresAt: 0, inflight: null };

/** Build and sign a service-account JWT assertion for the token exchange. */
function _signServiceAccountJwt(sa, now = Math.floor(Date.now() / 1000)) {
    const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id || undefined };
    const payload = {
        iss: sa.client_email,
        sub: sa.client_email,
        aud: GOOGLE_OAUTH_TOKEN_URL,
        scope: GOOGLE_ANDROIDPUBLISHER_SCOPE,
        iat: now,
        exp: now + 3600,
    };
    return jwt.sign(payload, sa.private_key, { algorithm: 'RS256', header });
}

/**
 * Acquire an OAuth access token for the androidpublisher scope.
 * Returns the cached token if still fresh (within GOOGLE_TOKEN_CACHE_MS).
 * Throws google_auth_failed on any upstream failure.
 */
async function _getGoogleAccessToken({ fetchImpl = fetch, now = Date.now() } = {}) {
    const sa = _getServiceAccount();
    if (!sa) {
        const e = new Error('google_auth_failed');
        e.reason = 'gsa_missing_or_invalid';
        throw e;
    }

    if (_accessTokenCache.token && _accessTokenCache.expiresAt > now) {
        return _accessTokenCache.token;
    }
    if (_accessTokenCache.inflight) {
        return _accessTokenCache.inflight;
    }

    _accessTokenCache.inflight = (async () => {
        try {
            const assertion = _signServiceAccountJwt(sa);
            const body = new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion,
            });
            const resp = await fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
            });
            if (!resp.ok) {
                const e = new Error('google_auth_failed');
                e.reason = `token_exchange_http_${resp.status}`;
                throw e;
            }
            const data = await resp.json();
            if (!data || typeof data.access_token !== 'string') {
                const e = new Error('google_auth_failed');
                e.reason = 'token_exchange_malformed';
                throw e;
            }
            _accessTokenCache.token = data.access_token;
            _accessTokenCache.expiresAt = now + GOOGLE_TOKEN_CACHE_MS;
            return data.access_token;
        } finally {
            _accessTokenCache.inflight = null;
        }
    })();
    return _accessTokenCache.inflight;
}

/**
 * Verify a Google Play purchase token via androidpublisher v3.
 *
 * Returns on success:
 *   { valid: true, orderId, purchaseState, consumptionState,
 *     acknowledgementState, rawResponse }
 *
 * Throws with a typed `.code`:
 *   - google_auth_failed   — JWT sign / token exchange failed (500 to client)
 *   - google_token_invalid — HTTP 400/404 from Google (402 to client)
 *   - google_token_canceled — purchaseState=1 (402 to client)
 *   - google_token_pending  — purchaseState=2 (402 to client)
 *
 * `orderId` is Google's authoritative per-transaction ID — prefer this over
 * the raw purchaseToken when computing external_txn_id.
 */
async function verifyGooglePurchase(
    packageName,
    productId,
    purchaseToken,
    { fetchImpl = fetch } = {}
) {
    if (!packageName || typeof packageName !== 'string') throw new Error('package_name_invalid');
    if (!productId || typeof productId !== 'string') throw new Error('product_id_invalid');
    if (!purchaseToken || typeof purchaseToken !== 'string') throw new Error('purchase_token_invalid');

    const accessToken = await _getGoogleAccessToken({ fetchImpl });
    const url = `${GOOGLE_ANDROIDPUBLISHER_BASE}/applications/${encodeURIComponent(packageName)}`
              + `/purchases/products/${encodeURIComponent(productId)}`
              + `/tokens/${encodeURIComponent(purchaseToken)}`;

    const resp = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (resp.status === 401 || resp.status === 403) {
        // Most commonly: service account lacks Play Console access.
        const e = new Error('google_auth_failed');
        e.reason = `api_http_${resp.status}`;
        throw e;
    }
    if (resp.status === 400 || resp.status === 404 || resp.status === 410) {
        // Token does not identify a known purchase.
        const e = new Error('google_token_invalid');
        e.reason = `api_http_${resp.status}`;
        throw e;
    }
    if (!resp.ok) {
        const e = new Error('google_auth_failed');
        e.reason = `api_http_${resp.status}`;
        throw e;
    }

    let data;
    try {
        data = await resp.json();
    } catch (_err) {
        const e = new Error('google_auth_failed');
        e.reason = 'api_malformed_json';
        throw e;
    }

    // purchaseState: 0=purchased, 1=canceled, 2=pending
    if (data.purchaseState === 1) {
        const e = new Error('google_token_canceled');
        e.purchaseState = 1;
        throw e;
    }
    if (data.purchaseState === 2) {
        const e = new Error('google_token_pending');
        e.purchaseState = 2;
        throw e;
    }
    if (data.purchaseState !== 0) {
        const e = new Error('google_token_invalid');
        e.purchaseState = data.purchaseState;
        throw e;
    }

    return {
        valid: true,
        orderId: data.orderId || null,
        purchaseState: data.purchaseState,
        consumptionState: data.consumptionState,
        acknowledgementState: data.acknowledgementState,
        rawResponse: data,
    };
}

/**
 * Acknowledge a purchase. Must be called within 3 days of purchase or
 * Google auto-refunds. Fire-and-forget from the caller's perspective:
 * the wallet has already been credited, so an ack failure is logged + left
 * for a retry cron — we never revoke credited ecoins on ack failure.
 *
 * Never throws (errors are returned as { ok: false, error }).
 */
async function acknowledgeGooglePurchase(
    packageName,
    productId,
    purchaseToken,
    { fetchImpl = fetch } = {}
) {
    try {
        const accessToken = await _getGoogleAccessToken({ fetchImpl });
        const url = `${GOOGLE_ANDROIDPUBLISHER_BASE}/applications/${encodeURIComponent(packageName)}`
                  + `/purchases/products/${encodeURIComponent(productId)}`
                  + `/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
        const resp = await fetchImpl(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: '{}',
        });
        if (!resp.ok && resp.status !== 204) {
            return { ok: false, error: `ack_http_${resp.status}` };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message || 'ack_failed' };
    }
}

// ============================================
// Express factory
// ============================================

module.exports = function walletFactory({ authMiddleware, adminMiddleware, serverLog, devices, safeEqual } = {}) {
    if (typeof authMiddleware !== 'function') {
        throw new Error('wallet: authMiddleware is required');
    }
    const router = express.Router();
    const audit = serverLog || (() => {});

    // Errors thrown from handlers whose message matches this pattern are
    // mapped to HTTP 400 (input validation). Anything else becomes 500.
    const INPUT_ERROR_RE = /^(?:[a-z][a-z0-9_]*_(?:invalid|required)|unknown_[a-z_]+|order_not_found|insufficient_balance|insufficient_held|self_transfer_forbidden)$/;

    function walletRoute(fn) {
        return async (req, res) => {
            try {
                if (!req.user || !req.user.userId) {
                    return res.status(401).json({ success: false, error: 'unauthenticated' });
                }
                await fn(req, res);
            } catch (err) {
                if (INPUT_ERROR_RE.test(err.message)) {
                    return res.status(400).json({ success: false, error: err.message });
                }
                console.error('[Wallet] handler error:', err);
                res.status(500).json({ success: false, error: 'internal_error' });
            }
        };
    }

    // GET /api/wallet/balance
    router.get('/balance', authMiddleware, walletRoute(async (req, res) => {
        const data = await getBalance(req.user.userId);
        res.json({ success: true, wallet: data });
    }));

    // GET /api/wallet/history?limit=&offset=&type=
    router.get('/history', authMiddleware, walletRoute(async (req, res) => {
        const { limit, offset, type } = req.query;
        const rows = await getLedger(req.user.userId, { limit, offset, type });
        res.json({ success: true, entries: rows });
    }));

    // GET /api/wallet/topup/tiers — public catalog of available top-up tiers
    router.get('/topup/tiers', (_req, res) => {
        const tiers = Object.entries(TOPUP_TIERS).map(([productId, t]) => ({
            productId,
            priceUsd: t.priceUsd,
            ecoinBase: Math.round(t.baseMli / ECOIN_TO_MLI),
            ecoinBonus: Math.round(t.bonusMli / ECOIN_TO_MLI),
            ecoinTotal: Math.round((t.baseMli + t.bonusMli) / ECOIN_TO_MLI),
            bonusPct: t.baseMli > 0 ? Math.round((t.bonusMli / t.baseMli) * 100) : 0,
        }));
        res.json({ success: true, tiers });
    });

    // GET /api/wallet/topup/diag?deviceId=&deviceSecret=
    // Gated diagnostic for Android Top-up Path B debugging. Returns whether
    // GOOGLE_PLAY_SERVICE_ACCOUNT is loadable and which package is configured,
    // without leaking the private key. Device auth required (same shape as
    // /topup/verify-google) so this is not a public probe.
    router.get('/topup/diag', async (req, res) => {
        try {
            const { deviceId, deviceSecret: devSecret } = req.query || {};
            if (!deviceId || !devSecret || !devices || !safeEqual) {
                return res.status(401).json({ success: false, error: 'device_auth_required' });
            }
            const device = devices[deviceId];
            if (!device || !safeEqual(device.deviceSecret, devSecret)) {
                return res.status(401).json({ success: false, error: 'invalid_credentials' });
            }
            const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
            const gsa = _getServiceAccount();
            res.json({
                success: true,
                diag: {
                    googlePlayPackage: GOOGLE_PACKAGE_NAME,
                    packageFromEnv: !!process.env.GOOGLE_PLAY_PACKAGE,
                    gsaLoaded: !!gsa,
                    gsaEnvPresent: !!raw,
                    gsaRawType: typeof raw,
                    gsaRawLength: typeof raw === 'string' ? raw.length : 0,
                    gsaClientEmail: gsa ? gsa.client_email : null,
                    allowUnverified: process.env.GOOGLE_PLAY_ALLOW_UNVERIFIED === '1',
                    androidpublisherBase: GOOGLE_ANDROIDPUBLISHER_BASE,
                }
            });
        } catch (err) {
            res.status(500).json({ success: false, error: 'diag_failed', message: err.message });
        }
    });

    // POST /api/wallet/topup/verify-google
    // Body: { productId, purchaseToken, deviceId?, deviceSecret? }
    //   — Device auth (Android app): { deviceId, deviceSecret } in body
    //   — JWT auth (portal): cookie/Authorization header
    //
    // Verifies purchaseToken against Google androidpublisher v3 before
    // crediting the wallet. Fail-closed: if GOOGLE_PLAY_SERVICE_ACCOUNT is
    // missing/invalid the request is rejected (purchase_not_verified) so
    // an env misconfiguration can't open the door to forged tokens.
    router.post('/topup/verify-google', async (req, res) => {
        try {
            const { productId, purchaseToken, deviceId, deviceSecret: devSecret } = req.body || {};

            // --- Resolve userId: device auth first, JWT fallback ---
            let userId;

            if (deviceId && devSecret && devices && safeEqual) {
                // Device auth (Android app sends deviceId + deviceSecret)
                const device = devices[deviceId];
                if (!device || !safeEqual(device.deviceSecret, devSecret)) {
                    return res.status(401).json({ success: false, error: 'invalid_credentials' });
                }
                const userResult = await pool.query(
                    'SELECT id FROM user_accounts WHERE device_id = $1',
                    [deviceId]
                );
                if (userResult.rows.length === 0) {
                    return res.status(404).json({ success: false, error: 'no_account_for_device' });
                }
                userId = userResult.rows[0].id;
            } else {
                // JWT auth fallback (portal web).
                // fakeRes intercepts authMiddleware's res.status(401).json() path
                // so it resolves false instead of sending a response. Coupled to
                // auth.js:144-159 which only calls status().json() or next().
                const authed = await new Promise((resolve) => {
                    const fakeRes = { status: () => ({ json: () => resolve(false) }) };
                    authMiddleware(req, fakeRes, () => resolve(true));
                });
                if (!authed || !req.user || !req.user.userId) {
                    return res.status(401).json({ success: false, error: 'unauthenticated' });
                }
                userId = req.user.userId;
            }

            // --- Validate inputs ---
            if (!productId || typeof productId !== 'string') {
                return res.status(400).json({ success: false, error: 'product_id_required' });
            }
            if (!purchaseToken || typeof purchaseToken !== 'string' || purchaseToken.length < 8) {
                return res.status(400).json({ success: false, error: 'purchase_token_invalid' });
            }
            const tier = getTopupTier(productId);
            if (!tier) {
                return res.status(400).json({ success: false, error: 'unknown_product' });
            }

            // --- Verify with Google androidpublisher ---
            // Fail-closed by default. `GOOGLE_PLAY_ALLOW_UNVERIFIED=1` is an
            // explicit, audited escape hatch for emergency rollback.
            const allowUnverified = process.env.GOOGLE_PLAY_ALLOW_UNVERIFIED === '1';
            let googleOrderId = null;
            let skippedVerification = false;

            if (allowUnverified && !_getServiceAccount()) {
                // Emergency rollback path — audited so Hank sees it.
                skippedVerification = true;
                audit('warn', 'wallet', `google verification skipped (GOOGLE_PLAY_ALLOW_UNVERIFIED=1) user=${userId} product=${productId}`, {
                    userId, action: 'topup_verify', result: 'unverified_fallback',
                });
            } else {
                try {
                    const verified = await verifyGooglePurchase(
                        GOOGLE_PACKAGE_NAME, productId, purchaseToken
                    );
                    googleOrderId = verified.orderId;
                } catch (vErr) {
                    if (vErr.message === 'google_auth_failed') {
                        // Server-side problem (bad GSA, Google 5xx). Mask the
                        // internal reason from the client; log for ops.
                        audit('error', 'wallet', `google_auth_failed user=${userId} reason=${vErr.reason || 'unknown'}`, {
                            userId, action: 'topup_verify', result: 'google_auth_failed',
                        });
                        return res.status(500).json({ success: false, error: 'google_auth_failed' });
                    }
                    // google_token_invalid / canceled / pending → 402 + safe error code
                    const code = vErr.message;  // safe: one of the enumerated strings
                    audit('warn', 'wallet', `purchase_not_verified user=${userId} product=${productId} code=${code}`, {
                        userId, action: 'topup_verify', result: code,
                    });
                    return res.status(402).json({
                        success: false,
                        error: 'purchase_not_verified',
                        details: { code },
                    });
                }
            }

            // Google orderId (stable per-transaction) is preferred over the
            // raw purchaseToken as the external_txn_id. Fall back to the token
            // only when Google omitted orderId (rare) or we skipped verification.
            const externalTxnId = googleOrderId || purchaseToken;

            const order = await createTopupOrder({
                userId,
                channel: 'google_play',
                priceUsd: tier.priceUsd,
                baseMli: tier.baseMli,
                bonusMli: tier.bonusMli,
                externalTxnId,
                externalRaw: {
                    productId,
                    source: 'verify-google',
                    orderId: googleOrderId,
                    verified: !skippedVerification,
                    // Persisted so the ack-retry sweep (ack-retry-sweep.js)
                    // can re-invoke `:acknowledge` on this purchase if the
                    // fire-and-forget ack below silently fails. Google auto-
                    // refunds after 3 days of missing ack, so we MUST have
                    // these fields to reconcile.
                    packageName: GOOGLE_PACKAGE_NAME,
                    purchaseToken,
                },
            });

            const ledger = await markTopupPaid({
                orderId: order.id,
                userId,
                amountMli: parseInt(order.ecoin_total_mli, 10),
                channel: 'google_play',
            });

            audit('info', 'wallet', `topup verified user=${userId} product=${productId} order=${order.id}`, {
                userId, action: 'topup_verify', resource: order.id, result: 'success',
            });

            // Fire-and-forget acknowledge AFTER ledger credit succeeded.
            // If ack fails, the user keeps their ecoins; the ack-retry sweep
            // (ack-retry-sweep.js, hourly cron) picks up any order whose
            // ack_state != 'acked' within the Google 72h refund window.
            // Never block the response on this.
            if (!skippedVerification) {
                Promise.resolve()
                    .then(() => acknowledgeGooglePurchase(GOOGLE_PACKAGE_NAME, productId, purchaseToken))
                    .then((ackRes) => {
                        if (ackRes.ok) {
                            // Mark acked so the sweep skips this row.
                            pool.query(
                                `UPDATE topup_orders
                                 SET ack_state = 'acked', ack_at = NOW(), ack_attempts = ack_attempts + 1
                                 WHERE id = $1 AND ack_state <> 'acked'`,
                                [order.id]
                            ).catch((uErr) => {
                                audit('warn', 'wallet', `ack_state update failed order=${order.id}`, {
                                    userId, action: 'topup_ack', resource: order.id, result: 'state_update_failed',
                                    metadata: { message: uErr && uErr.message },
                                });
                            });
                        } else {
                            // Ack failed: bump attempts so the sweep can
                            // 3-strike it out faster.
                            pool.query(
                                `UPDATE topup_orders
                                 SET ack_attempts = ack_attempts + 1
                                 WHERE id = $1 AND ack_state = 'pending'`,
                                [order.id]
                            ).catch(() => {});
                            audit('warn', 'wallet', `google ack failed user=${userId} order=${order.id} err=${ackRes.error}`, {
                                userId, action: 'topup_ack', resource: order.id, result: 'ack_failed',
                            });
                        }
                    })
                    .catch((ackErr) => {
                        pool.query(
                            `UPDATE topup_orders
                             SET ack_attempts = ack_attempts + 1
                             WHERE id = $1 AND ack_state = 'pending'`,
                            [order.id]
                        ).catch(() => {});
                        audit('warn', 'wallet', `google ack threw user=${userId} order=${order.id}`, {
                            userId, action: 'topup_ack', resource: order.id, result: 'ack_threw',
                            metadata: { message: ackErr && ackErr.message },
                        });
                    });
            } else {
                // Skipped verification (GOOGLE_PLAY_ALLOW_UNVERIFIED fallback).
                // No ack is possible without a real token/GSA — mark the row
                // so the sweep doesn't pick it up.
                pool.query(
                    `UPDATE topup_orders
                     SET ack_state = 'acked', ack_at = NOW()
                     WHERE id = $1 AND ack_state = 'pending'`,
                    [order.id]
                ).catch(() => {});
            }

            res.json({
                success: true,
                order: {
                    id: order.id,
                    status: 'paid',
                    ecoinTotal: Math.round(parseInt(order.ecoin_total_mli, 10) / ECOIN_TO_MLI),
                    deduped: !!order.deduped || !!ledger.deduped,
                },
            });
        } catch (err) {
            console.error('[Wallet] topup verify-google error:', err);
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // ============================================
    // POST /api/wallet/topup/verify-apple
    // Body: { productId, transactionId, receipt }
    //   - productId: Apple IAP product identifier (must match TOPUP_TIERS)
    //   - transactionId: Apple transaction ID (for idempotency)
    //   - receipt: base64-encoded receipt-data from StoreKit
    //
    // Verifies receipt via Apple's /verifyReceipt endpoint (prod → sandbox fallback)
    // and credits wallet. Uses UNIQUE(channel='apple_iap', external_txn_id) for dedupe.
    // ============================================
    const APPLE_VERIFY_PROD = 'https://buy.itunes.apple.com/verifyReceipt';
    const APPLE_VERIFY_SANDBOX = 'https://sandbox.itunes.apple.com/verifyReceipt';

    async function verifyAppleReceipt(receipt, sharedSecret, useSandbox = false) {
        const url = useSandbox ? APPLE_VERIFY_SANDBOX : APPLE_VERIFY_PROD;
        const body = {
            'receipt-data': receipt,
            ...(sharedSecret ? { password: sharedSecret } : {}),
            'exclude-old-transactions': true,
        };
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            throw new Error(`apple_verify_http_invalid`);
        }
        const data = await resp.json();
        // status 21007 → receipt is from sandbox, retry sandbox endpoint
        if (data.status === 21007 && !useSandbox) {
            return verifyAppleReceipt(receipt, sharedSecret, true);
        }
        if (data.status !== 0) {
            // 21002/21003 = malformed/unauthenticated receipt → client error (receipt_invalid)
            // Other statuses → internal_error (Apple server / config issue)
            const err = new Error(
                [21000, 21002, 21003, 21006].includes(data.status)
                    ? 'receipt_invalid'
                    : `apple_status_${data.status}_invalid`
            );
            err.appleStatus = data.status;
            throw err;
        }
        return data;
    }

    router.post('/topup/verify-apple', authMiddleware, walletRoute(async (req, res) => {
        const { productId, transactionId, receipt } = req.body || {};
        if (!productId || typeof productId !== 'string') {
            throw new Error('product_id_required');
        }
        if (!transactionId || typeof transactionId !== 'string' || transactionId.length < 4) {
            throw new Error('transaction_id_invalid');
        }
        if (!receipt || typeof receipt !== 'string' || receipt.length < 20) {
            throw new Error('receipt_invalid');
        }
        const tier = getTopupTier(productId);
        if (!tier) throw new Error('unknown_product');

        const sharedSecret = process.env.APPLE_IAP_SHARED_SECRET || null;
        const envForceSandbox = process.env.APPLE_IAP_ENV === 'sandbox';

        // Verify with Apple (prod by default; falls back to sandbox on status 21007)
        const verified = await verifyAppleReceipt(receipt, sharedSecret, envForceSandbox);

        // Find the matching in-app purchase record
        const inApp = Array.isArray(verified.receipt?.in_app) ? verified.receipt.in_app : [];
        const latestInApp = Array.isArray(verified.latest_receipt_info) ? verified.latest_receipt_info : [];
        const allTxns = [...inApp, ...latestInApp];
        const matched = allTxns.find(
            (t) => (t.transaction_id === transactionId || t.original_transaction_id === transactionId)
                && t.product_id === productId
        );
        if (!matched) {
            throw new Error('transaction_invalid');
        }

        // Verify bundle ID matches (belt-and-suspenders check)
        const expectedBundleId = process.env.APPLE_BUNDLE_ID || 'com.eclawbot.app';
        if (verified.receipt?.bundle_id && verified.receipt.bundle_id !== expectedBundleId) {
            throw new Error('bundle_id_invalid');
        }

        const order = await createTopupOrder({
            userId: req.user.userId,
            channel: 'apple_iap',
            priceUsd: tier.priceUsd,
            baseMli: tier.baseMli,
            bonusMli: tier.bonusMli,
            externalTxnId: transactionId,
            externalRaw: {
                productId,
                source: 'verify-apple',
                originalTransactionId: matched.original_transaction_id,
                purchaseDate: matched.purchase_date,
                environment: verified.environment || (envForceSandbox ? 'Sandbox' : 'Production'),
            },
        });

        const ledger = await markTopupPaid({
            orderId: order.id,
            userId: req.user.userId,
            amountMli: parseInt(order.ecoin_total_mli, 10),
            channel: 'apple_iap',
        });

        audit('info', 'wallet', `apple topup verified user=${req.user.userId} product=${productId} order=${order.id}`, {
            userId: req.user.userId,
            action: 'topup_verify',
            resource: order.id,
            result: 'success',
            metadata: { channel: 'apple_iap', environment: verified.environment },
        });

        res.json({
            success: true,
            order: {
                id: order.id,
                status: 'paid',
                ecoinTotal: Math.round(parseInt(order.ecoin_total_mli, 10) / ECOIN_TO_MLI),
                deduped: !!order.deduped || !!ledger.deduped,
                environment: verified.environment || 'Production',
            },
        });
    }));

    // POST /api/wallet/admin/grant — admin manual e-coin grant (audited)
    // Body: { userId, ecoin, reason }
    //
    // Falls through to walletRoute's 401 if unauthenticated. The
    // adminMiddleware (when supplied) enforces admin role; tests that
    // omit it must seed `req.user.is_admin` themselves.
    const adminGate = adminMiddleware || ((_req, _res, next) => next());
    // GET /api/wallet/admin/reconcile — run full ledger-vs-wallet audit
    router.get('/admin/reconcile', authMiddleware, adminGate, walletRoute(async (req, res) => {
        const limit = parseInt(req.query.limit, 10) || 100;
        const report = await reconcileBalances({ limit });
        if (!report.ok) {
            audit('error', 'wallet', `reconcile FAIL: ${report.discrepancies.length} drift`, {
                userId: req.user.userId, action: 'reconcile', result: 'drift',
            });
        }
        res.json({ success: true, report });
    }));

    router.post('/admin/grant', authMiddleware, adminGate, walletRoute(async (req, res) => {
        const { userId, ecoin, reason } = req.body || {};
        if (!userId || typeof userId !== 'string') throw new Error('user_id_required');
        if (!Number.isFinite(ecoin) || ecoin === 0) throw new Error('ecoin_invalid');
        if (!reason || typeof reason !== 'string' || reason.length > 200) {
            throw new Error('reason_invalid');
        }

        const deltaMli = Math.round(ecoin * ECOIN_TO_MLI);
        const idemKey = `admin-grant:${req.user.userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        const result = await adminAdjust({
            userId, deltaMli, reason,
            adminUserId: req.user.userId,
            idempotencyKey: idemKey,
        });

        audit('warn', 'wallet', `admin grant ${ecoin} e幣 to ${userId}: ${reason}`, {
            userId: req.user.userId, action: 'admin_grant', resource: userId, result: 'success',
        });

        res.json({ success: true, ledger_id: result.id });
    }));

    return {
        router,
        initWalletDatabase,
        // Core primitives (for other modules like rental-contract.js)
        creditTopup,
        grantSubscriptionEcoin,
        transferEcoin,
        holdDeposit,
        releaseDeposit,
        forfeitDeposit,
        adminAdjust,
        createTopupOrder,
        markTopupPaid,
        getBalance,
        getLedger,
        reconcileBalances,
        // Transaction primitives for other modules (e.g. rental.js) that
        // need to write wallet ledger entries inside their own business
        // transactions (atomic cross-module operations).
        withTransaction,
        applyLedgerEntry,
        // Constants
        LEDGER_TYPES,
        USD_TO_MLI,
        ECOIN_TO_MLI,
        PLATFORM_FEE_BPS,
        INSURANCE_POOL_BPS,
        PLATFORM_WALLET_USER_ID,
        INSURANCE_POOL_USER_ID,
        TOPUP_TIERS,
        getTopupTier,
        // Conversion helpers
        usdToMli,
        ecoinToMli,
        mliToEcoin,
        // Google Play verification (exposed for tests + callers)
        verifyGooglePurchase,
        acknowledgeGooglePurchase,
        GOOGLE_PACKAGE_NAME,
        // Internals exposed for testing
        _internals: { applyLedgerEntry, withTransaction, pool, _resetGoogleCache, _getServiceAccount },
    };
};

// Also expose static constants + helpers at module level for convenience
module.exports.LEDGER_TYPES = LEDGER_TYPES;
module.exports.USD_TO_MLI = USD_TO_MLI;
module.exports.ECOIN_TO_MLI = ECOIN_TO_MLI;
module.exports.PLATFORM_FEE_BPS = PLATFORM_FEE_BPS;
module.exports.INSURANCE_POOL_BPS = INSURANCE_POOL_BPS;
module.exports.PLATFORM_WALLET_USER_ID = PLATFORM_WALLET_USER_ID;
module.exports.INSURANCE_POOL_USER_ID = INSURANCE_POOL_USER_ID;
module.exports.usdToMli = usdToMli;
module.exports.ecoinToMli = ecoinToMli;
module.exports.mliToEcoin = mliToEcoin;
module.exports.TOPUP_TIERS = TOPUP_TIERS;
module.exports.getTopupTier = getTopupTier;
module.exports.GOOGLE_PACKAGE_NAME = GOOGLE_PACKAGE_NAME;
module.exports.verifyGooglePurchase = verifyGooglePurchase;
module.exports.acknowledgeGooglePurchase = acknowledgeGooglePurchase;
module.exports._resetGoogleCache = _resetGoogleCache;
