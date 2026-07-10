/**
 * usage-warning.test.js — card_9cd84ee7d830b2f76c595f6c
 *
 * Verifies the pure shouldWarnNow() + formatWarningText() helpers in
 * backend/lib/usage-warning.js. We exercise the three acceptance
 * scenarios called out in the card spec:
 *   - 5h used 86% → 14% remaining → triggers (≤ 15% default threshold)
 *   - 5h used 50% → 50% remaining → silent
 *   - no daemon snapshot / stale snapshot → silent (no false positives)
 *   - disabled toggle → silent regardless of usage
 */

const {
    STALE_THRESHOLD_MS,
    DEFAULT_COOLDOWN_MS,
    shouldWarnNow,
    formatWarningText,
    pickClaudeLivePct,
    pickCodexPct,
    resolveEntityEngine,
    withinCooldown,
    resolveCooldownMs,
    getWarningPrefix,
    _resetCooldownState,
} = require('../../lib/usage-warning');

const DEFAULT_CFG = { enabled: true, threshold_5h_pct: 15, threshold_7d_pct: 5, entity_engines: {} };
const NOW = 1781500000000;
const fresh = (msAgo) => new Date(NOW - msAgo).toISOString();

function mkSnap({ five = null, seven = null, ageMs = 60_000 } = {}) {
    const live = {};
    if (five != null) live.five_hour_pct = five;
    if (seven != null) live.seven_day_pct = seven;
    return {
        captured_at: fresh(ageMs),
        claude_json: { live },
        codex_json: {},
    };
}

describe('pickClaudeLivePct', () => {
    test('reads flat shape', () => {
        expect(pickClaudeLivePct({ five_hour_pct: 42 }, 'five_hour')).toBe(42);
        expect(pickClaudeLivePct({ seven_day_pct: 17 }, 'seven_day')).toBe(17);
    });
    test('reads nested rate_limits shape', () => {
        const live = { rate_limits: { five_hour: { used_percentage: 4 } } };
        expect(pickClaudeLivePct(live, 'five_hour')).toBe(4);
    });
    test('flat shape wins over nested when both present', () => {
        const live = { five_hour_pct: 12, rate_limits: { five_hour: { used_percentage: 99 } } };
        expect(pickClaudeLivePct(live, 'five_hour')).toBe(12);
    });
    test('null / non-numeric → null', () => {
        expect(pickClaudeLivePct(null, 'five_hour')).toBeNull();
        expect(pickClaudeLivePct({ five_hour_pct: 'oops' }, 'five_hour')).toBeNull();
    });
});

describe('pickCodexPct / resolveEntityEngine', () => {
    test('reads Codex rate_limits flat shape', () => {
        const codex = { rate_limits: { five_hour_pct: 42, seven_day_pct: 17 } };
        expect(pickCodexPct(codex, 'five_hour')).toBe(42);
        expect(pickCodexPct(codex, 'seven_day')).toBe(17);
    });

    test('reads Codex nested used percentage shape', () => {
        const codex = { rate_limits: { five_hour: { used_percentage: 4 } } };
        expect(pickCodexPct(codex, 'five_hour')).toBe(4);
    });

    test('invalid Codex shape returns null', () => {
        expect(pickCodexPct(null, 'five_hour')).toBeNull();
        expect(pickCodexPct({ rate_limits: { five_hour_pct: 'oops' } }, 'five_hour')).toBeNull();
    });

    test('entity_engines selects codex only for explicitly mapped entities', () => {
        const cfg = { ...DEFAULT_CFG, entity_engines: { '6': 'codex', bad: 'codex', '7': 'openclaw' } };
        expect(resolveEntityEngine(cfg, 6)).toBe('codex');
        expect(resolveEntityEngine(cfg, '6')).toBe('codex');
        expect(resolveEntityEngine(cfg, 2)).toBe('claude');
        expect(resolveEntityEngine(null, 6)).toBe('claude');
    });
});

