'use strict';

/**
 * Per-card usage-threshold cron skip (card_c2635849, parent card_ad507345).
 *
 * Covers:
 *   1. PUT /card/:id/schedule validation accepts integers 50–99 and rejects
 *      out-of-range / non-integer / non-numeric input.
 *   2. POST /card accepts schedule.skipIf{5h,7d}UsagePctOver with the same
 *      validation surface.
 *   3. evaluateUsageSkipDecision returns skip=true when ANY assigned entity
 *      crosses the 5h or 7d threshold and skip=false otherwise.
 *   4. Null usage% (no daemon push for that entity) is treated as 0% so the
 *      guard never blocks dispatch on missing data — preserves existing
 *      behavior for cards predating this column.
 *   5. Static code-shape: the cron fire path advances schedule_next_run_at
 *      on skip but does NOT bump schedule_last_run_at, so the audit trail
 *      reflects last successful dispatch.
 */

const fs = require('fs');
const path = require('path');
const { _private } = require('../../kanban');

const {
    isValidUsageThreshold,
    clampUsageThreshold,
    readClaudeLivePct,
    readCodexLivePct,
    evaluateUsageSkipDecision,
    SCHEDULE_USAGE_THRESHOLD_MIN,
    SCHEDULE_USAGE_THRESHOLD_MAX,
    DEFAULT_SKIP_5H_PCT,
    DEFAULT_SKIP_7D_PCT,
} = _private;

describe('isValidUsageThreshold — write-boundary validator', () => {
    test('accepts canonical boundary values 50, 85, 99', () => {
        expect(isValidUsageThreshold(50)).toBe(true);
        expect(isValidUsageThreshold(85)).toBe(true);
        expect(isValidUsageThreshold(99)).toBe(true);
    });

    test('accepts arbitrary integer mid-range values', () => {
        expect(isValidUsageThreshold(65)).toBe(true);
        expect(isValidUsageThreshold(72)).toBe(true);
        expect(isValidUsageThreshold(95)).toBe(true);
    });

    test('rejects boundary-adjacent invalid values 49 and 100', () => {
        expect(isValidUsageThreshold(49)).toBe(false);
        expect(isValidUsageThreshold(100)).toBe(false);
    });

    test('rejects negative numbers and extreme out-of-range values', () => {
        expect(isValidUsageThreshold(-1)).toBe(false);
        expect(isValidUsageThreshold(0)).toBe(false);
        expect(isValidUsageThreshold(1000)).toBe(false);
    });

    test('rejects non-integer numerics (decimals)', () => {
        expect(isValidUsageThreshold(85.5)).toBe(false);
        expect(isValidUsageThreshold(50.0001)).toBe(false);
    });

    test('rejects strings (even numeric-looking ones)', () => {
        expect(isValidUsageThreshold('85')).toBe(false);
        expect(isValidUsageThreshold('abc')).toBe(false);
        expect(isValidUsageThreshold('')).toBe(false);
    });

    test('rejects null, undefined, booleans, objects, arrays', () => {
        expect(isValidUsageThreshold(null)).toBe(false);
        expect(isValidUsageThreshold(undefined)).toBe(false);
        expect(isValidUsageThreshold(true)).toBe(false);
        expect(isValidUsageThreshold(false)).toBe(false);
        expect(isValidUsageThreshold({})).toBe(false);
        expect(isValidUsageThreshold([])).toBe(false);
        expect(isValidUsageThreshold(NaN)).toBe(false);
        expect(isValidUsageThreshold(Infinity)).toBe(false);
    });

    test('boundary constants match the documented [50, 99] range', () => {
        expect(SCHEDULE_USAGE_THRESHOLD_MIN).toBe(50);
        expect(SCHEDULE_USAGE_THRESHOLD_MAX).toBe(99);
    });
});

describe('clampUsageThreshold — read-side normalizer', () => {
    test('returns valid in-range integer unchanged', () => {
        expect(clampUsageThreshold(50, 85)).toBe(50);
        expect(clampUsageThreshold(72, 85)).toBe(72);
        expect(clampUsageThreshold(99, 85)).toBe(99);
    });

    test('falls back to default for null/undefined/empty string', () => {
        expect(clampUsageThreshold(null, 85)).toBe(85);
        expect(clampUsageThreshold(undefined, 85)).toBe(85);
        expect(clampUsageThreshold('', 85)).toBe(85);
    });

    test('falls back to default for out-of-range values', () => {
        expect(clampUsageThreshold(0, 85)).toBe(85);
        expect(clampUsageThreshold(49, 85)).toBe(85);
        expect(clampUsageThreshold(100, 85)).toBe(85);
        expect(clampUsageThreshold(-50, 85)).toBe(85);
    });

    test('truncates decimals to integer when in-range', () => {
        // Legacy rows could carry decimals; truncate rather than reject so
        // the guard still functions instead of permanently falling back.
        expect(clampUsageThreshold(85.7, 50)).toBe(85);
        expect(clampUsageThreshold(72.4, 50)).toBe(72);
    });

    test('defaults match documented column defaults', () => {
        expect(DEFAULT_SKIP_5H_PCT).toBe(85);
        expect(DEFAULT_SKIP_7D_PCT).toBe(95);
    });
});

