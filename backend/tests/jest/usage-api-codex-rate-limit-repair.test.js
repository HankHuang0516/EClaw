'use strict';

const usageApi = require('../../usage-api');
const {
    isUsableCodexRateLimits,
    isUntrustedZeroCodexRateLimits,
    mergeCodexRateLimits,
    repairLatestCodexRateLimits,
} = usageApi({})._internal;

describe('usage-api Codex rate-limit display repair', () => {
    test('treats zero Codex limits without a plan type as untrusted', () => {
        const untrusted = {
            five_hour_pct: 0,
            five_hour_resets_at: 1783694855,
            seven_day_pct: 0,
            seven_day_resets_at: 1784281655,
            plan_type: null,
            updated_at: '2026-07-10T09:48:01.464Z'
        };
        const realZero = {
            ...untrusted,
            plan_type: 'prolite'
        };

        expect(isUntrustedZeroCodexRateLimits(untrusted)).toBe(true);
        expect(isUsableCodexRateLimits(untrusted)).toBe(false);
        expect(isUntrustedZeroCodexRateLimits(realZero)).toBe(false);
        expect(isUsableCodexRateLimits(realZero)).toBe(true);
    });

    test('merges the latest usable Codex rate limits into a newer device row', () => {
        const latest = {
            id: '51137',
            entity_id: 2,
            codex_json: {
                sessions: [{ project: 'codex-eclaw-bridge' }],
                rate_limits: {
                    five_hour_pct: 0,
                    seven_day_pct: 0,
                    plan_type: null,
                    updated_at: '2026-07-10T09:48:01.464Z'
                }
            }
        };
        const source = {
            id: '51132',
            entity_id: 6,
            captured_at: '2026-07-10T09:48:30.293Z',
            codex_json: {
                rate_limits: {
                    five_hour_pct: 94,
                    five_hour_resets_at: 1783677455,
                    seven_day_pct: 17,
                    seven_day_resets_at: 1784244512,
                    plan_type: 'prolite',
                    updated_at: '2026-07-10T09:48:18.522Z'
                }
            }
        };

        const repaired = mergeCodexRateLimits(latest, source);

        expect(repaired).not.toBe(latest);
        expect(repaired.entity_id).toBe(2);
        expect(repaired.codex_json.sessions).toEqual(latest.codex_json.sessions);
        expect(repaired.codex_json.rate_limits).toEqual(source.codex_json.rate_limits);
        expect(repaired.codex_json.rate_limits_source).toMatchObject({
            repaired: true,
            entityId: 6,
            snapshotId: '51132'
        });
    });

    test('repairLatestCodexRateLimits scans recent rows and picks #6-like usable limits', async () => {
        const latest = {
            id: '51137',
            entity_id: 2,
            codex_json: {
                rate_limits: { five_hour_pct: 0, seven_day_pct: 0, plan_type: null }
            }
        };
        const pool = {
            query: jest.fn().mockResolvedValue({
                rows: [
                    latest,
                    {
                        id: '51132',
                        entity_id: 6,
                        captured_at: '2026-07-10T09:48:30.293Z',
                        codex_json: {
                            rate_limits: {
                                five_hour_pct: 94,
                                five_hour_resets_at: 1783677455,
                                seven_day_pct: 17,
                                seven_day_resets_at: 1784244512,
                                plan_type: 'prolite',
                                updated_at: '2026-07-10T09:48:18.522Z'
                            }
                        }
                    }
                ]
            })
        };

        const repaired = await repairLatestCodexRateLimits(pool, 'device-1', latest);

        expect(pool.query).toHaveBeenCalledTimes(1);
        expect(repaired.codex_json.rate_limits.five_hour_pct).toBe(94);
        expect(repaired.codex_json.rate_limits.seven_day_pct).toBe(17);
        expect(repaired.codex_json.rate_limits_source.entityId).toBe(6);
    });

    test('does not scan when the latest row already has usable Codex limits', async () => {
        const latest = {
            id: '51140',
            entity_id: 6,
            codex_json: {
                rate_limits: { five_hour_pct: 0, seven_day_pct: 0, plan_type: 'prolite' }
            }
        };
        const pool = { query: jest.fn() };

        await expect(repairLatestCodexRateLimits(pool, 'device-1', latest)).resolves.toBe(latest);
        expect(pool.query).not.toHaveBeenCalled();
    });

    test('keeps the original latest row if the repair scan fails', async () => {
        const latest = {
            id: '51137',
            entity_id: 2,
            codex_json: {
                rate_limits: { five_hour_pct: 0, seven_day_pct: 0, plan_type: null }
            }
        };
        const pool = {
            query: jest.fn().mockRejectedValue(new Error('database unavailable'))
        };

        await expect(repairLatestCodexRateLimits(pool, 'device-1', latest)).resolves.toBe(latest);
    });
});