describe('shouldWarnNow — trigger logic (card acceptance #3/#4)', () => {
    test('5h used 86% (remaining 14%) WARNS at default 15% threshold', () => {
        const out = shouldWarnNow(mkSnap({ five: 86, seven: 30 }), DEFAULT_CFG, NOW);
        expect(out.warn).toBe(true);
        expect(out.five_hour_remaining_pct).toBe(14);
        expect(out.seven_day_remaining_pct).toBe(70);
        expect(out.stale).toBe(false);
        expect(out.no_snapshot).toBe(false);
    });

    test('5h used 50% (remaining 50%) does NOT warn at default thresholds', () => {
        const out = shouldWarnNow(mkSnap({ five: 50, seven: 50 }), DEFAULT_CFG, NOW);
        expect(out.warn).toBe(false);
    });

    test('7d remaining ≤ threshold alone triggers warning', () => {
        const out = shouldWarnNow(mkSnap({ five: 10, seven: 96 }), DEFAULT_CFG, NOW);
        // 5h_remaining=90 (not breached), 7d_remaining=4 (≤5 → breach)
        expect(out.warn).toBe(true);
        expect(out.seven_day_remaining_pct).toBe(4);
    });

    test('exactly at threshold boundary triggers (≤ comparison)', () => {
        const out = shouldWarnNow(mkSnap({ five: 85, seven: 50 }), DEFAULT_CFG, NOW);
        // 5h_remaining = 15, threshold 15 → 15 ≤ 15 → warn
        expect(out.warn).toBe(true);
    });

    test('codex engine ignores breaching Claude live quota and uses Codex rate_limits', () => {
        const out = shouldWarnNow({
            captured_at: fresh(60_000),
            claude_json: { live: { five_hour_pct: 99, seven_day_pct: 100 } },
            codex_json: { rate_limits: { five_hour_pct: 10, seven_day_pct: 20, updated_at: fresh(30_000) } },
        }, DEFAULT_CFG, NOW, 'codex');
        expect(out.warn).toBe(false);
        expect(out.engine).toBe('codex');
        expect(out.five_hour_remaining_pct).toBe(90);
        expect(out.seven_day_remaining_pct).toBe(80);
    });

    test('codex engine warns when Codex weekly quota breaches threshold', () => {
        const out = shouldWarnNow({
            captured_at: fresh(60_000),
            claude_json: { live: { five_hour_pct: 10, seven_day_pct: 10 } },
            codex_json: { rate_limits: { five_hour_pct: 20, seven_day_pct: 99, updated_at: fresh(30_000) } },
        }, DEFAULT_CFG, NOW, 'codex');
        expect(out.warn).toBe(true);
        expect(out.seven_day_remaining_pct).toBe(1);
    });

    test('codex rate_limits updated_at older than 6h is stale even when snapshot row is fresh', () => {
        const out = shouldWarnNow({
            captured_at: fresh(60_000),
            claude_json: { live: { five_hour_pct: 10, seven_day_pct: 10 } },
            codex_json: { rate_limits: { five_hour_pct: 99, seven_day_pct: 99, updated_at: fresh(STALE_THRESHOLD_MS + 60_000) } },
        }, DEFAULT_CFG, NOW, 'codex');
        expect(out.warn).toBe(false);
        expect(out.stale).toBe(true);
    });
});

describe('shouldWarnNow — empty / disabled / stale (card spec F)', () => {
    test('disabled config → no warning even on critical usage', () => {
        const cfg = { enabled: false, threshold_5h_pct: 15, threshold_7d_pct: 5 };
        const out = shouldWarnNow(mkSnap({ five: 99 }), cfg, NOW);
        expect(out.warn).toBe(false);
        expect(out.disabled).toBe(true);
    });

    test('null snapshot → no_snapshot, no warning', () => {
        const out = shouldWarnNow(null, DEFAULT_CFG, NOW);
        expect(out.warn).toBe(false);
        expect(out.no_snapshot).toBe(true);
    });

    test('snapshot present but missing %s → no_snapshot, no warning (no false positive)', () => {
        const out = shouldWarnNow(mkSnap({}), DEFAULT_CFG, NOW);
        expect(out.warn).toBe(false);
        expect(out.no_snapshot).toBe(true);
    });

    test('snapshot captured >6h ago → stale, no warning', () => {
        const out = shouldWarnNow(mkSnap({ five: 99, ageMs: STALE_THRESHOLD_MS + 60_000 }), DEFAULT_CFG, NOW);
        expect(out.warn).toBe(false);
        expect(out.stale).toBe(true);
    });

    test('snapshot captured exactly at 6h boundary — still considered fresh', () => {
        // 6h - 1ms → fresh
        const out = shouldWarnNow(mkSnap({ five: 99, ageMs: STALE_THRESHOLD_MS - 1 }), DEFAULT_CFG, NOW);
        expect(out.stale).toBe(false);
        expect(out.warn).toBe(true);
    });
});

describe('shouldWarnNow — custom thresholds', () => {
    test('user-set thresholds replace defaults', () => {
        const cfg = { enabled: true, threshold_5h_pct: 50, threshold_7d_pct: 10 };
        const out = shouldWarnNow(mkSnap({ five: 60, seven: 80 }), cfg, NOW);
        // 5h_remaining=40 ≤ 50 → warn
        expect(out.warn).toBe(true);
    });

    test('threshold 0 effectively disables the axis without disabling the toggle', () => {
        const cfg = { enabled: true, threshold_5h_pct: 0, threshold_7d_pct: 5 };
        // 5h_remaining=10, threshold=0 → 10 ≤ 0 false → no 5h breach
        // 7d_remaining=10, threshold=5 → 10 ≤ 5 false → no breach either
        const out = shouldWarnNow(mkSnap({ five: 90, seven: 90 }), cfg, NOW);
        expect(out.warn).toBe(false);
    });
});

