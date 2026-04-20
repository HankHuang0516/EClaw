/**
 * Onboarding Wizard (Scope 0 router) — static audit tests
 *
 * The wizard at /portal/onboarding/wizard.html is a questionnaire that collapses
 * a user's answers into one of 7 landing routes:
 *   try_free          → track1
 *   pay_premium       → track2
 *   byoc + openclaw   → track3
 *   byoc + claude     → track4
 *   byoc + hermes     → hermes placeholder
 *   benchmark         → track6
 *   just_explore      → dashboard (no tour)
 *
 * These tests guard the landing HTML, the routing table, the linkage from the
 * Scope 0 card chooser, the i18n coverage in en + zh, and the mark-complete
 * contract (track:"wizard" so backend distinguishes wizard completion from a
 * specific track walkthrough).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BACKEND_DIR = path.join(__dirname, '../..');

function read(relPath) {
    return fs.readFileSync(path.join(BACKEND_DIR, relPath), 'utf8');
}

describe('Wizard landing page exists and has expected structure', () => {
    test('wizard.html exists', () => {
        expect(fs.existsSync(path.join(BACKEND_DIR, 'public/portal/onboarding/wizard.html'))).toBe(true);
    });

    test('wizard.html loads i18n.js', () => {
        const html = read('public/portal/onboarding/wizard.html');
        expect(html).toMatch(/<script\s+src=["'][^"']*\/shared\/i18n\.js["']/);
    });

    test('wizard.html has 3 radio-group questions and a summary step', () => {
        const html = read('public/portal/onboarding/wizard.html');
        expect(html).toMatch(/name="intent"/);
        expect(html).toMatch(/name="channel"/);
        expect(html).toMatch(/name="has_key"/);
        // summary step container
        expect(html).toMatch(/data-step="4"/);
    });

    test('wizard.html exposes all expected intent options', () => {
        const html = read('public/portal/onboarding/wizard.html');
        ['try_free', 'pay_premium', 'byoc', 'benchmark', 'just_explore'].forEach(v => {
            expect(html).toMatch(new RegExp(`value="${v}"`));
        });
    });

    test('wizard.html exposes all expected channel options', () => {
        const html = read('public/portal/onboarding/wizard.html');
        ['openclaw', 'claude', 'hermes'].forEach(v => {
            expect(html).toMatch(new RegExp(`value="${v}"`));
        });
    });
});

describe('Wizard routing + state', () => {
    const html = read('public/portal/onboarding/wizard.html');

    test('TRACK_ROUTES table includes all 7 destinations', () => {
        expect(html).toMatch(/track1:\s*'\/portal\/plaza\.html\?tour=track1'/);
        expect(html).toMatch(/track2:\s*'\/portal\/community\.html\?tour=track2#rental'/);
        expect(html).toMatch(/track3:\s*'\/portal\/settings\.html\?tour=track3[^']*'/);
        expect(html).toMatch(/track4:\s*'\/portal\/env-vars\.html\?tour=track4'/);
        expect(html).toMatch(/hermes:\s*'\/portal\/onboarding\/hermes-coming-soon\.html'/);
        expect(html).toMatch(/track6:\s*'\/arena\/\?tour=track6'/);
        expect(html).toMatch(/dashboard:\s*'\/portal\/dashboard\.html'/);
    });

    test('resolveTrack maps each intent correctly', () => {
        // Locate the function block by anchors. The extracted source runs in
        // an isolated vm sandbox so any edit to wizard.html flows here.
        const start = html.indexOf('function resolveTrack(');
        expect(start).toBeGreaterThan(-1);
        // function body ends at the '}' closing the function itself — walk braces.
        const bodyStart = html.indexOf('{', start);
        let depth = 0, i = bodyStart;
        for (; i < html.length; i++) {
            if (html[i] === '{') depth++;
            else if (html[i] === '}') {
                depth--;
                if (depth === 0) break;
            }
        }
        expect(i).toBeLessThan(html.length);
        const src = html.slice(start, i + 1);

        const sandbox = {};
        vm.createContext(sandbox);
        vm.runInContext(`${src}; this.resolveTrack = resolveTrack;`, sandbox);
        const resolveTrack = sandbox.resolveTrack;

        expect(resolveTrack({ intent: 'try_free' })).toBe('track1');
        expect(resolveTrack({ intent: 'pay_premium' })).toBe('track2');
        expect(resolveTrack({ intent: 'benchmark' })).toBe('track6');
        expect(resolveTrack({ intent: 'just_explore' })).toBe('dashboard');
        expect(resolveTrack({ intent: 'byoc', channel: 'openclaw' })).toBe('track3');
        expect(resolveTrack({ intent: 'byoc', channel: 'claude' })).toBe('track4');
        expect(resolveTrack({ intent: 'byoc', channel: 'hermes' })).toBe('hermes');
        expect(resolveTrack({ intent: 'byoc' })).toBeNull();  // missing channel
        expect(resolveTrack({})).toBeNull();
        expect(resolveTrack(null)).toBeNull();
    });

    test('wizard persists answers + done flag to expected localStorage keys', () => {
        expect(html).toMatch(/eclaw_onboarding_wizard_answers/);
        expect(html).toMatch(/eclaw_onboarding_wizard_done/);
    });

    test('wizard posts mark-complete with track:"wizard"', () => {
        expect(html).toMatch(/\/api\/user\/onboarding\/mark-complete/);
        expect(html).toMatch(/track:\s*['"]wizard['"]/);
        expect(html).toMatch(/wizardTarget/);
    });
});

describe('Scope 0 landing links into wizard', () => {
    const html = read('public/portal/onboarding.html');

    test('onboarding.html has a link to wizard.html', () => {
        expect(html).toMatch(/href=["']\/portal\/onboarding\/wizard\.html["']/);
    });

    test('wizard link uses onboarding_wizard_link i18n key', () => {
        expect(html).toMatch(/data-i18n=["']onboarding_wizard_link["']/);
    });
});

describe('i18n keys for wizard are defined in en and zh', () => {
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
        'onboarding_wizard_link',
        'wizard_title',
        'wizard_hero_title',
        'wizard_hero_desc',
        'wizard_q1',
        'wizard_q1_hint',
        'wizard_q1_opt_free_title',
        'wizard_q1_opt_paid_title',
        'wizard_q1_opt_byoc_title',
        'wizard_q1_opt_benchmark_title',
        'wizard_q1_opt_explore_title',
        'wizard_q2',
        'wizard_q2_opt_openclaw_title',
        'wizard_q2_opt_claude_title',
        'wizard_q2_opt_hermes_title',
        'wizard_q3',
        'wizard_q3_opt_yes_title',
        'wizard_q3_opt_no_title',
        'wizard_q3_opt_idk_title',
        'wizard_result_title',
        'wizard_result_hint',
        'wizard_target_track1_title',
        'wizard_target_track2_title',
        'wizard_target_track3_title',
        'wizard_target_track4_title',
        'wizard_target_hermes_title',
        'wizard_target_track6_title',
        'wizard_target_dashboard_title',
        'wizard_btn_next',
        'wizard_btn_back',
        'wizard_btn_go',
        'wizard_btn_skip'
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
