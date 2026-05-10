/**
 * Unit test for kanban_done / kanban_done_auto notification categories.
 *
 * Hank 2026-05-10 (card_8a4e2bb268ed2120a8cf3362):
 * Card-done events should now fire device-level push (web/FCM), with auto/cron
 * card completions on a separate prefs key so chatty crons can be muted
 * without losing manual closures.
 */

const { DEFAULT_PREFS, isCategoryEnabled } = require('../../notifications');

describe('kanban_done / kanban_done_auto — DEFAULT_PREFS', () => {
    test('kanban_done is registered and defaults to true', () => {
        expect(DEFAULT_PREFS.kanban_done).toBe(true);
    });

    test('kanban_done_auto is registered and defaults to true', () => {
        expect(DEFAULT_PREFS.kanban_done_auto).toBe(true);
    });
});

describe('kanban_done / kanban_done_auto — isCategoryEnabled gating', () => {
    test('kanban_done=false suppresses notification', () => {
        expect(isCategoryEnabled({ kanban_done: false }, 'kanban_done')).toBe(false);
    });

    test('kanban_done_auto=false suppresses notification', () => {
        expect(isCategoryEnabled({ kanban_done_auto: false }, 'kanban_done_auto')).toBe(false);
    });

    test('toggles are independent (muting auto does not mute manual)', () => {
        const prefs = { kanban_done: true, kanban_done_auto: false };
        expect(isCategoryEnabled(prefs, 'kanban_done')).toBe(true);
        expect(isCategoryEnabled(prefs, 'kanban_done_auto')).toBe(false);
    });

    test('toggles are independent (muting manual does not mute auto)', () => {
        const prefs = { kanban_done: false, kanban_done_auto: true };
        expect(isCategoryEnabled(prefs, 'kanban_done')).toBe(false);
        expect(isCategoryEnabled(prefs, 'kanban_done_auto')).toBe(true);
    });

    test('missing keys fail-open (default true)', () => {
        expect(isCategoryEnabled({}, 'kanban_done')).toBe(true);
        expect(isCategoryEnabled({}, 'kanban_done_auto')).toBe(true);
    });
});
