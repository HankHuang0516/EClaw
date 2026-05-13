/**
 * P0 Phase 4: rebind cascade — strict active-contract termination.
 *
 * On rebind, only active contracts on the rebound owner slot are terminated.
 * Everything runs inside one wallet transaction: contracts + wallets are locked,
 * the renter's held deposit is released, the owner pays a per-second refund,
 * and rental_rebind_audit_log records the rental-side audit trail. If the owner
 * cannot cover all refunds, the transaction rejects and rolls back.
 */

jest.mock('pg', () => {
    const state = {
        listings: [],
        contracts: [],
        wallets: new Map(),
        ledger: [],
        cooldowns: [],
        rebindAudit: [],
        nextLedgerId: 1,
        now: new Date('2026-05-13T06:00:00.000Z'),
        txSnapshot: null,
    };
    globalThis.__rebindState = state;

    function cloneDate(v) { return v instanceof Date ? new Date(v.getTime()) : v; }
    function cloneState() {
        return {
            listings: state.listings.map(r => ({ ...r })),
            contracts: state.contracts.map(r => ({ ...r, started_at: cloneDate(r.started_at), ends_at: cloneDate(r.ends_at), actual_ended_at: cloneDate(r.actual_ended_at) })),
            wallets: new Map([...state.wallets.entries()].map(([k, v]) => [k, { ...v }])),
            ledger: state.ledger.map(r => ({ ...r, created_at: cloneDate(r.created_at) })),
            cooldowns: state.cooldowns.map(r => ({ ...r })),
            rebindAudit: state.rebindAudit.map(r => ({ ...r, created_at: cloneDate(r.created_at) })),
            nextLedgerId: state.nextLedgerId,
        };
    }
    function restoreState(snapshot) {
        state.listings.length = 0; state.listings.push(...snapshot.listings);
        state.contracts.length = 0; state.contracts.push(...snapshot.contracts);
        state.wallets.clear(); for (const [k, v] of snapshot.wallets.entries()) state.wallets.set(k, v);
        state.ledger.length = 0; state.ledger.push(...snapshot.ledger);
        state.cooldowns.length = 0; state.cooldowns.push(...snapshot.cooldowns);
        state.rebindAudit.length = 0; state.rebindAudit.push(...snapshot.rebindAudit);
        state.nextLedgerId = snapshot.nextLedgerId;
    }

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

        if (/^BEGIN$/i.test(norm)) { state.txSnapshot = cloneState(); return { rows: [], rowCount: 0 }; }
        if (/^COMMIT$/i.test(norm)) { state.txSnapshot = null; return { rows: [], rowCount: 0 }; }
        if (/^ROLLBACK$/i.test(norm)) {
            if (state.txSnapshot) restoreState(state.txSnapshot);
            state.txSnapshot = null;
            return { rows: [], rowCount: 0 };
        }
        if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(norm)) return { rows: [], rowCount: 0 };

        // Phase 4 strict query: active contracts only, locked by the transaction.
        if (/^SELECT c\.id, c\.listing_id, c\.owner_user_id, c\.renter_user_id, c\.deposit_mli, c\.planned_duration_min, COALESCE\(/i.test(norm) && /FROM rental_contracts c JOIN bot_listings l ON l\.id = c\.listing_id/i.test(norm) && /AND c\.status = 'active'/i.test(norm)) {
            const [deviceId, entityId] = params;
            const now = state.now;
            const matches = state.contracts.filter(c => {
                const l = state.listings.find(x => x.id === c.listing_id);
                return l && l.owner_device_id === deviceId &&
                    l.owner_entity_id === entityId && c.status === 'active';
            }).sort((a, b) => a.id.localeCompare(b.id)).map(c => {
                const total = c.total_duration_sec ?? (c.planned_duration_min * 60);
                const remaining = c.ends_at ? Math.max(0, Math.floor((c.ends_at.getTime() - now.getTime()) / 1000)) : 0;
                return {
                    id: c.id,
                    listing_id: c.listing_id,
                    owner_user_id: c.owner_user_id,
                    renter_user_id: c.renter_user_id,
                    deposit_mli: c.deposit_mli.toString(),
                    planned_duration_min: c.planned_duration_min,
                    total_duration_sec: String(total),
                    remaining_sec: String(remaining),
                    started_at: c.started_at,
                    ends_at: c.ends_at,
                    status: c.status,
                    terminated_at: now,
                };
            });
            return { rows: matches, rowCount: matches.length };
        }

        // Stable ordered wallet lock for every participating owner/renter.
        if (/^SELECT user_id, balance_mli, held_mli FROM wallets WHERE user_id = ANY\(\$1::uuid\[\]\) ORDER BY user_id FOR UPDATE$/i.test(norm)) {
            const ids = params[0] || [];
            const rows = ids.filter(id => state.wallets.has(id)).sort().map(id => {
                const w = state.wallets.get(id);
                return { user_id: id, balance_mli: w.balance_mli.toString(), held_mli: w.held_mli.toString() };
            });
            return { rows, rowCount: rows.length };
        }

        // UPDATE rental_contracts on rebind termination.
        if (/^UPDATE rental_contracts SET status = \$2, end_reason = \$2, actual_ended_at = NOW\(\) WHERE id = \$1 AND status = 'active' RETURNING/i.test(norm)) {
            const row = state.contracts.find(c => c.id === params[0] && c.status === 'active');
            if (!row) return { rows: [], rowCount: 0 };
            row.status = params[1]; row.end_reason = params[1]; row.actual_ended_at = new Date(state.now.getTime());
            return { rows: [{ id: row.id, status: row.status, end_reason: row.end_reason, actual_ended_at: row.actual_ended_at }], rowCount: 1 };
        }

        if (/^INSERT INTO rental_rebind_audit_log/i.test(norm)) {
            const [contractId, listingId, deviceId, entityId, ownerId, renterId, statusFrom, statusTo,
                depositMli, releaseMli, refundMli, remainingSec, totalDurationSec,
                releaseKey, debitKey, creditKey] = params;
            if (!state.rebindAudit.some(r => r.contract_id === contractId)) {
                state.rebindAudit.push({
                    contract_id: contractId,
                    listing_id: listingId,
                    owner_device_id: deviceId,
                    owner_entity_id: entityId,
                    owner_user_id: ownerId,
                    renter_user_id: renterId,
                    status_from: statusFrom,
                    status_to: statusTo,
                    deposit_mli: String(depositMli),
                    deposit_release_mli: String(releaseMli),
                    refund_mli: String(refundMli),
                    remaining_sec: String(remainingSec),
                    total_duration_sec: String(totalDurationSec),
                    wallet_release_idempotency_key: releaseKey,
                    wallet_debit_idempotency_key: debitKey,
                    wallet_credit_idempotency_key: creditKey,
                    created_at: new Date(state.now.getTime()),
                });
            }
            return { rows: [], rowCount: 1 };
        }

        // Legacy endRental queries are still needed by unrelated rental exports/tests.
        if (/^SELECT id, listing_id, owner_user_id, renter_user_id, deposit_mli, status\s*FROM rental_contracts WHERE id = \$1 FOR UPDATE$/i.test(norm)) {
            const row = state.contracts.find(c => c.id === params[0]);
            if (!row) return { rows: [], rowCount: 0 };
            return { rows: [{
                id: row.id, listing_id: row.listing_id,
                owner_user_id: row.owner_user_id, renter_user_id: row.renter_user_id,
                deposit_mli: row.deposit_mli.toString(), status: row.status,
            }], rowCount: 1 };
        }
        if (/^INSERT INTO rental_cooldowns/i.test(norm)) {
            state.cooldowns.push({ user_id: params[0], listing_id: params[1] });
            return { rows: [], rowCount: 1 };
        }

        // wallet.js query surface.
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
        if (/^SELECT balance_mli, held_mli FROM wallets\s+WHERE user_id = \$1 FOR UPDATE$/i.test(norm)) {
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
                created_at: new Date(state.now.getTime()),
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
const NOW = new Date('2026-05-13T06:00:00.000Z');

function reset() {
    const s = globalThis.__rebindState;
    s.listings.length = 0; s.contracts.length = 0; s.cooldowns.length = 0; s.rebindAudit.length = 0;
    s.wallets.clear(); s.ledger.length = 0; s.nextLedgerId = 1; s.txSnapshot = null;
    s.now = new Date(NOW.getTime());
}
beforeEach(() => reset());

function topup(userId, amount, label = 'seed') {
    return walletApi.creditTopup({
        userId, amountMli: amount, orderId: `${label}-${userId}`,
        channel: 'admin_grant', idempotencyKey: `topup:${label}:${userId}:${Math.random()}`,
    });
}

async function holdDeposit(userId, contractId, amount) {
    await walletApi.withTransaction(async (client) => {
        await walletApi.applyLedgerEntry(client, {
            userId, balanceDelta: -amount, heldDelta: amount,
            type: walletApi.LEDGER_TYPES.DEPOSIT_HOLD,
            refType: 'rental_contract', refId: contractId,
            idempotencyKey: `seed-hold-${contractId}`,
        });
    });
}

function seedContract({
    contractId,
    listingId = `listing-${contractId}`,
    ownerUserId = OWNER,
    renterUserId = RENTER,
    deviceId = DEVICE_ID,
    entityId = ENTITY_ID,
    depositMli,
    plannedDurationMin = 60,
    totalDurationSec = plannedDurationMin * 60,
    remainingSec = Math.floor(totalDurationSec / 2),
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
    const endsAt = new Date(s.now.getTime() + remainingSec * 1000);
    const startedAt = new Date(endsAt.getTime() - totalDurationSec * 1000);
    s.contracts.push({
        id: contractId,
        listing_id: listingId,
        owner_user_id: ownerUserId,
        renter_user_id: renterUserId,
        deposit_mli: BigInt(depositMli),
        planned_duration_min: plannedDurationMin,
        total_duration_sec: totalDurationSec,
        started_at: startedAt,
        ends_at: endsAt,
        status,
        end_reason: null,
        actual_ended_at: null,
    });
}

function ledgerByKey(key) {
    return globalThis.__rebindState.ledger.find(r => r.idempotency_key === key);
}

describe('Phase 4: terminateActiveContractsOnRebind strict refunds', () => {
    test('no active contracts on slot → returns empty', async () => {
        const out = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi);
        expect(out).toEqual([]);
    });

    test('active contract: deposit release + exact per-second owner refund + audit log', async () => {
        seedContract({
            contractId: 'c1',
            depositMli: 100_000,
            totalDurationSec: 3600,
            remainingSec: 1801,
        });
        await topup(RENTER, 100_000, 'renter-c1');
        await holdDeposit(RENTER, 'c1', 100_000);
        await topup(OWNER, 200_000, 'owner-c1');

        const outcomes = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi);

        expect(outcomes).toEqual([expect.objectContaining({
            contractId: 'c1',
            releasedDepositMli: 100_000,
            refundMli: Math.floor(100_000 * 1801 / 3600),
            remainingSec: 1801,
            totalDurationSec: 3600,
            status: 'terminated_by_rebind',
        })]);

        const renterBal = await walletApi.getBalance(RENTER);
        expect(renterBal.balance_mli).toBe(String(100_000 + Math.floor(100_000 * 1801 / 3600)));
        expect(renterBal.held_mli).toBe('0');

        const ownerBal = await walletApi.getBalance(OWNER);
        expect(ownerBal.balance_mli).toBe(String(200_000 - Math.floor(100_000 * 1801 / 3600)));

        const contract = globalThis.__rebindState.contracts.find(c => c.id === 'c1');
        expect(contract.status).toBe('terminated_by_rebind');
        expect(contract.end_reason).toBe('terminated_by_rebind');

        expect(ledgerByKey('rebind-deposit-release:c1')).toEqual(expect.objectContaining({
            user_id: RENTER,
            delta_mli: '100000',
            held_delta_mli: '-100000',
            type: walletApi.LEDGER_TYPES.DEPOSIT_RELEASE,
        }));
        expect(ledgerByKey('rebind-refund-debit:c1')).toEqual(expect.objectContaining({
            user_id: OWNER,
            delta_mli: String(-Math.floor(100_000 * 1801 / 3600)),
            type: walletApi.LEDGER_TYPES.REFUND,
        }));
        expect(ledgerByKey('rebind-refund-credit:c1')).toEqual(expect.objectContaining({
            user_id: RENTER,
            delta_mli: String(Math.floor(100_000 * 1801 / 3600)),
            type: walletApi.LEDGER_TYPES.REFUND,
        }));

        expect(globalThis.__rebindState.rebindAudit).toEqual([expect.objectContaining({
            contract_id: 'c1',
            status_from: 'active',
            status_to: 'terminated_by_rebind',
            deposit_release_mli: '100000',
            refund_mli: String(Math.floor(100_000 * 1801 / 3600)),
            wallet_release_idempotency_key: 'rebind-deposit-release:c1',
            wallet_debit_idempotency_key: 'rebind-refund-debit:c1',
            wallet_credit_idempotency_key: 'rebind-refund-credit:c1',
        })]);
    });

    test('expired active and free active contracts terminate with zero owner refund', async () => {
        seedContract({ contractId: 'expired', depositMli: 50_000, totalDurationSec: 3600, remainingSec: -10 });
        seedContract({ contractId: 'free', listingId: 'listing-free', depositMli: 0, totalDurationSec: 3600, remainingSec: 1800, renterUserId: RENTER_B });
        await topup(RENTER, 50_000, 'renter-expired');
        await holdDeposit(RENTER, 'expired', 50_000);
        // Owner deliberately has no balance; zero-refund contracts must still terminate.

        const out = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi);
        expect(out).toHaveLength(2);
        expect(out.find(o => o.contractId === 'expired')).toEqual(expect.objectContaining({
            releasedDepositMli: 50_000,
            refundMli: 0,
            remainingSec: 0,
        }));
        expect(out.find(o => o.contractId === 'free')).toEqual(expect.objectContaining({
            releasedDepositMli: 0,
            refundMli: 0,
        }));

        const ownerBal = await walletApi.getBalance(OWNER);
        expect(ownerBal.balance_mli).toBe('0');
        expect(ledgerByKey('rebind-refund-debit:expired')).toBeUndefined();
        expect(ledgerByKey('rebind-refund-credit:free')).toBeUndefined();
        expect(globalThis.__rebindState.rebindAudit).toHaveLength(2);
    });

    test('owner insufficient balance rejects and rolls back contract, wallet, ledger, and audit changes', async () => {
        seedContract({ contractId: 'cShort', depositMli: 100_000, totalDurationSec: 3600, remainingSec: 3600 });
        await topup(RENTER, 100_000, 'renter-short');
        await holdDeposit(RENTER, 'cShort', 100_000);
        await topup(OWNER, 99_999, 'owner-short');

        await expect(rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi))
            .rejects.toThrow('owner_insufficient_balance_for_rebind_refund');

        const contract = globalThis.__rebindState.contracts.find(c => c.id === 'cShort');
        expect(contract.status).toBe('active');
        expect(contract.end_reason).toBeNull();
        expect(contract.actual_ended_at).toBeNull();

        const renterBal = await walletApi.getBalance(RENTER);
        expect(renterBal.balance_mli).toBe('0');
        expect(renterBal.held_mli).toBe('100000');
        const ownerBal = await walletApi.getBalance(OWNER);
        expect(ownerBal.balance_mli).toBe('99999');
        expect(ledgerByKey('rebind-deposit-release:cShort')).toBeUndefined();
        expect(globalThis.__rebindState.rebindAudit).toEqual([]);
    });

    test('terminated/reserved/suspended contracts are skipped; only active slot contracts are affected', async () => {
        seedContract({ contractId: 'active', depositMli: 60_000, totalDurationSec: 3600, remainingSec: 1800 });
        seedContract({ contractId: 'terminated', listingId: 'listing-term', depositMli: 60_000, status: 'terminated_by_rebind' });
        seedContract({ contractId: 'reserved', listingId: 'listing-res', depositMli: 60_000, status: 'reserved' });
        seedContract({ contractId: 'suspended', listingId: 'listing-susp', depositMli: 60_000, status: 'suspended_insufficient_funds' });
        seedContract({
            contractId: 'otherSlot', listingId: 'listing-other', depositMli: 60_000,
            deviceId: DEVICE_ID, entityId: 1, ownerUserId: OWNER_B, renterUserId: RENTER_B,
        });
        await topup(RENTER, 60_000, 'renter-active');
        await holdDeposit(RENTER, 'active', 60_000);
        await topup(OWNER, 1_000_000, 'owner-active');

        const out = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi);
        expect(out.map(o => o.contractId)).toEqual(['active']);
        expect(globalThis.__rebindState.contracts.find(c => c.id === 'active').status).toBe('terminated_by_rebind');
        expect(globalThis.__rebindState.contracts.find(c => c.id === 'terminated').status).toBe('terminated_by_rebind');
        expect(globalThis.__rebindState.contracts.find(c => c.id === 'reserved').status).toBe('reserved');
        expect(globalThis.__rebindState.contracts.find(c => c.id === 'suspended').status).toBe('suspended_insufficient_funds');
        expect(globalThis.__rebindState.contracts.find(c => c.id === 'otherSlot').status).toBe('active');
    });

    test('idempotency: a second run sees no active contract and does not duplicate audit/ledger', async () => {
        seedContract({ contractId: 'cIdem', depositMli: 60_000, totalDurationSec: 3600, remainingSec: 1800 });
        await topup(RENTER, 60_000, 'renter-idem');
        await holdDeposit(RENTER, 'cIdem', 60_000);
        await topup(OWNER, 1_000_000, 'owner-idem');

        const first = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi);
        expect(first).toHaveLength(1);
        const ledgerCount = globalThis.__rebindState.ledger.length;
        const auditCount = globalThis.__rebindState.rebindAudit.length;

        const second = await rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, walletApi);
        expect(second).toEqual([]);
        expect(globalThis.__rebindState.ledger).toHaveLength(ledgerCount);
        expect(globalThis.__rebindState.rebindAudit).toHaveLength(auditCount);
    });

    test('missing walletApi or invalid args → returns [] without throwing', async () => {
        seedContract({ contractId: 'cBad', depositMli: 10_000 });
        await expect(rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, ENTITY_ID, null)).resolves.toEqual([]);
        await expect(rentalApi.terminateActiveContractsOnRebind(null, ENTITY_ID, walletApi)).resolves.toEqual([]);
        await expect(rentalApi.terminateActiveContractsOnRebind(DEVICE_ID, 'not-a-number', walletApi)).resolves.toEqual([]);
    });
});
