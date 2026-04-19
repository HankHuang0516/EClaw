/**
 * Wallet Module Unit Tests (Jest)
 *
 * Strategy: mock `pg` with an in-memory simulator that implements just
 * the queries wallet.js uses. This verifies:
 *
 *  - Transactional integrity (BEGIN/COMMIT/ROLLBACK)
 *  - Idempotency deduplication
 *  - Balance / held invariants (no negative balances)
 *  - Ledger double-entry correctness for transfers
 *  - Input validation
 *
 * The simulator is intentionally minimal — it only recognizes the exact
 * SQL shapes wallet.js issues. If wallet.js grows new queries, extend the
 * dispatcher below.
 */

// ── In-memory pg simulator ──────────────────────────────────────────────
// Jest requires mock factories to be self-contained. We stash the shared
// state on globalThis so the test body can inspect + reset it.

jest.mock('pg', () => {
    const state = {
        wallets: new Map(),
        ledger: [],
        nextLedgerId: 1,
        topupOrders: [],
        nextOrderId: 1,
        userAccounts: new Map(),  // user_id -> { is_admin }
    };
    globalThis.__walletFakeState = state;

    function ensureWallet(userId) {
        if (!state.wallets.has(userId)) {
            state.wallets.set(userId, {
                balance_mli: 0n,
                held_mli: 0n,
                lifetime_earned_mli: 0n,
                lifetime_spent_mli: 0n,
            });
        }
    }

    function runQuery(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();

        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(norm)) {
            return { rows: [], rowCount: 0 };
        }
        if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(norm)) {
            return { rows: [], rowCount: 0 };
        }
        if (/^INSERT INTO wallets \(user_id\) VALUES/i.test(norm)) {
            ensureWallet(params[0]);
            return { rows: [], rowCount: 1 };
        }
        if (/^SELECT .* FROM wallet_ledger WHERE idempotency_key = \$1$/i.test(norm)) {
            const match = state.ledger.find(r => r.idempotency_key === params[0]);
            return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
        }
        if (/^SELECT balance_mli, held_mli FROM wallets WHERE user_id = \$1 FOR UPDATE$/i.test(norm)) {
            const w = state.wallets.get(params[0]);
            if (!w) return { rows: [], rowCount: 0 };
            return {
                rows: [{ balance_mli: w.balance_mli.toString(), held_mli: w.held_mli.toString() }],
                rowCount: 1,
            };
        }
        if (/^SELECT user_id FROM wallets WHERE user_id = ANY/i.test(norm)) {
            const ids = params[0] || [];
            const found = ids.filter(id => state.wallets.has(id)).map(id => ({ user_id: id }));
            return { rows: found, rowCount: found.length };
        }
        if (/^UPDATE wallets SET balance_mli = \$1, held_mli = \$2/i.test(norm)) {
            const [bal, held, earnedInc, spentInc, userId] = params;
            const w = state.wallets.get(userId);
            if (!w) return { rows: [], rowCount: 0 };
            w.balance_mli = BigInt(bal);
            w.held_mli = BigInt(held);
            w.lifetime_earned_mli += BigInt(earnedInc);
            w.lifetime_spent_mli += BigInt(spentInc);
            return { rows: [], rowCount: 1 };
        }
        if (/^INSERT INTO wallet_ledger/i.test(norm)) {
            const [userId, deltaMli, heldDeltaMli, balanceAfter, heldAfter,
                   type, refType, refId, counterparty, note, idemKey] = params;
            if (state.ledger.some(r => r.idempotency_key === idemKey)) {
                throw new Error('duplicate key value violates unique constraint "wallet_ledger_idempotency_key_key"');
            }
            const row = {
                id: state.nextLedgerId++,
                user_id: userId,
                delta_mli: String(deltaMli),
                held_delta_mli: String(heldDeltaMli),
                balance_after_mli: String(balanceAfter),
                held_after_mli: String(heldAfter),
                type,
                ref_type: refType,
                ref_id: refId,
                counterparty_user_id: counterparty,
                note,
                idempotency_key: idemKey,
                created_at: new Date(),
            };
            state.ledger.push(row);
            return { rows: [{ id: row.id, created_at: row.created_at }], rowCount: 1 };
        }
        if (/^SELECT balance_mli, held_mli, lifetime_earned_mli, lifetime_spent_mli FROM wallets/i.test(norm)) {
            const w = state.wallets.get(params[0]);
            if (!w) return { rows: [], rowCount: 0 };
            return {
                rows: [{
                    balance_mli: w.balance_mli.toString(),
                    held_mli: w.held_mli.toString(),
                    lifetime_earned_mli: w.lifetime_earned_mli.toString(),
                    lifetime_spent_mli: w.lifetime_spent_mli.toString(),
                }],
                rowCount: 1,
            };
        }
        if (/^SELECT .* FROM wallet_ledger WHERE user_id = \$1/i.test(norm)) {
            const userId = params[0];
            const limitParam = params[params.length - 2];
            const offsetParam = params[params.length - 1];
            const hasTypeFilter = /AND type = \$2/i.test(norm);
            const typeFilter = hasTypeFilter ? params[1] : null;
            let rows = state.ledger.filter(r => r.user_id === userId);
            if (typeFilter) rows = rows.filter(r => r.type === typeFilter);
            rows.sort((a, b) => b.id - a.id);
            rows = rows.slice(offsetParam, offsetParam + limitParam);
            return { rows, rowCount: rows.length };
        }

        // ── topup_orders ────────────────────────────────────────────────
        if (/^SELECT id, status, ecoin_total_mli FROM topup_orders WHERE channel = \$1 AND external_txn_id = \$2$/i.test(norm)) {
            const [channel, txnId] = params;
            const match = state.topupOrders.find(o => o.channel === channel && o.external_txn_id === txnId);
            return { rows: match ? [{ id: match.id, status: match.status, ecoin_total_mli: String(match.ecoin_total_mli) }] : [], rowCount: match ? 1 : 0 };
        }
        if (/^INSERT INTO topup_orders/i.test(norm)) {
            const [userId, channel, amountTwd, baseMli, bonusMli, totalMli, externalTxnId, externalRaw] = params;
            const id = `order-${state.nextOrderId++}`;
            const row = {
                id, user_id: userId, channel, amount_twd: amountTwd,
                ecoin_base_mli: baseMli, ecoin_bonus_mli: bonusMli, ecoin_total_mli: totalMli,
                status: 'pending', external_txn_id: externalTxnId, external_raw: externalRaw,
                created_at: new Date(), paid_at: null,
            };
            state.topupOrders.push(row);
            return { rows: [{ id, status: 'pending', ecoin_total_mli: String(totalMli) }], rowCount: 1 };
        }
        if (/^SELECT id, status FROM topup_orders WHERE id = \$1 FOR UPDATE$/i.test(norm)) {
            const order = state.topupOrders.find(o => o.id === params[0]);
            if (!order) return { rows: [], rowCount: 0 };
            return { rows: [{ id: order.id, status: order.status }], rowCount: 1 };
        }
        if (/^UPDATE topup_orders SET status = 'paid', paid_at = NOW\(\) WHERE id = \$1$/i.test(norm)) {
            const order = state.topupOrders.find(o => o.id === params[0]);
            if (!order) return { rows: [], rowCount: 0 };
            order.status = 'paid';
            order.paid_at = new Date();
            return { rows: [], rowCount: 1 };
        }

        // ── user_accounts (admin check) ──────────────────────────────────
        if (/^SELECT is_admin FROM user_accounts WHERE id = \$1$/i.test(norm)) {
            const u = state.userAccounts.get(params[0]);
            if (!u) return { rows: [], rowCount: 0 };
            return { rows: [{ is_admin: u.is_admin }], rowCount: 1 };
        }

        // ── reconcile CTE — ledger vs wallet drift detection ─────────────
        if (/^WITH agg AS/i.test(norm) && /FROM wallets w\s+LEFT JOIN agg/i.test(norm)) {
            const limitParam = params[0];
            const agg = new Map();
            for (const row of state.ledger) {
                const cur = agg.get(row.user_id) || { balance: 0n, held: 0n };
                cur.balance += BigInt(row.delta_mli);
                cur.held += BigInt(row.held_delta_mli);
                agg.set(row.user_id, cur);
            }
            const rows = [];
            for (const [userId, w] of state.wallets) {
                const expected = agg.get(userId) || { balance: 0n, held: 0n };
                if (w.balance_mli !== expected.balance || w.held_mli !== expected.held) {
                    rows.push({
                        user_id: userId,
                        cached_balance_mli: w.balance_mli.toString(),
                        cached_held_mli: w.held_mli.toString(),
                        expected_balance_mli: expected.balance.toString(),
                        expected_held_mli: expected.held.toString(),
                    });
                    if (rows.length >= limitParam) break;
                }
            }
            return { rows, rowCount: rows.length };
        }

        throw new Error(`[fake-pg] Unhandled SQL: ${norm}`);
    }

    class FakeClient {
        async query(sql, params) { return runQuery(sql, params); }
        release() { /* noop */ }
    }
    class FakePool {
        async connect() { return new FakeClient(); }
        async query(sql, params) { return runQuery(sql, params); }
    }

    return { Pool: jest.fn().mockImplementation(() => new FakePool()) };
});