describe('readClaudeLivePct / readCodexLivePct — usage-snapshot shape adapters', () => {
    test('reads Claude nested rate_limits shape', () => {
        const claudeJson = {
            live: {
                rate_limits: {
                    five_hour: { used_percentage: 87.4 },
                    seven_day: { used_percentage: 42.1 },
                },
            },
        };
        expect(readClaudeLivePct(claudeJson, 'five_hour')).toBe(87.4);
        expect(readClaudeLivePct(claudeJson, 'seven_day')).toBe(42.1);
    });

    test('reads Claude flat *_pct fallback shape', () => {
        const claudeJson = { live: { five_hour_pct: 90, seven_day_pct: 30 } };
        expect(readClaudeLivePct(claudeJson, 'five_hour')).toBe(90);
        expect(readClaudeLivePct(claudeJson, 'seven_day')).toBe(30);
    });

    test('returns null when Claude live block missing or empty', () => {
        expect(readClaudeLivePct(null, 'five_hour')).toBeNull();
        expect(readClaudeLivePct({}, 'five_hour')).toBeNull();
        expect(readClaudeLivePct({ live: {} }, 'five_hour')).toBeNull();
        expect(readClaudeLivePct({ live: { rate_limits: {} } }, 'five_hour')).toBeNull();
    });

    test('reads Codex flat rate_limits *_pct shape', () => {
        const codexJson = { rate_limits: { five_hour_pct: 55, seven_day_pct: 88 } };
        expect(readCodexLivePct(codexJson, 'five_hour')).toBe(55);
        expect(readCodexLivePct(codexJson, 'seven_day')).toBe(88);
    });

    test('returns null when Codex rate_limits missing', () => {
        expect(readCodexLivePct(null, 'five_hour')).toBeNull();
        expect(readCodexLivePct({}, 'five_hour')).toBeNull();
        expect(readCodexLivePct({ rate_limits: {} }, 'five_hour')).toBeNull();
    });
});