describe('withinCooldown / resolveCooldownMs (card_a69e8ffa)', () => {
    test('never-warned (null last) → not within cooldown', () => {
        expect(withinCooldown(null, NOW)).toBe(false);
        expect(withinCooldown(undefined, NOW)).toBe(false);
    });
    test('inside the window → within cooldown (suppress)', () => {
        expect(withinCooldown(NOW - 5 * 60 * 1000, NOW, DEFAULT_COOLDOWN_MS)).toBe(true);
    });
    test('past the window → not within cooldown (allow)', () => {
        expect(withinCooldown(NOW - 31 * 60 * 1000, NOW, DEFAULT_COOLDOWN_MS)).toBe(false);
    });
    test('exactly at the boundary → not within cooldown (allow)', () => {
        expect(withinCooldown(NOW - DEFAULT_COOLDOWN_MS, NOW, DEFAULT_COOLDOWN_MS)).toBe(false);
    });
    test('resolveCooldownMs reads config.cooldown_min (minutes → ms)', () => {
        expect(resolveCooldownMs({ cooldown_min: 10 })).toBe(10 * 60 * 1000);
        expect(resolveCooldownMs({ cooldown_min: 0 })).toBe(0);     // disables cooldown
        expect(resolveCooldownMs({})).toBe(DEFAULT_COOLDOWN_MS);    // default
        expect(resolveCooldownMs(null)).toBe(DEFAULT_COOLDOWN_MS);
    });
    test('cooldown_min: 0 → every breach allowed (no suppression)', () => {
        expect(withinCooldown(NOW - 1, NOW, resolveCooldownMs({ cooldown_min: 0 }))).toBe(false);
    });
});