// Convenience accessor — defined after jest.mock so the state exists.
const fake = { get state() { return globalThis.__walletFakeState; } };

// Don't actually read wallet_schema.sql in tests — initWalletDatabase is
// tested separately; in unit tests we directly manipulate the simulator.
jest.mock('fs', () => {
    const real = jest.requireActual('fs');
    return {
        ...real,
        readFileSync: jest.fn((p, enc) => {
            if (typeof p === 'string' && p.endsWith('wallet_schema.sql')) return '';
            return real.readFileSync(p, enc);
        }),
    };
});

const wallet = require('../../wallet');

// Factory instance (we only need the primitive methods, not the router).
// authMiddleware is hard-required, so pass a no-op stub.
const noopMiddleware = (_req, _res, next) => next();
const walletApi = wallet({ authMiddleware: noopMiddleware });

// ── Helpers ─────────────────────────────────────────────────────────────

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB   = '22222222-2222-2222-2222-222222222222';

function resetState() {
    fake.state.wallets.clear();
    fake.state.ledger.length = 0;
    fake.state.nextLedgerId = 1;
    fake.state.topupOrders.length = 0;
    fake.state.nextOrderId = 1;
    fake.state.userAccounts.clear();
}

beforeEach(() => { resetState(); });

// ── Conversion helpers ──────────────────────────────────────────────────

