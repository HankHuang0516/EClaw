/**
 * growth-tracking.js — lightweight signup attribution helpers.
 *
 * Canonical frontend source for signup_source attribution. Pages can pass the
 * returned value as `signupSource` to /api/auth/register; backend auth routes
 * still normalize and validate the final source.
 */
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.EClawGrowthTracking = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function safeLocalStorageGet(key) {
        try { return localStorage.getItem(key); } catch (_) { return null; }
    }

    function normalizeSource(value, fallback) {
        const raw = (typeof value === 'string' ? value : '').trim().toLowerCase();
        const normalized = raw
            .replace(/\s+/g, '_')
            .replace(/[^a-z0-9._:-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^[-_.:]+|[-_.:]+$/g, '')
            .slice(0, 64);
        return normalized || fallback || 'web_portal';
    }

    function getParams(search) {
        try { return new URLSearchParams(search || (typeof window !== 'undefined' ? window.location.search : '')); }
        catch (_) { return new URLSearchParams(''); }
    }

    function collectSignupSource(options) {
        options = options || {};
        const params = getParams(options.search);
        const fallback = options.fallback || 'web_portal';
        const explicit = options.source || params.get('signup_source') || params.get('signupSource') || params.get('source');
        const utmSource = options.utmSource || params.get('utm_source') || params.get('utmSource');
        const inviteCode = options.inviteCode || params.get('code') || params.get('invite') || params.get('invite_code') || safeLocalStorageGet('pendingInviteCode');

        if (explicit) return normalizeSource(explicit, fallback);
        if (utmSource) return normalizeSource('utm:' + utmSource, fallback);
        if (inviteCode) return 'invite';
        return normalizeSource(fallback, 'web_portal');
    }


    function getUtmParams() {
        const params = getParams();
        return {
            utm_source: params.get('utm_source') || params.get('utmSource') || null,
            utm_medium: params.get('utm_medium') || params.get('utmMedium') || null,
            utm_campaign: params.get('utm_campaign') || params.get('utmCampaign') || null,
            utm_content: params.get('utm_content') || params.get('utmContent') || null,
            utm_term: params.get('utm_term') || params.get('utmTerm') || null,
            source: params.get('source') || null,
            channel: params.get('channel') || null,
        };
    }

    return {
        collectSignupSource,
        normalizeSource,
        getUtmParams
    };
}));
