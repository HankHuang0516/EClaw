/**
 * Rental Wallet Integration Tests — full financial lifecycle.
 *
 * Verifies that deposit hold, normal refund, early-end forfeit split,
 * and zero-drift invariants all hold across wallet + rental modules.
 *
 * Uses the same fake-pg pool pattern as rental-contract.test.js.
 */

jest.mock('pg', () => {
    const state = {
        listings: [],
        contracts: [],
        snapshots: [],
        wallets: new Map(),
        ledger: [],
        nextListingId: 1,
        nextContractId: 1,
        nextLedgerId: 1,
    };
    globalThis.__rwState = state;

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

        // bot_listings
        if (/^SELECT id, status FROM bot_listings WHERE owner_device_id/i.test(norm))
            return { rows: [], rowCount: 0 };
        if (/^SELECT cooldown_until FROM rental_cooldowns/i.test(norm))
            return { rows: [], rowCount: 0 };
        if (/^INSERT INTO rental_cooldowns/i.test(norm))
            return { rows: [], rowCount: 1 };
        if (/^INSERT INTO bot_listings/i.test(norm)) {
            const id = `listing-${state.nextListingId++}`;
            state.listings.push({
                id, owner_user_id: params[0], owner_device_id: params[1],
                owner_entity_id: params[2], title: params[3],
                rate_mli_per_ktoken: params[5], status: 'listed',
                interview_passed: true, min_rental_minutes: params[6],
                max_rental_minutes: params[7],
                created_at: new Date(), updated_at: new Date(),
            });
            return { rows: [{ id, status: 'listed', created_at: new Date() }], rowCount: 1 };
        }
        if (/^SELECT id, owner_user_id, rate_mli_per_ktoken,\s*min_rental_minutes, max_rental_minutes,\s*status, interview_passed(?:, soft_pause_until, soft_pause_reason)?\s*FROM bot_listings WHERE id = \$1 FOR UPDATE$/i.test(norm)) {
            const row = state.listings.find(l => l.id === params[0]);
            if (!row) return { rows: [], rowCount: 0 };
            return { rows: [{ id: row.id, owner_user_id: row.owner_user_id, rate_mli_per_ktoken: row.rate_mli_per_ktoken, min_rental_minutes: row.min_rental_minutes, max_rental_minutes: row.max_rental_minutes, status: row.status, interview_passed: row.interview_passed, soft_pause_until: row.soft_pause_until || null, soft_pause_reason: row.soft_pause_reason || null }], rowCount: 1 };
        }

        // rental_contracts exclusivity
        if (/^SELECT id FROM rental_contracts\s+WHERE listing_id = \$1\s+AND status IN/i.test(norm)) {
            const blocking = state.contracts.filter(c => c.listing_id === params[0] && ['reserved', 'active', 'suspended_insufficient_funds'].includes(c.status));
            return { rows: blocking.map(c => ({ id: c.id })), rowCount: blocking.length };
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

        // INSERT rental_contracts
        if (/^INSERT INTO rental_contracts/i.test(norm)) {
            const [id, listingId, ownerUserId, renterUserId, renterDeviceId, rateSnapshot, depositMli, durationMin] = params;
            state.nextContractId++;
            const startedAt = new Date();
            const endsAt = new Date(Date.now() + durationMin * 60 * 1000);
            state.contracts.push({
                id, listing_id: listingId, owner_user_id: ownerUserId,
                renter_user_id: renterUserId, renter_device_id: renterDeviceId,
                rate_mli_per_ktoken_snapshot: rateSnapshot, deposit_mli: depositMli,
                planned_duration_min: durationMin, started_at: startedAt, ends_at: endsAt,
                actual_ended_at: null, status: 'active', end_reason: null, created_at: new Date(),
            });
            return { rows: [{ id, status: 'active', started_at: startedAt, ends_at: endsAt, deposit_mli: depositMli }], rowCount: 1 };
        }

        // INSERT rental_snapshots
        if (/^INSERT INTO rental_snapshots/i.test(norm)) {
            state.snapshots.push({ contract_id: params[0] });
            return { rows: [], rowCount: 1 };
        }

        // SELECT contract FOR UPDATE (endRental)
        if (/^SELECT id,.*deposit_mli, status\s*FROM rental_contracts WHERE id = \$1 FOR UPDATE$/i.test(norm)) {
            const row = state.contracts.find(c => c.id === params[0]);
            if (!row) return { rows: [], rowCount: 0 };
            return { rows: [{ id: row.id, listing_id: row.listing_id, owner_user_id: row.owner_user_id, renter_user_id: row.renter_user_id, deposit_mli: row.deposit_mli.toString(), status: row.status }], rowCount: 1 };
        }

        // UPDATE rental_contracts on end
        if (/^UPDATE rental_contracts\s+SET status = \$2, end_reason = \$3, actual_ended_at = NOW\(\)/i.test(norm)) {
            const row = state.contracts.find(c => c.id === params[0]);
            if (!row) return { rows: [], rowCount: 0 };
            row.status = params[1]; row.end_reason = params[2]; row.actual_ended_at = new Date();
            return { rows: [{ id: row.id, status: row.status, end_reason: row.end_reason, actual_ended_at: row.actual_ended_at }], rowCount: 1 };
        }

        // Full balance read
        if (/^SELECT balance_mli, held_mli, lifetime_earned_mli, lifetime_spent_mli FROM wallets/i.test(norm)) {
            const w = state.wallets.get(params[0]);
            if (!w) return { rows: [], rowCount: 0 };
            return { rows: [{ balance_mli: w.balance_mli.toString(), held_mli: w.held_mli.toString(), lifetime_earned_mli: w.lifetime_earned_mli.toString(), lifetime_spent_mli: w.lifetime_spent_mli.toString() }], rowCount: 1 };
        }

        // wallet mutations
        if (/^INSERT INTO wallets \(user_id\) VALUES/i.test(norm)) {
            ensureWallet(params[0]); return { rows: [], rowCount: 1 };
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

        throw new Error(`[fake-pg rw] Unhandled SQL: ${norm}`);
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

const OWNER    = '11111111-1111-1111-1111-111111111111';
const RENTER   = '22222222-2222-2222-2222-222222222222';
const PLATFORM = '00000000-0000-0000-0000-000000000001';
const INSURANCE = '00000000-0000-0000-0000-000000000002';

function resetState() {
    const s = globalThis.__rwState;
    s.listings.length = 0; s.contracts.length = 0; s.snapshots.length = 0;
    s.wallets.clear(); s.ledger.length = 0;
    s.nextListingId = 1; s.nextContractId = 1; s.nextLedgerId = 1;
}
beforeEach(() => resetState());

/** Sum all delta_mli across every ledger entry for a given user. */
function userLedgerSum(userId) {
    return globalThis.__rwState.ledger
        .filter(e => e.user_id === userId)
        .reduce((acc, e) => acc + BigInt(e.delta_mli), 0n);
}

/** Sum ALL delta_mli across ALL ledger entries (global zero-drift check). */
function globalLedgerSum() {
    return globalThis.__rwState.ledger
        .reduce((acc, e) => acc + BigInt(e.delta_mli), 0n);
}

async function seedAndStart({ rate = 5_000, fund = 1_000_000 } = {}) {
    const listing = await rentalApi.createListing({
        ownerUserId: OWNER, ownerDeviceId: 'owner-dev', ownerEntityId: 0,
        title: 'Test bot', rateMliPerKtoken: rate,
    });
    // Interview-gate fix (2026-04-24): createListing now forces rate=0. Poke the
    // in-memory row so the wallet math sees the rate this test wants to exercise.
    const row = globalThis.__rwState.listings.find(l => l.id === listing.id);
    if (row) { row.rate_mli_per_ktoken = rate; row.interview_passed = true; }
    await walletApi.creditTopup({
        userId: RENTER, amountMli: fund, orderId: 'seed',
        channel: 'admin_grant', idempotencyKey: `seed-${Date.now()}-${Math.random()}`,
    });
    const contract = await rentalApi.startRental({
        listingId: listing.id, renterUserId: RENTER,
        renterDeviceId: 'renter-dev', durationMinutes: 60,
    }, walletApi);
    return contract;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('rental wallet integration: deposit hold', () => {
    test('startRental holds deposit_mli from renter wallet', async () => {
        const contract = await seedAndStart({ rate: 5_000, fund: 1_000_000 });
        // deposit = 5000 * 20 = 100_000
        expect(String(contract.deposit_mli)).toBe('100000');
        const bal = await walletApi.getBalance(RENTER);
        expect(bal.balance_mli).toBe('900000');
        expect(bal.held_mli).toBe('100000');
    });
});

describe('rental wallet integration: normal end refund', () => {
    test('ended_normal refunds 100% deposit, all entries sum to 0 for renter', async () => {
        const contract = await seedAndStart();
        await rentalApi.endRental({
            contractId: contract.id, endReason: 'ended_normal', requesterUserId: RENTER,
        }, walletApi);

        const bal = await walletApi.getBalance(RENTER);
        expect(bal.balance_mli).toBe('1000000');
        expect(bal.held_mli).toBe('0');

        // Renter net effect from deposit hold + release = 0
        // (topup is +1M, deposit hold delta=−100k, release delta=+100k → net +1M)
        // Excluding topup, rental entries sum to 0:
        const rentalEntries = globalThis.__rwState.ledger
            .filter(e => e.user_id === RENTER && e.type !== 'topup');
        const rentalSum = rentalEntries.reduce((a, e) => a + BigInt(e.delta_mli), 0n);
        expect(rentalSum).toBe(0n);
    });
});

describe('rental wallet integration: early end forfeit split', () => {
    test('ended_early_by_renter splits 50% forfeit: 85% owner + 13% platform + 2% insurance', async () => {
        const contract = await seedAndStart({ rate: 5_000, fund: 1_000_000 });
        const depositMli = 100_000; // 5000 * 20
        const ended = await rentalApi.endRental({
            contractId: contract.id, endReason: 'ended_early_by_renter', requesterUserId: RENTER,
        }, walletApi);

        expect(ended.refund_mli).toBe(50_000);
        expect(ended.forfeit_mli).toBe(50_000);

        // Forfeit split: 85% owner, 13% platform, 2% insurance
        const forfeit = 50_000;
        const expectedInsurance = Math.floor(forfeit * 200 / 10000);   // 1000
        const platformGross = Math.floor(forfeit * 1500 / 10000);      // 7500
        const expectedPlatform = platformGross - expectedInsurance;     // 6500
        const expectedOwner = forfeit - platformGross;                  // 42500

        const ownerIncome = globalThis.__rwState.ledger
            .filter(e => e.user_id === OWNER && e.type === 'rental_income')
            .reduce((a, e) => a + Number(e.delta_mli), 0);
        const platformIncome = globalThis.__rwState.ledger
            .filter(e => e.user_id === PLATFORM && e.type === 'platform_fee')
            .reduce((a, e) => a + Number(e.delta_mli), 0);
        const insuranceIncome = globalThis.__rwState.ledger
            .filter(e => e.user_id === INSURANCE && e.type === 'platform_fee')
            .reduce((a, e) => a + Number(e.delta_mli), 0);

        expect(ownerIncome).toBe(expectedOwner);       // 42500
        expect(platformIncome).toBe(expectedPlatform);  // 6500
        expect(insuranceIncome).toBe(expectedInsurance); // 1000
        // owner + platform + insurance = forfeit
        expect(ownerIncome + platformIncome + insuranceIncome).toBe(forfeit);
    });
});

describe('rental wallet integration: zero-drift verification', () => {
    test('normal end: global ledger sums to zero (excluding topup seed)', async () => {
        const contract = await seedAndStart();
        await rentalApi.endRental({
            contractId: contract.id, endReason: 'ended_normal', requesterUserId: RENTER,
        }, walletApi);

        // Exclude the initial topup (external money entering the system).
        // All rental-related entries must net to zero across all parties.
        const nonTopup = globalThis.__rwState.ledger.filter(e => e.type !== 'topup');
        const sum = nonTopup.reduce((a, e) => a + BigInt(e.delta_mli), 0n);
        expect(sum).toBe(0n);
    });

    test('early end: global ledger sums to zero (excluding topup seed)', async () => {
        const contract = await seedAndStart();
        await rentalApi.endRental({
            contractId: contract.id, endReason: 'ended_early_by_renter', requesterUserId: RENTER,
        }, walletApi);

        const nonTopup = globalThis.__rwState.ledger.filter(e => e.type !== 'topup');
        const sum = nonTopup.reduce((a, e) => a + BigInt(e.delta_mli), 0n);
        expect(sum).toBe(0n);
    });

    test('violation end: global ledger sums to zero (excluding topup seed)', async () => {
        const contract = await seedAndStart();
        await rentalApi.endRental({
            contractId: contract.id, endReason: 'ended_violation', requesterUserId: OWNER,
        }, walletApi);

        const nonTopup = globalThis.__rwState.ledger.filter(e => e.type !== 'topup');
        const sum = nonTopup.reduce((a, e) => a + BigInt(e.delta_mli), 0n);
        expect(sum).toBe(0n);
    });
});
