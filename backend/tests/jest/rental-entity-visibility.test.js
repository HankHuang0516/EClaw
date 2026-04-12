/**
 * Regression test: Rental entity dashboard visibility (#1712)
 *
 * Verifies that insertRentalEntity() creates entities with all required
 * fields (entityId, botSecret, publicCode) so they appear on the
 * renter's dashboard via GET /api/entities.
 */

const { insertRentalEntity, removeRentalEntity, createDefaultRentalEntity } = (() => {
    // We need to extract the pure functions from rental.js.
    // Since rental.js exports a factory, we access the named exports it attaches.
    const mod = require('../../rental');
    // The factory returns an object with these helpers
    const instance = mod({
        authMiddleware: (req, res, next) => next(),
        adminMiddleware: (req, res, next) => next(),
        walletModule: { withTransaction: async (fn) => fn({}) },
        serverLog: () => {},
    });
    return instance;
})();

describe('Rental entity dashboard visibility (#1712)', () => {
    let devices;
    let publicCodeIndex;
    const helpers = {
        generateBotSecret: () => 'test_bot_secret_32charhex1234567',
        generatePublicCode: () => 'abc123',
        publicCodeIndex: {},
        ensureOneEmptySlot: () => null,
    };

    beforeEach(() => {
        publicCodeIndex = {};
        helpers.publicCodeIndex = publicCodeIndex;
        devices = {
            'renter-device-1': {
                deviceId: 'renter-device-1',
                deviceSecret: 'secret',
                nextEntityId: 2,
                entities: {
                    0: {
                        entityId: 0,
                        botSecret: 'existing-secret',
                        isBound: true,
                        character: 'existing',
                        name: 'Existing Bot',
                        state: 'IDLE',
                        message: '',
                        parts: {},
                        lastUpdated: Date.now(),
                        messageQueue: [],
                        webhook: { url: 'https://example.com' },
                        xp: 0,
                        level: 1,
                        avatar: null,
                        publicCode: 'exist1',
                    },
                    1: {
                        entityId: 1,
                        isBound: false,
                        character: 'LOBSTER',
                        state: 'IDLE',
                        message: '',
                        parts: {},
                        lastUpdated: Date.now(),
                        messageQueue: [],
                        webhook: null,
                        xp: 0,
                        level: 1,
                        avatar: null,
                        publicCode: null,
                    },
                },
            },
        };
    });

    test('insertRentalEntity sets entityId on the entity', () => {
        const result = insertRentalEntity(devices, {
            renterDeviceId: 'renter-device-1',
            contractId: 'contract-1',
            listing: { title: 'Test Rental Bot' },
            rateMliPerKtoken: 5000,
        }, helpers);

        expect(result.slot).toBe(1); // reuses unbound slot 1
        const entity = devices['renter-device-1'].entities[1];
        expect(entity.entityId).toBe(1);
        expect(entity.isBound).toBe(true);
    });

    test('insertRentalEntity generates botSecret', () => {
        const result = insertRentalEntity(devices, {
            renterDeviceId: 'renter-device-1',
            contractId: 'contract-1',
            listing: { title: 'Test Rental Bot' },
            rateMliPerKtoken: 5000,
        }, helpers);

        const entity = devices['renter-device-1'].entities[result.slot];
        expect(entity.botSecret).toBeTruthy();
        expect(typeof entity.botSecret).toBe('string');
        expect(entity.botSecret.length).toBeGreaterThan(0);
        expect(result.botSecret).toBe(entity.botSecret);
    });

    test('insertRentalEntity generates publicCode and registers in index', () => {
        const result = insertRentalEntity(devices, {
            renterDeviceId: 'renter-device-1',
            contractId: 'contract-1',
            listing: { title: 'Test Rental Bot' },
            rateMliPerKtoken: 5000,
        }, helpers);

        const entity = devices['renter-device-1'].entities[result.slot];
        expect(entity.publicCode).toBeTruthy();
        expect(result.publicCode).toBe(entity.publicCode);
        // Should be registered in the public code index
        expect(publicCodeIndex[entity.publicCode]).toEqual({
            deviceId: 'renter-device-1',
            entityId: result.slot,
        });
    });

    test('insertRentalEntity sets name and character from listing title', () => {
        insertRentalEntity(devices, {
            renterDeviceId: 'renter-device-1',
            contractId: 'contract-1',
            listing: { title: 'My Cool Bot' },
            rateMliPerKtoken: 3000,
        }, helpers);

        const entity = devices['renter-device-1'].entities[1];
        expect(entity.name).toBe('My Cool Bot');
        expect(entity.character).toBe('My Cool Bot');
    });

    test('rental entity would be returned by /api/entities filter (isBound check)', () => {
        insertRentalEntity(devices, {
            renterDeviceId: 'renter-device-1',
            contractId: 'contract-1',
            listing: { title: 'Rental Bot' },
            rateMliPerKtoken: 5000,
        }, helpers);

        // Simulate what /api/entities does: iterate and filter isBound
        const entities = [];
        const device = devices['renter-device-1'];
        for (const i of Object.keys(device.entities).map(Number)) {
            const entity = device.entities[i];
            if (!entity) continue;
            if (entity.isBound) {
                entities.push({
                    entityId: entity.entityId,
                    name: entity.name,
                    character: entity.character,
                    isBound: true,
                    publicCode: entity.publicCode || null,
                    botSecret: entity.botSecret,
                });
            }
        }

        // Should have 2 entities: the existing one + the rental
        expect(entities.length).toBe(2);
        const rental = entities.find(e => e.name === 'Rental Bot');
        expect(rental).toBeDefined();
        expect(rental.entityId).toBe(1);
        expect(rental.publicCode).toBeTruthy();
        expect(rental.botSecret).toBeTruthy();
    });

    test('insertRentalEntity auto-expands when all slots are bound', () => {
        // Make slot 1 also bound
        devices['renter-device-1'].entities[1].isBound = true;

        let ensureCalled = false;
        const helpersWithExpand = {
            ...helpers,
            ensureOneEmptySlot: () => { ensureCalled = true; return null; },
        };

        const result = insertRentalEntity(devices, {
            renterDeviceId: 'renter-device-1',
            contractId: 'contract-1',
            listing: { title: 'Expanded Bot' },
            rateMliPerKtoken: 1000,
        }, helpersWithExpand);

        // Should have created slot 2
        expect(result.slot).toBe(2);
        const entity = devices['renter-device-1'].entities[2];
        expect(entity.entityId).toBe(2);
        expect(entity.isBound).toBe(true);
        expect(entity.botSecret).toBeTruthy();
        expect(ensureCalled).toBe(true);
    });

    test('removeRentalEntity cleans up publicCode from index', () => {
        const result = insertRentalEntity(devices, {
            renterDeviceId: 'renter-device-1',
            contractId: 'contract-1',
            listing: { title: 'Temp Bot' },
            rateMliPerKtoken: 2000,
        }, helpers);

        const code = result.publicCode;
        expect(publicCodeIndex[code]).toBeDefined();

        removeRentalEntity(devices, {
            renterDeviceId: 'renter-device-1',
            contractId: 'contract-1',
        }, { publicCodeIndex });

        // publicCode should be removed from index
        expect(publicCodeIndex[code]).toBeUndefined();
        // Entity should be unbound and cleared
        const entity = devices['renter-device-1'].entities[result.slot];
        expect(entity.isBound).toBe(false);
        expect(entity.botSecret).toBeNull();
        expect(entity.publicCode).toBeNull();
    });

    test('insertRentalEntity works without helpers (fallback)', () => {
        // When no helpers are passed, should still generate a botSecret via crypto
        const result = insertRentalEntity(devices, {
            renterDeviceId: 'renter-device-1',
            contractId: 'contract-1',
            listing: { title: 'Fallback Bot' },
            rateMliPerKtoken: 1000,
        });

        const entity = devices['renter-device-1'].entities[result.slot];
        expect(entity.entityId).toBe(1);
        expect(entity.isBound).toBe(true);
        // botSecret generated via crypto fallback
        expect(entity.botSecret).toBeTruthy();
        expect(entity.botSecret.length).toBe(32);
        // publicCode null without helper
        expect(entity.publicCode).toBeNull();
    });
});