describe('getWarningPrefix — entity-scoped attribution (card_2f6a5659)', () => {
    /**
     * Fake pool that EMULATES the usage_snapshots table semantics for both
     * query shapes the module can send:
     *   - device-only  (params [deviceId])         → latest row by captured_at
     *   - entity-scoped (params [deviceId, eid])   → WHERE entity_id = eid OR NULL,
     *                                                 ORDER BY (entity_id = eid) DESC, captured_at DESC
     * Because the emulation is faithful to the SQL semantics (not to the code
     * under test), these tests FAIL on the old device-only lookup and PASS on
     * the entity-scoped one.
     */
    function mkSnapshotPool(rows) {
        return {
            query: jest.fn().mockImplementation(async (sql, params) => {
                if (!/FROM\s+usage_snapshots/i.test(sql)) return { rows: [], rowCount: 0 };
                let cand = rows.filter(r => r.device_id === params[0]);
                if (params.length >= 2) {
                    const eid = params[1];
                    cand = cand
                        .filter(r => r.entity_id === eid || r.entity_id == null)
                        .sort((a, b) =>
                            ((b.entity_id === eid) - (a.entity_id === eid)) ||
                            (Date.parse(b.captured_at) - Date.parse(a.captured_at)));
                } else {
                    cand = cand.slice().sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at));
                }
                return { rows: cand.slice(0, 1), rowCount: Math.min(1, cand.length) };
            }),
        };
    }

    const DEV = 'dev-usage-scope';
    // #2's Claude snapshot: 7d used 100% → remaining 0 ≤ 5 → breach.
    const entity2Breach = (ageMs = 60_000) => ({
        device_id: DEV, entity_id: 2, captured_at: fresh(ageMs),
        claude_json: { live: { five_hour_pct: 10, seven_day_pct: 100 } }, codex_json: null,
    });

    beforeEach(() => _resetCooldownState());

    test('latest row belongs to entity 2 → entity 6 transform gets NO prefix (the card_2f6a5659 bug)', async () => {
        const pool = mkSnapshotPool([entity2Breach()]);
        const prefix = await getWarningPrefix(pool, DEV, DEFAULT_CFG, 'en', 6, NOW);
        expect(prefix).toBeNull();
    });

    test('same table → entity 2 (the actual owner of the breach) still gets the prefix', async () => {
        const pool = mkSnapshotPool([entity2Breach()]);
        const prefix = await getWarningPrefix(pool, DEV, DEFAULT_CFG, 'en', 2, NOW);
        expect(prefix).toContain('System notice');
        expect(prefix).toContain('0%'); // 7d remaining
    });

    test('legacy unscoped row (entity_id IS NULL) still warns any entity — daemon back-compat', async () => {
        const pool = mkSnapshotPool([{
            device_id: DEV, entity_id: null, captured_at: fresh(60_000),
            claude_json: { live: { seven_day_pct: 97 } }, codex_json: null,
        }]);
        const prefix = await getWarningPrefix(pool, DEV, DEFAULT_CFG, 'en', 6, NOW);
        expect(prefix).toContain('System notice');
    });

    test('mapped Codex entity reads codex_json and does not inherit Claude 0% remaining from the same row', async () => {
        const pool = mkSnapshotPool([{
            device_id: DEV, entity_id: 6, captured_at: fresh(60_000),
            claude_json: { live: { five_hour_pct: 99, seven_day_pct: 100 } },
            codex_json: { rate_limits: { five_hour_pct: 10, seven_day_pct: 20, updated_at: fresh(30_000) } },
        }]);
        const cfg = { ...DEFAULT_CFG, entity_engines: { '6': 'codex' } };
        const prefix = await getWarningPrefix(pool, DEV, cfg, 'en', 6, NOW);
        expect(prefix).toBeNull();
    });

    test('mapped Codex entity still warns when codex_json breaches', async () => {
        const pool = mkSnapshotPool([{
            device_id: DEV, entity_id: 6, captured_at: fresh(60_000),
            claude_json: { live: { five_hour_pct: 10, seven_day_pct: 10 } },
            codex_json: { rate_limits: { five_hour_pct: 10, seven_day_pct: 99, updated_at: fresh(30_000) } },
        }]);
        const cfg = { ...DEFAULT_CFG, entity_engines: { '6': 'codex' } };
        const prefix = await getWarningPrefix(pool, DEV, cfg, 'en', 6, NOW);
        expect(prefix).toContain('System notice');
        expect(prefix).toContain('1%');
    });

    test('entity-scoped row is preferred over a NEWER unscoped row', async () => {
        const pool = mkSnapshotPool([
            entity2Breach(10 * 60_000),                       // older, breaching, entity 2
            { device_id: DEV, entity_id: null, captured_at: fresh(1_000),
              claude_json: { live: { five_hour_pct: 5, seven_day_pct: 5 } }, codex_json: null }, // newer, healthy
        ]);
        // ORDER BY (entity_id = $2) DESC → entity-2 row wins despite being older.
        const prefix = await getWarningPrefix(pool, DEV, DEFAULT_CFG, 'en', 2, NOW);
        expect(prefix).toContain('System notice');
    });

    test('cooldown is per-entity: #2 warning does not suppress #6, but does suppress #2 itself', async () => {
        const entity6Breach = {
            device_id: DEV, entity_id: 6, captured_at: fresh(60_000),
            claude_json: { live: { seven_day_pct: 98 } }, codex_json: null,
        };
        const pool = mkSnapshotPool([entity2Breach(), entity6Breach]);
        expect(await getWarningPrefix(pool, DEV, DEFAULT_CFG, 'en', 2, NOW)).toContain('System notice');
        // Within the same cooldown window:
        expect(await getWarningPrefix(pool, DEV, DEFAULT_CFG, 'en', 2, NOW + 1_000)).toBeNull();
        expect(await getWarningPrefix(pool, DEV, DEFAULT_CFG, 'en', 6, NOW + 1_000)).toContain('System notice');
    });

    test('no entityId (legacy caller) falls back to device-latest lookup', async () => {
        const pool = mkSnapshotPool([entity2Breach()]);
        const prefix = await getWarningPrefix(pool, DEV, DEFAULT_CFG, 'en', null, NOW);
        expect(prefix).toContain('System notice');
        // and the SQL sent was the single-param shape
        expect(pool.query.mock.calls[0][1]).toEqual([DEV]);
    });
});

describe('formatWarningText', () => {
    test('zh template uses 系統訊息 wording', () => {
        const s = formatWarningText('zh-TW', 14, 4);
        expect(s).toContain('⚠️');
        expect(s).toContain('系統訊息');
        expect(s).toContain('14');
        expect(s).toContain('4');
    });

    test('zh-CN uses simplified-Chinese template', () => {
        const s = formatWarningText('zh-CN', 14, 4);
        expect(s).toContain('系统消息');
        expect(s).toContain('14');
    });

    test('en template is English', () => {
        const s = formatWarningText('en', 14, 4);
        expect(s).toContain('System notice');
        expect(s).toContain('14%');
        expect(s).toContain('4%');
    });

    test('unknown locale falls back to en', () => {
        const s = formatWarningText('xx-YY', 14, 4);
        expect(s).toContain('System notice');
    });

    test('null remaining values render as em dash placeholder', () => {
        const s = formatWarningText('en', null, 4);
        expect(s).toContain('—');
        expect(s).toContain('4%');
    });

    test('values round to nearest integer', () => {
        const s = formatWarningText('en', 14.6, 3.4);
        expect(s).toContain('15%');
        expect(s).toContain('3%');
    });
});
