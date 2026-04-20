/**
 * Onboarding Tour (Track 1: Free/Official Bot Rental) — static audit tests
 *
 * Verifies the product tour infrastructure is wired across pages:
 *   - Scope 0 wizard redirects Track 1 to /portal/plaza.html?tour=track1
 *   - plaza.html stub redirects to community.html
 *   - community.html, settings.html, dashboard.html all load product-tour.js
 *   - product-tour.js parses and exposes ProductTour globals
 *   - i18n.js defines the 5 callout keys + skip/next/finish in en + zh
 *   - /api/user/onboarding/mark-complete endpoint handler exists in index.js
 *
 * Regression protection: ensures the tour never silently breaks across a refactor.
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

describe('Onboarding Track 1 tour — files exist', () => {
    test('product-tour.js exists', () => {
        expect(fs.existsSync(path.join(PORTAL_DIR, 'shared/product-tour.js'))).toBe(true);
    });

    test('plaza.html stub exists', () => {
        expect(fs.existsSync(path.join(PORTAL_DIR, 'plaza.html'))).toBe(true);
    });
});

describe('Scope 0 wizard routes to plaza with tour param', () => {
    const html = read('public/portal/onboarding.html');

    test("trackRoutes['1'] points to plaza.html?tour=track1", () => {
        expect(html).toMatch(/'1':\s*'\/portal\/plaza\.html\?tour=track1'/);
    });

    test("trackRoutes['2'] points to community.html?tour=track2", () => {
        expect(html).toMatch(/'2':\s*'\/portal\/community\.html\?tour=track2[^']*'/);
    });
});

describe('plaza.html redirects to community.html preserving query', () => {
    const html = read('public/portal/plaza.html');

    test('has meta refresh to community.html', () => {
        expect(html).toMatch(/http-equiv="refresh"[^>]*community\.html/);
    });

    test('JS redirect preserves search params', () => {
        expect(html).toMatch(/community\.html/);
        expect(html).toMatch(/searchParams\.forEach/);
    });
});

describe('Product tour script is loaded on tour pages', () => {
    const pages = ['community.html', 'settings.html', 'dashboard.html', 'wallet.html', 'my-rentals.html'];
    test.each(pages)('%s loads shared/product-tour.js', (page) => {
        const html = read(`public/portal/${page}`);
        expect(html).toMatch(/<script\s+src=["'][^"']*product-tour\.js["']/);
    });
});

describe('product-tour.js parses and exports ProductTour API', () => {
    const src = read('public/portal/shared/product-tour.js');

    test('parses without syntax errors', () => {
        expect(() => new vm.Script(src, { filename: 'product-tour.js' })).not.toThrow();
    });

    test('exposes ProductTour globals (register/start/goTo/isDone/markDone)', () => {
        const sandbox = {
            window: {},
            document: { createElement: () => ({ appendChild: () => {} }), head: { appendChild: () => {} }, body: { appendChild: () => {} } },
            localStorage: { getItem: () => null, setItem: () => {} },
            console,
            setTimeout,
            setInterval
        };
        sandbox.global = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(src, sandbox);
        const pt = sandbox.window.ProductTour;
        expect(pt).toBeDefined();
        ['register', 'start', 'goTo', 'next', 'dismiss', 'isDone', 'markDone', 'getState'].forEach(k => {
            expect(typeof pt[k]).toBe('function');
        });
    });
});

describe('i18n keys for tour callouts are defined in en and zh', () => {
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
        'onboarding_tour_track1_step1',
        'onboarding_tour_track1_step2',
        'onboarding_tour_track1_step3',
        'onboarding_tour_track1_step4',
        'onboarding_tour_track1_step5',
        'onboarding_tour_track2_step1',
        'onboarding_tour_track2_step2',
        'onboarding_tour_track2_step3',
        'onboarding_tour_track2_step4',
        'onboarding_tour_track2_step5',
        'onboarding_tour_next',
        'onboarding_tour_finish',
        'onboarding_tour_skip'
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

describe('Backend /api/user/onboarding/mark-complete endpoint', () => {
    const indexSrc = read('index.js');

    test('index.js registers POST /api/user/onboarding/mark-complete', () => {
        expect(indexSrc).toMatch(/app\.post\(\s*['"]\/api\/user\/onboarding\/mark-complete['"]/);
    });

    test('device-preferences.js exposes setOnboarding', () => {
        const prefsSrc = read('device-preferences.js');
        expect(prefsSrc).toMatch(/setOnboarding/);
        expect(prefsSrc).toMatch(/module\.exports\s*=\s*\{[^}]*setOnboarding/);
    });
});

describe('Tour calls site integration', () => {
    test('community.html registers track1 tour with 3 steps', () => {
        const html = read('public/portal/community.html');
        expect(html).toMatch(/ProductTour\.register\(\s*['"]track1['"]/);
        expect(html).toMatch(/onboarding_tour_track1_step1/);
        expect(html).toMatch(/onboarding_tour_track1_step2/);
        expect(html).toMatch(/onboarding_tour_track1_step3/);
    });

    test('settings.html hosts step 4 and navigates to dashboard step 5', () => {
        const html = read('public/portal/settings.html');
        expect(html).toMatch(/onboarding_tour_track1_step4/);
        expect(html).toMatch(/\/portal\/dashboard\.html\?tour=track1&step=5/);
    });

    test('dashboard.html hosts step 5 and calls mark-complete API', () => {
        const html = read('public/portal/dashboard.html');
        expect(html).toMatch(/onboarding_tour_track1_step5/);
        expect(html).toMatch(/\/api\/user\/onboarding\/mark-complete/);
    });

    test('community.html registers track2 tour with 3 steps', () => {
        const html = read('public/portal/community.html');
        expect(html).toMatch(/ProductTour\.register\(\s*['"]track2['"]/);
        expect(html).toMatch(/onboarding_tour_track2_step1/);
        expect(html).toMatch(/onboarding_tour_track2_step2/);
        expect(html).toMatch(/onboarding_tour_track2_step3/);
        expect(html).toMatch(/\/portal\/wallet\.html\?tour=track2&step=4/);
    });

    test('wallet.html hosts track2 step 4 and navigates to my-rentals step 5', () => {
        const html = read('public/portal/wallet.html');
        expect(html).toMatch(/onboarding_tour_track2_step4/);
        expect(html).toMatch(/\/portal\/my-rentals\.html\?tour=track2&step=5/);
    });

    test('my-rentals.html hosts track2 step 5 and calls mark-complete with track:"track2"', () => {
        const html = read('public/portal/my-rentals.html');
        expect(html).toMatch(/onboarding_tour_track2_step5/);
        expect(html).toMatch(/\/api\/user\/onboarding\/mark-complete/);
        expect(html).toMatch(/track:\s*['"]track2['"]/);
    });
});
