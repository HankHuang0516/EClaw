/**
 * refs-popover.js — `?` icon bidirectional references popover.
 *
 * Spec: docs/specs/portal-bidirectional-refs.md (PR #3124 + #3131).
 *
 * Usage:
 *   <button class="eclaw-refs-icon" data-refs-from="card_aa15ed26..."
 *           aria-label="Show related cards, specs, and PRs">ⓘ</button>
 *
 *   On click: GET /api/refs?from=<id> → render popover anchored on the icon.
 *   Content is two sections — Outgoing (this cites) + Incoming (cited by).
 *
 *   Reuses shared/help-popover.js for show/hide/focus-trap/ESC plumbing.
 *   Adds `variant: 'sheet'` automatically on mobile (≤720 px).
 *
 * Public API (window.RefsPopover):
 *   - init():            re-bind newly-added .eclaw-refs-icon elements
 *   - open(anchor):      open popover programmatically for a given icon
 *   - close():           close the popover
 */
(function () {
    'use strict';

    const ICON_CLASS = 'eclaw-refs-icon';
    const MOBILE_BREAKPOINT = 720;
    const DESKTOP_MAX_WIDTH = 360;
    const REFS_ENDPOINT = '/api/refs';

    // ── Auth ──────────────────────────────────────────────────────────────────
    // Matches the kanban portal convention: `window.currentUser.deviceId /
    // deviceSecret / entityId` is the canonical source set by shared/auth.js.
    // Test stubs may inject `window.deviceState` instead.
    function readCreds() {
        try {
            const cu = window.currentUser || {};
            const ds = window.deviceState || {};
            return {
                deviceId: cu.deviceId || ds.deviceId || null,
                deviceSecret: cu.deviceSecret || ds.deviceSecret || null,
                botSecret: cu.botSecret || ds.botSecret || null,
                entityId: cu.entityId ?? ds.entityId ?? null,
            };
        } catch (_) {
            return { deviceId: null, deviceSecret: null, botSecret: null, entityId: null };
        }
    }

    // ── i18n shim ─────────────────────────────────────────────────────────────
    function t(key, fallback) {
        try {
            if (window.i18n && typeof window.i18n.t === 'function') {
                const v = window.i18n.t(key);
                if (v && v !== key) return v;
            }
        } catch (_) {}
        return fallback;
    }

    // ── Icon glyphs by kind ───────────────────────────────────────────────────
    const KIND_GLYPH = {
        card:  '📋',
        spec:  '📄',
        doc:   '📘',
        pr:    '🔀',
    };

    function navHrefFor(ref) {
        switch (ref.kind) {
            case 'card':
                return `/portal/kanban.html#${encodeURIComponent(ref.id)}`;
            case 'spec':
            case 'doc':
                // Source-view fallback while portal/docs.html doesn't exist (per #6 scope).
                return `https://github.com/HankHuang0516/EClaw/blob/main/${ref.id}`;
            case 'pr':
                return `https://github.com/HankHuang0516/EClaw/pull/${ref.id}`;
            default:
                return '#';
        }
    }

    // ── Render ────────────────────────────────────────────────────────────────
    function renderRow(ref, fromId) {
        const li = document.createElement('li');
        li.className = ICON_CLASS + '-row';
        li.setAttribute('data-ref-kind', ref.kind);

        const glyph = document.createElement('span');
        glyph.className = ICON_CLASS + '-glyph';
        glyph.textContent = KIND_GLYPH[ref.kind] || '🔗';
        glyph.setAttribute('aria-hidden', 'true');

        const link = document.createElement('a');
        link.className = ICON_CLASS + '-link';
        link.href = navHrefFor(ref);
        if (ref.kind === 'pr' || ref.kind === 'spec' || ref.kind === 'doc') {
            // Cross-origin (github) opens in new tab so we don't navigate away.
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
        }
        link.dataset.refFrom = fromId;
        link.dataset.refKind = ref.kind;
        link.dataset.refId = ref.id;

        const label = ref.label || ref.id;
        link.textContent = label;
        link.title = `${ref.kind}: ${ref.id}`;

        li.appendChild(glyph);
        li.appendChild(link);
        return li;
    }

    function renderPopover(payload) {
        const wrap = document.createElement('div');
        wrap.className = ICON_CLASS + '-popover';

        const fromId = payload?.from?.id || '?';
        const fromKind = payload?.from?.kind || 'item';
        const fromLabel = payload?.from?.label || fromId;

        const header = document.createElement('div');
        header.className = ICON_CLASS + '-header';
        const title = document.createElement('h3');
        title.className = ICON_CLASS + '-title';
        title.textContent = t('refs.popover_title', 'References');
        const subtitle = document.createElement('div');
        subtitle.className = ICON_CLASS + '-subtitle';
        subtitle.textContent = `${fromKind}: ${fromLabel}`;
        subtitle.title = fromId;
        header.appendChild(title);
        header.appendChild(subtitle);
        wrap.appendChild(header);

        const refs = Array.isArray(payload?.refs) ? payload.refs : [];
        const outRefs = refs.filter(r => r.direction === 'out');
        const inRefs  = refs.filter(r => r.direction === 'in');

        const buildSection = (label, items) => {
            const sec = document.createElement('section');
            sec.className = ICON_CLASS + '-section';
            const h = document.createElement('h4');
            h.className = ICON_CLASS + '-section-title';
            h.textContent = label;
            sec.appendChild(h);
            if (!items.length) {
                const empty = document.createElement('p');
                empty.className = ICON_CLASS + '-empty';
                empty.textContent = t('refs.empty', 'No related items yet.');
                sec.appendChild(empty);
            } else {
                const ul = document.createElement('ul');
                ul.className = ICON_CLASS + '-list';
                for (const r of items) ul.appendChild(renderRow(r, fromId));
                sec.appendChild(ul);
            }
            return sec;
        };

        wrap.appendChild(buildSection(t('refs.section_out', 'This cites'), outRefs));
        wrap.appendChild(buildSection(t('refs.section_in', 'Cited by'), inRefs));
        return wrap;
    }

    function renderError() {
        const el = document.createElement('div');
        el.className = ICON_CLASS + '-error';
        el.textContent = t('refs.error', 'Couldn\'t load related items.');
        return el;
    }

    function renderLoading() {
        const el = document.createElement('div');
        el.className = ICON_CLASS + '-loading';
        el.textContent = '…';
        el.setAttribute('aria-live', 'polite');
        return el;
    }

    // ── Fetch ─────────────────────────────────────────────────────────────────
    async function fetchRefs(fromId) {
        const { deviceId, deviceSecret, botSecret, entityId } = readCreds();
        if (!deviceId) throw new Error('missing_creds');
        const params = ['from=' + encodeURIComponent(fromId),
                        'deviceId=' + encodeURIComponent(deviceId)];
        // Secrets travel in request headers (X-Device-Secret / X-Bot-Secret),
        // never in the URL query, so they don't leak into browser history,
        // server/Cloudflare access logs or the Referer header.
        // Prefer deviceSecret (kanban portal convention); fall back to botSecret
        // for bot-authed callers / tests.
        const headers = {};
        if (deviceSecret) {
            headers['X-Device-Secret'] = deviceSecret;
        } else if (botSecret) {
            headers['X-Bot-Secret'] = botSecret;
        } else {
            throw new Error('missing_creds');
        }
        if (entityId !== null && entityId !== undefined && entityId !== '') {
            params.push('entityId=' + encodeURIComponent(entityId));
        }
        const url = REFS_ENDPOINT + '?' + params.join('&');
        const res = await fetch(url, { credentials: 'same-origin', headers });
        if (!res.ok) throw new Error('http_' + res.status);
        const json = await res.json();
        if (!json || json.success !== true) throw new Error('api_error');
        return json;
    }

    // ── Popover plumbing (reuses HelpPopover) ─────────────────────────────────
    function getPopover() {
        return window.HelpPopover;
    }

    function popoverOpts() {
        const isMobile = window.matchMedia
            && window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
        return {
            maxWidth: DESKTOP_MAX_WIDTH,
            variant: isMobile ? 'sheet' : 'tooltip',
            extraClass: ICON_CLASS + '-anchor',
            closeLabel: t('refs.close', 'Close references'),
            placement: 'bottom',
        };
    }

    async function openPopoverFor(anchor) {
        const fromId = anchor.getAttribute('data-refs-from');
        if (!fromId) return;
        const Pop = getPopover();
        if (!Pop) return;
        Pop.show(renderLoading(), anchor, popoverOpts());
        try {
            const payload = await fetchRefs(fromId);
            Pop.show(renderPopover(payload), anchor, popoverOpts());
        } catch (_) {
            Pop.show(renderError(), anchor, popoverOpts());
        }
    }

    function onIconClick(e) {
        e.preventDefault();
        e.stopPropagation();
        const icon = e.currentTarget;
        openPopoverFor(icon);
    }

    function onIconKeyDown(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            openPopoverFor(e.currentTarget);
        }
    }

    function bindIcon(icon) {
        if (icon.__refsBound) return;
        icon.__refsBound = true;
        if (!icon.hasAttribute('tabindex')) icon.setAttribute('tabindex', '0');
        if (!icon.hasAttribute('role')) icon.setAttribute('role', 'button');
        if (!icon.hasAttribute('aria-label')) {
            icon.setAttribute('aria-label', 'Show related cards, specs, and PRs');
        }
        if (!icon.textContent || icon.textContent.trim() === '') icon.textContent = 'ⓘ';
        icon.addEventListener('click', onIconClick);
        icon.addEventListener('keydown', onIconKeyDown);
    }

    function init() {
        document.querySelectorAll('.' + ICON_CLASS).forEach(bindIcon);
    }

    // Observer for dynamic content (e.g., kanban card re-renders).
    function watch() {
        if (!('MutationObserver' in window)) return;
        const obs = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const n of m.addedNodes) {
                    if (!(n instanceof HTMLElement)) continue;
                    if (n.classList && n.classList.contains(ICON_CLASS)) bindIcon(n);
                    n.querySelectorAll && n.querySelectorAll('.' + ICON_CLASS).forEach(bindIcon);
                }
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { init(); watch(); });
    } else {
        init();
        watch();
    }

    window.RefsPopover = {
        init,
        open: openPopoverFor,
        close: () => { const p = getPopover(); if (p) p.hide(); },
        _internals: { renderPopover, fetchRefs, navHrefFor, popoverOpts },
    };
})();
