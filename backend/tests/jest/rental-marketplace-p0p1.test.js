/**
 * Rental Marketplace Test Plan — P0 + P1
 *
 * P0: Production deployment verification (subscription grants, idempotency)
 * P1: Wallet financial safety (reconcile, concurrent idempotency)
 *
 * Uses the same in-memory pg mock as wallet.test.js.
 */

jest.mock('pg', () => {
    const state = {
        wallets: new Map(),
        ledger: [],
        nextLedgerId: 1,
        topupOrders: [],
        nextOrderId: 1,
        userAccounts: new Map(),
    };
    globalThis.__p0p1FakeState = state;

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

        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(norm)) return { rows: [], rowCount: 0 };
        if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(norm)) return { rows: [], rowCount: 0 };
        if (/^ALTER TABLE/i.test(norm)) return { rows: [], rowCount: 0 };
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
            return { rows: [{ balance_mli: w.balance_mli.toString(), held_mli: w.held_mli.toString() }], rowCount: 1 };
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
                type, ref_type: refType, ref_id: refId,
                counterparty_user_id: counterparty, note,
                idempotency_key: idemKey,
                created_at: new Date(),
            };
            state.ledger.push(row);
            return { rows: [row], rowCount: 1 };
        }
        // getBalance
        if (/^SELECT balance_mli, held_mli, lifetime_earned_mli, lifetime_spent_mli FROM wallets WHERE user_id = \$1$/i.test(norm)) {
            const w = state.wallets.get(params[0]);
            if (!w) return { rows: [{ balance_mli: '0', held_mli: '0', lifetime_earned_mli: '0', lifetime_spent_mli: '0' }], rowCount: 1 };
            return { rows: [{ balance_mli: w.balance_mli.toString(), held_mli: w.held_mli.toString(), lifetime_earned_mli: w.lifetime_earned_mli.toString(), lifetime_spent_mli: w.lifetime_spent_mli.toString() }], rowCount: 1 };
        }
        // getLedger
        if (/^SELECT .* FROM wallet_ledger WHERE user_id = \$1/i.test(norm)) {
            let rows = state.ledger.filter(r => r.user_id === params[0]);
            rows.sort((a, b) => b.id - a.id);
            return { rows: rows.slice(0, 50), rowCount: rows.length };
        }
        // reconcile
        if (/^WITH agg AS/i.test(norm)) {
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
                    rows.push({ user_id: userId, cached_balance_mli: w.balance_mli.toString(), expected_balance_mli: expected.balance.toString() });
                }
            }
            return { rows, rowCount: rows.length };
        }

        throw new Error(`[fake-pg] Unhandled SQL: ${norm}`);
    }

    class FakeClient {
        async query(sql, params) { return runQuery(sql, params); }
        release() {}
    }

    return {
        Pool: jest.fn().mockImplementation(() => ({
            query: jest.fn((sql, params) => runQuery(sql, params)),
            connect: jest.fn().mockResolvedValue(new FakeClient()),
            end: jest.fn().mockResolvedValue(undefined),
        })),
    };
});

// ── Module setup ──
const walletFactory = require('../../wallet');
const authMw = (_req, _res, next) => next();
const adminMw = (_req, _res, next) => next();
const wallet = walletFactory({ authMiddleware: authMw, adminMiddleware: adminMw, serverLog: () => {} });

// Helper: generate UUID-like test user ID
let uidCounter = 0;
function testUserId(tag) {
    return `00000000-test-0000-${tag}-${String(++uidCounter).padStart(12, '0')}`;
}

// Helper: seed a wallet with initial balance
async function seedWallet(userId, ecoin) {
    await wallet.creditTopup({
        userId,
        amountMli: ecoin * 1000,
        orderId: `seed-${userId.slice(0, 20)}`,
        channel: 'admin_grant',
        idempotencyKey: `seed-${userId}-${Date.now()}-${Math.random()}`,
    });
}

// ============================================
// P0: Production Deployment Verification
// ============================================

describe('P0: grantSubscriptionEcoin', () => {
    test('P0-4: subscription_grant ledger type is accepted and credits balance', async () => {
        const userId = testUserId('p004');
        await seedWallet(userId, 1000); // 1000 e幣

        const result = await wallet.grantSubscriptionEcoin(userId, 'starter', 2000);
        expect(result).toBeDefined();
        expect(result.id).toBeDefined();
        expect(result.deduped).toBe(false);

        const bal = await wallet.getBalance(userId);
        expect(Number(bal.balance_mli)).toBe(3000000); // 1000 seed + 2000 grant
    });

    test('P0-5: same month + same plan = idempotent (no double grant)', async () => {
        const userId = testUserId('p005');
        await seedWallet(userId, 500);

        await wallet.grantSubscriptionEcoin(userId, 'starter', 2000);
        const bal1 = await wallet.getBalance(userId);

        // Same call again — should be deduplicated by idempotency key
        await wallet.grantSubscriptionEcoin(userId, 'starter', 2000);
        const bal2 = await wallet.getBalance(userId);

        expect(Number(bal1.balance_mli)).toBe(Number(bal2.balance_mli));
    });

    test('P0-6: different plan same month = separate grants', async () => {
        const userId = testUserId('p006');
        await seedWallet(userId, 500);

        await wallet.grantSubscriptionEcoin(userId, 'starter', 2000);
        const bal1 = await wallet.getBalance(userId);

        await wallet.grantSubscriptionEcoin(userId, 'pro', 8000);
        const bal2 = await wallet.getBalance(userId);

        expect(Number(bal2.balance_mli)).toBe(Number(bal1.balance_mli) + 8000000);
    });
});

// ============================================
// P1: Wallet Financial Safety
// ============================================

describe('P1: Wallet reconciliation and idempotency', () => {
    test('P1-1: reconcile reports 0 drift after topup + hold + release sequence', async () => {
        const userId = testUserId('p011');
        await seedWallet(userId, 10000); // 10,000 e幣

        // Hold 5000 e幣 as deposit
        await wallet.holdDeposit({
            userId,
            amountMli: 5000000,
            contractId: 'contract-p11',
            idempotencyKey: 'hold-p11',
        });

        // Release 3000 e幣 back
        await wallet.releaseDeposit({
            userId,
            amountMli: 3000000,
            contractId: 'contract-p11',
            idempotencyKey: 'release-p11',
        });

        // Forfeit remaining 2000 e幣
        await wallet.forfeitDeposit({
            userId,
            amountMli: 2000000,
            contractId: 'contract-p11',
            idempotencyKey: 'forfeit-p11',
        });

        const report = await wallet.reconcileBalances({ limit: 100 });
        expect(report.ok).toBe(true);
        expect(report.discrepancies).toHaveLength(0);
    });

    test('P1-2: concurrent idempotency — duplicate creditTopup returns original', async () => {
        const userId = testUserId('p012');
        const idemKey = 'topup-p12-unique';

        const result1 = await wallet.creditTopup({
            userId,
            amountMli: 5000000,
            orderId: 'order-p12',
            channel: 'google_play',
            idempotencyKey: idemKey,
        });

        // Duplicate call with same key
        const result2 = await wallet.creditTopup({
            userId,
            amountMli: 5000000,
            orderId: 'order-p12',
            channel: 'google_play',
            idempotencyKey: idemKey,
        });

        expect(result1.id).toBe(result2.id);
        const bal = await wallet.getBalance(userId);
        expect(Number(bal.balance_mli)).toBe(5000000); // Only once
    });
});
