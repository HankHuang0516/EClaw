/**
 * P0 Phase 4: rebind cascade — terminate active contracts + owner pays
 * pro-rata penalty.
 *
 * Hank's policy (2026-04-25): "重綁屬於 owner 問題 所以虧要 owner 吃."
 * On rebind:
 *   1. End each active/reserved contract with `ended_admin` (full deposit
 *      released to renter).
 *   2. Owner debited pro-rata penalty = deposit × remaining/planned, clamped
 *      to owner's available balance. Renter credited the same.
 */

jest.mock('pg', () => {
    const state = {
        listings: [],
        contracts: [],
        wallets: new Map(),
        ledger: [],
        cooldowns: [],
        nextLedgerId: 1,
    };
    globalThis.__rebindState = state;

    function ensureWallet(userId) {
        if (!state.wallets.has(userId)) {
            state.wallets.set(userId, {
                balance_mli: 0n, held_mli: 0n,
                lifetime_earned_mli: 0n, lifetime_spent_mli: 0n,
            });
        }
    }

    function runQuery(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();

        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(norm)) return { rows: [], rowCount: 0 };
        if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(norm)) return { rows: [], rowCount: 0 };

        // Phase 4 query: JOIN rental_contracts × bot_listings on slot match.
        if (/^SELECT c\.id, c\.listing_id, c\.owner_user_id, c\.renter_user_id,\s*c\.deposit_mli, c\.planned_duration_min, c\.started_at, c\.ends_at,\s*c\.status\s*FROM rental_contracts c\s*JOIN bot_listings l ON l\.id = c\.listing_id\s*WHERE l\.owner_device_id = \$1\s*AND l\.owner_entity_id = \$2\s*AND c\.status IN/i.test(norm)) {
            const [deviceId, entityId] = params;
            const matches = state.contracts.filter(c => {
                const l = state.listings.find(x => x.id === c.listing_id);
                if (!l) return false;
                return l.owner_device_id === deviceId &&
                    l.owner_entity_id === entityId &&
                    ['reserved', 'active', 'suspended_insufficient_funds'].includes(c.status);
            }).map(c => ({
                id: c.id, listing_id: c.listing_id,
                owner_user_id: c.owner_user_id, renter_user_id: c.renter_user_id,
                deposit_mli: c.deposit_mli.toString(),
                planned_duration_min: c.planned_duration_min,
                started_at: c.started_at, ends_at: c.ends_at, status: c.status,
            }));
            return { rows: matches, rowCount: matches.length };
        }

        // SELECT contract FOR UPDATE (endRental)
        if (/^SELECT id, listing_id, owner_user_id, renter_user_id, deposit_mli, status\s*FROM rental_contracts WHERE id = \$1 FOR UPDATE$/i.test(norm)) {
            const row = state.contracts.find(c => c.id === params[0]);
            if (!row) return { rows: [], rowCount: 0 };
            return { rows: [{
                id: row.id, listing_id: row.listing_id,
                owner_user_id: row.owner_user_id, renter_user_id: row.renter_user_id,
                deposit_mli: row.deposit_mli.toString(), status: row.status,
            }], rowCount: 1 };
        }

        // UPDATE rental_contracts on end
        if (/^UPDATE rental_contracts\s+SET status = \$2, end_reason = \$3, actual_ended_at = NOW\(\)/i.test(norm)) {
            const row = state.contracts.find(c => c.id === params[0]);
            if (!row) return { rows: [], rowCount: 0 };
            row.status = params[1]; row.end_reason = params[2]; row.actual_ended_at = new Date();
            return { rows: [{ id: row.id, status: row.status, end_reason: row.end_reason, actual_ended_at: row.actual_ended_at }], rowCount: 1 };
        }

        // rental_cooldowns
        if (/^INSERT INTO rental_cooldowns/i.test(norm)) {
            state.cooldowns.push({ user_id: params[0], listing_id: params[1] });
            return { rows: [], rowCount: 1 };
        }

        // wallet balance reads
        if (/^SELECT balance_mli FROM wallets WHERE user_id = \$1$/i.test(norm)) {
            const w = state.wallets.get(params[0]);
            if (!w) return { rows: [], rowCount: 0 };
            return { rows: [{ balance_mli: w.balance_mli.toString() }], rowCount: 1 };
        }
        if (/^SELECT held_mli FROM wallets WHERE user_id = \$1$/i.test(norm)) {
            const w = state.wallets.get(params[0]);
            if (!w) return { rows: [], rowCount: 0 };
            return { rows: [{ held_mli: w.held_mli.toString() }], rowCount: 1 };
        }
        if (/^SELECT balance_mli, held_mli, lifetime_earned_mli, lifetime_spent_mli FROM wallets/i.test(norm)) {
            const w = state.wallets.get(params[0]);
            if (!w) return { rows: [], rowCount: 0 };
            return { rows: [{
                balance_mli: w.balance_mli.toString(), held_mli: w.held_mli.toString(),
                lifetime_earned_mli: w.lifetime_earned_mli.toString(),
                lifetime_spent_mli: w.lifetime_spent_mli.toString(),
            }], rowCount: 1 };
        }
        if (/^SELECT balance_mli, held_mli FROM wallets WHERE user_id = \$1 FOR UPDATE$/i.test(norm)) {
            const w = state.wallets.get(params[0]);
            if (!w) return { rows: [], rowCount: 0 };
            return { rows: [{ balance_mli: w.balance_mli.toString(), held_mli: w.held_mli.toString() }], rowCount: 1 };
        }
        if (/^INSERT INTO wallets \(user_id\) VALUES/i.test(norm)) {
            ensureWallet(params[0]); return { rows: [], rowCount: 1 };
        }
        if (/^SELECT .* FROM wallet_ledger WHERE idempotency_key = \$1$/i.test(norm)) {
            const match = state.ledger.find(r => r.idempotency_key === params[0]);
            return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
        }
        if (/^UPDATE wallets SET balance_mli = \$1, held_mli = \$2/i.test(norm)) {
            const [bal, held, earnedInc, spentInc, userId] = params;
            const w = state.wallets.get(userId);
            if (!w) return { rows: [], rowCount: 0 };
            w.balance_mli = BigInt(bal); w.held_mli = BigInt(held);
            w.lifetime_earned_mli += BigInt(earnedInc); w.lifetime_spent_mli += BigInt(spentInc);
            return { rows: [], rowCount: 1 };
        }
        if (/^INSERT INTO wallet_ledger/i.test(norm)) {
            const [userId, deltaMli, heldDeltaMli, balanceAfter, heldAfter, type, refType, refId, counterparty, note, idemKey] = params;
            if (state.ledger.some(r => r.idempotency_key === idemKey))
                throw new Error('duplicate key value violates unique constraint "wallet_ledger_idempotency_key_key"');
            const row = {
                id: state.nextLedgerId++, user_id: userId,
                delta_mli: String(deltaMli), held_delta_mli: String(heldDeltaMli),
                balance_after_mli: String(balanceAfter), held_after_mli: String(heldAfter),
                type, ref_type: refType, ref_id: refId,
                counterparty_user_id: counterparty, note, idempotency_key: idemKey,
                created_at: new Date(),
            };
            state.ledger.push(row);
            return { rows: [{ id: row.id, created_at: row.created_at }], rowCount: 1 };
        }

        throw new Error(`[fake-pg rebind] Unhandled SQL: ${norm}`);
    }

    class FakePool {
        async connect() { return { query: async (sql, p) => runQuery(sql, p), release: () => {} }; }
        async query(sql, p) { return runQuery(sql, p); }
    }
    return { Pool: jest.fn().mockImplementation(() => new FakePool()) };
});

