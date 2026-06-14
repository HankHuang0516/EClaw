/* global window */
/**
 * Canonical route registry — docs/redirect-state-machine-spec.md §2.
 * Cards: card_14571f26914b9c1eae148362 (Phase A) + card_125161f56080b1d7df597f6f (Phase D).
 *
 * The single source of truth for every logical navigation target. URL shapes
 * intentionally match the CURRENT page consumers (per #6 review amendment 1):
 * kanban's `?card=<id>#<id>` hash handler, chat's `?contact=<publicCode>`
 * shareable-link param, mission's `?note=`, and the `/p/:publicCode` route.
 *
 * Phase D (2026-06-14) added the proof-slice migration targets per
 * docs/smart-router-spec.md §4: wallet / my-rentals (+ optional rentalId) /
 * invite / files / petdx plain routes, chat-mention / chat-msg sub-routes for
 * kanban→chat hops, and settings-agent-policy sub-route for the dashboard
 * agent-policy editor hop.
 *
 * Used by: backend/redirect-router.js (Phase A) AND the portal-side
 * SmartRouter (docs/smart-router-spec.md), which consumes this very file in
 * the browser via the `/shared-core/route-registry.js` static mount — single
 * URL SoT, no drift. The UMD tail below exposes `window.EClawRouteRegistry`
 * in the browser while keeping `module.exports` for Node; keep this file
 * dependency-free so it serves verbatim.
 */
'use strict';

// sensitive: deep link pre-selects private context → requires HMAC sig (spec §3)
const ROUTES = {
    dashboard:    { web: '/portal/dashboard.html',                     params: [],             sensitive: false },
    chat:         { web: '/portal/chat.html?contact={publicCode}',     params: ['publicCode'], sensitive: false },
    card:         { web: '/portal/kanban.html?card={cardId}#{cardId}', params: ['cardId'],     sensitive: true  },
    note:         { web: '/portal/mission.html?note={noteId}',         params: ['noteId'],     sensitive: true  },
    profile:      { web: '/p/{publicCode}',                            params: ['publicCode'], sensitive: false },
    settings:     { web: '/portal/settings.html',                      params: [],             sensitive: false },

    // Phase D — sub-routes for chat context hops (kanban → chat with mention/msg)
    'chat-mention': { web: '/portal/chat.html?mention={mention}',      params: ['mention'],    sensitive: false },
    'chat-msg':     { web: '/portal/chat.html?msg={msg}',              params: ['msg'],        sensitive: false },

    // Phase D — settings sub-section deep-link (dashboard → agent policy editor)
    'settings-agent-policy': {
        web:    '/portal/settings.html?agentPolicy=1&scope={scope}&entityId={entityId}&channel={channel}#agent-policy',
        params: ['scope', 'entityId', 'channel'],
        sensitive: true
    },

    // Phase D — plain destinations (no required params; settings card grid + dashboard)
    wallet:       { web: '/portal/wallet.html',                        params: [],             sensitive: false },
    'my-rentals': { web: '/portal/my-rentals.html',                    params: [], optionalParams: ['rentalId'], sensitive: false },
    invite:       { web: '/portal/invite.html',                        params: [],             sensitive: false },
    files:        { web: '/portal/files.html',                         params: [],             sensitive: false },
    petdx:        { web: '/portal/petdx-browser.html',                 params: [],             sensitive: false },
};

const PARAM_RE = {
    cardId:     /^card_[a-zA-Z0-9]{6,32}$/,
    noteId:     /^[a-zA-Z0-9_-]{1,64}$/,
    publicCode: /^[a-z0-9]{6}$/,

    // Phase D — sub-route params
    mention:    /^[a-z0-9]{6}$/,                 // publicCode of mentioned entity (same shape)
    msg:        /^[a-zA-Z0-9_-]{1,64}$/,         // chat message id
    scope:      /^(device|entity)$/,             // agent-policy scope
    entityId:   /^\d{1,4}$/,                     // numeric entity id (0..9999)
    channel:    /^[a-z][a-z0-9_-]{0,40}$/,       // channel slug

    // Phase D — optional param
    rentalId:   /^[a-zA-Z0-9_-]{1,64}$/,         // rental contract id
};