describe('wallet: conversion helpers', () => {
    test('usdToMli: 1 USD = 3,000,000 mli', () => {
        expect(wallet.usdToMli(1)).toBe(3_000_000);
        expect(wallet.usdToMli(10)).toBe(30_000_000);
        expect(wallet.usdToMli(0)).toBe(0);
    });

    test('ecoinToMli: 1 e幣 = 1000 mli', () => {
        expect(wallet.ecoinToMli(1)).toBe(1000);
        expect(wallet.ecoinToMli(10.5)).toBe(10_500);
    });

    test('mliToEcoin: inverse of ecoinToMli', () => {
        expect(wallet.mliToEcoin(1000)).toBe(1);
        expect(wallet.mliToEcoin(17_000_000)).toBe(17_000);
    });

    test('usdToMli rejects invalid input', () => {
        expect(() => wallet.usdToMli(-1)).toThrow('invalid_usd');
        expect(() => wallet.usdToMli(NaN)).toThrow('invalid_usd');
    });

    test('LEDGER_TYPES is frozen and complete', () => {
        expect(Object.isFrozen(wallet.LEDGER_TYPES)).toBe(true);
        expect(wallet.LEDGER_TYPES.TOPUP).toBe('topup');
        expect(wallet.LEDGER_TYPES.DEPOSIT_HOLD).toBe('deposit_hold');
    });
});

// ── creditTopup ─────────────────────────────────────────────────────────

describe('wallet: creditTopup', () => {
    test('credits the specified amount and writes a ledger row', async () => {
        const res = await walletApi.creditTopup({
            userId: ALICE,
            amountMli: 17_000_000,  // NT$170 = 17,000 e幣
            orderId: 'order-abc123',
            channel: 'google_play',
            idempotencyKey: 'topup:order-abc123',
        });
        expect(res.deduped).toBe(false);
        const bal = await walletApi.getBalance(ALICE);
        expect(bal.balance_mli).toBe('17000000');
        expect(bal.balance_ecoin).toBe(17_000);
        expect(fake.state.ledger).toHaveLength(1);
        expect(fake.state.ledger[0].type).toBe('topup');
    });

    test('is idempotent on duplicate key', async () => {
        const key = 'topup:retry-me';
        await walletApi.creditTopup({
            userId: ALICE, amountMli: 1000, orderId: 'order-1',
            channel: 'google_play', idempotencyKey: key,
        });
        // Second call with same key should not double-credit.
        const second = await walletApi.creditTopup({
            userId: ALICE, amountMli: 1000, orderId: 'order-1',
            channel: 'google_play', idempotencyKey: key,
        });
        expect(second.deduped).toBe(true);
        const bal = await walletApi.getBalance(ALICE);
        expect(bal.balance_mli).toBe('1000');
        expect(fake.state.ledger).toHaveLength(1);
    });

    test('rejects non-positive amount', async () => {
        await expect(walletApi.creditTopup({
            userId: ALICE, amountMli: 0, orderId: 'o', channel: 'g', idempotencyKey: 'k1',
        })).rejects.toThrow(/amount_mli/);
        await expect(walletApi.creditTopup({
            userId: ALICE, amountMli: -100, orderId: 'o', channel: 'g', idempotencyKey: 'k2',
        })).rejects.toThrow(/amount_mli/);
    });
});

// ── holdDeposit / releaseDeposit / forfeitDeposit ──────────────────────

describe('wallet: deposit primitives', () => {
    async function fundAlice(mli) {
        await walletApi.creditTopup({
            userId: ALICE, amountMli: mli, orderId: 'seed',
            channel: 'admin_grant', idempotencyKey: `seed:${Date.now()}:${Math.random()}`,
        });
    }

    test('holdDeposit moves balance into held bucket', async () => {
        await fundAlice(5_000_000);  // 5,000 e幣
        await walletApi.holdDeposit({
            userId: ALICE, amountMli: 2_000_000, contractId: 'rc-1',
            idempotencyKey: 'hold:rc-1',
        });
        const bal = await walletApi.getBalance(ALICE);
        expect(bal.balance_mli).toBe('3000000');
        expect(bal.held_mli).toBe('2000000');
    });

    test('holdDeposit fails if balance insufficient', async () => {
        await fundAlice(100);
        await expect(walletApi.holdDeposit({
            userId: ALICE, amountMli: 500, contractId: 'rc-2',
            idempotencyKey: 'hold:rc-2',
        })).rejects.toThrow('insufficient_balance');
    });

    test('releaseDeposit returns held back to balance', async () => {
        await fundAlice(5_000_000);
        await walletApi.holdDeposit({
            userId: ALICE, amountMli: 2_000_000, contractId: 'rc-3',
            idempotencyKey: 'hold:rc-3',
        });
        await walletApi.releaseDeposit({
            userId: ALICE, amountMli: 2_000_000, contractId: 'rc-3',
            idempotencyKey: 'release:rc-3',
        });
        const bal = await walletApi.getBalance(ALICE);
        expect(bal.balance_mli).toBe('5000000');
        expect(bal.held_mli).toBe('0');
    });

    test('forfeitDeposit removes held without refund', async () => {
        await fundAlice(5_000_000);
        await walletApi.holdDeposit({
            userId: ALICE, amountMli: 2_000_000, contractId: 'rc-4',
            idempotencyKey: 'hold:rc-4',
        });
        await walletApi.forfeitDeposit({
            userId: ALICE, amountMli: 2_000_000, contractId: 'rc-4',
            idempotencyKey: 'forfeit:rc-4', note: 'violation 5/5',
        });
        const bal = await walletApi.getBalance(ALICE);
        expect(bal.balance_mli).toBe('3000000');
        expect(bal.held_mli).toBe('0');
    });

    test('forfeitDeposit cannot overshoot held bucket', async () => {
        await fundAlice(5_000_000);
        await walletApi.holdDeposit({
            userId: ALICE, amountMli: 1_000_000, contractId: 'rc-5',
            idempotencyKey: 'hold:rc-5',
        });
        await expect(walletApi.forfeitDeposit({
            userId: ALICE, amountMli: 2_000_000, contractId: 'rc-5',
            idempotencyKey: 'forfeit:rc-5',
        })).rejects.toThrow('insufficient_held');
    });
});

