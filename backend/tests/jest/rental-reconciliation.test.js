/**
 * Rental Reconciliation Tests — reconcileRentalEntities() 4-phase unit tests.
 *
 * Mocks pg Pool.query to simulate DB responses for each phase.
 * Uses the same rental module import pattern as rental-guardrails.test.js.
 */

// ── Mock pg before any require ─────────────────────────────────────────
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockQuery,
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
    })),
}));

jest.mock('fs', () => {
    const real = jest.requireActual('fs');
    return {
        ...real,
        readFileSync: jest.fn((p, enc) => {
            if (typeof p === 'string' &&
                (p.endsWith('rental_schema.sql') || p.endsWith('wallet_schema.sql'))) return '';
            return real.readFileSync(p, enc);
        }),
    };
});

// ── Require rental module ──────────────────────────────────────────────
const rental = require('../../rental');
const noopAuth = (_req, _res, next) => next();
const stubWallet = {
    withTransaction: async () => { throw new Error('not_used'); },
    LEDGER_TYPES: {},
};
const rentalApi = rental({ authMiddleware: noopAuth, walletModule: stubWallet });

const mockSaveDeviceData = jest.fn().mockResolvedValue(undefined);

function makeHelpers(overrides = {}) {
    return {
        generateBotSecret: () => 'secret-' + Math.random(),
        generatePublicCode: () => 'PC' + Math.random(),
        publicCodeIndex: {},
        ensureOneEmptySlot: jest.fn(),
        getOrCreateDevice: jest.fn((id) => ({ entities: {} })),
        saveDeviceData: mockSaveDeviceData,
        ...overrides,
    };
}

beforeEach(() => {
    mockQuery.mockReset();
    mockSaveDeviceData.mockClear();
});

// ── Phase 1: Remove renter entities whose contracts ended ──────────────
describe('Phase 1: ended contract cleanup', () => {
    test('entity with ended contract is deleted', async () => {
        const devices = {
            'dev-1': {
                entities: {
                    0: { isBound: true, rental_contract_id: 'c-ended', rental_status: 'leased_in', publicCode: 'PC1' },
                },
            },
        };
        // contract query returns ended status
        mockQuery.mockResolvedValueOnce({ rows: [{ status: 'ended' }] });
        // Phase 2 queries (allTitles, activeTitles)
        mockQuery.mockResolvedValueOnce({ rows: [] }); // active titles
        mockQuery.mockResolvedValueOnce({ rows: [] }); // all titles
        // Phase 4 active contracts
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const helpers = makeHelpers();
        const result = await rentalApi.reconcileRentalEntities(devices, helpers);

        expect(devices['dev-1'].entities[0]).toBeUndefined();
        expect(result.reconciled).toBeGreaterThanOrEqual(1);
        expect(helpers.publicCodeIndex['PC1']).toBeUndefined();
    });

    test('entity with active contract is preserved and rental_status backfilled', async () => {
        const devices = {
            'dev-1': {
                entities: {
                    0: { isBound: true, rental_contract_id: 'c-active', rental_status: undefined },
                },
            },
        };
        // Phase 1: contract is active
        mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }] });
        // Phase 2
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        // Phase 4
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const result = await rentalApi.reconcileRentalEntities(devices, makeHelpers());

        expect(devices['dev-1'].entities[0]).toBeDefined();
        expect(devices['dev-1'].entities[0].rental_status).toBe('leased_in');
    });
});

