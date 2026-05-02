/**
 * Rental debug endpoints.
 *
 * Covers the production E2E failure mode where contract start returned
 * internal_error and the existing debug endpoint also crashed before it could
 * explain the state.
 */

jest.mock('pg', () => {
    const state = {
        devices: new Map(),
        usersByDevice: new Map(),
        listings: new Map(),
        cooldowns: [],
        contracts: [],
        wallets: new Map(),
        entitiesByDevice: new Map(),
    };
    globalThis.__rentalDebugState = state;

    function runQuery(sql, params = []) {
        const norm = sql.replace(/\s+/g, ' ').trim();

        if (/^SELECT device_id, device_secret FROM devices WHERE device_id = \$1$/i.test(norm)) {
            const row = state.devices.get(params[0]);
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
        }

        if (/^SELECT id, email, device_id FROM user_accounts WHERE device_id = \$1$/i.test(norm)) {
            const row = state.usersByDevice.get(params[0]);
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
        }

        if (/^SELECT id, owner_user_id, owner_device_id, owner_entity_id,/i.test(norm)) {
            const row = state.listings.get(params[0]);
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
        }

        if (/^SELECT id, owner_user_id, rate_mli_per_ktoken,/i.test(norm)) {
            const row = state.listings.get(params[0]);
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
        }

        if (/^SELECT cooldown_until FROM rental_cooldowns/i.test(norm)) {
            const rows = state.cooldowns.filter(c => c.user_id === params[0] && c.listing_id === params[1]);
            return { rows, rowCount: rows.length };
        }

        if (/^SELECT id, status, started_at, ends_at FROM rental_contracts/i.test(norm)) {
            const rows = state.contracts.filter(c =>
                c.listing_id === params[0] &&
                ['reserved', 'active', 'suspended_insufficient_funds'].includes(c.status)
            );
            return { rows, rowCount: rows.length };
        }

        if (/^SELECT id FROM rental_contracts/i.test(norm)) {
            const rows = state.contracts.filter(c =>
                c.listing_id === params[0] &&
                ['reserved', 'active', 'suspended_insufficient_funds'].includes(c.status)
            );
            return { rows: rows.map(c => ({ id: c.id })), rowCount: rows.length };
        }

        if (/^INSERT INTO rental_contracts/i.test(norm)) {
            return {
                rows: [{
                    id: params[0],
                    status: 'active',
                    started_at: new Date('2026-05-01T00:00:00Z'),
                    ends_at: new Date('2026-05-01T00:30:00Z'),
                    deposit_mli: params[6],
                }],
                rowCount: 1,
            };
        }

        if (/^INSERT INTO rental_snapshots/i.test(norm)) {
            return { rows: [], rowCount: 1 };
        }

        if (/^SELECT id, listing_id, status, started_at, ends_at, renter_device_id FROM rental_contracts/i.test(norm)) {
            const rows = state.contracts.filter(c =>
                c.renter_device_id === params[0] &&
                ['reserved', 'active', 'suspended_insufficient_funds'].includes(c.status)
            );
            return { rows, rowCount: rows.length };
        }

        if (/^SELECT balance_mli, held_mli FROM wallets WHERE user_id = \$1$/i.test(norm)) {
            const row = state.wallets.get(params[0]);
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
        }

        if (/^SELECT balance_mli FROM wallets WHERE user_id = \$1$/i.test(norm)) {
            const row = state.wallets.get(params[0]);
            return { rows: row ? [{ balance_mli: row.balance_mli }] : [], rowCount: row ? 1 : 0 };
        }

        if (/^SELECT entity_id, is_bound, character, webhook FROM entities WHERE device_id = \$1/i.test(norm)) {
            const rows = state.entitiesByDevice.get(params[0]) || [];
            return { rows: rows.map(r => ({ ...r })), rowCount: rows.length };
        }

        if (/^(BEGIN|ROLLBACK)$/i.test(norm)) {
            return { rows: [], rowCount: 0 };
        }

        throw new Error(`[rental-debug fake pg] Unhandled SQL: ${norm}`);
    }

    return {
        Pool: jest.fn(() => ({
            query: jest.fn((sql, params) => Promise.resolve(runQuery(sql, params))),
            connect: jest.fn(() => Promise.resolve({
                query: jest.fn((sql, params) => Promise.resolve(runQuery(sql, params))),
                release: jest.fn(),
            })),
        })),
    };
});

const express = require('express');
const request = require('supertest');
const rentalFactory = require('../../rental');

