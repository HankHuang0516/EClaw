/**
 * Onboarding 5-minute quick win — static regression tests
 *
 * Protects the first-run onboarding entry point so new users can see:
 *   - a 30-second quick-win demo before setup
 *   - 3 prebuilt workflow templates
 *   - a 4-step progress indicator toward first useful result
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BACKEND_DIR = path.join(__dirname, '../..');

function read(relPath) {
    return fs.readFileSync(path.join(BACKEND_DIR, relPath), 'utf8');
}

describe('onboarding quick-win demo structure', () => {
    const html = read('public/portal/onboarding.html');

    test('renders a dedicated 30-second quick-win section before track selection', () => {
        expect(html).toMatch(/<section class="ob-quickwin" id="ob-quickwin"/);
        expect(html.indexOf('id="ob-quickwin"')).toBeGreaterThan(-1);
        expect(html.indexOf('id="ob-quickwin"')).toBeLessThan(html.indexOf('id="ob-grid"'));
        expect(html).toMatch(/data-i18n="onboarding_quickwin_badge"/);
    });

    test('offers exactly the 3 approved prebuilt workflow templates', () => {
        const templates = [...html.matchAll(/data-ob-template="([^"]+)"/g)].map(m => m[1]);
        expect(templates).toEqual(['content', 'code', 'translate']);
        expect(html).toMatch(/data-i18n="onboarding_template_content_title"/);
        expect(html).toMatch(/data-i18n="onboarding_template_code_title"/);
        expect(html).toMatch(/data-i18n="onboarding_template_translate_title"/);
    });

    test('shows a 4-step progress indicator from template to chat continuation', () => {
        const steps = [...html.matchAll(/data-ob-step="(\d+)"/g)].map(m => Number(m[1]));
        expect(steps).toEqual([1, 2, 3, 4]);
        expect(html).toMatch(/data-i18n="onboarding_progress_step1"/);
        expect(html).toMatch(/data-i18n="onboarding_progress_step4"/);
    });

    test('wires template selection, demo progress, and chat continuation state', () => {
        expect(html).toMatch(/const quickWinTemplates = \{/);
        expect(html).toMatch(/selectQuickWinTemplate\(btn\.getAttribute\('data-ob-template'\), 2\)/);
        expect(html).toMatch(/setQuickWinProgress\(4\)/);
        expect(html).toMatch(/eclaw_onboarding_quickwin_template/);
        expect(html).toMatch(/\/portal\/chat\.html\?quickWin=/);
    });
});

describe('onboarding quick-win i18n coverage', () => {
    const i18nSrc = read('public/shared/i18n.js');
    const sandbox = {
        localStorage: { getItem: () => null, setItem: () => {} },
        navigator: { language: 'en' },
        document: { addEventListener: () => {}, querySelectorAll: () => [], documentElement: { lang: '' } },
        fetch: () => Promise.resolve(),
        console,
        _result: {}
    };
    vm.createContext(sandbox);
    vm.runInContext(i18nSrc + '\n_result.TRANSLATIONS = TRANSLATIONS;', sandbox);
    const translations = sandbox._result.TRANSLATIONS;

    const requiredKeys = [
        'onboarding_quickwin_badge',
        'onboarding_quickwin_title',
        'onboarding_quickwin_desc',
        'onboarding_quickwin_eta',
        'onboarding_progress_step1',
        'onboarding_progress_step2',
        'onboarding_progress_step3',
        'onboarding_progress_step4',
        'onboarding_template_content_title',
        'onboarding_template_code_title',
        'onboarding_template_translate_title',
        'onboarding_demo_result_content',
        'onboarding_demo_result_code',
        'onboarding_demo_result_translate',
        'onboarding_quickwin_run',
        'onboarding_quickwin_continue'
    ];

    test.each(requiredKeys)('en has %s', (key) => {
        expect(translations.en[key]).toEqual(expect.any(String));
        expect(translations.en[key].length).toBeGreaterThan(0);
    });

    test.each(requiredKeys)('zh has %s', (key) => {
        expect(translations.zh[key]).toEqual(expect.any(String));
        expect(translations.zh[key].length).toBeGreaterThan(0);
    });

    test('localized quick-win titles are real translations', () => {
        expect(translations.zh.onboarding_quickwin_title).not.toBe(translations.en.onboarding_quickwin_title);
        expect(translations.zh.onboarding_template_code_title).not.toBe(translations.en.onboarding_template_code_title);
    });
});
