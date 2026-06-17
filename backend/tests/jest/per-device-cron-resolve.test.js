'use strict';

/**
 * Per-device cron host resolution (card_1ce50de359411f0d0947399f, #6 ruling d).
 *
 * Deterministic unit tests for the pure resolver that decides which registered
 * device should receive a recurring card's dispatch for a given assigned entity.
 *
 * Scenarios covered:
 *  - Card assigned to an entity hosted on the card's OWN device → local dispatch
 *    (legacy single-device path, backward compatible).
 *  - Card assigned to an entity hosted on a DIFFERENT registered device (the
 *    Hermes Docker class) → cross-device dispatch to device A, NOT device B,
 *    matched by stable publicCode.
 *  - Unregistered / no-host entity → skip-with-reason (never a silent drop or a
 *    crash).
 *  - Idempotency: resolving the same entity is a pure read — it returns the same
 *    single host and never advances any schedule (no double-fire).
 */

const {
    isEntityReachable,
    findEntityByPublicCode,
    resolveEntityHostDevice,
} = require('../../lib/per-device-cron');

// Helper to build a reachable channel-bound entity.
function channelEntity(entityId, publicCode, channelAccountId = 100 + entityId) {
    return {
        entityId,
        publicCode,
        isBound: true,
        bindingType: 'channel',
        channelAccountId,
        botSecret: `secret-${publicCode}`,
    };
}

function webhookEntity(entityId, publicCode) {
    return {
        entityId,
        publicCode,
        isBound: true,
        bindingType: 'webhook',
        webhook: `https://wh.example/${publicCode}`,
        botSecret: `secret-${publicCode}`,
    };
}

const MAIN_DEVICE = '480def4c-main';
const HERMES_DEVICE = 'hermes-docker-device';

describe('per-device-cron — isEntityReachable', () => {
    test('channel-bound entity with channelAccountId is reachable', () => {
        expect(isEntityReachable(channelEntity(2, 'pc-lobster'))).toBe(true);
    });
    test('webhook-bound entity with webhook url is reachable', () => {
        expect(isEntityReachable(webhookEntity(3, 'pc-mace'))).toBe(true);
    });
    test('unbound entity is not reachable', () => {
        expect(isEntityReachable({ isBound: false, bindingType: 'channel', channelAccountId: 5 })).toBe(false);
    });
    test('channel entity missing channelAccountId is not reachable', () => {
        expect(isEntityReachable({ isBound: true, bindingType: 'channel', channelAccountId: null })).toBe(false);
    });
    test('null / undefined entity is not reachable', () => {
        expect(isEntityReachable(null)).toBe(false);
        expect(isEntityReachable(undefined)).toBe(false);
    });
});

describe('per-device-cron — findEntityByPublicCode', () => {
    test('finds the entity slot carrying a publicCode', () => {
        const device = { entities: { 0: channelEntity(0, null), 5: channelEntity(5, 'pc-hermes') } };
        const match = findEntityByPublicCode(device, 'pc-hermes');
        expect(match).not.toBeNull();
        expect(match.entityId).toBe(5);
    });
    test('returns null when no slot matches', () => {
        const device = { entities: { 0: channelEntity(0, 'pc-a') } };
        expect(findEntityByPublicCode(device, 'pc-missing')).toBeNull();
    });
    test('tolerates missing device / entities', () => {
        expect(findEntityByPublicCode(null, 'pc-a')).toBeNull();
        expect(findEntityByPublicCode({}, 'pc-a')).toBeNull();
    });
});

