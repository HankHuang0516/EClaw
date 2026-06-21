'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const I18N_FILE = path.join(__dirname, '..', '..', 'public', 'shared', 'i18n.js');

function loadI18n() {
    const src = fs.readFileSync(I18N_FILE, 'utf8');
    const noop = () => {};
    const sandbox = {
        _result: null,
        _I18nClass: null,
        localStorage: { getItem: () => null, setItem: noop },
        navigator: { language: 'en' },
        document: { querySelectorAll: () => [], documentElement: { lang: 'en' }, addEventListener: noop, getElementById: () => null },
        window: { location: { search: '' } },
        setTimeout: noop,
        console: { log: noop, warn: noop, error: noop }
    };
    vm.createContext(sandbox);
    vm.runInContext(src + '\n_result = TRANSLATIONS;\n_I18nClass = I18n;', sandbox, { timeout: 5000 });
    return { TRANSLATIONS: sandbox._result, I18n: sandbox._I18nClass };
}

describe('i18n.t() — zh-TW / zh-CN → zh fallback chain', () => {
    let TRANSLATIONS, I18n;
    beforeAll(() => {
        ({ TRANSLATIONS, I18n } = loadI18n());
    });

    test('TRANSLATIONS.zh exists and is the canonical Traditional Chinese dict', () => {
        expect(TRANSLATIONS.zh).toBeDefined();
        expect(typeof TRANSLATIONS.zh).toBe('object');
        expect(Object.keys(TRANSLATIONS.zh).length).toBeGreaterThan(1000);
    });

    test('TRANSLATIONS["zh-TW"] stays a small override layer', () => {
        expect(TRANSLATIONS['zh-TW']).toBeDefined();
        const zhTwKeys = Object.keys(TRANSLATIONS['zh-TW']);
        // zh-TW intentionally overrides only locale-specific copy and should
        // continue to fall back through the canonical zh dictionary.
        expect(zhTwKeys.length).toBeLessThan(150);
        expect(zhTwKeys.length).toBeLessThan(Object.keys(TRANSLATIONS.zh).length / 50);
        expect(zhTwKeys.length).toBeGreaterThan(0);
    });

    test('zh-TW lang resolves a key present in zh (not present in zh-TW stub)', () => {
        // Pick a key that exists in zh but NOT in the zh-TW stub.
        const zhKeys = Object.keys(TRANSLATIONS.zh);
        const zhTwSet = new Set(Object.keys(TRANSLATIONS['zh-TW']));
        // Require zh value to actually differ from en — many brand-name keys
        // are intentionally identical (e.g. "EClawbot Mission Control"); those
        // can't prove the fallback path was taken.
        const fallbackKey = zhKeys.find(k => !zhTwSet.has(k) && TRANSLATIONS.zh[k] && TRANSLATIONS.en[k] && TRANSLATIONS.zh[k] !== TRANSLATIONS.en[k]);
        expect(fallbackKey).toBeDefined();

        const i18n = new I18n();
        i18n.lang = 'zh-TW';
        const out = i18n.t(fallbackKey);
        expect(out).toBe(TRANSLATIONS.zh[fallbackKey]);
        expect(out).not.toBe(TRANSLATIONS.en[fallbackKey]);
    });

    test('zh-TW lang STILL prefers stub override when key exists in stub', () => {
        const stubKeys = Object.keys(TRANSLATIONS['zh-TW']);
        expect(stubKeys.length).toBeGreaterThan(0);
        const k = stubKeys[0];

        const i18n = new I18n();
        i18n.lang = 'zh-TW';
        const out = i18n.t(k);
        expect(out).toBe(TRANSLATIONS['zh-TW'][k]);
    });

    test('zh-CN lang falls back through zh before en', () => {
        // Find a key absent from zh-CN but present in zh and en.
        const zhCnSet = new Set(Object.keys(TRANSLATIONS['zh-CN']));
        const zhKeys = Object.keys(TRANSLATIONS.zh);
        const fallbackKey = zhKeys.find(k => !zhCnSet.has(k) && TRANSLATIONS.zh[k] && TRANSLATIONS.en[k] && TRANSLATIONS.zh[k] !== TRANSLATIONS.en[k]);
        if (!fallbackKey) {
            // No such key in this snapshot — skip rather than fail (zh-CN may have grown to fully cover zh).
            return;
        }

        const i18n = new I18n();
        i18n.lang = 'zh-CN';
        const out = i18n.t(fallbackKey);
        expect(out).toBe(TRANSLATIONS.zh[fallbackKey]);
    });

    test('keys absent from both zh-TW stub AND zh fall through to en', () => {
        // Find a key in en but not in zh and not in zh-TW.
        const enKeys = Object.keys(TRANSLATIONS.en);
        const zhSet = new Set(Object.keys(TRANSLATIONS.zh));
        const zhTwSet = new Set(Object.keys(TRANSLATIONS['zh-TW']));
        const enOnly = enKeys.find(k => !zhSet.has(k) && !zhTwSet.has(k));
        if (!enOnly) return;

        const i18n = new I18n();
        i18n.lang = 'zh-TW';
        const out = i18n.t(enOnly);
        expect(out).toBe(TRANSLATIONS.en[enOnly]);
    });

    test('non-Chinese locales unaffected by the zh fallback (e.g. ja key missing → en, NOT zh)', () => {
        const enKeys = Object.keys(TRANSLATIONS.en);
        const jaSet = new Set(Object.keys(TRANSLATIONS.ja || {}));
        const zhSet = new Set(Object.keys(TRANSLATIONS.zh));
        const k = enKeys.find(x => !jaSet.has(x) && zhSet.has(x) && TRANSLATIONS.zh[x] !== TRANSLATIONS.en[x]);
        if (!k) return;

        const i18n = new I18n();
        i18n.lang = 'ja';
        const out = i18n.t(k);
        expect(out).toBe(TRANSLATIONS.en[k]);
        expect(out).not.toBe(TRANSLATIONS.zh[k]);
    });

    test('unknown key returns the key itself (last-resort fallback preserved)', () => {
        const i18n = new I18n();
        i18n.lang = 'zh-TW';
        const bogus = '__no_such_key_zzz_' + Date.now();
        expect(i18n.t(bogus)).toBe(bogus);
    });

    test('parameter replacement still works through the fallback path', () => {
        // Find a zh key with {param} placeholder that's not in zh-TW stub.
        const zhKeys = Object.keys(TRANSLATIONS.zh);
        const zhTwSet = new Set(Object.keys(TRANSLATIONS['zh-TW']));
        const paramKey = zhKeys.find(k => !zhTwSet.has(k) && /\{[a-zA-Z_]+\}/.test(TRANSLATIONS.zh[k] || ''));
        if (!paramKey) return;

        const placeholder = TRANSLATIONS.zh[paramKey].match(/\{([a-zA-Z_]+)\}/)[1];
        const i18n = new I18n();
        i18n.lang = 'zh-TW';
        const out = i18n.t(paramKey, { [placeholder]: 'XYZ' });
        expect(out).toContain('XYZ');
        expect(out).not.toContain(`{${placeholder}}`);
    });
});
