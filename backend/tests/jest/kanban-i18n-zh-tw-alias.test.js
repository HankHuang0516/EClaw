/**
 * Kanban notification i18n — Traditional Chinese alias resolution.
 *
 * Regression: card_a791afadbefa9c7286706480
 * Hank's user_accounts.language ended up as 'ar' AND/OR onboarding may write
 * 'zh-TW'. Either path used to leak the wrong dict to him because:
 * - TRANSLATIONS only has 'zh' (Traditional), no 'zh-TW' key
 * - validLangs in PATCH /api/auth/language rejected 'zh-TW'
 *
 * After the fix, BCP-47 Traditional aliases (zh-TW, zh-Hant, zh-HK, etc.)
 * resolve to the 'zh' dict in tKanban/statusLabel.
 */

const { tKanban, statusLabel, TRANSLATIONS } = require('../../i18n/kanban-notifications');

describe('kanban-notifications zh-TW alias', () => {
    const traditionalAliases = ['zh-TW', 'zh-Hant', 'zh-HK', 'zh-Hant-TW', 'zh-Hant-HK'];

    test.each(traditionalAliases)('statusLabel("%s","review") returns Traditional Chinese「審查」', (alias) => {
        expect(statusLabel(alias, 'review')).toBe('審查');
    });

    test.each(traditionalAliases)('tKanban("%s","staleNudge",…) uses Traditional Chinese template', (alias) => {
        const out = tKanban(alias, 'staleNudge', { title: 'X', status: '待辦', hours: 3 });
        expect(out).toContain('⏰ 任務催促');
        expect(out).toContain('[X]');
        expect(out).toContain('3 小時');
    });

    test('zh-CN still routes to Simplified dict (not Traditional)', () => {
        expect(statusLabel('zh-CN', 'review')).toBe('审查');
        expect(statusLabel('zh-CN', 'review')).not.toBe('審查');
    });

    test('ar still routes to Arabic dict (alias change does not touch other locales)', () => {
        expect(statusLabel('ar', 'review')).toBe('مراجعة');
    });

    test('unknown locale falls back to English', () => {
        expect(statusLabel('xx-YY', 'review')).toBe('Review');
    });

    test('TRANSLATIONS exposes zh (Traditional) but intentionally NOT zh-TW key', () => {
        expect(TRANSLATIONS.zh).toBeDefined();
        expect(TRANSLATIONS['zh-TW']).toBeUndefined();
    });
});
