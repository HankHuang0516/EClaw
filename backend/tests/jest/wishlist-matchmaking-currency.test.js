/**
 * wishlist-matchmaking CURRENCY DEFAULT (card_647fc0ba, Hank 拍板 2026-07-05).
 *
 * Proves the locale-derived currency default replaces the old hardcoded TWD and
 * follows the settled priority:
 *   ① the item's own / caller-supplied currency
 *   ② the owner's default_currency pref
 *   ③ the owner's interface-locale-derived currency (zh→TWD, en→USD, ja→JPY, ko→KRW)
 *   ④ fallback USD
 * plus: normalizeCurrency uses the SAME allowlist as wishlist-app (an unusable code
 * falls back identically on both ends), and priceCompat derives a MISSING side
 * currency from that owner's context instead of TWD (additive-only).
 */

const mm = require('../../wishlist-matchmaking');

describe('localeToCurrency map (priority ③)', () => {
    it('maps the four canonical locales (leading subtag, case-insensitive)', () => {
        expect(mm.localeToCurrency('zh')).toBe('TWD');
        expect(mm.localeToCurrency('zh-TW')).toBe('TWD');
        expect(mm.localeToCurrency('zh_Hant')).toBe('TWD');
        expect(mm.localeToCurrency('ZH')).toBe('TWD');
        expect(mm.localeToCurrency('en')).toBe('USD');
        expect(mm.localeToCurrency('en-US')).toBe('USD');
        expect(mm.localeToCurrency('ja')).toBe('JPY');
        expect(mm.localeToCurrency('ko-KR')).toBe('KRW');
    });
    it('returns "" for an absent / unrecognised locale (caller applies USD fallback)', () => {
        expect(mm.localeToCurrency('')).toBe('');
        expect(mm.localeToCurrency(null)).toBe('');
        expect(mm.localeToCurrency(undefined)).toBe('');
        expect(mm.localeToCurrency('fr')).toBe('');
        expect(mm.localeToCurrency('de-DE')).toBe('');
        expect(mm.localeToCurrency(123)).toBe('');
    });
});

describe('normalizeCurrency — allowlist-gated, no hardcoded TWD default', () => {
    it('absent → "" (NOT TWD any more)', () => {
        expect(mm.normalizeCurrency('')).toBe('');
        expect(mm.normalizeCurrency(null)).toBe('');
        expect(mm.normalizeCurrency(undefined)).toBe('');
    });
    it('allowlisted code → upper-cased; non-allowlisted → ""', () => {
        expect(mm.normalizeCurrency('twd')).toBe('TWD');
        expect(mm.normalizeCurrency(' usd ')).toBe('USD');
        expect(mm.normalizeCurrency('KRW')).toBe('KRW');
        // Not in the allowlist (even though it is 3 letters) → unusable → "".
        expect(mm.normalizeCurrency('XYZ')).toBe('');
        expect(mm.normalizeCurrency('BITCOIN')).toBe('');
        expect(mm.normalizeCurrency(42)).toBe('');
    });
    it('shares the exact allowlist with wishlist-app', () => {
        for (const c of ['TWD', 'USD', 'JPY', 'EUR', 'GBP', 'CNY', 'HKD', 'KRW', 'SGD', 'AUD', 'CAD']) {
            expect(mm.ALLOWED_CURRENCIES.has(c)).toBe(true);
        }
    });
});

describe('resolveCurrency — settled priority (item > pref > locale > USD)', () => {
    it('① item currency wins over everything', () => {
        expect(mm.resolveCurrency({ raw: 'jpy', ownerDefault: 'USD', locale: 'zh' })).toBe('JPY');
    });
    it('② owner default_currency pref wins when item currency absent/unusable', () => {
        expect(mm.resolveCurrency({ raw: '', ownerDefault: 'USD', locale: 'zh' })).toBe('USD');
        expect(mm.resolveCurrency({ raw: 'XYZ', ownerDefault: 'gbp', locale: 'zh' })).toBe('GBP');
    });
    it('③ locale-derived when item + pref both absent/unusable', () => {
        expect(mm.resolveCurrency({ raw: '', ownerDefault: '', locale: 'zh-TW' })).toBe('TWD');
        expect(mm.resolveCurrency({ raw: '', ownerDefault: 'NOPE', locale: 'ja' })).toBe('JPY');
        expect(mm.resolveCurrency({ raw: '', ownerDefault: '', locale: 'ko' })).toBe('KRW');
    });
    it('④ USD fallback when nothing resolves', () => {
        expect(mm.resolveCurrency({ raw: '', ownerDefault: '', locale: '' })).toBe('USD');
        expect(mm.resolveCurrency({ raw: '', ownerDefault: '', locale: 'fr' })).toBe('USD');
        expect(mm.resolveCurrency({})).toBe('USD');
    });
});

describe('priceCompat — locale-derived default for a missing side currency (additive-only)', () => {
    it('both prices, both currencies ABSENT but SAME locale ⇒ same derived currency ⇒ compares', () => {
        // buyerMax 100 >= sellerAsk 80, both derive TWD from zh locale ⇒ compatible.
        const d = mm.priceCompat({
            buyerMaxPrice: 100, sellerAskPrice: 80,
            buyerLocale: 'zh', sellerLocale: 'zh',
        });
        expect(d).toEqual({ compatible: true, reason: 'price_compatible' });
    });
    it('both prices same derived currency but buyerMax < sellerAsk ⇒ INCOMPATIBLE (still filters)', () => {
        const d = mm.priceCompat({
            buyerMaxPrice: 50, sellerAskPrice: 80,
            buyerDefaultCurrency: 'USD', sellerDefaultCurrency: 'USD',
        });
        expect(d).toEqual({ compatible: false, reason: 'price_incompatible' });
    });
    it('different derived currencies ⇒ currency_mismatch_fallback (no FX, never blocks)', () => {
        // buyer derives TWD (zh), seller derives JPY (ja) ⇒ cannot compare ⇒ fallback.
        const d = mm.priceCompat({
            buyerMaxPrice: 100, sellerAskPrice: 80,
            buyerLocale: 'zh', sellerLocale: 'ja',
        });
        expect(d).toEqual({ compatible: true, reason: 'currency_mismatch_fallback' });
    });
    it('missing price on either side ⇒ name-only fallback (unchanged)', () => {
        expect(mm.priceCompat({ sellerAskPrice: 80, sellerLocale: 'zh' }))
            .toEqual({ compatible: true, reason: 'no_price_fallback' });
    });
    it('explicit item currency still overrides the derived default', () => {
        // Both sides explicitly JPY ⇒ compare directly regardless of locale.
        const d = mm.priceCompat({
            buyerMaxPrice: 100, buyerCurrency: 'JPY',
            sellerAskPrice: 80, sellerCurrency: 'JPY',
            buyerLocale: 'zh', sellerLocale: 'en',
        });
        expect(d).toEqual({ compatible: true, reason: 'price_compatible' });
    });
});