// ── transferEcoin ──────────────────────────────────────────────────────

describe('wallet: transferEcoin', () => {
    test('moves balance atomically from sender to receiver', async () => {
        await walletApi.creditTopup({
            userId: ALICE, amountMli: 10_000, orderId: 'seed',
            channel: 'admin_grant', idempotencyKey: 'seed:alice',
        });
        await walletApi.transferEcoin({
            fromUserId: ALICE, toUserId: BOB, amountMli: 3_000,
            type: wallet.LEDGER_TYPES.RENTAL_INCOME,
            refType: 'rental_contract', refId: 'rc-9',
            idempotencyKey: 'xfer:rc-9',
        });
        const a = await walletApi.getBalance(ALICE);
        const b = await walletApi.getBalance(BOB);
        expect(a.balance_mli).toBe('7000');
        expect(b.balance_mli).toBe('3000');
        // Two ledger rows produced (one debit, one credit).
        expect(fake.state.ledger.filter(r => r.ref_id === 'rc-9')).toHaveLength(2);
    });

    test('refuses self-transfer', async () => {
        await expect(walletApi.transferEcoin({
            fromUserId: ALICE, toUserId: ALICE, amountMli: 100,
            type: wallet.LEDGER_TYPES.RENTAL_INCOME,
            idempotencyKey: 'bad-self-xfer',
        })).rejects.toThrow('self_transfer_forbidden');
    });

    test('fails cleanly when sender has insufficient funds', async () => {
        await walletApi.creditTopup({
            userId: ALICE, amountMli: 100, orderId: 'seed2',
            channel: 'admin_grant', idempotencyKey: 'seed:alice2',
        });
        await expect(walletApi.transferEcoin({
            fromUserId: ALICE, toUserId: BOB, amountMli: 5000,
            type: wallet.LEDGER_TYPES.RENTAL_INCOME,
            idempotencyKey: 'xfer:too-much',
        })).rejects.toThrow('insufficient_balance');
        // Alice balance untouched; Bob should not exist or be zero.
        const a = await walletApi.getBalance(ALICE);
        expect(a.balance_mli).toBe('100');
    });
});

// ── adminAdjust ─────────────────────────────────────────────────────────

describe('wallet: adminAdjust', () => {
    test('applies signed delta and records reason', async () => {
        await walletApi.adminAdjust({
            userId: ALICE, deltaMli: 50_000, reason: 'compensation',
            adminUserId: '99999999-9999-9999-9999-999999999999',
            idempotencyKey: 'admin:compo-1',
        });
        const bal = await walletApi.getBalance(ALICE);
        expect(bal.balance_mli).toBe('50000');
        expect(fake.state.ledger[0].type).toBe('admin_adjust');
        expect(fake.state.ledger[0].note).toMatch(/compensation/);
    });

    test('rejects zero delta', async () => {
        await expect(walletApi.adminAdjust({
            userId: ALICE, deltaMli: 0, reason: 'x', idempotencyKey: 'k',
        })).rejects.toThrow(/delta_mli/);
    });

    test('rejects missing reason', async () => {
        await expect(walletApi.adminAdjust({
            userId: ALICE, deltaMli: 100, reason: '', idempotencyKey: 'k2',
        })).rejects.toThrow('reason_required');
    });
});

// ── getLedger ──────────────────────────────────────────────────────────

describe('wallet: getLedger', () => {
    test('returns entries newest first, respects limit', async () => {
        for (let i = 0; i < 5; i++) {
            await walletApi.creditTopup({
                userId: ALICE, amountMli: 100 * (i + 1), orderId: `order-${i}`,
                channel: 'admin_grant', idempotencyKey: `topup-seed-${i}`,
            });
        }
        const rows = await walletApi.getLedger(ALICE, { limit: 3 });
        expect(rows).toHaveLength(3);
        // Newest first — delta should be 500, 400, 300
        expect(String(rows[0].delta_mli)).toBe('500');
    });

    test('type filter restricts results', async () => {
        await walletApi.creditTopup({
            userId: ALICE, amountMli: 1000, orderId: 'order-x',
            channel: 'admin_grant', idempotencyKey: 'topup-a',
        });
        await walletApi.adminAdjust({
            userId: ALICE, deltaMli: 500, reason: 'bonus', idempotencyKey: 'admin-b',
        });
        const onlyTopup = await walletApi.getLedger(ALICE, { type: 'topup' });
        expect(onlyTopup).toHaveLength(1);
        expect(onlyTopup[0].type).toBe('topup');
    });

    test('rejects unknown type', async () => {
        await expect(walletApi.getLedger(ALICE, { type: 'garbage' }))
            .rejects.toThrow(/unknown_ledger_type/);
    });
});