describe('per-device-cron — resolveEntityHostDevice', () => {
    test('LOCAL: entity hosted on the card device → dispatch locally (legacy path)', () => {
        const devices = {
            [MAIN_DEVICE]: { entities: { 0: channelEntity(0, 'pc-user'), 2: channelEntity(2, 'pc-lobster') } },
        };
        const card = { device_id: MAIN_DEVICE };
        const decision = resolveEntityHostDevice(card, 2, devices);
        expect(decision.shouldDispatch).toBe(true);
        expect(decision.resolution).toBe('local');
        expect(decision.hostDeviceId).toBe(MAIN_DEVICE);
        expect(decision.hostEntityId).toBe(2);
    });

    test('CROSS-DEVICE: entity hosted on another device (Hermes Docker class) → dispatch to A, not B', () => {
        // Card owned by main device, assigned entity #5 (Hermes). On the main
        // device, slot #5 exists but is NOT reachable (no live binding). The
        // Hermes Docker device hosts the SAME publicCode on its own slot #1 and
        // IS reachable → cron must dispatch to the Hermes device.
        const devices = {
            [MAIN_DEVICE]: {
                entities: {
                    0: channelEntity(0, 'pc-user'),
                    5: { entityId: 5, publicCode: 'pc-hermes', isBound: false, bindingType: null }, // placeholder, not reachable
                },
            },
            [HERMES_DEVICE]: {
                entities: {
                    0: channelEntity(0, 'pc-hermes-user'),
                    1: channelEntity(1, 'pc-hermes'), // the reachable Hermes entity
                },
            },
        };
        const card = { device_id: MAIN_DEVICE };
        const decision = resolveEntityHostDevice(card, 5, devices);
        expect(decision.shouldDispatch).toBe(true);
        expect(decision.resolution).toBe('cross_device');
        expect(decision.hostDeviceId).toBe(HERMES_DEVICE); // device A (the host), NOT card device B
        expect(decision.hostEntityId).toBe(1);
        expect(decision.publicCode).toBe('pc-hermes');
    });

    test('NO-HOST: entity not reachable anywhere → skip with reason (no silent drop, no throw)', () => {
        const devices = {
            [MAIN_DEVICE]: {
                entities: {
                    5: { entityId: 5, publicCode: 'pc-orphan', isBound: false, bindingType: null },
                },
            },
            [HERMES_DEVICE]: {
                entities: { 1: channelEntity(1, 'pc-someone-else') },
            },
        };
        const card = { device_id: MAIN_DEVICE };
        const decision = resolveEntityHostDevice(card, 5, devices);
        expect(decision.shouldDispatch).toBe(false);
        expect(decision.resolution).toBe('no_host');
        expect(decision.reason).toBe('no_registered_host_device');
        expect(decision.hostDeviceId).toBeNull();
    });

    test('NO-HOST: local slot has no publicCode and is unreachable → cannot route cross-device', () => {
        const devices = {
            [MAIN_DEVICE]: {
                entities: { 5: { entityId: 5, publicCode: null, isBound: false } },
            },
        };
        const decision = resolveEntityHostDevice({ device_id: MAIN_DEVICE }, 5, devices);
        expect(decision.shouldDispatch).toBe(false);
        expect(decision.resolution).toBe('no_host');
        expect(decision.reason).toBe('no_public_code_and_local_unreachable');
    });

    test('LOCAL wins over a cross-device copy (no double-resolution): reachable locally → local', () => {
        // Same publicCode reachable on BOTH the card device and another device.
        // Local-first must pick the card device, guaranteeing a single host.
        const devices = {
            [MAIN_DEVICE]: { entities: { 5: channelEntity(5, 'pc-dual') } },
            [HERMES_DEVICE]: { entities: { 1: channelEntity(1, 'pc-dual') } },
        };
        const decision = resolveEntityHostDevice({ device_id: MAIN_DEVICE }, 5, devices);
        expect(decision.resolution).toBe('local');
        expect(decision.hostDeviceId).toBe(MAIN_DEVICE);
    });

    test('IDEMPOTENT: repeated resolution yields the same single host (no side effects)', () => {
        const devices = {
            [MAIN_DEVICE]: { entities: { 5: { entityId: 5, publicCode: 'pc-hermes', isBound: false } } },
            [HERMES_DEVICE]: { entities: { 1: channelEntity(1, 'pc-hermes') } },
        };
        const card = { device_id: MAIN_DEVICE };
        const a = resolveEntityHostDevice(card, 5, devices);
        const b = resolveEntityHostDevice(card, 5, devices);
        expect(a).toEqual(b);
        // exactly one host device chosen — never both
        expect(a.hostDeviceId).toBe(HERMES_DEVICE);
    });

    test('legacy single-device deployment is fully unchanged (only the card device registered)', () => {
        const devices = {
            [MAIN_DEVICE]: { entities: { 0: channelEntity(0, 'pc-user'), 1: webhookEntity(1, 'pc-worker') } },
        };
        const decision = resolveEntityHostDevice({ device_id: MAIN_DEVICE }, 1, devices);
        expect(decision.shouldDispatch).toBe(true);
        expect(decision.resolution).toBe('local');
        expect(decision.hostDeviceId).toBe(MAIN_DEVICE);
        expect(decision.hostEntityId).toBe(1);
    });
});