jest.mock('fs', () => {
    const real = jest.requireActual('fs');
    return { ...real, readFileSync: jest.fn((p, enc) => {
        if (typeof p === 'string' && (p.endsWith('rental_schema.sql') || p.endsWith('wallet_schema.sql'))) return '';
        return real.readFileSync(p, enc);
    }) };
});

const wallet = require('../../wallet');
const rental = require('../../rental');

const noopAuth = (_req, _res, next) => next();
const walletApi = wallet({ authMiddleware: noopAuth });
const rentalApi = rental({ authMiddleware: noopAuth, walletModule: walletApi });

const OWNER  = '11111111-1111-1111-1111-111111111111';
const RENTER = '22222222-2222-2222-2222-222222222222';
const RENTER_B = '33333333-3333-3333-3333-333333333333';
const OWNER_B  = '44444444-4444-4444-4444-444444444444';
const DEVICE_ID = 'owner-dev-1';
const ENTITY_ID = 0;

function reset() {
    const s = globalThis.__rebindState;
    s.listings.length = 0; s.contracts.length = 0; s.cooldowns.length = 0;
    s.wallets.clear(); s.ledger.length = 0; s.nextLedgerId = 1;
}
beforeEach(() => reset());

function topup(userId, amount, label = 'seed') {
    return walletApi.creditTopup({
        userId, amountMli: amount, orderId: `${label}-${userId}`,
        channel: 'admin_grant', idempotencyKey: `topup:${label}:${userId}:${Math.random()}`,
    });
}

/**
 * Insert a listing + active contract directly into fake state (skipping the
 * createListing/startRental flow because that path is already tested elsewhere
 * and would require mocking interview-passed state). We need precise control
 * over started_at/ends_at to test the pro-rata math.
 */
