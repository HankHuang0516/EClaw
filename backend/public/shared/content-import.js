/**
 * content-import.js — content import dispatcher
 * Spec: docs/specs/a-hover-click-dom-interaction.md §4
 *
 * v1 surfaces (per #6 sign-off):
 *   { kind: "url", url }      — iframe-embed, CORS proxy for cross-origin
 *   { kind: "portal", path }  — direct same-origin DOM
 *   { kind: "ax" }            — stub, returns not-supported-v1 error
 *
 * Returns { rootEl, sourceMap, dispose }.
 */
(function (root) {
  'use strict';

  // Deny-on-miss public host allowlist per spec §4.2 / #6 review decision.
  // Curated; explicit Hank decision before adding new entries. Localhost /
  // private IPs / file:// blocked server-side; client-side check is defence
  // in depth — the proxy endpoint enforces this canonically.
  const PUBLIC_ALLOWLIST = [
    /^https?:\/\/eclawbot\.com(\/.*)?$/i,
    /^https?:\/\/.*\.eclawbot\.com(\/.*)?$/i,
    /^https?:\/\/example\.com(\/.*)?$/i, // Whitelisted for the v1 demo fixture
  ];

  function isAllowedPublicUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const hostname = u.hostname;
      // Block private / loopback at the client too.
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
      if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
      return PUBLIC_ALLOWLIST.some((re) => re.test(url));
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {Object} spec
   * @returns {Promise<{rootEl:Element, sourceMap:Map, dispose:Function}>}
   */
  async function importContent(spec) {
    if (!spec || !spec.kind) throw new Error('content-import: spec.kind required');

    if (spec.kind === 'ax') {
      throw new Error(root.i18n && root.i18n.t
        ? root.i18n.t('hover_click.import_unsupported_ax_v1')
        : 'Native APP element selection arriving in v2.');
    }

    if (spec.kind === 'portal') {
      // Same-origin portal page: import the document fragment directly.
      const path = spec.path || '/portal/chat.html';
      const resp = await fetch(path, { credentials: 'same-origin' });
      if (!resp.ok) throw new Error(`portal fetch ${path} failed: ${resp.status}`);
      const html = await resp.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const wrap = document.createElement('div');
      wrap.className = 'eclaw-content-import__portal';
      // Copy body children into the wrap; we deliberately ignore document
      // scripts (no eval-on-import; the toolbar operates on inert markup).
      Array.from(doc.body.childNodes).forEach((node) => {
        if (node.nodeType === 1 && node.tagName.toLowerCase() === 'script') return;
        wrap.appendChild(node.cloneNode(true));
      });
      const sourceMap = new Map();
      sourceMap.set('__root__', { file: path, kind: 'portal' });
      return {
        rootEl: wrap,
        sourceMap,
        sourceContext: { kind: 'portal', path, url: `${root.location.origin}${path}` },
        dispose() { wrap.remove(); },
      };
    }

    if (spec.kind === 'url') {
      if (!spec.url) throw new Error('content-import: spec.url required');
      const allowed = isAllowedPublicUrl(spec.url);
      const sameOrigin = allowed && new URL(spec.url).origin === root.location.origin;
      const iframe = document.createElement('iframe');
      iframe.className = 'eclaw-content-import__iframe';
      iframe.setAttribute('referrerpolicy', 'no-referrer');
      iframe.setAttribute('loading', 'eager');
      // v1.3: same-origin portal pages need scripts to render (auth-checks,
      // i18n.apply, nav inject). Without allow-scripts they hand back an empty
      // body and the user sees a blank box. Cross-origin proxied content stays
      // in the strict-no-scripts sandbox per spec §4.2 threat model.
      if (sameOrigin) {
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups');
      } else {
        iframe.setAttribute('sandbox', 'allow-same-origin allow-forms');
      }
      if (sameOrigin) {
        iframe.src = spec.url;
      } else if (allowed) {
        // Cross-origin allowed → proxy through our origin (strips X-Frame-Options /
        // frame-ancestors per spec §4.2). Endpoint enforces the canonical
        // allowlist server-side.
        iframe.src = `/api/import/proxy?url=${encodeURIComponent(spec.url)}`;
      } else {
        // Deny-on-miss: do not render. Surface i18n-friendly error to caller.
        throw new Error(root.i18n && root.i18n.t
          ? root.i18n.t('hover_click.import_url_not_allowed')
          : 'URL not in import allowlist');
      }
      // Wait for the iframe to load before exposing rootEl, so callers can
      // attach DOM-select to the iframe document.
      // v1.3: also reject after a load-with-empty-body timeout, since browsers
      // fire 'load' even on X-Frame-Options DENY and the document is unusable.
      const loaded = await new Promise((res, rej) => {
        iframe.addEventListener('load', () => res('load'), { once: true });
        iframe.addEventListener('error', () => rej(new Error('iframe error event')), { once: true });
        document.body.appendChild(iframe);
        setTimeout(() => res('timeout'), 8000);
      });
      let doc;
      try { doc = iframe.contentDocument; } catch (_) { doc = null; }
      const bodyEmpty = !doc || !doc.body || (doc.body.childElementCount === 0 && !doc.body.textContent.trim());
      if (loaded === 'timeout' || bodyEmpty) {
        iframe.remove();
        throw new Error(root.i18n && root.i18n.t
          ? root.i18n.t('hover_click.import_iframe_blocked')
          : 'Import target blocked the iframe (X-Frame-Options / frame-ancestors). Try a different URL or use "This page".');
      }
      const sourceMap = new Map();
      sourceMap.set('__root__', { file: spec.url, kind: 'url' });
      return {
        rootEl: doc.body || doc.documentElement,
        sourceMap,
        iframe,
        sourceContext: { kind: 'url', url: spec.url, viewport: { w: iframe.clientWidth, h: iframe.clientHeight } },
        dispose() { iframe.remove(); },
      };
    }

    throw new Error(`content-import: unknown kind=${spec.kind}`);
  }

  root.EClawContentImport = {
    importContent,
    isAllowedPublicUrl,
  };
})(typeof window !== 'undefined' ? window : this);
