/**
 * Rental Contract Lifecycle Tests — startRental / endRental / getMyContracts.
 *
 * These tests exercise the cross-module transaction flow where rental.js
 * writes contract + snapshot rows *and* wallet.js writes ledger entries
 * inside a single transaction. The in-memory pg simulator below is
 * shared by both modules (same Pool mock) so writes land in one state
 * object.
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
    globalThis.__rcState = state;

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

        // ── bot_listings ─────────────────────────────────────────────────
        // BUG-M2: Duplicate listing check
        if (/^SELECT id, status FROM bot_listings WHERE owner_device_id/i.test(norm)) {
            return { rows: [], rowCount: 0 };
        }
        // Cooldown check
        if (/^SELECT cooldown_until FROM rental_cooldowns/i.test(norm)) {
            return { rows: [], rowCount: 0 };
        }
        // Cooldown insert
        if (/^INSERT INTO rental_cooldowns/i.test(norm)) {
            return { rows: [], rowCount: 1 };
        }
        if (/^INSERT INTO bot_listings/i.test(norm)) {
            const id = `listing-${state.nextListingId++}`;
            state.listings.push({
                id,
                owner_user_id: params[0],
                owner_device_id: params[1],
                owner_entity_id: params[2],
                title: params[3],
                description: params[4],
                rate_mli_per_ktoken: params[5],
                min_rental_minutes: params[6],
                max_rental_minutes: params[7],
                availability_windows: [],
                model_detected: null,
                capabilities: {},
                benchmark_score: {},
                interview_passed: true,  // assume passed for contract tests
                last_interview_at: null,
                avg_rating: 0, total_rentals: 0, uptime_pct: 100,
                status: 'listed',
                created_at: new Date(), updated_at: new Date(),
            });
            return { rows: [{ id, status: 'listed', created_at: new Date() }], rowCount: 1 };
        }

        // SELECT listing FOR UPDATE (used by startRental)
        if (/^SELECT id, owner_user_id, rate_mli_per_ktoken,\s*min_rental_minutes, max_rental_minutes,\s*status, interview_passed(?:, soft_pause_until, soft_pause_reason)?\s*FROM bot_listings WHERE id = \$1 FOR UPDATE$/i.test(norm)) {
            const row = state.listings.find(l => l.id === params[0]);
            if (!row) return { rows: [], rowCount: 0 };
            return { rows: [{
                id: row.id, owner_user_id: row.owner_user_id,
                rate_mli_per_ktoken: row.rate_mli_per_ktoken,
                min_rental_minutes: row.min_rental_minutes,
                max_rental_minutes: row.max_rental_minutes,
                status: row.status, interview_passed: row.interview_passed,
                soft_pause_until: row.soft_pause_until || null,
                soft_pause_reason: row.soft_pause_reason || null,
            }], rowCount: 1 };
        }

        // ── rental_contracts ─────────────────────────────────────────────
        // Exclusivity check
        if (/^SELECT id FROM rental_contracts\s+WHERE listing_id = \$1\s+AND status IN/i.test(norm)) {
            const blocking = state.contracts.filter(c =>
                c.listing_id === params[0] &&
                ['reserved', 'active', 'suspended_insufficient_funds'].includes(c.status)
            );
            return { rows: blocking.map(c => ({ id: c.id })), rowCount: blocking.length };
        }

        // Read balance for rental affordability
        if (/^SELECT balance_mli FROM wallets WHERE user_id = \$1$/i.test(norm)) {
            const w = state.wallets.get(params[0]);
            if (!w) return { rows: [], rowCount: 0 };
            return { rows: [{ balance_mli: w.balance_mli.toString() }], rowCount: 1 };
        }
        // Read held_mli for endRental deposit refund calculation
        if (/^SELECT held_mli FROM wallets WHERE user_id = \$1$/i.test(norm)) {
            const w = state.wallets.get(params[0]);
            if (!w) return { rows: [], rowCount: 0 };
            return { rows: [{ held_mli: w.held_mli.toString() }], rowCount: 1 };
        }

        // INSERT rental_contracts
        if (/^INSERT INTO rental_contracts/i.test(norm)) {
            const [id, listingId, ownerUserId, renterUserId, renterDeviceId,
                   rateSnapshot, depositMli, durationMin] = params;
            state.nextContractId++;
            const startedAt = new Date();
            const endsAt = new Date(Date.now() + durationMin * 60 * 1000);
            const row = {
                id, listing_id: listingId,
                owner_user_id: ownerUserId, renter_user_id: renterUserId,
                renter_device_id: renterDeviceId,
                rate_mli_per_ktoken_snapshot: rateSnapshot,
                deposit_mli: depositMli,
                planned_duration_min: durationMin,
                started_at: startedAt,
                ends_at: endsAt,
                actual_ended_at: null,
                tokens_consumed: 0,
                ecoin_charged_mli: 0,
                violation_count: 0,
                status: 'active',
                end_reason: null,
                created_at: new Date(),
            };
            state.contracts.push(row);
            return { rows: [{
                id, status: 'active',
                started_at: startedAt, ends_at: endsAt,
                deposit_mli: depositMli,
            }], rowCount: 1 };
        }

        // INSERT rental_snapshots
        if (/^INSERT INTO rental_snapshots/i.test(norm)) {
            state.snapshots.push({
                contract_id: params[0],
                identity: params[1], rules: params[2], skills: params[3],
                webhook_url: params[4], allowed_vars: params[5],
            });
            return { rows: [], rowCount: 1 };
        }

        // SELECT contract FOR UPDATE (used by endRental)
        if (/^SELECT id,.*deposit_mli, status\s*FROM rental_contracts WHERE id = \$1 FOR UPDATE$/i.test(norm)) {
            const row = state.contracts.find(c => c.id === params[0]);
            if (!row) return { rows: [], rowCount: 0 };
            return { rows: [{
                id: row.id,
                owner_user_id: row.owner_user_id,
                renter_user_id: row.renter_user_id,
                deposit_mli: row.deposit_mli.toString(),
                status: row.status,
            }], rowCount: 1 };
        }

        // UPDATE rental_contracts on end
        if (/^UPDATE rental_contracts\s+SET status = \$2, end_reason = \$3, actual_ended_at = NOW\(\)/i.test(norm)) {
            const row = state.contracts.find(c => c.id === params[0]);
            if (!row) return { rows: [], rowCount: 0 };
            row.status = params[1];
            row.end_reason = params[2];
            row.actual_ended_at = new Date();
            return { rows: [{
                id: row.id, status: row.status, end_reason: row.end_reason,
                actual_ended_at: row.actual_ended_at,
            }], rowCount: 1 };
        }

        // my-contracts list — distinguish the 3 WHERE shapes by presence
        // of `renter_user_id = $1` and/or `owner_user_id = $1`.
        if (/FROM rental_contracts/i.test(norm) && /ORDER BY.*created_at DESC/i.test(norm)) {
            const userId = params[0];
            const hasRenter = /renter_user_id = \$1/i.test(norm);
            const hasOwner = /owner_user_id = \$1/i.test(norm);
            let rows;
            if (hasRenter && hasOwner) {
                rows = state.contracts.filter(c =>
                    c.renter_user_id === userId || c.owner_user_id === userId);
            } else if (hasRenter) {
                rows = state.contracts.filter(c => c.renter_user_id === userId);
            } else if (hasOwner) {
                rows = state.contracts.filter(c => c.owner_user_id === userId);
            } else {
                rows = [];
            }
            rows = rows.sort((a, b) => b.created_at - a.created_at);
            const limitParam = params[params.length - 2];
            const offsetParam = params[params.length - 1];
            rows = rows.slice(offsetParam, offsetParam + limitParam);
            return { rows, rowCount: rows.length };
        }

        // Wallet balance read (for walletApi.getBalance used in tests)
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

        // ── wallet_ledger / wallets (needed for deposit hold/release) ────
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
            return { rows: [{ id: row.id, created_at: row.created_at }], rowCount: 1 };
        }

        throw new Error(`[fake-pg rc] Unhandled SQL: ${norm}`);
    }

    class FakePool {
        async connect() {
            return { query: async (sql, params) => runQuery(sql, params), release: () => {} };
        }
        async query(sql, params) { return runQuery(sql, params); }
    }
    return { Pool: jest.fn().mockImplementation(() => new FakePool()) };
});

jest.mock('fs', () => {
    const real = jest.requireActual('fs');
    return {
        ...real,
        readFileSync: jest.fn((p, enc) => {
            if (typeof p === 'string' &&
                (p.endsWith('rental_schema.sql') || p.endsWith('wallet_schema.sql'))) {
                return '';
            }
            return real.readFileSync(p, enc);
        }),
    };
});

const wallet = require('../../wallet');
const rental = require('../../rental');

const noopAuth = (_req, _res, next) => next();
const walletApi = wallet({ authMiddleware: noopAuth });
const rentalApi = rental({ authMiddleware: noopAuth, walletModule: walletApi });

const OWNER  = '11111111-1111-1111-1111-111111111111';
const RENTER = '22222222-2222-2222-2222-222222222222';
const STRANGER = '33333333-3333-3333-3333-333333333333';

function resetState() {
    const s = globalThis.__rcState;
    s.listings.length = 0;
    s.contracts.length = 0;
    s.snapshots.length = 0;
    s.wallets.clear();
    s.ledger.length = 0;
    s.nextListingId = 1;
    s.nextContractId = 1;
    s.nextLedgerId = 1;
}
beforeEach(() => { resetState(); });

async function seedListing({ rate = 5000 } = {}) {
    const listing = await rentalApi.createListing({
        ownerUserId: OWNER, ownerDeviceId: 'owner-dev', ownerEntityId: 0,
        title: 'Test bot', rateMliPerKtoken: rate,
    });
    // Interview-gate fix (2026-04-24): createListing forces rate=0. These
    // contract tests bypass publish and assume rate is set; poke in-memory row.
    const row = globalThis.__rcState.listings.find(l => l.id === listing.id);
    if (row) row.rate_mli_per_ktoken = rate;
    return listing;
}

async function fundRenter(amountMli) {
    return walletApi.creditTopup({
        userId: RENTER, amountMli, orderId: 'seed',
        channel: 'admin_grant', idempotencyKey: `seed-${Date.now()}-${Math.random()}`,
    });
}

// ── startRental ───────────────────────────────────────────────────────

describe('rental: startRental happy path', () => {
    test('creates contract, snapshot, and holds deposit atomically', async () => {
        const listing = await seedListing({ rate: 5_000 });
        await fundRenter(1_000_000); // 1,000 e幣

        const contract = await rentalApi.startRental({
            listingId: listing.id,
            renterUserId: RENTER,
            renterDeviceId: 'renter-dev',
            durationMinutes: 60,
        }, walletApi);

        expect(contract.id).toMatch(/^contract_[a-f0-9]{24}$/);
        expect(contract.status).toBe('active');
        // Deposit = rate × 20 = 5000 × 20 = 100_000
        expect(String(contract.deposit_mli)).toBe('100000');

        // Wallet: balance down by 100k, held up by 100k
        const bal = await walletApi.getBalance(RENTER);
        expect(bal.balance_mli).toBe('900000');
        expect(bal.held_mli).toBe('100000');

        // Snapshot row created
        const state = globalThis.__rcState;
        expect(state.snapshots).toHaveLength(1);
        expect(state.snapshots[0].contract_id).toBe(contract.id);
    });
});

describe('rental: startRental validation', () => {
    test('rejects self-rental', async () => {
        const listing = await seedListing();
        await walletApi.creditTopup({
            userId: OWNER, amountMli: 1_000_000, orderId: 'o',
            channel: 'admin_grant', idempotencyKey: 'owner-seed',
        });
        await expect(rentalApi.startRental({
            listingId: listing.id, renterUserId: OWNER,
            renterDeviceId: 'x', durationMinutes: 60,
        }, walletApi)).rejects.toThrow('self_rental_forbidden');
    });

    test('rejects when listing does not exist', async () => {
        await expect(rentalApi.startRental({
            listingId: 'listing-999', renterUserId: RENTER,
            renterDeviceId: 'x', durationMinutes: 60,
        }, walletApi)).rejects.toThrow('listing_not_found');
    });

    test('rejects when renter balance is insufficient', async () => {
        const listing = await seedListing({ rate: 50_000 }); // deposit = 1_000_000
        await fundRenter(100_000); // way too little
        await expect(rentalApi.startRental({
            listingId: listing.id, renterUserId: RENTER,
            renterDeviceId: 'x', durationMinutes: 60,
        }, walletApi)).rejects.toThrow('insufficient_balance_for_rental');
    });

    test('rejects duration below listing minimum', async () => {
        const listing = await seedListing();
        await fundRenter(10_000_000);
        await expect(rentalApi.startRental({
            listingId: listing.id, renterUserId: RENTER,
            renterDeviceId: 'x', durationMinutes: 20, // below 30 min floor
        }, walletApi)).rejects.toThrow('duration_too_short');
    });

    test('rejects duration above 7 days', async () => {
        const listing = await seedListing();
        await fundRenter(10_000_000);
        await expect(rentalApi.startRental({
            listingId: listing.id, renterUserId: RENTER,
            renterDeviceId: 'x', durationMinutes: 20_000,
        }, walletApi)).rejects.toThrow('duration_too_long');
    });

    test('rejects concurrent rental of same listing (exclusivity)', async () => {
        const listing = await seedListing();
        await fundRenter(5_000_000);
        await rentalApi.startRental({
            listingId: listing.id, renterUserId: RENTER,
            renterDeviceId: 'x', durationMinutes: 60,
        }, walletApi);

        // Second rental by a different user for the same listing → blocked
        await walletApi.creditTopup({
            userId: STRANGER, amountMli: 5_000_000, orderId: 's',
            channel: 'admin_grant', idempotencyKey: 'stranger-seed',
        });
        await expect(rentalApi.startRental({
            listingId: listing.id, renterUserId: STRANGER,
            renterDeviceId: 'y', durationMinutes: 60,
        }, walletApi)).rejects.toThrow('listing_already_rented');
    });
});

// ── endRental ─────────────────────────────────────────────────────────

describe('rental: endRental deposit disposition', () => {
    async function startWithSeed({ rate = 5_000 } = {}) {
        const listing = await seedListing({ rate });
        await fundRenter(1_000_000);
        return rentalApi.startRental({
            listingId: listing.id, renterUserId: RENTER,
            renterDeviceId: 'x', durationMinutes: 60,
        }, walletApi);
    }

    test('ended_normal refunds full deposit', async () => {
        const contract = await startWithSeed();
        const ended = await rentalApi.endRental({
            contractId: contract.id,
            endReason: 'ended_normal',
            requesterUserId: RENTER,
        }, walletApi);

        expect(ended.status).toBe('ended_normal');
        expect(ended.refund_mli).toBe(100_000);
        expect(ended.forfeit_mli).toBe(0);

        const bal = await walletApi.getBalance(RENTER);
        expect(bal.balance_mli).toBe('1000000'); // fully restored
        expect(bal.held_mli).toBe('0');
    });

    test('ended_early_by_renter refunds 50% and forfeits 50%', async () => {
        const contract = await startWithSeed();
        const ended = await rentalApi.endRental({
            contractId: contract.id,
            endReason: 'ended_early_by_renter',
            requesterUserId: RENTER,
        }, walletApi);

        expect(ended.refund_mli).toBe(50_000);
        expect(ended.forfeit_mli).toBe(50_000);
        const bal = await walletApi.getBalance(RENTER);
        expect(bal.balance_mli).toBe('950000');
        expect(bal.held_mli).toBe('0');
    });

    test('ended_zero_balance refunds remaining deposit (last-msg already deducted by proxy)', async () => {
        const contract = await startWithSeed();
        // In real flow, chargeRentalUsage would have deducted the
        // last-message shortfall from held_mli before ending.
        // Simulate: deduct 35,000 mli from held (as if proxy did it).
        const state = globalThis.__rcState;
        const w = state.wallets.get(RENTER);
        w.held_mli -= 35_000n; // simulate proxy deduction

        const ended = await rentalApi.endRental({
            contractId: contract.id,
            endReason: 'ended_zero_balance',
            requesterUserId: RENTER,
        }, walletApi);

        // Remaining deposit (100k - 35k = 65k) refunded to renter.
        expect(ended.refund_mli).toBe(65_000);
        expect(ended.forfeit_mli).toBe(0);
        const bal = await walletApi.getBalance(RENTER);
        // balance was 900k (after deposit hold), now +65k refund = 965k
        expect(bal.balance_mli).toBe('965000');
        expect(bal.held_mli).toBe('0');
    });

    test('ended_violation forfeits 30% and refunds 70%', async () => {
        const contract = await startWithSeed();
        const ended = await rentalApi.endRental({
            contractId: contract.id,
            endReason: 'ended_violation',
            requesterUserId: OWNER,
        }, walletApi);

        expect(ended.refund_mli).toBe(70_000);
        expect(ended.forfeit_mli).toBe(30_000);
    });

    test('rejects end by unrelated user', async () => {
        const contract = await startWithSeed();
        await expect(rentalApi.endRental({
            contractId: contract.id,
            endReason: 'ended_normal',
            requesterUserId: STRANGER,
        }, walletApi)).rejects.toThrow('contract_end_forbidden');
    });

    test('rejects end on already-ended contract', async () => {
        const contract = await startWithSeed();
        await rentalApi.endRental({
            contractId: contract.id, endReason: 'ended_normal',
            requesterUserId: RENTER,
        }, walletApi);
        await expect(rentalApi.endRental({
            contractId: contract.id, endReason: 'ended_normal',
            requesterUserId: RENTER,
        }, walletApi)).rejects.toThrow('contract_already_ended');
    });

    test('rejects unknown end_reason', async () => {
        const contract = await startWithSeed();
        await expect(rentalApi.endRental({
            contractId: contract.id,
            endReason: 'ended_because_i_feel_like_it',
            requesterUserId: RENTER,
        }, walletApi)).rejects.toThrow('end_reason_invalid');
    });
});

// ── getMyContracts ────────────────────────────────────────────────────

describe('rental: getMyContracts', () => {
    test('returns contracts where user is renter', async () => {
        const listing = await seedListing();
        await fundRenter(1_000_000);
        const contract = await rentalApi.startRental({
            listingId: listing.id, renterUserId: RENTER,
            renterDeviceId: 'x', durationMinutes: 60,
        }, walletApi);

        const mine = await rentalApi.getMyContracts(RENTER);
        expect(mine).toHaveLength(1);
        expect(mine[0].id).toBe(contract.id);
    });

    test('role=owner filter excludes contracts I am only renting', async () => {
        const listing = await seedListing();
        await fundRenter(1_000_000);
        await rentalApi.startRental({
            listingId: listing.id, renterUserId: RENTER,
            renterDeviceId: 'x', durationMinutes: 60,
        }, walletApi);

        const asRenter = await rentalApi.getMyContracts(RENTER, { role: 'renter' });
        expect(asRenter).toHaveLength(1);

        const asOwnerPov = await rentalApi.getMyContracts(RENTER, { role: 'owner' });
        expect(asOwnerPov).toHaveLength(0);
    });

    test('owner sees contracts where they are the owner', async () => {
        const listing = await seedListing();
        await fundRenter(1_000_000);
        await rentalApi.startRental({
            listingId: listing.id, renterUserId: RENTER,
            renterDeviceId: 'x', durationMinutes: 60,
        }, walletApi);

        const asOwner = await rentalApi.getMyContracts(OWNER, { role: 'owner' });
        expect(asOwner).toHaveLength(1);
    });
});

// ── factory contract ──────────────────────────────────────────────────

describe('rental: factory walletModule dependency', () => {
    test('throws when walletModule is missing', () => {
        expect(() => rental({ authMiddleware: noopAuth }))
            .toThrow(/walletModule/);
    });
});
