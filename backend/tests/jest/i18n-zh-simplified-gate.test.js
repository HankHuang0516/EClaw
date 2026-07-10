/**
 * Simplified-char gate for Traditional-Chinese locales (card_2f3a43d6)
 *
 * Regression: TRANSLATIONS['zh'] is the canonical Traditional-Chinese
 * dictionary (zh-TW / zh-CN fall back to it in i18n.t), but 161 keys —
 * including every dialog_* destructive-confirm key (dialog_confirm was 确认),
 * dashboard_usage_widget_*, mm_card_* — carried Simplified-Chinese values,
 * so zh users saw 简体 buttons on the highest-risk delete confirmations.
 *
 * Gate: no value in a gated Traditional locale (zh, zh-TW) may contain a
 * Simplified-distinguishing character (a char valid ONLY in Simplified text,
 * derived from OpenCC ST/TS/TWVariants tables — snapshot in
 * backend/scripts/i18n-zh-simplified-chars.json). The same rule hard-fails
 * CI via backend/scripts/i18n-check.js; this suite covers the collector
 * red→green and pins the real dictionary at zero offenders.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
    collectSimplifiedCharOffenders,
    loadZhSimplifiedCharSet,
    SIMPLIFIED_GATED_LOCALES,
} = require('../../scripts/i18n-check');

const I18N_PATH = path.join(__dirname, '../../public/shared/i18n.js');

function loadRealTranslations() {
    const content = fs.readFileSync(I18N_PATH, 'utf8');
    const sandbox = {
        localStorage: { getItem: () => null, setItem: () => {} },
        navigator: { language: 'en' },
        document: { addEventListener: () => {}, querySelectorAll: () => [], documentElement: { lang: '' } },
        fetch: () => Promise.resolve(),
        console,
        _result: {}
    };
    vm.createContext(sandbox);
    vm.runInContext(content + '\n_result.TRANSLATIONS = TRANSLATIONS;', sandbox);
    return sandbox._result.TRANSLATIONS;
}

describe('Simplified-distinguishing character set', () => {
    let simpChars;
    beforeAll(() => { simpChars = loadZhSimplifiedCharSet(); });

    test('loads a non-trivial char set', () => {
        expect(simpChars.size).toBeGreaterThan(1000);
    });

    test('contains canonical Simplified-only chars', () => {
        // The exact chars from the original defect: dialog_confirm=确认,
        // mm_card_title=心智图, ped_* 点选/编辑.
        for (const ch of ['确', '认', '图', '点', '编', '辑', '简']) {
            expect(simpChars.has(ch)).toBe(true);
        }
    });

    test('covers 广 (supplemental — 廣; OpenCC ST self-maps it so the pure derivation misses it)', () => {
        // Gate hole found 2026-07-10: chat_routing_broadcast=广播 slipped into
        // TRANSLATIONS.zh and stayed CI-green because 广 was in neither the
        // derived `chars` nor `supplementalChars`. It has no modern-Traditional
        // usage (廣 is the Traditional form), so it belongs in supplementalChars.
        expect(simpChars.has('广')).toBe(true);
        expect(simpChars.has('廣')).toBe(false); // Traditional form must stay out.
    });

    test('does NOT contain Traditional or Taiwan-standard chars', () => {
        // 確認/圖 are Traditional; 群/秘/台 are Taiwan-standard forms that a
        // naive OpenCC key-scan would false-positive on (羣/祕 variants).
        for (const ch of ['確', '認', '圖', '群', '秘', '台', '和', '即', '查']) {
            expect(simpChars.has(ch)).toBe(false);
        }
    });
});

describe('collectSimplifiedCharOffenders', () => {
    let simpChars;
    beforeAll(() => { simpChars = loadZhSimplifiedCharSet(); });

    test('flags a Simplified value in zh (the dialog_confirm=确认 defect)', () => {
        const offenders = collectSimplifiedCharOffenders(
            { zh: { dialog_confirm: '确认' } }, simpChars
        );
        expect(offenders).toHaveLength(1);
        expect(offenders[0]).toMatchObject({ locale: 'zh', key: 'dialog_confirm' });
        expect(offenders[0].chars).toContain('确');
    });

    test('passes the Traditional equivalent', () => {
        expect(collectSimplifiedCharOffenders(
            { zh: { dialog_confirm: '確認' } }, simpChars
        )).toEqual([]);
    });

    test('flags mixed Traditional+Simplified values (跳过 in a 繁體 sentence)', () => {
        const offenders = collectSimplifiedCharOffenders(
            { zh: { kb_label_gated: '自動升級跳过此卡' } }, simpChars
        );
        expect(offenders).toHaveLength(1);
        expect(offenders[0].chars).toBe('过');
    });

    test('gates zh-TW too', () => {
        const offenders = collectSimplifiedCharOffenders(
            { 'zh-TW': { k: '准备好发布' } }, simpChars
        );
        expect(offenders).toHaveLength(1);
        expect(offenders[0].locale).toBe('zh-TW');
    });

    test('ignores non-gated locales (zh-CN is allowed to be Simplified)', () => {
        expect(collectSimplifiedCharOffenders(
            { 'zh-CN': { dialog_confirm: '确认' }, ja: { k: '点' } }, simpChars
        )).toEqual([]);
    });

    test('passes Taiwan-standard chars that naive scans false-positive on', () => {
        expect(collectSimplifiedCharOffenders(
            { zh: { a: '社群媒體', b: '秘密金鑰', c: '平台即服務' } }, simpChars
        )).toEqual([]);
    });

    test('skips non-string values', () => {
        expect(collectSimplifiedCharOffenders(
            { zh: { n: 42, o: null } }, simpChars
        )).toEqual([]);
    });
});

describe('production TRANSLATIONS', () => {
    test('gated Traditional locales contain zero Simplified-distinguishing chars', () => {
        const TRANSLATIONS = loadRealTranslations();
        const simpChars = loadZhSimplifiedCharSet();
        const offenders = collectSimplifiedCharOffenders(TRANSLATIONS, simpChars, SIMPLIFIED_GATED_LOCALES);
        if (offenders.length) {
            throw new Error(
                'Simplified-Chinese characters found in Traditional-Chinese locale(s) — ' +
                'same class as the dialog_confirm=确认 defect (card_2f3a43d6). Rewrite in Traditional:\n  ' +
                offenders.map(o => `${o.locale}.${o.key} [${o.chars}]: "${o.preview}"`).join('\n  ')
            );
        }
    });

    test('dialog destructive-confirm keys are Traditional in zh', () => {
        const TRANSLATIONS = loadRealTranslations();
        expect(TRANSLATIONS.zh.dialog_confirm).toBe('確認');
        expect(TRANSLATIONS.zh.dialog_confirm_destructive).toBe('確認破壞性操作');
    });

    test('dialog_type_to_confirm exists in en/zh/zh-TW with {phrase} placeholder', () => {
        const TRANSLATIONS = loadRealTranslations();
        expect(TRANSLATIONS.en.dialog_type_to_confirm).toBe('Type {phrase} to confirm');
        expect(TRANSLATIONS.zh.dialog_type_to_confirm).toBe('輸入 {phrase} 以確認');
        expect(TRANSLATIONS['zh-TW'].dialog_type_to_confirm).toBe('輸入 {phrase} 以確認');
    });

    test('routing-chip keys are Traditional + present in zh (vision-review 2026-07-10)', () => {
        // The zh block (Traditional default) had broadcast=广播 (Simplified) and
        // was MISSING org_upward + to_user entirely, so the chip rendered the
        // en fallback "Escalated"/"User" in an otherwise-Traditional UI. Pin the
        // corrected values so a regression re-fails here.
        const TRANSLATIONS = loadRealTranslations();
        expect(TRANSLATIONS.zh.chat_routing_broadcast).toBe('廣播');
        expect(TRANSLATIONS.zh.chat_routing_org_upward).toBe('上報');
        expect(TRANSLATIONS.zh.chat_routing_to_user).toBe('用戶');
    });
});
