const backfill = require('../../scripts/petdx-phase0-backfill');

const LOBSTER_COMPANION = 'petdx-lobster-default';
const LOBSTER_AVATAR_URL = '/static/companions/petdx-lobster-default/avatar.png';

function entity(overrides = {}) {
    return {
        deviceId: 'D1',
        entityId: 7,
        character: 'LOBSTER',
        avatar: null,
        rental_status: null,
        identity: null,
        ...overrides,
    };
}

describe('petdx-phase0-backfill decision planner', () => {
    test('fresh default-avatar entity receives current/avatar/source updates', () => {
        const decision = backfill.planBackfillForEntity(entity(), {});
        expect(decision.outcome).toBe('assigned');
        expect(decision.companionId).toBe(LOBSTER_COMPANION);
        expect(decision.avatarUrl).toBe(LOBSTER_AVATAR_URL);
        expect(decision.updates).toEqual({
            PETDX_CURRENT_7: LOBSTER_COMPANION,
            PETDX_AVATAR_7: LOBSTER_AVATAR_URL,
            PETDX_SOURCE_7: 'phase0-backfill',
        });
        expect(decision.audit).toMatchObject({
            deviceId: 'D1',
            entityId: 7,
            companionId: LOBSTER_COMPANION,
        });
    });

    test('existing current without source stamps source only', () => {
        const decision = backfill.planBackfillForEntity(entity(), {
            PETDX_CURRENT_7: 'petdx-legacy',
            PETDX_AVATAR_7: '/static/companions/petdx-legacy/avatar.png',
        });
        expect(decision.outcome).toBe('stamped-existing');
        expect(decision.updates).toEqual({ PETDX_SOURCE_7: 'phase0-backfill' });
        expect(decision.audit.companionId).toBe('petdx-legacy');
    });

    test('user-selected source is preserved untouched', () => {
        const decision = backfill.planBackfillForEntity(entity(), {
            PETDX_CURRENT_7: 'petdx-custom',
            PETDX_SOURCE_7: 'user-selected',
        });
        expect(decision).toMatchObject({
            outcome: 'preserves_existing_source',
            source: 'user-selected',
            companionId: 'petdx-custom',
        });
        expect(decision.updates).toBeUndefined();
    });

    test('non-phase0 source tag is preserved even when current is missing', () => {
        const decision = backfill.planBackfillForEntity(entity(), {
            PETDX_SOURCE_7: 'rental-inherited',
        });
        expect(decision).toMatchObject({
            outcome: 'preserves_existing_source',
            source: 'rental-inherited',
            companionId: null,
        });
        expect(decision.updates).toBeUndefined();
    });

    test('leased-in rental and custom avatar are skipped', () => {
        expect(backfill.planBackfillForEntity(entity({ rental_status: 'leased_in' }), {}))
            .toMatchObject({ outcome: 'skipped', reason: 'rental-leased-in' });
        expect(backfill.planBackfillForEntity(entity({ avatar: 'https://example.com/me.png' }), {}))
            .toMatchObject({ outcome: 'skipped', reason: 'user-custom-avatar' });
    });

    test('phase0 current is idempotent', () => {
        const decision = backfill.planBackfillForEntity(entity(), {
            PETDX_CURRENT_7: LOBSTER_COMPANION,
            PETDX_SOURCE_7: 'phase0-auto',
        });
        expect(decision).toMatchObject({
            outcome: 'skipped',
            reason: 'already_assigned',
            source: 'phase0-auto',
        });
    });

    test('summarize reports backfill outcome counts', () => {
        const decisions = [
            { outcome: 'assigned' },
            { outcome: 'stamped-existing' },
            { outcome: 'preserves_existing_source' },
            { outcome: 'skipped' },
        ];
        expect(backfill.summarize(decisions)).toEqual({
            total: 4,
            assigned: 1,
            stampedExisting: 1,
            preservesExistingSource: 1,
            skipped: 1,
        });
    });
});