function buildApp() {
    const app = express();
    app.use(express.json());
    const rental = rentalFactory({
        authMiddleware: (req, _res, next) => {
            req.user = { userId: 'requester-user', deviceId: 'owner-device' };
            next();
        },
        walletModule: {
            withTransaction: async (fn) => fn({ query: () => Promise.resolve({ rows: [], rowCount: 0 }) }),
            applyLedgerEntry: jest.fn(() => Promise.resolve({})),
            LEDGER_TYPES: { DEPOSIT_HOLD: 'deposit_hold' },
        },
    });
    rental.setInterviewDeps({
        devices: {
            'owner-device': {
                entities: {
                    1: {
                        isBound: true,
                        character: 'Mac_F',
                        name: 'My Bot',
                        webhook: { url: 'https://example.test/hook' },
                    },
                },
            },
            'renter-device': { entities: {} },
        },
    });
    app.use('/api/rental', rental.router);
    return app;
}

function seedHappyPath() {
    const state = globalThis.__rentalDebugState;
    state.devices.clear();
    state.usersByDevice.clear();
    state.listings.clear();
    state.cooldowns = [];
    state.contracts = [];
    state.wallets.clear();
    state.entitiesByDevice.clear();

    state.devices.set('owner-device', {
        device_id: 'owner-device',
        device_secret: 'owner-secret',
    });
    state.usersByDevice.set('owner-device', {
        id: 'owner-user',
        email: 'owner@example.test',
        device_id: 'owner-device',
    });
    state.usersByDevice.set('renter-device', {
        id: 'renter-user',
        email: 'renter@example.test',
        device_id: 'renter-device',
    });
    state.listings.set('listing-1', {
        id: 'listing-1',
        owner_user_id: 'owner-user',
        owner_device_id: 'owner-device',
        owner_entity_id: 1,
        title: 'My Bot',
        status: 'listed',
        interview_passed: true,
        rate_mli_per_ktoken: 5000,
        min_rental_minutes: 30,
        max_rental_minutes: 10080,
        updated_at: new Date('2026-05-01T00:00:00Z'),
    });
    state.wallets.set('renter-user', {
        balance_mli: '480000',
        held_mli: '0',
    });
    state.entitiesByDevice.set('renter-device', [
        { entity_id: 15, is_bound: false, character: null, webhook: null },
    ]);
}

describe('rental debug endpoints', () => {
    beforeEach(seedHappyPath);

    test('rental-entity-visibility authenticates with safeEqual import fixed', async () => {
        const res = await request(buildApp())
            .get('/api/rental/debug/rental-entity-visibility')
            .query({ deviceId: 'owner-device', deviceSecret: 'owner-secret' })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.bug).toBe('rental-entity-visibility');
        expect(res.body.error).toBeUndefined();
    });

    test('contract-start-fail reports affordability and no predicted blocker', async () => {
        const res = await request(buildApp())
            .get('/api/rental/debug/contract-start-fail')
            .query({
                deviceId: 'owner-device',
                deviceSecret: 'owner-secret',
                listingId: 'listing-1',
                renterDeviceId: 'renter-device',
                durationMinutes: 30,
            })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.bug).toBe('contract-start-fail');
        expect(res.body.diagnostics.economics).toMatchObject({
            deposit_mli: '100000',
            buffer_mli: '300000',
            required_mli: '400000',
            current_mli: '480000',
            affordable: true,
            predicted_error: null,
        });
        expect(res.body.diagnostics.memory.ownerDeviceInMemory).toBe(true);
        expect(res.body.diagnostics.renterDbEntities).toEqual([
            expect.objectContaining({ entity_id: 15, is_bound: false }),
        ]);
        expect(res.body.diagnostics.dryRunStart).toMatchObject({
            ok: true,
        });
        expect(res.body.diagnostics.dryRunStart.contractIdPreview).toMatch(/^contract_[a-f0-9]{24}$/);
    });

    test('contract-start-fail predicts insufficient rental balance', async () => {
        globalThis.__rentalDebugState.wallets.set('renter-user', {
            balance_mli: '399999',
            held_mli: '0',
        });

        const res = await request(buildApp())
            .get('/api/rental/debug/contract-start-fail')
            .query({
                deviceId: 'owner-device',
                deviceSecret: 'owner-secret',
                listingId: 'listing-1',
                renterDeviceId: 'renter-device',
                durationMinutes: 30,
            })
            .expect(200);

        expect(res.body.diagnostics.economics).toMatchObject({
            required_mli: '400000',
            current_mli: '399999',
            affordable: false,
            predicted_error: 'insufficient_balance_for_rental',
        });
    });
});
