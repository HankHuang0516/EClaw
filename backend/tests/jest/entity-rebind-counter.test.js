/**
 * Entity rebind counter — P0 Phase 1 (silent identity-drift detection)
 *
 * Verifies createDefaultEntity returns rebindCount=0 / lastRebindAt=null
 * and that the rebind pattern (snapshot → reset → bump) increments correctly.
 *
 * Card: card_b0d150cfc6ab20c52640d4b7
 */

require('./helpers/mock-setup');

const { _createDefaultEntity: createDefaultEntity } = require('../../index');

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise((resolve) => httpServer.close(resolve));
});

describe('createDefaultEntity: rebind counter fields', () => {
    test('a fresh entity has rebindCount=0 and lastRebindAt=null', () => {
        const e = createDefaultEntity(0);
        expect(e.entityId).toBe(0);
        expect(e.rebindCount).toBe(0);
        expect(e.lastRebindAt).toBeNull();
    });

    test('rebind pattern increments rebindCount and stamps lastRebindAt', () => {
        // Simulate the pattern used at the 8 rebind callsites in index.js:
        //   const prev = device.entities[eId];
        //   device.entities[eId] = createDefaultEntity(eId);
        //   device.entities[eId].rebindCount = (prev.rebindCount || 0) + 1;
        //   device.entities[eId].lastRebindAt = Date.now();
        const prev = { rebindCount: 4, name: 'OldBot', xp: 50, level: 3 };
        const before = Date.now();

        const next = createDefaultEntity(2);
        next.name = prev.name || null;
        next.xp = prev.xp || 0;
        next.level = prev.level || 1;
        next.rebindCount = (prev.rebindCount || 0) + 1;
        next.lastRebindAt = Date.now();

        expect(next.rebindCount).toBe(5);
        expect(next.lastRebindAt).toBeGreaterThanOrEqual(before);
        expect(next.name).toBe('OldBot');
        expect(next.xp).toBe(50);
        expect(next.level).toBe(3);
        // Identity fields are reset
        expect(next.botSecret).toBeNull();
        expect(next.isBound).toBe(false);
        expect(next.identity).toBeNull();
    });

    test('rebind from prev with no rebindCount field defaults to 1', () => {
        // Backwards-compat: entities saved before this change have no rebindCount.
        const prev = { name: 'Legacy' }; // rebindCount undefined
        const next = createDefaultEntity(0);
        next.rebindCount = (prev.rebindCount || 0) + 1;
        expect(next.rebindCount).toBe(1);
    });

    test('spread-shape rebind (free/personal bind paths) preserves the increment', () => {
        // Simulate the spread pattern at 11919 / 12082 callsites:
        //   device.entities[eId] = {
        //       ...createDefaultEntity(eId),
        //       rebindCount: (existing?.rebindCount || 0) + 1,
        //       lastRebindAt: Date.now(),
        //       botSecret: ..., isBound: true, ...
        //   };
        const existing = { rebindCount: 2, xp: 10, level: 2 };
        const next = {
            ...createDefaultEntity(1),
            xp: existing.xp,
            level: existing.level,
            rebindCount: (existing.rebindCount || 0) + 1,
            lastRebindAt: Date.now(),
            botSecret: 'new-secret',
            isBound: true,
        };
        expect(next.rebindCount).toBe(3);
        expect(next.lastRebindAt).not.toBeNull();
        expect(next.isBound).toBe(true);
        expect(next.botSecret).toBe('new-secret');
        expect(next.entityId).toBe(1);
    });
});
