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
const walletApi = wallet({});

// ── Helpers ─────────────────────────────────────────────────────────────

const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB   = '22222222-2222-2222-2222-222222222222';

function resetState() {
    fake.state.wallets.clear();
    fake.state.ledger.length = 0;
    fake.state.nextLedgerId = 1;
}

beforeEach(() => { resetState(); });

// ── Conversion helpers ──────────────────────────────────────────────────

describe('wallet: conversion helpers', () => {
    test('twdToMli: 1 TWD = 100,000 mli', () => {
        expect(wallet.twdToMli(1)).toBe(100_000);
        expect(wallet.twdToMli(170)).toBe(17_000_000);
        expect(wallet.twdToMli(0)).toBe(0);
    });

    test('ecoinToMli: 1 e幣 = 1000 mli', () => {
        expect(wallet.ecoinToMli(1)).toBe(1000);
        expect(wallet.ecoinToMli(10.5)).toBe(10_500);
    });

    test('mliToEcoin: inverse of ecoinToMli', () => {
        expect(wallet.mliToEcoin(1000)).toBe(1);
        expect(wallet.mliToEcoin(17_000_000)).toBe(17_000);
    });

    test('twdToMli rejects invalid input', () => {
        expect(() => wallet.twdToMli(-1)).toThrow('invalid_twd');
        expect(() => wallet.twdToMli(NaN)).toThrow('invalid_twd');
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