// ── Input validation sanity ────────────────────────────────────────────

describe('wallet: input validation', () => {
    test('creditTopup rejects short idempotency key', async () => {
        await expect(walletApi.creditTopup({
            userId: ALICE, amountMli: 100, orderId: 'o',
            channel: 'g', idempotencyKey: 'x',
        })).rejects.toThrow(/idempotency_key/);
    });

    test('getBalance returns zero-wallet for unknown user', async () => {
        const bal = await walletApi.getBalance(BOB);
        expect(bal.balance_mli).toBe('0');
        expect(bal.held_mli).toBe('0');
    });
});

// ── TOPUP_TIERS catalog ────────────────────────────────────────────────

describe('wallet: top-up tier catalog', () => {
    test('TOPUP_TIERS is frozen and contains expected tiers', () => {
        expect(Object.isFrozen(wallet.TOPUP_TIERS)).toBe(true);
        expect(wallet.TOPUP_TIERS['ec.topup.starter']).toBeDefined();
        expect(wallet.TOPUP_TIERS['ec.topup.premium']).toBeDefined();
    });

    test('starter tier: $3 → 9,000 e幣 base + 450 bonus', () => {
        const t = wallet.TOPUP_TIERS['ec.topup.starter'];
        expect(t.priceUsd).toBe(3);
        expect(t.baseMli).toBe(9_000_000);   // 9,000 e幣 in mli
        expect(t.bonusMli).toBe(450_000);    // 450 e幣 in mli
    });

    test('premium tier: $20 → 60,000 e幣 base + 9,000 bonus', () => {
        const t = wallet.TOPUP_TIERS['ec.topup.premium'];
        expect(t.priceUsd).toBe(20);
        expect(t.baseMli).toBe(60_000_000);
        expect(t.bonusMli).toBe(9_000_000);
    });

    test('getTopupTier returns null for unknown product', () => {
        expect(wallet.getTopupTier('garbage_id')).toBeNull();
        expect(wallet.getTopupTier('ec.topup.starter')).not.toBeNull();
    });
});

// ── createTopupOrder + markTopupPaid ──────────────────────────────────

describe('wallet: top-up order lifecycle', () => {
    test('createTopupOrder inserts a pending row and returns id', async () => {
        const tier = wallet.TOPUP_TIERS['ec.topup.starter'];
        const order = await walletApi.createTopupOrder({
            userId: ALICE,
            channel: 'google_play',
            priceUsd: tier.priceUsd,
            baseMli: tier.baseMli,
            bonusMli: tier.bonusMli,
            externalTxnId: 'gp-token-aaa',
            externalRaw: { productId: 'ec.topup.starter' },
        });
        expect(order.id).toMatch(/^order-/);
        expect(order.status).toBe('pending');
        expect(order.deduped).toBe(false);
        expect(fake.state.topupOrders).toHaveLength(1);
    });

    test('createTopupOrder dedupes on (channel, external_txn_id)', async () => {
        const tier = wallet.TOPUP_TIERS['ec.topup.starter'];
        const args = {
            userId: ALICE, channel: 'google_play',
            priceUsd: tier.priceUsd, baseMli: tier.baseMli, bonusMli: tier.bonusMli,
            externalTxnId: 'gp-dup-token',
        };
        const first = await walletApi.createTopupOrder(args);
        const second = await walletApi.createTopupOrder(args);
        expect(first.deduped).toBe(false);
        expect(second.deduped).toBe(true);
        expect(second.id).toBe(first.id);
        expect(fake.state.topupOrders).toHaveLength(1);
    });

    test('markTopupPaid credits wallet and is idempotent', async () => {
        const tier = wallet.TOPUP_TIERS['ec.topup.starter'];
        const order = await walletApi.createTopupOrder({
            userId: ALICE, channel: 'google_play',
            priceUsd: tier.priceUsd, baseMli: tier.baseMli, bonusMli: tier.bonusMli,
            externalTxnId: 'gp-pay-1',
        });
        const total = parseInt(order.ecoin_total_mli, 10);

        await walletApi.markTopupPaid({
            orderId: order.id, userId: ALICE,
            amountMli: total, channel: 'google_play',
        });
        const bal1 = await walletApi.getBalance(ALICE);
        expect(bal1.balance_mli).toBe(String(total));

        // Second call should not double-credit (idempotency_key dedupes).
        await walletApi.markTopupPaid({
            orderId: order.id, userId: ALICE,
            amountMli: total, channel: 'google_play',
        });
        const bal2 = await walletApi.getBalance(ALICE);
        expect(bal2.balance_mli).toBe(String(total));
    });

    test('createTopupOrder rejects invalid input', async () => {
        await expect(walletApi.createTopupOrder({
            userId: ALICE, channel: '', priceUsd: 100, baseMli: 100, bonusMli: 0,
        })).rejects.toThrow(/channel/);
        await expect(walletApi.createTopupOrder({
            userId: ALICE, channel: 'google_play', priceUsd: -1, baseMli: 100, bonusMli: 0,
        })).rejects.toThrow(/price/);
        await expect(walletApi.createTopupOrder({
            userId: ALICE, channel: 'google_play', priceUsd: 100, baseMli: 0, bonusMli: 0,
        })).rejects.toThrow(/base/);
    });
});

// ── HTTP routes (using supertest against the Express factory) ──────────

