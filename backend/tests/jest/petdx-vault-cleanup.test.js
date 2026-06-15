'use strict';

/**
 * Petdx PR-C — one-time vault cleanup script.
 *
 * Covers the pure planner (which keys get removed) and the device-level
 * cleanup loop against an in-memory vault, including dry-run vs commit,
 * sibling-key preservation, and audit emission.
 */

const cleanup = require('../../scripts/petdx-vault-cleanup');

const SEAL_KEY = 'a'.repeat(64);

describe('petdx-vault-cleanup — planCleanup', () => {
    test('selects only PETDX_CURRENT/AVATAR/SOURCE_<digits> keys', () => {
        const vars = {
            PETDX_CURRENT_7: 'petdx-lobster-default',
            PETDX_AVATAR_7: '/static/companions/petdx-lobster-default/avatar.png',
            PETDX_SOURCE_7: 'phase0-auto',
            PETDX_CURRENT_12: 'petdx-zoro',
            OPENAI_API_KEY: 'sk-xxx',
            PETDX_FEATURE_FLAG: 'on',       // PETDX_ prefix but not a per-entity key
            PETDX_CURRENT_ABC: 'not-numeric',
        };
        expect(cleanup.planCleanup(vars).sort()).toEqual([
            'PETDX_AVATAR_7',
            'PETDX_CURRENT_12',
            'PETDX_CURRENT_7',
            'PETDX_SOURCE_7',
        ]);
    });

    test('returns empty for clean / non-object inputs', () => {
        expect(cleanup.planCleanup({ OPENAI_API_KEY: 'x' })).toEqual([]);
        expect(cleanup.planCleanup(null)).toEqual([]);
        expect(cleanup.planCleanup(undefined)).toEqual([]);
    });
});

describe('petdx-vault-cleanup — cleanupDevice', () => {
    function makePool(vault) {
        const audits = [];
        const saved = [];
        const pool = {
            audits,
            saved,
            async query(sql, params) {
                if (/SELECT .* FROM device_vars WHERE device_id/i.test(sql)) {
                    if (!vault) return { rows: [] };
                    const { encrypted, iv, authTag } = cleanup.encryptVars(vault.vars, SEAL_KEY);
                    return {
                        rows: [{
                            encrypted_vars: encrypted, iv, auth_tag: authTag,
                            var_sources: JSON.stringify(vault.sources || {}),
                            is_locked: !!vault.locked,
                        }],
                    };
                }
                if (/INSERT INTO device_vars /i.test(sql)) {
                    // params: [deviceId, encrypted, iv, authTag, varKeys, varSources, locked, ts]
                    const decoded = cleanup.decryptVars(params[1], params[2], params[3], SEAL_KEY);
                    saved.push({ deviceId: params[0], vars: decoded, varKeys: params[4] });
                    return { rows: [] };
                }
                if (/INSERT INTO device_vars_audit/i.test(sql)) {
                    audits.push({ deviceId: params[0], keyName: params[1], source: params[2] });
                    return { rows: [] };
                }
                return { rows: [] };
            },
        };
        return pool;
    }

    test('dry-run reports keys but does not write or audit', async () => {
        const pool = makePool({
            vars: { PETDX_CURRENT_7: 'petdx-lobster-default', OPENAI_API_KEY: 'sk-x' },
            sources: { PETDX_CURRENT_7: 'petdx-phase0', OPENAI_API_KEY: 'user' },
        });
        const res = await cleanup.cleanupDevice(pool, SEAL_KEY, 'D1', false);
        expect(res).toMatchObject({ deviceId: 'D1', status: 'dry-run' });
        expect(res.removed).toEqual(['PETDX_CURRENT_7']);
        expect(pool.saved).toHaveLength(0);
        expect(pool.audits).toHaveLength(0);
    });

    test('commit removes only PETDX keys, preserves siblings, emits one audit per key', async () => {
        const pool = makePool({
            vars: {
                PETDX_CURRENT_7: 'petdx-lobster-default',
                PETDX_AVATAR_7: '/static/companions/petdx-lobster-default/avatar.png',
                OPENAI_API_KEY: 'sk-x',
            },
            sources: { PETDX_CURRENT_7: 'petdx-phase0', PETDX_AVATAR_7: 'petdx-phase0', OPENAI_API_KEY: 'user' },
        });
        const res = await cleanup.cleanupDevice(pool, SEAL_KEY, 'D1', true);
        expect(res.status).toBe('cleaned');
        expect(res.removed.sort()).toEqual(['PETDX_AVATAR_7', 'PETDX_CURRENT_7']);

        expect(pool.saved).toHaveLength(1);
        expect(pool.saved[0].vars).toEqual({ OPENAI_API_KEY: 'sk-x' });

        expect(pool.audits).toHaveLength(2);
        expect(pool.audits.every(a => a.source === 'petdx-phase0-prc-cleanup')).toBe(true);
        expect(pool.audits.map(a => a.keyName).sort()).toEqual(['PETDX_AVATAR_7', 'PETDX_CURRENT_7']);
    });

    test('a vault with no PETDX keys is left untouched (status=clean)', async () => {
        const pool = makePool({ vars: { OPENAI_API_KEY: 'sk-x' }, sources: {} });
        const res = await cleanup.cleanupDevice(pool, SEAL_KEY, 'D1', true);
        expect(res.status).toBe('clean');
        expect(res.removed).toEqual([]);
        expect(pool.saved).toHaveLength(0);
        expect(pool.audits).toHaveLength(0);
    });

    test('a device with no vault row returns status=no-vault', async () => {
        const pool = makePool(null);
        const res = await cleanup.cleanupDevice(pool, SEAL_KEY, 'D1', true);
        expect(res.status).toBe('no-vault');
        expect(res.removed).toEqual([]);
    });
});

describe('petdx-vault-cleanup — runCleanup summary', () => {
    test('summarize counts scanned / modified / keys', () => {
        const results = [
            { deviceId: 'A', removed: ['PETDX_CURRENT_1', 'PETDX_AVATAR_1'], status: 'cleaned' },
            { deviceId: 'B', removed: [], status: 'clean' },
            { deviceId: 'C', removed: ['PETDX_SOURCE_2'], status: 'dry-run' },
            { deviceId: 'D', removed: [], status: 'no-vault' },
        ];
        expect(cleanup.summarize(results)).toEqual({
            devicesScanned: 4,
            devicesModified: 2,
            keysRemoved: 3,
        });
    });
});
