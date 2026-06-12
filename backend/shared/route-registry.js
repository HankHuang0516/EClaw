/* global window */
/**
 * Canonical route registry — docs/redirect-state-machine-spec.md §2.
 * Card: card_14571f26914b9c1eae148362 (OODA-R Phase 2 #7, Phase A).
 *
 * The single source of truth for every logical navigation target. URL shapes
 * intentionally match the CURRENT page consumers (per #6 review amendment 1):
 * kanban's `?card=<id>#<id>` hash handler, chat's `?contact=<publicCode>`
 * shareable-link param, mission's `?note=`, and the `/p/:publicCode` route.
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
    dashboard: { web: '/portal/dashboard.html',                     params: [],             sensitive: false },
    chat:      { web: '/portal/chat.html?contact={publicCode}',     params: ['publicCode'], sensitive: false },
    card:      { web: '/portal/kanban.html?card={cardId}#{cardId}', params: ['cardId'],     sensitive: true },
    note:      { web: '/portal/mission.html?note={noteId}',         params: ['noteId'],     sensitive: true },
    profile:   { web: '/p/{publicCode}',                            params: ['publicCode'], sensitive: false },
    settings:  { web: '/portal/settings.html',                      params: [],             sensitive: false },
};

const PARAM_RE = {
    cardId:     /^card_[a-zA-Z0-9]{6,32}$/,
    noteId:     /^[a-zA-Z0-9_-]{1,64}$/,
    publicCode: /^[a-z0-9]{6}$/,
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
    return { ok: true };
}

/** Build the web URL (path + query/hash) for a target. Throws on invalid input. */
function buildWebUrl(target, params) {
    const check = validateParams(target, params);
    if (!check.ok) throw new Error('buildWebUrl: ' + check.error);
    let url = ROUTES[target].web;
    for (const name of ROUTES[target].params) {
        url = url.split('{' + name + '}').join(encodeURIComponent(String(params[name])));
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
    const qs = new URLSearchParams();
    for (const name of ROUTES[target].params) qs.set(name, String(params[name]));
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
