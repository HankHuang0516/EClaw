/**
 * Covers the closed-allowlist CTA beacon: public pages under /portal
 * can't use pageviewMiddleware (excluded prefix), so they POST to
 * /api/analytics/cta-event which calls recordCtaEvent. An unbounded
 * `name` would let a spammer write arbitrary paths into site_page_views
 * and poison analytics — so the allowlist is load-bearing.
 */
const sp = require('../../site-pageviews');

describe('site-pageviews CTA beacon', () => {
    test('allowlist contains share-chat events', () => {
        expect(sp.isValidCtaEvent('share-chat-view')).toBe(true);
        expect(sp.isValidCtaEvent('share-chat-register-cta')).toBe(true);
    });

    test('rejects anything outside the allowlist', () => {
        for (const bad of [null, undefined, '', 'attack', '../../etc/passwd', '_cta/foo', 42, {}]) {
            expect(sp.isValidCtaEvent(bad)).toBe(false);
        }
    });

    test('recordCtaEvent is a silent no-op when pool is missing', async () => {
        await expect(sp.recordCtaEvent(null, { headers: {}, query: {} }, 'share-chat-view')).resolves.toBeUndefined();
    });

    test('recordCtaEvent writes /_cta/<name> when allowed', async () => {
        const captured = [];
        const fakePool = { query: (sql, params) => { captured.push({ sql, params }); return Promise.resolve(); } };
        const req = {
            headers: { 'user-agent': 'ua', referer: 'r' },
            query: { utm_source: 's' },
            socket: { remoteAddress: '1.2.3.4' },
        };
        await sp.recordCtaEvent(fakePool, req, 'share-chat-register-cta');
        expect(captured).toHaveLength(1);
        expect(captured[0].params[0]).toBe('/_cta/share-chat-register-cta');
        expect(captured[0].params[1]).toBe('1.2.3.4');
        expect(captured[0].params[4]).toBe('s');
    });

    test('recordCtaEvent silently drops non-allowlisted names', async () => {
        const fakePool = { query: () => { throw new Error('should not be called'); } };
        await expect(
            sp.recordCtaEvent(fakePool, { headers: {}, query: {} }, 'nope')
        ).resolves.toBeUndefined();
    });
});
