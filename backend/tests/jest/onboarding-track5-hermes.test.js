/**
 * Onboarding Track 5 — Hermes channel Coming Soon placeholder — static audit tests
 *
 * Verifies the Track 5 placeholder is wired:
 *   - /portal/onboarding/hermes-coming-soon.html exists and loads i18n.js
 *   - onboarding.html routes Track 5 to the placeholder page (no longer disabled)
 *   - Placeholder sets the `eclaw_tour_track5_seen` localStorage flag
 *   - Required i18n keys exist in en + zh
 *
 * Regression protection: static audit so the placeholder doesn't silently regress
 * before the real Hermes integration ships.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_DIR = path.join(__dirname, '../../public');
const PORTAL_DIR = path.join(PUBLIC_DIR, 'portal');
const BACKEND_DIR = path.join(__dirname, '../..');

function read(relPath) {
    return fs.readFileSync(path.join(BACKEND_DIR, relPath), 'utf8');
}

describe('Track 5 Hermes placeholder file exists', () => {
    test('hermes-coming-soon.html exists under /portal/onboarding/', () => {
        const p = path.join(PORTAL_DIR, 'onboarding/hermes-coming-soon.html');
        expect(fs.existsSync(p)).toBe(true);
    });
});

describe('hermes-coming-soon.html structure', () => {
    const html = read('public/portal/onboarding/hermes-coming-soon.html');

    test('has i18n title tag', () => {
        expect(html).toMatch(/data-i18n="hermes_coming_soon_title"/);
    });

    test('loads i18n.js', () => {
        expect(html).toMatch(/<script\s+src=["'][^"']*i18n\.js["']/);
    });

    test('sets eclaw_tour_track5_seen localStorage flag', () => {
        expect(html).toMatch(/eclaw_tour_track5_seen/);
        expect(html).toMatch(/localStorage\.setItem\(\s*SEEN_KEY\s*,\s*['"]1['"]/);
    });

    test('has back-to-wizard link', () => {
        expect(html).toMatch(/href="\/portal\/onboarding\.html"/);
    });

    test('has notify-me button (mailto placeholder)', () => {
        expect(html).toMatch(/href="mailto:[^"]*"/);
        expect(html).toMatch(/data-i18n="hermes_coming_soon_notify_btn"/);
    });
});

describe('onboarding.html wires Track 5 to placeholder page', () => {
    const html = read('public/portal/onboarding.html');

    test('Track 5 card links to hermes-coming-soon.html', () => {
        expect(html).toMatch(/href="\/portal\/onboarding\/hermes-coming-soon\.html"\s+data-track="5"/);
    });

    test('Track 5 card is no longer data-disabled', () => {
        expect(html).not.toMatch(/data-track="5"\s+data-disabled="true"/);
    });

    test("trackRoutes['5'] points to hermes-coming-soon.html", () => {
        expect(html).toMatch(/'5':\s*'\/portal\/onboarding\/hermes-coming-soon\.html'/);
    });
});

describe('Track 5 i18n keys defined in en + zh', () => {
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
    const T = sandbox._result.TRANSLATIONS;

    const requiredKeys = [
        'hermes_coming_soon_title',
        'hermes_coming_soon_badge',
        'hermes_coming_soon_desc',
        'hermes_coming_soon_notify_btn',
        'hermes_coming_soon_back_wizard',
        'hermes_coming_soon_explore'
    ];

    test.each(requiredKeys)('en has %s', (key) => {
        expect(T.en[key]).toBeDefined();
        expect(T.en[key]).toEqual(expect.any(String));
        expect(T.en[key].length).toBeGreaterThan(0);
    });

    test.each(requiredKeys)('zh has %s', (key) => {
        expect(T.zh[key]).toBeDefined();
        expect(T.zh[key]).toEqual(expect.any(String));
        expect(T.zh[key].length).toBeGreaterThan(0);
    });

    test('zh translations differ from en (real translation, not copy)', () => {
        for (const key of requiredKeys) {
            expect(T.zh[key]).not.toBe(T.en[key]);
        }
    });
});