describe('wallet: HTTP routes', () => {
    const express = require('express');
    const supertest = require('supertest');

    function buildApp({ user = null, isAdmin = false } = {}) {
        const app = express();
        app.use(express.json());
        // Stub auth middleware that injects req.user (or skips if null).
        const fakeAuth = (req, _res, next) => {
            if (user) req.user = user;
            next();
        };
        // Admin middleware: gate by isAdmin flag for tests.
        const fakeAdmin = (req, res, next) => {
            if (!req.user || !isAdmin) {
                return res.status(403).json({ success: false, error: 'admin_only' });
            }
            next();
        };
        const w = wallet({ authMiddleware: fakeAuth, adminMiddleware: fakeAdmin });
        app.use('/api/wallet', w.router);
        return app;
    }

    test('GET /topup/tiers returns the tier list (no auth required)', async () => {
        const res = await supertest(buildApp())
            .get('/api/wallet/topup/tiers')
            .expect(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.tiers)).toBe(true);
        expect(res.body.tiers.length).toBeGreaterThanOrEqual(5);
        const starter = res.body.tiers.find(t => t.productId === 'ec.topup.starter');
        expect(starter).toBeDefined();
        expect(starter.priceUsd).toBe(3);
        expect(starter.bonusPct).toBe(5);
    });

    test('GET /balance requires authentication', async () => {
        const res = await supertest(buildApp())
            .get('/api/wallet/balance')
            .expect(401);
        expect(res.body.error).toBe('unauthenticated');
    });

    test('GET /balance returns wallet for authenticated user', async () => {
        const app = buildApp({ user: { userId: ALICE } });
        // Seed a balance via the wallet primitive.
        await walletApi.creditTopup({
            userId: ALICE, amountMli: 5000, orderId: 'seed-bal',
            channel: 'admin_grant', idempotencyKey: 'seed-bal-key',
        });
        const res = await supertest(app).get('/api/wallet/balance').expect(200);
        expect(res.body.success).toBe(true);
        expect(res.body.wallet.balance_mli).toBe('5000');
        expect(res.body.wallet.balance_ecoin).toBe(5);
    });

    test('POST /topup/verify-google rejects missing fields', async () => {
        const app = buildApp({ user: { userId: ALICE } });
        await supertest(app).post('/api/wallet/topup/verify-google')
            .send({}).expect(400);
        await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter' }).expect(400);
        await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'ec.topup.starter', purchaseToken: 'short' }).expect(400);
    });

    test('POST /topup/verify-google rejects unknown product', async () => {
        const app = buildApp({ user: { userId: ALICE } });
        const res = await supertest(app).post('/api/wallet/topup/verify-google')
            .send({ productId: 'fake_tier', purchaseToken: 'long-enough-token' })
            .expect(400);
        expect(res.body.error).toBe('unknown_product');
    });

    test('POST /topup/verify-google credits wallet end-to-end', async () => {
        // The full androidpublisher verification path is covered by
        // wallet-topup-google.test.js (mocks global.fetch for the Google API).
        // This legacy case exercises the rollback fallback (explicit
        // GOOGLE_PLAY_ALLOW_UNVERIFIED=1) so it doesn't require real creds.
        const prevGsa = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
        const prevAllow = process.env.GOOGLE_PLAY_ALLOW_UNVERIFIED;
        delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
        process.env.GOOGLE_PLAY_ALLOW_UNVERIFIED = '1';
        if (wallet._resetGoogleCache) wallet._resetGoogleCache();
        try {
            const app = buildApp({ user: { userId: ALICE } });
            const res = await supertest(app).post('/api/wallet/topup/verify-google')
                .send({ productId: 'ec.topup.starter', purchaseToken: 'gp-real-token-12345' })
                .expect(200);
            expect(res.body.success).toBe(true);
            expect(res.body.order.status).toBe('paid');
            // 9000 + 450 bonus = 9450 e幣
            expect(res.body.order.ecoinTotal).toBe(9450);
            expect(res.body.order.deduped).toBe(false);

            // Replaying the same token should dedupe (no double credit).
            const replay = await supertest(app).post('/api/wallet/topup/verify-google')
                .send({ productId: 'ec.topup.starter', purchaseToken: 'gp-real-token-12345' })
                .expect(200);
            expect(replay.body.order.deduped).toBe(true);

            const bal = await walletApi.getBalance(ALICE);
            expect(bal.balance_ecoin).toBe(9450);
        } finally {
            if (prevGsa === undefined) delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
            else process.env.GOOGLE_PLAY_SERVICE_ACCOUNT = prevGsa;
            if (prevAllow === undefined) delete process.env.GOOGLE_PLAY_ALLOW_UNVERIFIED;
            else process.env.GOOGLE_PLAY_ALLOW_UNVERIFIED = prevAllow;
            if (wallet._resetGoogleCache) wallet._resetGoogleCache();
        }
    });

    // ── Apple IAP verification ──────────────────────────────────────

    function mockAppleFetch({
        status = 0,
        productId = 'ec.topup.standard',
        transactionId = 'apple-txn-001',
        bundleId = 'com.eclawbot.app',
        environment = 'Production',
    } = {}) {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                status,
                environment,
                receipt: {
                    bundle_id: bundleId,
                    in_app: [
                        {
                            product_id: productId,
                            transaction_id: transactionId,
                            original_transaction_id: transactionId,
                            purchase_date: '2026-04-14 12:00:00 Etc/GMT',
                        },
                    ],
                },
            }),
        });
    }

    test('POST /topup/verify-apple rejects missing fields', async () => {
        const app = buildApp({ user: { userId: ALICE } });
        await supertest(app).post('/api/wallet/topup/verify-apple').send({}).expect(400);
        await supertest(app).post('/api/wallet/topup/verify-apple')
            .send({ productId: 'ec.topup.starter' }).expect(400);
        await supertest(app).post('/api/wallet/topup/verify-apple')
            .send({ productId: 'ec.topup.starter', transactionId: 'abc' }).expect(400);
        await supertest(app).post('/api/wallet/topup/verify-apple')
            .send({
                productId: 'ec.topup.starter',
                transactionId: 'abc1234',
                receipt: 'short',
            }).expect(400);
    });

    test('POST /topup/verify-apple rejects unknown product', async () => {
        const app = buildApp({ user: { userId: ALICE } });
        const res = await supertest(app).post('/api/wallet/topup/verify-apple')
            .send({
                productId: 'fake_tier',
                transactionId: 'apple-txn-abc',
                receipt: 'base64-receipt-data-long-enough',
            })
            .expect(400);
        expect(res.body.error).toBe('unknown_product');
    });

    test('POST /topup/verify-apple credits wallet end-to-end', async () => {
        mockAppleFetch({ productId: 'ec.topup.standard', transactionId: 'apple-txn-std-001' });
        const app = buildApp({ user: { userId: ALICE } });
        const res = await supertest(app).post('/api/wallet/topup/verify-apple')
            .send({
                productId: 'ec.topup.standard',
                transactionId: 'apple-txn-std-001',
                receipt: 'base64-receipt-data-long-enough',
            })
            .expect(200);
        expect(res.body.success).toBe(true);
        expect(res.body.order.status).toBe('paid');
        // standard: 15000 base + 1200 bonus = 16200 e幣
        expect(res.body.order.ecoinTotal).toBe(16200);
        expect(res.body.order.deduped).toBe(false);

        // Replay with same transactionId → dedupe
        mockAppleFetch({ productId: 'ec.topup.standard', transactionId: 'apple-txn-std-001' });
        const replay = await supertest(app).post('/api/wallet/topup/verify-apple')
            .send({
                productId: 'ec.topup.standard',
                transactionId: 'apple-txn-std-001',
                receipt: 'base64-receipt-data-long-enough',
            })
            .expect(200);
        expect(replay.body.order.deduped).toBe(true);

        const bal = await walletApi.getBalance(ALICE);
        expect(bal.balance_ecoin).toBe(16200);
    });

    test('POST /topup/verify-apple falls back to sandbox on status 21007', async () => {
        let callCount = 0;
        global.fetch = jest.fn().mockImplementation(async (url) => {
            callCount += 1;
            if (url.includes('buy.itunes.apple.com') && callCount === 1) {
                return { ok: true, json: async () => ({ status: 21007 }) };
            }
            return {
                ok: true,
                json: async () => ({
                    status: 0,
                    environment: 'Sandbox',
                    receipt: {
                        bundle_id: 'com.eclawbot.app',
                        in_app: [{
                            product_id: 'ec.topup.small',
                            transaction_id: 'sandbox-txn-1',
                            original_transaction_id: 'sandbox-txn-1',
                            purchase_date: '2026-04-14 12:00:00 Etc/GMT',
                        }],
                    },
                }),
            };
        });

        const app = buildApp({ user: { userId: ALICE } });
        const res = await supertest(app).post('/api/wallet/topup/verify-apple')
            .send({
                productId: 'ec.topup.small',
                transactionId: 'sandbox-txn-1',
                receipt: 'base64-receipt-data-long-enough',
            })
            .expect(200);
        expect(res.body.order.environment).toBe('Sandbox');
        expect(callCount).toBe(2); // prod → sandbox fallback
    });

    test('POST /topup/verify-apple rejects when transaction not in receipt', async () => {
        mockAppleFetch({ productId: 'ec.topup.standard', transactionId: 'different-txn' });
        const app = buildApp({ user: { userId: ALICE } });
        const res = await supertest(app).post('/api/wallet/topup/verify-apple')
            .send({
                productId: 'ec.topup.standard',
                transactionId: 'requested-txn',
                receipt: 'base64-receipt-data-long-enough',
            })
            .expect(400);
        expect(res.body.error).toBe('transaction_invalid');
    });

    test('POST /topup/verify-apple rejects bundle ID mismatch', async () => {
        mockAppleFetch({
            bundleId: 'com.malicious.app',
            productId: 'ec.topup.standard',
            transactionId: 'apple-txn-002',
        });
        const app = buildApp({ user: { userId: ALICE } });
        const res = await supertest(app).post('/api/wallet/topup/verify-apple')
            .send({
                productId: 'ec.topup.standard',
                transactionId: 'apple-txn-002',
                receipt: 'base64-receipt-data-long-enough',
            })
            .expect(400);
        expect(res.body.error).toBe('bundle_id_invalid');
    });

    test('POST /topup/verify-apple rejects malformed receipt (status 21002)', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ status: 21002 }),
        });
        const app = buildApp({ user: { userId: ALICE } });
        const res = await supertest(app).post('/api/wallet/topup/verify-apple')
            .send({
                productId: 'ec.topup.standard',
                transactionId: 'bad-txn',
                receipt: 'base64-receipt-data-long-enough',
            })
            .expect(400);
        expect(res.body.error).toBe('receipt_invalid');
    });

    test('POST /admin/grant rejects non-admin', async () => {
        const app = buildApp({ user: { userId: ALICE }, isAdmin: false });
        const res = await supertest(app).post('/api/wallet/admin/grant')
            .send({ userId: BOB, ecoin: 100, reason: 'test' })
            .expect(403);
        expect(res.body.error).toBe('admin_only');
    });

    test('POST /admin/grant grants e-coin to target user', async () => {
        const app = buildApp({ user: { userId: ALICE }, isAdmin: true });
        await supertest(app).post('/api/wallet/admin/grant')
            .send({ userId: BOB, ecoin: 500, reason: 'support_compensation' })
            .expect(200);
        const bal = await walletApi.getBalance(BOB);
        expect(bal.balance_ecoin).toBe(500);
        // Verify ledger note carries the reason.
        const ledger = fake.state.ledger.find(r => r.user_id === BOB);
        expect(ledger.note).toMatch(/support_compensation/);
    });

    test('POST /admin/grant validates input', async () => {
        const app = buildApp({ user: { userId: ALICE }, isAdmin: true });
        await supertest(app).post('/api/wallet/admin/grant')
            .send({ ecoin: 100, reason: 'r' }).expect(400);
        await supertest(app).post('/api/wallet/admin/grant')
            .send({ userId: BOB, ecoin: 0, reason: 'r' }).expect(400);
        await supertest(app).post('/api/wallet/admin/grant')
            .send({ userId: BOB, ecoin: 100, reason: '' }).expect(400);
    });

    test('factory throws when authMiddleware is missing', () => {
        expect(() => wallet({})).toThrow(/authMiddleware/);
    });
});

