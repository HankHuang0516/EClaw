/**
 * i18n.js syntax and structure regression tests
 *
 * Ensures the i18n translation file parses correctly and all language
 * sections are properly structured. Catches misplaced translations
 * and missing commas between language blocks.
 *
 * Regression: orphaned French arena translations between es/de sections
 * caused a SyntaxError preventing the entire i18n.js from loading,
 * crashing all portal pages.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const I18N_PATH = path.join(__dirname, '../../public/shared/i18n.js');

describe('i18n.js syntax and structure', () => {
    let content;

    beforeAll(() => {
        content = fs.readFileSync(I18N_PATH, 'utf8');
    });

    test('file parses without syntax errors', () => {
        expect(() => {
            new vm.Script(content, { filename: 'i18n.js' });
        }).not.toThrow();
    });

    test('TRANSLATIONS object is valid and contains expected languages', () => {
        const sandbox = {
            localStorage: { getItem: () => null, setItem: () => {} },
            navigator: { language: 'en' },
            document: {
                addEventListener: () => {},
                querySelectorAll: () => [],
                documentElement: { lang: '' }
            },
            fetch: () => Promise.resolve(),
            console,
            _result: {}
        };
        vm.createContext(sandbox);
        vm.runInContext(content + '\n_result.TRANSLATIONS = TRANSLATIONS; _result.i18n = i18n;', sandbox);

        const { TRANSLATIONS, i18n } = sandbox._result;

        const requiredLangs = ['en', 'zh', 'ja', 'ko', 'fr', 'es', 'de'];
        for (const lang of requiredLangs) {
            expect(TRANSLATIONS).toHaveProperty(lang);
            expect(typeof TRANSLATIONS[lang]).toBe('object');
        }

        expect(i18n).toBeDefined();
        expect(typeof i18n.t).toBe('function');
        expect(typeof i18n.setLanguage).toBe('function');
    });

    test('i18n.t() returns translations, not raw keys', () => {
        const sandbox = {
            localStorage: { getItem: () => null, setItem: () => {} },
            navigator: { language: 'en' },
            document: {
                addEventListener: () => {},
                querySelectorAll: () => [],
                documentElement: { lang: '' }
            },
            fetch: () => Promise.resolve(),
            console,
            _result: {}
        };
        vm.createContext(sandbox);
        vm.runInContext(content + '\n_result.i18n = i18n;', sandbox);

        const { i18n } = sandbox._result;
        // Should return a translated string, not the key itself
        const result = i18n.t('mc_title');
        expect(result).not.toBe('mc_title');
        expect(result).toBe('EClawbot Mission Control');
    });

    test('French (fr) section contains arena translations', () => {
        const sandbox = {
            localStorage: { getItem: () => null, setItem: () => {} },
            navigator: { language: 'en' },
            document: {
                addEventListener: () => {},
                querySelectorAll: () => [],
                documentElement: { lang: '' }
            },
            fetch: () => Promise.resolve(),
            console,
            _result: {}
        };
        vm.createContext(sandbox);
        vm.runInContext(content + '\n_result.TRANSLATIONS = TRANSLATIONS;', sandbox);

        const fr = sandbox._result.TRANSLATIONS.fr;
        expect(fr).toBeDefined();
        expect(fr['arena_title']).toBeDefined();
        expect(fr['arena_subtitle']).toBeDefined();
        expect(fr['arena_generate']).toBeDefined();
    });
});
