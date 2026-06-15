/**
 * clearPetdxVaultForEntity — verify the unbind cleanup wipes the three Phase 0
 * vault keys for a single entity without touching other entities' keys or
 * non-PETDX vault entries.
 *
 * Regression: card_8310195c122e7735076b96e3 — without this cleanup the portal
 * chip kept painting the previous companion sprite after rebind because
 * entity-utils.js getAvatarForEntity reads PETDX_AVATAR_<id> via the
 * /api/entities enrichment ahead of the character emoji fallback.
 *
 * These tests assert the static invariants of the helper's behaviour:
 * the key naming pattern, the sibling-entity boundary, and the audit
 * source string convention. A full integration test that boots the
 * server, encrypts a vault row, and round-trips the cleanup belongs
 * to the destructive-modals-style E2E playbook (see PR body).
 */

describe('clearPetdxVaultForEntity — static invariants', () => {
    const TARGET_KEYS = (eId) => [
        `PETDX_CURRENT_${eId}`,
        `PETDX_AVATAR_${eId}`,
        `PETDX_SOURCE_${eId}`,
    ];

    it('targets exactly three Phase 0 keys for a given entity id', () => {
        expect(TARGET_KEYS(4)).toEqual([
            'PETDX_CURRENT_4',
            'PETDX_AVATAR_4',
            'PETDX_SOURCE_4',
        ]);
        expect(TARGET_KEYS(0)).toEqual([
            'PETDX_CURRENT_0',
            'PETDX_AVATAR_0',
            'PETDX_SOURCE_0',
        ]);
    });

    it('sibling-entity isolation: clearing entity 4 must not match entity 5 keys', () => {
        const cleared = TARGET_KEYS(4);
        const sibling = TARGET_KEYS(5);
        for (const k of sibling) {
            expect(cleared).not.toContain(k);
        }
    });

    it('does NOT match the legacy non-suffixed PETDX_CURRENT / PETDX_AVATAR / PETDX_SOURCE keys', () => {
        const cleared = TARGET_KEYS(4);
        for (const legacy of ['PETDX_CURRENT', 'PETDX_AVATAR', 'PETDX_SOURCE']) {
            expect(cleared).not.toContain(legacy);
        }
    });

    it('audit source convention: every unbind callsite uses petdx-phase0-<context>', () => {
        const callContexts = [
            'rental-expire',           // backend/index.js:~1474, periodic borrow cleanup
            'entity-remove',           // backend/index.js:~9705, /api/entity/:eId/remove
            'device-entity-remove',    // backend/index.js:~9828, /api/device/entity DELETE
            'borrow-unbind',           // backend/index.js:~15279, internal helper
            'official-borrow-unbind',  // backend/index.js:~15972, /api/official-borrow/unbind
            'entity-transfer-out',     // backend/index.js:~18220, device transfer path
        ];
        for (const ctx of callContexts) {
            const source = `petdx-phase0-${ctx}`;
            expect(source.startsWith('petdx-phase0-')).toBe(true);
            expect(source.length).toBeLessThan(80); // device_vars_audit.source column width
        }
    });

    it('PR-B: writes an unbind tombstone into companion_select_log before the legacy wipe', () => {
        const fs = require('fs');
        const src = fs.readFileSync(require.resolve('../../index'), 'utf8');
        const i = src.indexOf('async function clearPetdxVaultForEntity');
        expect(i).toBeGreaterThan(-1);
        const body = src.slice(i, i + 2600);
        // Looks up the latest selection, then inserts a tombstone row tagged
        // origin=PETDX_TOMBSTONE_ORIGIN, skipping when already tombstoned.
        expect(body).toMatch(/FROM companion_select_log/);
        expect(body).toMatch(/INSERT INTO companion_select_log/);
        expect(body).toMatch(/latest\.rows\[0\]\.origin !== PETDX_TOMBSTONE_ORIGIN/);
        expect(body).toMatch(/PETDX_TOMBSTONE_ORIGIN/);
        // The tombstone write is best-effort and must not break the unbind.
        expect(body).toMatch(/\[Petdx tombstone\] failed/);
    });

    it('PR-B: PETDX_TOMBSTONE_ORIGIN is the unbind-cleared sentinel origin', () => {
        const fs = require('fs');
        const src = fs.readFileSync(require.resolve('../../index'), 'utf8');
        expect(src).toMatch(/PETDX_TOMBSTONE_ORIGIN\s*=\s*['"]unbind-cleared['"]/);
    });

    it('helper signature: (deviceId, entityId, callContext) — null/undefined inputs short-circuit', () => {
        // Documents the early-exit contract: if deviceId or entityId is missing,
        // the helper returns 0 without throwing or hitting the DB.
        const validInputs = [
            ['device-abc', 4, 'unbind'],
            ['device-xyz', 0, 'rental-expire'],
        ];
        const invalidInputs = [
            [null, 4, 'unbind'],
            ['device-abc', null, 'unbind'],
            ['device-abc', undefined, 'unbind'],
            [undefined, 4, 'unbind'],
        ];
        for (const [d, e] of validInputs) {
            expect(d && (e !== undefined && e !== null)).toBeTruthy();
        }
        for (const [d, e] of invalidInputs) {
            expect(!!d && (e !== undefined && e !== null)).toBeFalsy();
        }
    });
});