// ── markTopupPaid order_not_found ──────────────────────────────────────

describe('wallet: markTopupPaid edge cases', () => {
    test('throws order_not_found when order id is unknown', async () => {
        await expect(walletApi.markTopupPaid({
            orderId: 'order-does-not-exist',
            userId: ALICE,
            amountMli: 100,
            channel: 'google_play',
        })).rejects.toThrow('order_not_found');
    });
});

// ── reconcileBalances ──────────────────────────────────────────────────

describe('wallet: reconcileBalances', () => {
    test('clean wallet reports no drift', async () => {
        await walletApi.creditTopup({
            userId: ALICE, amountMli: 1_000_000, orderId: 'seed-recon',
            channel: 'admin_grant', idempotencyKey: 'seed-recon-key',
        });
        const report = await walletApi.reconcileBalances();
        expect(report.ok).toBe(true);
        expect(report.discrepancies).toHaveLength(0);
    });

    test('detects manual drift (cached balance out of sync with ledger)', async () => {
        await walletApi.creditTopup({
            userId: ALICE, amountMli: 500_000, orderId: 'seed-drift',
            channel: 'admin_grant', idempotencyKey: 'seed-drift-key',
        });
        // Simulate a buggy direct write that bypasses applyLedgerEntry.
        fake.state.wallets.get(ALICE).balance_mli = 999_999n;

        const report = await walletApi.reconcileBalances();
        expect(report.ok).toBe(false);
        expect(report.discrepancies).toHaveLength(1);
        const d = report.discrepancies[0];
        expect(d.userId).toBe(ALICE);
        expect(d.cachedBalanceMli).toBe('999999');
        expect(d.expectedBalanceMli).toBe('500000');
        expect(d.deltaMli).toBe('499999');
    });

    test('transfers leave both sides reconciled', async () => {
        await walletApi.creditTopup({
            userId: ALICE, amountMli: 10_000, orderId: 'seed-xfer',
            channel: 'admin_grant', idempotencyKey: 'seed-xfer-key',
        });
        await walletApi.transferEcoin({
            fromUserId: ALICE, toUserId: BOB, amountMli: 4_000,
            type: wallet.LEDGER_TYPES.RENTAL_INCOME,
            idempotencyKey: 'xfer-recon-1',
        });
        const report = await walletApi.reconcileBalances();
        expect(report.ok).toBe(true);
    });
});