// ── Phase 2: Remove legacy ghost entities (title matching) ─────────────
describe('Phase 2: legacy ghost cleanup', () => {
    test('entity name matches listing title but no active contract -> deleted', async () => {
        const devices = {
            'dev-2': {
                entities: {
                    0: { isBound: true, name: 'Ghost Bot', publicCode: 'PC2' },
                    // no rental_contract_id, no rental_status
                },
            },
        };
        // Phase 2: active titles (none match), all titles (matches)
        mockQuery.mockResolvedValueOnce({ rows: [] }); // active titles
        mockQuery.mockResolvedValueOnce({ rows: [{ title: 'Ghost Bot' }] }); // all titles
        // Phase 4
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const helpers = makeHelpers();
        const result = await rentalApi.reconcileRentalEntities(devices, helpers);

        expect(devices['dev-2'].entities[0]).toBeUndefined();
        expect(result.reconciled).toBeGreaterThanOrEqual(1);
    });

    test('entity name matches listing title WITH active contract -> preserved', async () => {
        const devices = {
            'dev-2': {
                entities: {
                    0: { isBound: true, name: 'Active Bot' },
                },
            },
        };
        // Phase 2: active titles includes this name, all titles too
        mockQuery.mockResolvedValueOnce({ rows: [{ title: 'Active Bot' }] }); // active titles
        mockQuery.mockResolvedValueOnce({ rows: [{ title: 'Active Bot' }] }); // all titles
        // Phase 4
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const result = await rentalApi.reconcileRentalEntities(devices, makeHelpers());

        expect(devices['dev-2'].entities[0]).toBeDefined();
    });
});

// ── Phase 3: Clear stale leased_out on owner entities ──────────────────
describe('Phase 3: stale leased_out cleanup', () => {
    test('owner entity with leased_out but ended contract -> status cleared', async () => {
        const devices = {
            'owner-dev': {
                entities: {
                    0: { isBound: true, rental_status: 'leased_out', rental_contract_id: 'c-old' },
                },
            },
        };
        // Phase 1 also processes this entity (has rental_contract_id) — return
        // active so Phase 1 preserves it; entity.rental_status is already set
        // so no backfill branch fires.
        mockQuery.mockResolvedValueOnce({ rows: [{ status: 'active' }] });
        // Phase 2
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        // Phase 3: now contract is ended → status should be cleared
        mockQuery.mockResolvedValueOnce({ rows: [{ status: 'ended' }] });
        // Phase 4
        mockQuery.mockResolvedValueOnce({ rows: [] });

        const result = await rentalApi.reconcileRentalEntities(devices, makeHelpers());

        expect(devices['owner-dev'].entities[0].rental_status).toBeNull();
        expect(devices['owner-dev'].entities[0].rental_contract_id).toBeNull();
        expect(result.reconciled).toBeGreaterThanOrEqual(1);
    });
});

// ── Phase 4: Restore missing entities for active contracts ─────────────
describe('Phase 4: restore missing renter entities', () => {
    test('active contract but no renter entity -> entity restored', async () => {
        const devices = {
            'renter-dev': { entities: {} },
        };
        // Phase 2
        mockQuery.mockResolvedValueOnce({ rows: [] });
        mockQuery.mockResolvedValueOnce({ rows: [] });
        // Phase 4: active contracts query
        mockQuery.mockResolvedValueOnce({
            rows: [{
                id: 'c-restore', renter_device_id: 'renter-dev',
                listing_id: 'lst-1', rate_mli_per_ktoken_snapshot: '8000',
            }],
        });
        // Phase 4: getListing query (called twice — once for insert, once for markOwner)
        const listingRow = {
            id: 'lst-1', title: 'Restored Bot', owner_device_id: 'owner-dev',
            owner_entity_id: 0, rate_mli_per_ktoken: 8000,
        };
        mockQuery.mockResolvedValueOnce({ rows: [listingRow] }); // for insertRentalEntity
        mockQuery.mockResolvedValueOnce({ rows: [listingRow] }); // for markOwnerEntityLeasedOut

        const helpers = makeHelpers();
        const result = await rentalApi.reconcileRentalEntities(devices, helpers);

        // Should have inserted a rental entity
        const entities = Object.values(devices['renter-dev'].entities);
        const restored = entities.find(e => e?.rental_contract_id === 'c-restore');
        expect(restored).toBeDefined();
        expect(restored.isBound).toBe(true);
        expect(restored.rental_status).toBe('leased_in');
        expect(result.reconciled).toBeGreaterThanOrEqual(1);
    });
});
