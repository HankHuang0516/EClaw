/**
 * Unit test for isCategoryEnabled() category aliasing.
 *
 * Regression: cross_speak / cross_speak_sent dispatch sites bypassed the
 * user's "speak_to" toggle because those sub-categories were not in
 * DEFAULT_PREFS, so `prefs[category] !== false` returned true (undefined).
 * Reported by Hank 2026-05-03 (card_5385cfeacade16ce86b56378).
 */

const { isCategoryEnabled } = require('../../notifications');

describe('isCategoryEnabled — category aliases', () => {
    test('cross_speak honors speak_to=false', () => {
        expect(isCategoryEnabled({ speak_to: false }, 'cross_speak')).toBe(false);
    });

    test('cross_speak_sent honors speak_to=false', () => {
        expect(isCategoryEnabled({ speak_to: false }, 'cross_speak_sent')).toBe(false);
    });

    test('cross_speak honors speak_to=true', () => {
        expect(isCategoryEnabled({ speak_to: true }, 'cross_speak')).toBe(true);
    });

    test('speak_to itself remains gated by its own key', () => {
        expect(isCategoryEnabled({ speak_to: false }, 'speak_to')).toBe(false);
        expect(isCategoryEnabled({ speak_to: true }, 'speak_to')).toBe(true);
    });

    test('non-aliased category passes through unchanged', () => {
        expect(isCategoryEnabled({ bot_reply: false }, 'bot_reply')).toBe(false);
        expect(isCategoryEnabled({ bot_reply: true }, 'bot_reply')).toBe(true);
    });

    test('missing prefs object returns true (fail-open)', () => {
        expect(isCategoryEnabled(null, 'cross_speak')).toBe(true);
        expect(isCategoryEnabled(undefined, 'cross_speak')).toBe(true);
    });

    test('alias does not leak into the wrong key when speak_to absent but cross_speak set', () => {
        // User who somehow got cross_speak=false stored: still respected via fallback.
        // (We map cross_speak → speak_to first; if speak_to absent, undefined !== false → true.)
        // This documents that the alias is one-way: cross_speak reads speak_to, not vice versa.
        expect(isCategoryEnabled({ cross_speak: false }, 'speak_to')).toBe(true);
    });
});