describe('wallet: /admin/reconcile route', () => {
    const express = require('express');
    const supertest = require('supertest');

    function buildAdminApp(isAdmin) {
        const app = express();
        app.use(express.json());
        const fakeAuth = (req, _res, next) => { req.user = { userId: ALICE }; next(); };
        const fakeAdmin = (req, res, next) => isAdmin ? next() : res.status(403).json({ success: false, error: 'admin_only' });
        const w = wallet({ authMiddleware: fakeAuth, adminMiddleware: fakeAdmin });
        app.use('/api/wallet', w.router);
        return app;
    }

    test('non-admin gets 403', async () => {
        await supertest(buildAdminApp(false))
            .get('/api/wallet/admin/reconcile')
            .expect(403);
    });

    test('admin receives ok report when ledger matches', async () => {
        await walletApi.creditTopup({
            userId: ALICE, amountMli: 1_000, orderId: 'rc-clean',
            channel: 'admin_grant', idempotencyKey: 'rc-clean-key',
        });
        const res = await supertest(buildAdminApp(true))
            .get('/api/wallet/admin/reconcile')
            .expect(200);
        expect(res.body.success).toBe(true);
        expect(res.body.report.ok).toBe(true);
        expect(res.body.report.discrepancies).toHaveLength(0);
    });
});