describe('evaluateUsageSkipDecision — per-card dispatch guard', () => {
    const mkCard = (overrides = {}) => ({
        id: 'card_test',
        device_id: 'dev1',
        schedule_skip_if_5h_pct_over: null,  // → falls back to default 85
        schedule_skip_if_7d_pct_over: null,  // → falls back to default 95
        ...overrides,
    });

    test('SKIPS when entity 5h usage strictly exceeds threshold', async () => {
        const lookup = jest.fn().mockResolvedValue({ five: 87, seven: 40 });
        const decision = await evaluateUsageSkipDecision(mkCard(), [2], lookup);
        expect(decision.skip).toBe(true);
        expect(decision.entityId).toBe(2);
        expect(decision.window).toBe('5h');
        expect(decision.pct).toBe(87);
        expect(decision.limit).toBe(85);
    });

    test('SKIPS when entity 7d usage strictly exceeds threshold', async () => {
        const lookup = jest.fn().mockResolvedValue({ five: 40, seven: 96 });
        const decision = await evaluateUsageSkipDecision(mkCard(), [5], lookup);
        expect(decision.skip).toBe(true);
        expect(decision.entityId).toBe(5);
        expect(decision.window).toBe('7d');
        expect(decision.pct).toBe(96);
        expect(decision.limit).toBe(95);
    });

    test('PROCEEDS (skip=false) when 5h usage exactly equals threshold (strict >)', async () => {
        // Threshold is "strictly over" — equal is not over.
        const lookup = jest.fn().mockResolvedValue({ five: 85, seven: 95 });
        const decision = await evaluateUsageSkipDecision(mkCard(), [2], lookup);
        expect(decision.skip).toBe(false);
    });

    test('PROCEEDS when usage under threshold', async () => {
        const lookup = jest.fn().mockResolvedValue({ five: 30, seven: 50 });
        const decision = await evaluateUsageSkipDecision(mkCard(), [2], lookup);
        expect(decision.skip).toBe(false);
    });

    test('PROCEEDS when usage data unavailable (null) — treated as 0%', async () => {
        // Per spec: "If usage data unavailable for the entity, treat as 0%
        // (do NOT skip — preserve current behavior)."
        const lookup = jest.fn().mockResolvedValue({ five: null, seven: null });
        const decision = await evaluateUsageSkipDecision(mkCard(), [2], lookup);
        expect(decision.skip).toBe(false);
    });

    test('PROCEEDS when usage lookup returns null/undefined entirely', async () => {
        const lookup = jest.fn().mockResolvedValue(null);
        const decision = await evaluateUsageSkipDecision(mkCard(), [2], lookup);
        expect(decision.skip).toBe(false);
    });

    test('honors per-card custom 5h threshold (60%)', async () => {
        const lookup = jest.fn().mockResolvedValue({ five: 65, seven: 40 });
        const card = mkCard({ schedule_skip_if_5h_pct_over: 60 });
        const decision = await evaluateUsageSkipDecision(card, [2], lookup);
        expect(decision.skip).toBe(true);
        expect(decision.limit).toBe(60);
    });

    test('honors per-card custom 7d threshold (70%)', async () => {
        const lookup = jest.fn().mockResolvedValue({ five: 10, seven: 75 });
        const card = mkCard({ schedule_skip_if_7d_pct_over: 70 });
        const decision = await evaluateUsageSkipDecision(card, [3], lookup);
        expect(decision.skip).toBe(true);
        expect(decision.window).toBe('7d');
        expect(decision.limit).toBe(70);
    });

    test('SKIPS on FIRST offending entity in multi-entity assignment', async () => {
        // First bot is over threshold → skip; we don't need to check the rest.
        const lookup = jest.fn()
            .mockResolvedValueOnce({ five: 90, seven: 40 })  // entity 2 — over
            .mockResolvedValueOnce({ five: 10, seven: 10 }); // entity 3 — fine
        const decision = await evaluateUsageSkipDecision(mkCard(), [2, 3], lookup);
        expect(decision.skip).toBe(true);
        expect(decision.entityId).toBe(2);
        expect(lookup).toHaveBeenCalledTimes(1);  // short-circuit
    });

    test('SKIPS when SECOND of two entities is over threshold', async () => {
        const lookup = jest.fn()
            .mockResolvedValueOnce({ five: 30, seven: 40 })  // entity 2 — fine
            .mockResolvedValueOnce({ five: 88, seven: 40 }); // entity 3 — over
        const decision = await evaluateUsageSkipDecision(mkCard(), [2, 3], lookup);
        expect(decision.skip).toBe(true);
        expect(decision.entityId).toBe(3);
    });

    test('PROCEEDS when bots array empty (no assigned entities to check)', async () => {
        const lookup = jest.fn();
        const decision = await evaluateUsageSkipDecision(mkCard(), [], lookup);
        expect(decision.skip).toBe(false);
        expect(lookup).not.toHaveBeenCalled();
    });

    test('out-of-range stored threshold falls back to default 85/95 at fire time', async () => {
        // Defense-in-depth: if a corrupt row stores 200 or 0, the dispatch
        // path must not silently disable the guard. clampUsageThreshold
        // returns the default, so a 90% entity still trips the 85% guard.
        const card = mkCard({ schedule_skip_if_5h_pct_over: 200 });
        const lookup = jest.fn().mockResolvedValue({ five: 90, seven: 10 });
        const decision = await evaluateUsageSkipDecision(card, [2], lookup);
        expect(decision.skip).toBe(true);
        expect(decision.limit).toBe(85);  // not 200
    });
});