function seedActiveContract({
    contractId,
    listingId = `listing-${contractId}`,
    ownerUserId = OWNER,
    renterUserId = RENTER,
    deviceId = DEVICE_ID,
    entityId = ENTITY_ID,
    depositMli,
    plannedDurationMin,
    startedMinutesAgo,
    status = 'active',
}) {
    const s = globalThis.__rebindState;
    s.listings.push({
        id: listingId,
        owner_user_id: ownerUserId,
        owner_device_id: deviceId,
        owner_entity_id: entityId,
        status: 'listed',
    });
    const startedAt = startedMinutesAgo == null ? null
        : new Date(Date.now() - startedMinutesAgo * 60 * 1000);
    const endsAt = startedAt
        ? new Date(startedAt.getTime() + plannedDurationMin * 60 * 1000)
        : null;
    s.contracts.push({
        id: contractId,
        listing_id: listingId,
        owner_user_id: ownerUserId,
        renter_user_id: renterUserId,
        deposit_mli: BigInt(depositMli),
        planned_duration_min: plannedDurationMin,
        started_at: startedAt,
        ends_at: endsAt,
        status,
        end_reason: null,
        actual_ended_at: null,
    });
}

describe('Phase 4: terminateActiveContractsOnRebind', () => {
    test('no contracts on slot → returns empty', async () => {
        const out = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi);
        expect(out).toEqual([]);
    });

    test('active contract: renter held released + owner pays pro-rata penalty', async () => {
        const deposit = 100_000;
        const planned = 60; // minutes
        // Halfway through: 30 min elapsed, 30 min remain → ratio = 0.5
        seedActiveContract({
            contractId: 'c1', depositMli: deposit, plannedDurationMin: planned,
            startedMinutesAgo: 30,
        });
        // Renter has the deposit held (simulate startRental side effect).
        await topup(RENTER, deposit);
        await walletApi.withTransaction(async (client) => {
            await walletApi.applyLedgerEntry(client, {
                userId: RENTER, balanceDelta: -deposit, heldDelta: deposit,
                type: walletApi.LEDGER_TYPES.DEPOSIT_HOLD,
                refType: 'rental_contract', refId: 'c1',
                idempotencyKey: 'seed-hold-c1',
            });
        });
        // Owner has plenty of balance to cover the penalty.
        await topup(OWNER, 1_000_000);

        const outcomes = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi);

        expect(outcomes).toHaveLength(1);
        const o = outcomes[0];
        expect(o.contractId).toBe('c1');
        // pro-rata: 100k × 30/60 = 50k (clock-skew tolerance ±1k)
        expect(o.penaltyMli).toBeGreaterThanOrEqual(49_000);
        expect(o.penaltyMli).toBeLessThanOrEqual(50_000);
        expect(o.actualPenaltyMli).toBe(o.penaltyMli);
        expect(o.shortfallMli).toBe(0);

        // Renter wallet: starts with 0 (paid deposit out), gets full deposit back, plus penalty.
        const renterBal = await walletApi.getBalance(RENTER);
        // renter started with deposit (100k) topped up, paid 100k into held → balance 0, held 100k
        // After ended_admin: balance += 100k, held -= 100k → balance 100k, held 0
        // After owner pays penalty (~50k): balance ≈ 150k
        expect(Number(renterBal.balance_mli)).toBeGreaterThanOrEqual(149_000);
        expect(Number(renterBal.balance_mli)).toBeLessThanOrEqual(150_000);
        expect(renterBal.held_mli).toBe('0');

        // Owner wallet debited by penalty.
        const ownerBal = await walletApi.getBalance(OWNER);
        expect(Number(ownerBal.balance_mli)).toBeGreaterThanOrEqual(950_000);
        expect(Number(ownerBal.balance_mli)).toBeLessThanOrEqual(951_000);

        // Contract marked ended_admin.
        const contract = globalThis.__rebindState.contracts.find(c => c.id === 'c1');
        expect(contract.status).toBe('ended_admin');
    });

    test('reserved contract: full deposit treated as remaining → 100% penalty', async () => {
        const deposit = 80_000;
        seedActiveContract({
            contractId: 'c2', depositMli: deposit, plannedDurationMin: 60,
            startedMinutesAgo: null, status: 'reserved',
        });
        await topup(RENTER, deposit);
        await walletApi.withTransaction(async (client) => {
            await walletApi.applyLedgerEntry(client, {
                userId: RENTER, balanceDelta: -deposit, heldDelta: deposit,
                type: walletApi.LEDGER_TYPES.DEPOSIT_HOLD,
                refType: 'rental_contract', refId: 'c2',
                idempotencyKey: 'seed-hold-c2',
            });
        });
        await topup(OWNER, 1_000_000);

        const [o] = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi);
        expect(o.penaltyMli).toBe(deposit);
        expect(o.actualPenaltyMli).toBe(deposit);
        expect(o.shortfallMli).toBe(0);
    });

    test('owner balance < penalty → clamp + log shortfall', async () => {
        const deposit = 100_000;
        seedActiveContract({
            contractId: 'c3', depositMli: deposit, plannedDurationMin: 60,
            startedMinutesAgo: 0, // just started → ratio ≈ 1
        });
        await topup(RENTER, deposit);
        await walletApi.withTransaction(async (client) => {
            await walletApi.applyLedgerEntry(client, {
                userId: RENTER, balanceDelta: -deposit, heldDelta: deposit,
                type: walletApi.LEDGER_TYPES.DEPOSIT_HOLD,
                refType: 'rental_contract', refId: 'c3',
                idempotencyKey: 'seed-hold-c3',
            });
        });
        // Owner only has 30k available — penalty wants ~100k.
        await topup(OWNER, 30_000);

        const [o] = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi);
        expect(o.penaltyMli).toBeGreaterThanOrEqual(99_000);
        expect(o.actualPenaltyMli).toBe(30_000); // clamped to balance
        expect(o.shortfallMli).toBeGreaterThanOrEqual(69_000);

        const ownerBal = await walletApi.getBalance(OWNER);
        expect(ownerBal.balance_mli).toBe('0'); // fully drained, no negative
    });

    test('only contracts on the rebound slot are affected', async () => {
        // Contract A on the rebound slot (entity 0).
        seedActiveContract({
            contractId: 'cA', depositMli: 50_000, plannedDurationMin: 60,
            startedMinutesAgo: 30, deviceId: DEVICE_ID, entityId: 0,
        });
        // Contract B on a DIFFERENT slot (entity 1) — should NOT be touched.
        seedActiveContract({
            contractId: 'cB', listingId: 'listing-cB', depositMli: 50_000,
            plannedDurationMin: 60, startedMinutesAgo: 30,
            deviceId: DEVICE_ID, entityId: 1,
            ownerUserId: OWNER_B, renterUserId: RENTER_B,
        });
        await topup(RENTER, 50_000);
        await topup(RENTER_B, 50_000);
        await walletApi.withTransaction(async (client) => {
            await walletApi.applyLedgerEntry(client, {
                userId: RENTER, balanceDelta: -50_000, heldDelta: 50_000,
                type: walletApi.LEDGER_TYPES.DEPOSIT_HOLD,
                refType: 'rental_contract', refId: 'cA', idempotencyKey: 'seed-hold-cA',
            });
            await walletApi.applyLedgerEntry(client, {
                userId: RENTER_B, balanceDelta: -50_000, heldDelta: 50_000,
                type: walletApi.LEDGER_TYPES.DEPOSIT_HOLD,
                refType: 'rental_contract', refId: 'cB', idempotencyKey: 'seed-hold-cB',
            });
        });
        await topup(OWNER, 1_000_000);
        await topup(OWNER_B, 1_000_000);

        const outcomes = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, 0, walletApi);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].contractId).toBe('cA');

        // cB untouched.
        const cB = globalThis.__rebindState.contracts.find(c => c.id === 'cB');
        expect(cB.status).toBe('active');
    });

    test('already-ended contracts are not re-terminated', async () => {
        seedActiveContract({
            contractId: 'cEnded', depositMli: 50_000, plannedDurationMin: 60,
            startedMinutesAgo: 30, status: 'ended_normal',
        });
        const out = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi);
        expect(out).toEqual([]);
    });

    test('idempotency: re-running with same contract id is a no-op (already ended)', async () => {
        seedActiveContract({
            contractId: 'cIdem', depositMli: 60_000, plannedDurationMin: 60,
            startedMinutesAgo: 30,
        });
        await topup(RENTER, 60_000);
        await walletApi.withTransaction(async (client) => {
            await walletApi.applyLedgerEntry(client, {
                userId: RENTER, balanceDelta: -60_000, heldDelta: 60_000,
                type: walletApi.LEDGER_TYPES.DEPOSIT_HOLD,
                refType: 'rental_contract', refId: 'cIdem', idempotencyKey: 'seed-hold-cIdem',
            });
        });
        await topup(OWNER, 1_000_000);

        const first = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi);
        expect(first).toHaveLength(1);
        // Second call: contract is now ended_admin, so the WHERE filter excludes it.
        const second = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi);
        expect(second).toEqual([]);
    });

    test('missing walletApi → returns [] without throwing', async () => {
        seedActiveContract({
            contractId: 'cBad', depositMli: 10_000, plannedDurationMin: 60,
            startedMinutesAgo: 30,
        });
        const out = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, null);
        expect(out).toEqual([]);
    });

    test('invalid args → returns []', async () => {
        const a = await rentalApi.terminateActiveContractsOnRebind(null, ENTITY_ID, walletApi);
        expect(a).toEqual([]);
        const b = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, 'not-a-number', walletApi);
        expect(b).toEqual([]);
    });
});