function isKnownTarget(target) {
    return Object.prototype.hasOwnProperty.call(ROUTES, target);
}

/** Validate params against the target's declared list + per-param regex. */
function validateParams(target, params) {
    if (!isKnownTarget(target)) return { ok: false, error: 'unknown_target' };
    const route = ROUTES[target];
    params = params || {};
    for (const name of route.params) {
        const v = params[name];
        if (v === undefined || v === null || v === '') return { ok: false, error: 'missing_param:' + name };
        if (PARAM_RE[name] && !PARAM_RE[name].test(String(v))) return { ok: false, error: 'invalid_param:' + name };
    }
    // Optional params — if provided, must satisfy the regex; absent is fine.
    if (Array.isArray(route.optionalParams)) {
        for (const name of route.optionalParams) {
            const v = params[name];
            if (v === undefined || v === null || v === '') continue;
            if (PARAM_RE[name] && !PARAM_RE[name].test(String(v))) return { ok: false, error: 'invalid_param:' + name };
        }
    }
    return { ok: true };
}

/** Build the web URL (path + query/hash) for a target. Throws on invalid input. */
function buildWebUrl(target, params) {
    const check = validateParams(target, params);
    if (!check.ok) throw new Error('buildWebUrl: ' + check.error);
    const route = ROUTES[target];
    let url = route.web;
    for (const name of route.params) {
        url = url.split('{' + name + '}').join(encodeURIComponent(String(params[name])));
    }
    // Append optional params (validated above) preserving any existing query/hash.
    if (Array.isArray(route.optionalParams)) {
        const extras = [];
        for (const name of route.optionalParams) {
            const v = params[name];
            if (v === undefined || v === null || v === '') continue;
            extras.push(encodeURIComponent(name) + '=' + encodeURIComponent(String(v)));
        }
        if (extras.length) {
            const hashIdx = url.indexOf('#');
            const headEnd = hashIdx >= 0 ? hashIdx : url.length;
            const hasQuery = url.slice(0, headEnd).indexOf('?') >= 0;
            const sep = hasQuery ? '&' : '?';
            const head = url.slice(0, headEnd);
            const tail = hashIdx >= 0 ? url.slice(hashIdx) : '';
            url = head + sep + extras.join('&') + tail;
        }
    }
    return url;
}

/**
 * Build the universal /r/ entry URL (spec §3). Unsigned form — the caller
 * (redirect-router's mint endpoint) appends sig/exp for sensitive targets.
 */
function buildUniversalUrl(target, params, traceId) {
    const check = validateParams(target, params);
    if (!check.ok) throw new Error('buildUniversalUrl: ' + check.error);
    const route = ROUTES[target];
    const qs = new URLSearchParams();
    for (const name of route.params) qs.set(name, String(params[name]));
    if (Array.isArray(route.optionalParams)) {
        for (const name of route.optionalParams) {
            const v = params && params[name];
            if (v === undefined || v === null || v === '') continue;
            qs.set(name, String(v));
        }
    }
    if (traceId) qs.set('traceId', traceId);
    const q = qs.toString();
    return '/r/' + encodeURIComponent(target) + (q ? '?' + q : '');
}

/**
 * Validate a return_to value against the registry (spec §4): must be a
 * same-origin relative URL whose path is either a registered web path or
 * the /r/ entry. Never an open redirect.
 */
function isSafeReturnTo(value) {
    if (typeof value !== 'string' || !value.startsWith('/')) return false;
    if (value.startsWith('//')) return false; // protocol-relative escape
    const path = value.split(/[?#]/)[0];
    if (path === '/r' || path.startsWith('/r/')) return true;
    return Object.values(ROUTES).some(r => r.web.split(/[?#]/)[0] === path);
}

const _api = {
    ROUTES,
    isKnownTarget,
    validateParams,
    buildWebUrl,
    buildUniversalUrl,
    isSafeReturnTo,
};

// UMD tail: CJS for Node (redirect-router), global for the browser (SmartRouter).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = _api;
}
if (typeof window !== 'undefined') {
    window.EClawRouteRegistry = _api;
}