describe('cron fire path — source-shape invariants (card_c2635849)', () => {
    const kanbanSrc = fs.readFileSync(
        path.join(__dirname, '..', '..', 'kanban.js'),
        'utf8'
    );

    test('usage-skip check runs inside the recurring + is_automation branch', () => {
        const branchStart = kanbanSrc.indexOf("schedType === 'recurring' && card.is_automation");
        // Anchor on the in-fn call site (await form), not the export entry
        // — the export list also mentions evaluateUsageSkipDecision but
        // that's after every router handler.
        const usageIdx = kanbanSrc.indexOf('await evaluateUsageSkipDecision');
        // The cron-path idle gate is the only one whose log line says
        // "checking entity idle status (dispatch_mode=idle_only)" — anchor
        // on that to avoid colliding with the POST /card validator.
        const idlePathIdx = kanbanSrc.indexOf('checking entity idle status (dispatch_mode=idle_only)');
        expect(branchStart).toBeGreaterThan(-1);
        expect(idlePathIdx).toBeGreaterThan(branchStart);
        expect(usageIdx).toBeGreaterThan(branchStart);
        // Usage gate runs before the idle-dispatch path so quota saturation
        // trumps idle gating (both can defer dispatch but for different reasons).
        expect(usageIdx).toBeLessThan(idlePathIdx);
    });

    test('on usage skip, advances schedule_next_run_at but does NOT bump schedule_last_run_at', () => {
        // Grab the block from the [CronSkip] log line backward to the if (usageDecision.skip).
        const block = kanbanSrc.match(
            /if \(usageDecision\.skip\) \{[\s\S]*?\[CronSkip\][\s\S]*?continue;\s*\}/
        );
        expect(block).not.toBeNull();
        // Must update schedule_next_run_at so the row doesn't fire-spin on every poll.
        expect(block[0]).toMatch(/SET schedule_next_run_at = \$1/);
        // Must NOT bump schedule_last_run_at — preserves last-successful-dispatch audit.
        expect(block[0]).not.toMatch(/schedule_last_run_at = NOW\(\)/);
    });

    test('skip log line names entity + window + pct + limit (operator-friendly)', () => {
        // [CronSkip] card_X entity_Y usage_5h=87% > 85% — child dispatch skipped
        expect(kanbanSrc).toMatch(
            /\[CronSkip\] card_\$\{card\.id\} entity_\$\{usageDecision\.entityId\} usage_\$\{usageDecision\.window\}=\$\{usageDecision\.pct\}% > \$\{usageDecision\.limit\}%/
        );
    });

    test('serializeCard surfaces skipIf{5h,7d}UsagePctOver on schedule object', () => {
        expect(kanbanSrc).toMatch(/skipIf5hUsagePctOver: clampUsageThreshold\(row\.schedule_skip_if_5h_pct_over, DEFAULT_SKIP_5H_PCT\)/);
        expect(kanbanSrc).toMatch(/skipIf7dUsagePctOver: clampUsageThreshold\(row\.schedule_skip_if_7d_pct_over, DEFAULT_SKIP_7D_PCT\)/);
    });

    test('PUT /card/:id/schedule validates skipIf5h/7d via isValidUsageThreshold', () => {
        // The handler must call isValidUsageThreshold for both fields, and
        // return HTTP 400 with a [50, 99] error message when invalid.
        expect(kanbanSrc).toMatch(/skipIf5hUsagePctOver !== undefined[\s\S]{0,400}isValidUsageThreshold\(skipIf5hUsagePctOver\)/);
        expect(kanbanSrc).toMatch(/skipIf7dUsagePctOver !== undefined[\s\S]{0,400}isValidUsageThreshold\(skipIf7dUsagePctOver\)/);
        expect(kanbanSrc).toMatch(/skipIf5hUsagePctOver must be an integer in \[50, 99\]/);
        expect(kanbanSrc).toMatch(/skipIf7dUsagePctOver must be an integer in \[50, 99\]/);
    });

    test('POST /card validates the same threshold fields under schedule', () => {
        expect(kanbanSrc).toMatch(/schedule\.skipIf5hUsagePctOver !== undefined[\s\S]{0,400}isValidUsageThreshold\(schedule\.skipIf5hUsagePctOver\)/);
        expect(kanbanSrc).toMatch(/schedule\.skipIf7dUsagePctOver !== undefined[\s\S]{0,400}isValidUsageThreshold\(schedule\.skipIf7dUsagePctOver\)/);
    });
});

describe('migration + schema mirror', () => {
    test('up.sql adds both schedule_skip_if_*_pct_over columns', () => {
        const sql = fs.readFileSync(
            path.join(__dirname, '..', '..', 'migrations', '20260621_kanban_card_schedule_usage_threshold.up.sql'),
            'utf8'
        );
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS schedule_skip_if_5h_pct_over SMALLINT DEFAULT 85/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS schedule_skip_if_7d_pct_over SMALLINT DEFAULT 95/);
    });

    test('down.sql drops both columns (reversibility)', () => {
        const sql = fs.readFileSync(
            path.join(__dirname, '..', '..', 'migrations', '20260621_kanban_card_schedule_usage_threshold.down.sql'),
            'utf8'
        );
        expect(sql).toMatch(/DROP COLUMN IF EXISTS schedule_skip_if_5h_pct_over/);
        expect(sql).toMatch(/DROP COLUMN IF EXISTS schedule_skip_if_7d_pct_over/);
    });

    test('kanban_schema.sql mirrors the migration columns (boot-time bootstrap)', () => {
        const sql = fs.readFileSync(
            path.join(__dirname, '..', '..', 'kanban_schema.sql'),
            'utf8'
        );
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS schedule_skip_if_5h_pct_over SMALLINT DEFAULT 85/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS schedule_skip_if_7d_pct_over SMALLINT DEFAULT 95/);
    });
});
