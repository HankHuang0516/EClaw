/**
 * Wallet Module — Phase 0 of Bot Rental Marketplace
 *
 * Mounted at: /api/wallet
 *
 * Provides the e-coin wallet primitives that all rental-marketplace
 * features build on:
 *
 *   - transferEcoin()   — atomic p2p transfer (e.g. rental income payout)
 *   - holdDeposit()     — freeze spendable balance into deposit escrow
 *   - releaseDeposit()  — unfreeze deposit back to spendable balance
 *   - forfeitDeposit()  — remove deposit from user entirely (violation / fee)
 *   - creditTopup()     — credit e-coin from a top-up order (Google Play etc)
 *   - adminAdjust()     — manual balance adjustment (audited)
 *   - getBalance()      — read current balance (available + held)
 *   - getLedger()       — paginated ledger history
 *
 * All mutations go through a single transactional path and always
 * insert a corresponding wallet_ledger row. Every call must supply an
 * `idempotency_key` — duplicate keys are silently deduped.
 *
 * Units: all amounts are in 厘 (mli), where 1 e幣 = 1000 厘.
 * Exchange: 1 TWD = 100 e幣 = 100,000 厘. See TWD_TO_MLI.
 *
 * Design decisions are documented in memory/project_bot_rental_system.md
 * (design locked 2026-04-09).
 */

const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

// ============================================
// Constants
// ============================================

/** 1 TWD converts to 100,000 厘 (mli). */
const TWD_TO_MLI = 100_000;

/** 1 e幣 = 1000 厘. */
const ECOIN_TO_MLI = 1000;

/** Platform commission in basis points (15% = 1500 bps). */
const PLATFORM_FEE_BPS = 1500;

/** Portion of platform fee routed to insurance pool (2% of transaction). */
const INSURANCE_POOL_BPS = 200;

/** Well-known virtual user UUIDs for platform-owned wallets. */
const PLATFORM_WALLET_USER_ID = '00000000-0000-0000-0000-000000000001';
const INSURANCE_POOL_USER_ID  = '00000000-0000-0000-0000-000000000002';

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
    REFERRAL_BONUS:  'referral_bonus',
    SIGNUP_BONUS:    'signup_bonus',
    REFUND:          'refund',
    ADMIN_ADJUST:    'admin_adjust',
    WITHDRAW:        'withdraw',
});

const ALLOWED_LEDGER_TYPES = new Set(Object.values(LEDGER_TYPES));

// ============================================
// Helpers
// ============================================

function twdToMli(twd) {
    if (!Number.isFinite(twd) || twd < 0) throw new Error('invalid_twd');
    return Math.round(twd) * TWD_TO_MLI;
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
        console.log('[Wallet] Database initialized');
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
        try { await client.query('ROLLBACK'); } catch { /* noop */ }
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
// Express factory
// ============================================

module.exports = function walletFactory({ authMiddleware, serverLog } = {}) {
    const router = express.Router();
    const audit = serverLog || (() => {});

    // GET /api/wallet/balance
    router.get('/balance', authMiddleware || ((_req, _res, next) => next()), async (req, res) => {
        try {
            if (!req.user || !req.user.userId) {
                return res.status(401).json({ success: false, error: 'unauthenticated' });
            }
            const data = await getBalance(req.user.userId);
            res.json({ success: true, wallet: data });
        } catch (err) {
            console.error('[Wallet] /balance error:', err);
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    // GET /api/wallet/history?limit=&offset=&type=
    router.get('/history', authMiddleware || ((_req, _res, next) => next()), async (req, res) => {
        try {
            if (!req.user || !req.user.userId) {
                return res.status(401).json({ success: false, error: 'unauthenticated' });
            }
            const { limit, offset, type } = req.query;
            const rows = await getLedger(req.user.userId, { limit, offset, type });
            res.json({ success: true, entries: rows });
        } catch (err) {
            if (/unknown_ledger_type/.test(err.message)) {
                return res.status(400).json({ success: false, error: err.message });
            }
            console.error('[Wallet] /history error:', err);
            res.status(500).json({ success: false, error: 'internal_error' });
        }
    });

    return {
        router,
        initWalletDatabase,
        // Core primitives (for other modules like rental-contract.js)
        creditTopup,
        transferEcoin,
        holdDeposit,
        releaseDeposit,
        forfeitDeposit,
        adminAdjust,
        getBalance,
        getLedger,
        // Constants
        LEDGER_TYPES,
        TWD_TO_MLI,
        ECOIN_TO_MLI,
        PLATFORM_FEE_BPS,
        INSURANCE_POOL_BPS,
        PLATFORM_WALLET_USER_ID,
        INSURANCE_POOL_USER_ID,
        // Conversion helpers
        twdToMli,
        ecoinToMli,
        mliToEcoin,
        // Internals exposed for testing
        _internals: { applyLedgerEntry, withTransaction, pool },
        // Mark audit as touched so lint doesn't flag it
        _audit: audit,
    };
};

// Also expose static constants + helpers at module level for convenience
module.exports.LEDGER_TYPES = LEDGER_TYPES;
module.exports.TWD_TO_MLI = TWD_TO_MLI;
module.exports.ECOIN_TO_MLI = ECOIN_TO_MLI;
module.exports.PLATFORM_FEE_BPS = PLATFORM_FEE_BPS;
module.exports.INSURANCE_POOL_BPS = INSURANCE_POOL_BPS;
module.exports.PLATFORM_WALLET_USER_ID = PLATFORM_WALLET_USER_ID;
module.exports.INSURANCE_POOL_USER_ID = INSURANCE_POOL_USER_ID;
module.exports.twdToMli = twdToMli;
module.exports.ecoinToMli = ecoinToMli;
module.exports.mliToEcoin = mliToEcoin;
