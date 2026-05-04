// Safe Markdown helpers for public portal surfaces.
// Prefer marked.js + DOMPurify when present; keep a tiny safe fallback so
// release notes never show raw Markdown URLs if the CDN script is unavailable.
(function(root) {
    'use strict';

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttr(value) {
        return escapeHtml(value).replace(/`/g, '&#96;');
    }

    function addSafeLinkAttrs(html) {
        return String(html || '').replace(/<a\b([^>]*)>/g, (_match, attrs) => {
            const hasTarget = /\starget\s*=/.test(attrs);
            const hasRel = /\srel\s*=/.test(attrs);
            return `<a${attrs}${hasTarget ? '' : ' target="_blank"'}${hasRel ? '' : ' rel="noopener noreferrer"'}>`;
        });
    }

    function fallbackMarkdownInline(source) {
        let html = escapeHtml(source);
        html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => {
            const safeUrl = escapeAttr(url);
            return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        });
        html = html.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, (_m, prefix, url) => {
            const safeUrl = escapeAttr(url);
            return `${prefix}<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${url}</a>`;
        });
        return html;
    }

    function renderSafeMarkdownInline(source) {
        const text = String(source || '');
        let html = null;

        if (root.marked) {
            if (typeof root.marked.parseInline === 'function') {
                html = root.marked.parseInline(text);
            } else if (typeof root.marked.parse === 'function') {
                html = root.marked.parse(text).replace(/^<p>|<\/p>\s*$/g, '');
            }
        }

        if (html === null) html = fallbackMarkdownInline(text);

        if (root.DOMPurify && typeof root.DOMPurify.sanitize === 'function') {
            html = root.DOMPurify.sanitize(html, {
                ALLOWED_TAGS: ['a', 'strong', 'em', 'code', 'span'],
                ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
                ADD_ATTR: ['target', 'rel'],
            });
        }

        return addSafeLinkAttrs(html);
    }

    root.renderSafeMarkdownInline = renderSafeMarkdownInline;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { renderSafeMarkdownInline, fallbackMarkdownInline, escapeHtml };
    }
})(typeof window !== 'undefined' ? window : globalThis);
