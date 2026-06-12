/**
 * Backend usage-api pickClaudeLivePct helper — card_555a7d5f99fd5c6f1a28a169.
 *
 * The Claude statusLine hook writes nested
 * `live.rate_limits.{five_hour,seven_day}.used_percentage`. Earlier code
 * paths (live widget legacy + a few callers) also pass a flat
 * `live.{five_hour,seven_day}_pct`. The timeline endpoint previously only
 * read the flat form, so every Claude line in the SVG chart was empty
 * whenever statusLine was the only producer. The helper now tolerates both
 * shapes; these tests pin that contract.
 */
'use strict';

const usageApi = require('../../usage-api');

const { pickClaudeLivePct } = usageApi({}).router && usageApi({})._internal
    ? usageApi({})._internal
    : require('../../usage-api')({})._internal;

describe('pickClaudeLivePct — read both nested and flat shapes', () => {
    test('returns null for null / undefined / non-dict input', () => {
        expect(pickClaudeLivePct(null, 'five_hour')).toBeNull();
        expect(pickClaudeLivePct(undefined, 'five_hour')).toBeNull();
        expect(pickClaudeLivePct({}, 'five_hour')).toBeNull();
    });

    test('flat shape — live.five_hour_pct is read directly', () => {
        const live = { five_hour_pct: 42, seven_day_pct: 73 };
        expect(pickClaudeLivePct(live, 'five_hour')).toBe(42);
        expect(pickClaudeLivePct(live, 'seven_day')).toBe(73);
    });

    test('nested shape — statusLine hook output (used_percentage) is read', () => {
        const live = {
            rate_limits: {
                five_hour: { used_percentage: 4, resets_at: 1781295000 },
                seven_day: { used_percentage: 48, resets_at: 1781704800 },
            },
        };
        expect(pickClaudeLivePct(live, 'five_hour')).toBe(4);
        expect(pickClaudeLivePct(live, 'seven_day')).toBe(48);
    });

    test('flat wins over nested when both present (legacy producer + new producer overlap)', () => {
        const live = {
            five_hour_pct: 12,
            rate_limits: { five_hour: { used_percentage: 99 } },
        };
        expect(pickClaudeLivePct(live, 'five_hour')).toBe(12);
    });

    test('rejects non-number values gracefully', () => {
        expect(pickClaudeLivePct({ five_hour_pct: 'oops' }, 'five_hour')).toBeNull();
        expect(pickClaudeLivePct({ five_hour_pct: null }, 'five_hour')).toBeNull();
        expect(pickClaudeLivePct({
            rate_limits: { five_hour: { used_percentage: 'oops' } },
        }, 'five_hour')).toBeNull();
        expect(pickClaudeLivePct({ rate_limits: { five_hour: {} } }, 'five_hour')).toBeNull();
    });

    test('accepts zero (truthy-trap regression guard)', () => {
        expect(pickClaudeLivePct({ five_hour_pct: 0 }, 'five_hour')).toBe(0);
        expect(pickClaudeLivePct({
            rate_limits: { five_hour: { used_percentage: 0 } },
        }, 'five_hour')).toBe(0);
    });
});
