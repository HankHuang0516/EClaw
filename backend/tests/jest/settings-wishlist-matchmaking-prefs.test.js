/**
 * Wishlist × EClaw matchmaking SETTINGS UI (card_647fc0ba Scope A) — source-level
 * assertions that the portal settings page wires the four owner-facing controls to
 * the existing device-prefs API with the CORRECT defaults, and that the EN + zh-TW
 * (Traditional canonical) i18n keys exist. The renderer is browser code (no jsdom in
 * this test env), so we assert the load/save wiring + default semantics at source.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const settingsHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'settings.html'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'i18n.js'), 'utf8');

describe('settings — Needs-you mobile push toggle (needyou_push_enabled)', () => {
    test('renders the toggle wired to the pref, DEFAULT-ON (only explicit false opts out)', () => {
        expect(settingsHtml).toContain('id="toggleNeedyouPush"');
        expect(settingsHtml).toContain('saveNeedyouPushPref(this.checked)');
        // apply: default-on ⇒ checked unless explicitly false.
        expect(settingsHtml).toContain('prefs.needyou_push_enabled !== false');
        // save patches the exact backend key.
        expect(settingsHtml).toContain('needyou_push_enabled: !!enabled');
    });
});

describe('settings — Wishlist matchmaking card (card_647fc0ba)', () => {
    test('renders the card', () => {
        expect(settingsHtml).toContain('id="wishlistMatchmakingSettingsCard"');
        expect(settingsHtml).toContain('applyWishlistMatchmakingPrefs(prefs)');
    });

    test('participate toggle — DEFAULT OFF (opt-in only)', () => {
        expect(settingsHtml).toContain('id="toggleWishlistMatchmaking"');
        expect(settingsHtml).toContain('saveWishlistMatchmakingPref(this.checked)');
        // default OFF ⇒ checked ONLY when explicitly true.
        expect(settingsHtml).toContain('prefs.wishlist_matchmaking_enabled === true');
        expect(settingsHtml).toContain('wishlist_matchmaking_enabled: !!enabled');
    });

    test('contact-release-requires-human toggle — DEFAULT OFF (agent may consent)', () => {
        expect(settingsHtml).toContain('id="toggleContactReleaseRequiresHuman"');
        expect(settingsHtml).toContain('saveContactReleaseRequiresHumanPref(this.checked)');
        // default OFF ⇒ checked ONLY when explicitly true.
        expect(settingsHtml).toContain('prefs.contact_release_requires_human === true');
        expect(settingsHtml).toContain('contact_release_requires_human: !!enabled');
    });

    test('default-currency select — Auto option + allowlisted codes, normalised to "" when unusable', () => {
        expect(settingsHtml).toContain('id="wishlistDefaultCurrency"');
        expect(settingsHtml).toContain('saveWishlistDefaultCurrency(this.value)');
        // Auto (blank) option present + a couple of allowlisted codes.
        expect(settingsHtml).toContain('<option value="" data-i18n="wishlist_default_currency_auto">');
        expect(settingsHtml).toContain('<option value="TWD">TWD</option>');
        expect(settingsHtml).toContain('<option value="USD">USD</option>');
        expect(settingsHtml).toContain('<option value="KRW">KRW</option>');
        // Client normaliser mirrors the backend allowlist coercion (junk → '').
        expect(settingsHtml).toContain('function normalizeWishlistCurrency(value)');
        expect(settingsHtml).toContain('default_currency: normalizeWishlistCurrency(value)');
        expect(settingsHtml).toContain("const WISHLIST_CURRENCY_OPTIONS = ['TWD', 'USD', 'JPY', 'EUR', 'GBP', 'CNY', 'HKD', 'KRW', 'SGD', 'AUD', 'CAD'];");
    });

    test('load + socket paths apply the matchmaking prefs (not just the action-request ones)', () => {
        // load path
        expect(settingsHtml).toContain('applyWishlistMatchmakingPrefs(prefs);');
        // save-success path re-applies
        expect(settingsHtml).toContain('applyWishlistMatchmakingPrefs(data.prefs);');
    });
});

describe('settings — i18n EN + zh-TW (Traditional canonical) present for every new label', () => {
    const KEYS = [
        'needyou_push_label', 'needyou_push_desc',
        'wishlist_matchmaking_title', 'wishlist_matchmaking_desc',
        'wishlist_matchmaking_participate_label', 'wishlist_matchmaking_participate_desc',
        'contact_release_requires_human_label', 'contact_release_requires_human_desc',
        'wishlist_default_currency_label', 'wishlist_default_currency_desc', 'wishlist_default_currency_auto',
        'action_request_type_wishlist_trade_invite',
        'action_request_invite_item', 'action_request_invite_price', 'action_request_invite_from',
    ];
    test.each(KEYS)('key "%s" appears at least twice (en + zh)', (key) => {
        const occurrences = i18nJs.split('"' + key + '"').length - 1;
        expect(occurrences).toBeGreaterThanOrEqual(2);
    });

    test('the Traditional-Chinese consent label uses the canonical wording', () => {
        // The zh (Traditional canonical) block carries Hank's exact label wording.
        expect(i18nJs).toContain('"contact_release_requires_human_label": "聯絡釋出需真人同意"');
        expect(i18nJs).toContain('"wishlist_matchmaking_participate_label": "參與撮合"');
        expect(i18nJs).toContain('"wishlist_default_currency_label": "預設幣別"');
    });
});
