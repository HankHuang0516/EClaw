/**
 * Channel API is key-only, and every place that tells a user how to set it up
 * must say so.
 *
 * Regression for feedback #1547 / issue #5505: the setup guide
 * still promised "a Key + Secret pair — the Secret is only shown once" while
 * Settings → Channel API shows only the key (channel auth has been key-only
 * since "simplify auth to API key only"). A user kept generating keys looking
 * for the Secret that the guide told them to copy.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_DIR = path.join(__dirname, '../../public');
const REPO_ROOT = path.join(__dirname, '../../..');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

function loadTranslations() {
    const sandbox = {
        localStorage: { getItem: () => null, setItem: () => {} },
        navigator: { language: 'en' },
        document: { addEventListener: () => {}, querySelectorAll: () => [], documentElement: { lang: '' } },
        fetch: () => Promise.resolve(),
        console,
        _result: {},
    };
    vm.createContext(sandbox);
    vm.runInContext(read(PUBLIC_DIR, 'shared/i18n.js') + '\n_result.TRANSLATIONS = TRANSLATIONS;', sandbox);
    return sandbox._result.TRANSLATIONS;
}

// "Key + Secret", "API Key/Secret", "Clé + Secret", "Kunci + Rahsia", "Schlüsselpaar", "only shown once"…
const PROMISES_A_SECRET = /(?:Key|Clé|Clave|Kunci|Schlüssel)\s*(?:API\s*)?[+/]\s*(?:Secret|Rahsia)|Schlüsselpaar|only shown once|只顯示一次|只显示一次|一度しか表示|한 번만 표시/i;

describe('Settings → Channel API panel', () => {
    const html = read(PUBLIC_DIR, 'portal/settings.html');
    const card = html.slice(html.indexOf('id="channelApiCard"'), html.indexOf('id="channelCopyToast"'));

    test('the card is found', () => {
        expect(card.length).toBeGreaterThan(200);
    });

    test('says the key is the only credential, in a translatable string', () => {
        expect(card).toContain('data-i18n="settings_channel_api_desc"');
        expect(card).toContain('data-i18n="settings_channel_key_only_hint"');
        expect(card).toContain('data-i18n="settings_channel_new_key_title"');
    });

    test('does not call the key a "key pair"', () => {
        expect(card).not.toMatch(/key pair/i);
    });

    test('the "+ New Key" button keeps its translated label after generating', () => {
        const fn = html.slice(html.indexOf('async function generateChannelKey()'), html.indexOf('async function copyAccountKeys('));
        expect(fn).toContain("i18n.t('common_new_key')");
    });
});

describe('OpenClaw channel guide (info.html)', () => {
    const html = read(PUBLIC_DIR, 'portal/info.html');
    const start = html.indexOf('data-i18n="guide_channel_h2_3"');
    const end = html.indexOf('id="guide-claude-code-channel"');
    const guide = html.slice(start, end);

    test('the guide section is found', () => {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
    });

    test('does not tell the user to copy a Secret', () => {
        expect(guide).not.toMatch(PROMISES_A_SECRET);
        expect(guide).not.toContain('channel_api_secret');
        expect(guide).not.toContain('ecs_');
    });

    test('says the key is enough', () => {
        expect(guide).toContain('eck_');
        expect(guide).toContain('不需要 Secret');
    });
});

describe('translations', () => {
    const T = loadTranslations();
    const locales = Object.keys(T).filter(l => T[l] && typeof T[l] === 'object' && T[l].guide_channel_p_3);

    test('every full locale carries the guide step', () => {
        expect(locales.length).toBeGreaterThanOrEqual(15);
    });

    test.each(locales)('%s: step 1 and the FAQ do not promise a Secret', locale => {
        expect(T[locale].guide_channel_p_3).not.toMatch(PROMISES_A_SECRET);
        expect(T[locale].guide_channel_p_3).toContain('eck_');
        expect(T[locale].guide_channel_p_faq1_a).not.toMatch(PROMISES_A_SECRET);
    });

    test.each(locales)('%s: the settings panel strings exist', locale => {
        for (const key of ['settings_channel_api_desc', 'settings_channel_new_key_title', 'settings_channel_key_only_hint']) {
            expect(typeof T[locale][key]).toBe('string');
            expect(T[locale][key].length).toBeGreaterThan(5);
        }
        expect(T[locale].settings_channel_key_only_hint).toContain('Secret');
    });
});

describe('server contract the wording relies on', () => {
    const source = read(__dirname, '../../channel-api.js');
    const auth = source.slice(source.indexOf('async function channelAuth('), source.indexOf('// GET /provision'));

    test('a request with only the API key is accepted', () => {
        // the secret is compared only when the caller sent one
        expect(auth).toMatch(/if \(apiSecret && !safeEqual\(account\.channel_api_secret, apiSecret\)\)/);
        expect(auth).not.toMatch(/channel_api_secret required/);
    });
});

describe('OpenClaw plugin README', () => {
    const readme = read(REPO_ROOT, 'openclaw-channel-eclaw/README.md');
    const setup = readme.slice(0, readme.indexOf('## How It Works'));

    test('the config sample and the credential steps need only the key', () => {
        expect(setup).toContain('apiKey: "eck_..."');
        expect(setup).not.toMatch(/^\s*apiSecret:/m);
        expect(setup).not.toMatch(/Copy your `API Key`.*and `API Secret`/);
    });
});
