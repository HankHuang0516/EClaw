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
    shouldWarnNow,
    formatWarningText,
    pickClaudeLivePct,
} = require('../../lib/usage-warning');

const DEFAULT_CFG = { enabled: true, threshold_5h_pct: 15, threshold_7d_pct: 5 };
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
