const backfill = require('../../scripts/petdx-phase0-backfill');

const LOBSTER_COMPANION = 'petdx-lobster-default';

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
    test('fresh default-avatar entity (no log selection) is assigned + audited', () => {
        const decision = backfill.planBackfillForEntity(entity(), null);
        expect(decision.outcome).toBe('assigned');
        expect(decision.companionId).toBe(LOBSTER_COMPANION);
        expect(decision.updates).toBeUndefined();
        expect(decision.audit).toMatchObject({
            deviceId: 'D1',
            entityId: 7,
            companionId: LOBSTER_COMPANION,
        });
    });

    test('existing selection without source stamps a phase0 audit row', () => {
        const decision = backfill.planBackfillForEntity(entity(), {
            companionId: 'petdx-legacy',
            source: null,
        });
        expect(decision.outcome).toBe('stamped-existing');
        expect(decision.updates).toBeUndefined();
        expect(decision.audit.companionId).toBe('petdx-legacy');
    });

    test('user-selected source is preserved untouched', () => {
        const decision = backfill.planBackfillForEntity(entity(), {
            companionId: 'petdx-custom',
            source: 'user-selected',
        });
        expect(decision).toMatchObject({
            outcome: 'preserves_existing_source',
            source: 'user-selected',
            companionId: 'petdx-custom',
        });
        expect(decision.audit).toBeUndefined();
    });

    test('non-phase0 source tag is preserved even when companion is missing', () => {
        const decision = backfill.planBackfillForEntity(entity(), {
            companionId: null,
            source: 'rental-inherited',
        });
        expect(decision).toMatchObject({
            outcome: 'preserves_existing_source',
            source: 'rental-inherited',
            companionId: null,
        });
        expect(decision.audit).toBeUndefined();
    });

    test('leased-in rental and custom avatar are skipped', () => {
        expect(backfill.planBackfillForEntity(entity({ rental_status: 'leased_in' }), null))
            .toMatchObject({ outcome: 'skipped', reason: 'rental-leased-in' });
        expect(backfill.planBackfillForEntity(entity({ avatar: 'https://example.com/me.png' }), null))
            .toMatchObject({ outcome: 'skipped', reason: 'user-custom-avatar' });
    });

    test('phase0 selection is idempotent', () => {
        const decision = backfill.planBackfillForEntity(entity(), {
            companionId: LOBSTER_COMPANION,
            source: 'phase0-auto',
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
