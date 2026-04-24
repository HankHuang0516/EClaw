/**
 * AutolinkChip — detect NEW reference prefixes in already-escaped HTML and
 * render them as clickable 引用晶片 (reference chips).
 *
 * Recognised prefixes (this module owns):
 *   1. review_<6+ alnum>     — agent review
 *   2. src://<kind>/<type>/<id>[#anchor]  — source-anchor token
 *
 * NOT handled here (existing modules already own these):
 *   - card_<hex>      → EntityLinkRender (entity-link-render.js)
 *   - skill_/rule_/listing_/exam_/contract_ → EntityLinkRender
 *   - note_<24hex>    → NoteLinkRender
 *   - @mention        → MentionRender
 *   - his_<uuid>      → HisLinkRender
 *
 * Must run AFTER EntityLinkRender / NoteLinkRender / HisLinkRender in the
 * render pipeline so their spans' inner text ("card_abc123") isn't re-matched.
 *
 * All inputs are expected to be already-escaped HTML (post-DOMPurify or
 * post-escapeHtml), consistent with the other render modules.
 *
 * Subsequent cards (B: preview popover, C: recursive, D: backend expansion)
 * extend this module — do not rename public surface.
 */
(function (global) {
    'use strict';

    const REVIEW_RE      = /\breview_([a-zA-Z0-9_-]{6,})\b/g;
    const CODE_REVIEW_RE = /<code[^>]*>\s*review_([a-zA-Z0-9_-]{6,})\s*<\/code>/g;
    const SRC_RE         = /\bsrc:\/\/([a-z]+)\/([a-z]+)\/([a-f0-9]{8,})(#[a-z0-9-]+)?\b/gi;
    const CODE_SRC_RE    = /<code[^>]*>\s*src:\/\/([a-z]+)\/([a-z]+)\/([a-f0-9]{8,})(#[a-z0-9-]+)?\s*<\/code>/gi;

    const PLACEHOLDER_PREFIX = '\x00AUTOCHIP[';
    const PLACEHOLDER_SUFFIX = ']\x00';
    const pending = [];

    function queue(refType, refId, label, extra) {
        const idx = pending.length;
        pending.push({ refType, refId, label, extra: extra || null });
        return `${PLACEHOLDER_PREFIX}${idx}${PLACEHOLDER_SUFFIX}`;
    }

    function flush(html) {
        const out = html.replace(/\x00AUTOCHIP\[(\d+)\]\x00/g, (_m, idx) => {
            const c = pending[parseInt(idx, 10)];
            return buildChipHtml(c.refType, c.refId, c.label, c.extra);
        });
        pending.length = 0;
        return out;
    }

    function buildChipHtml(refType, refId, label, extra) {
        const dataset = [
            `data-ref-type="${escapeAttr(refType)}"`,
            `data-ref-id="${escapeAttr(refId)}"`,
            `data-ref-label="${escapeAttr(label)}"`,
            extra && extra.anchor ? `data-ref-anchor="${escapeAttr(extra.anchor)}"` : ''
        ].filter(Boolean).join(' ');
        const icon = refType === 'review' ? '⭐'
                    : refType === 'src' ? '📍'
                    : '🔗';
        return `<span class="autolink-chip autolink-chip--${escapeAttr(refType)}" ${dataset} onclick="AutolinkChip.onChipClick(this, event)" title="${escapeAttr(refType)}:${escapeAttr(refId)}">${icon} ${escapeAttr(label)}</span>`;
    }

    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * Replace review_ and src:// references in already-escaped HTML with
     * autolink-chip spans. Safe against <code>/<pre> blocks and any spans
     * already produced by upstream renderers (entity-link / note-link / his-link).
     */
    function render(escapedHtml) {
        if (!escapedHtml || typeof escapedHtml !== 'string') return escapedHtml;
        let html = escapedHtml;

        // Phase -1: <code>review_xxx</code> / <code>src://...</code> → chip (consumes the code wrapper)
        html = html.replace(CODE_REVIEW_RE, (_m, slug) => {
            const id = 'review_' + slug;
            return queue('review', id, shortLabel(id));
        });
        html = html.replace(CODE_SRC_RE, (_m, kind, type, id, anchor) => {
            const full = `src://${kind}/${type}/${id}${anchor || ''}`;
            return queue('src', full, shortLabel(full), { anchor: anchor || null });
        });

        // Split out <code>/<pre> blocks AND existing chip spans so bare patterns
        // don't touch already-rendered chips or literal code.
        const SPLIT_RE = /(<code[\s>][\s\S]*?<\/code>|<pre[\s>][\s\S]*?<\/pre>|<span\s+class="(?:entity-link|note-link|his-link|mention-chip)[^"]*"[\s\S]*?<\/span>)/gi;
        const parts = html.split(SPLIT_RE);
        for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 1) continue; // skipped block
            let p = parts[i];
            p = p.replace(REVIEW_RE, (_m, slug) => {
                const id = 'review_' + slug;
                return queue('review', id, shortLabel(id));
            });
            p = p.replace(SRC_RE, (_m, kind, type, id, anchor) => {
                const full = `src://${kind}/${type}/${id}${anchor || ''}`;
                return queue('src', full, shortLabel(full), { anchor: anchor || null });
            });
            parts[i] = p;
        }

        return flush(parts.join(''));
    }

    function shortLabel(fullId) {
        const r = /^review_(.{1,12})/.exec(fullId);
        if (r) return 'review_' + r[1] + (fullId.length > r[0].length ? '…' : '');
        if (fullId.startsWith('src://')) {
            // src://kanban/card/<24hex>#comment-<uuid> → src://kanban/card_<8hex>…
            const s = /^src:\/\/([a-z]+)\/([a-z]+)\/([a-f0-9]{8})/.exec(fullId);
            if (s) return `src://${s[1]}/${s[2]}_${s[3].slice(0, 4)}…`;
        }
        return fullId.length > 18 ? fullId.slice(0, 16) + '…' : fullId;
    }

    /**
     * Default click handler — delegates to preview opener if registered
     * (Card B), otherwise deep-links to the target surface.
     */
    function onChipClick(el, ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        const refType = el.getAttribute('data-ref-type');
        const refId = el.getAttribute('data-ref-id');
        if (!refType || !refId) return;

        // Preview handler wins if installed (Card B will register this)
        if (typeof global.AutolinkChipPreview === 'function') {
            try {
                global.AutolinkChipPreview(refType, refId, el);
                return;
            } catch (e) { /* fall through to deep-link */ }
        }

        // Fallback deep-link (Card A default behaviour — simple navigation)
        const url = deepLinkUrl(refType, refId, el.getAttribute('data-ref-anchor'));
        if (url) window.location.href = url;
    }

    function deepLinkUrl(refType, refId, anchor) {
        if (refType === 'review') return `/portal/reviews.html#${refId}`;
        if (refType === 'src') {
            // src://kanban/card/<id>#anchor → /portal/kanban.html#card_<id>[anchor]
            const m = /^src:\/\/([a-z]+)\/([a-z]+)\/([a-f0-9]{8,})(#.+)?$/i.exec(refId);
            if (m) {
                const surface = m[1] === 'kanban' ? 'kanban.html' : `${m[1]}.html`;
                return `/portal/${surface}#${m[2]}_${m[3]}${m[4] || ''}`;
            }
        }
        return null;
    }

    global.AutolinkChip = {
        render,
        onChipClick,
        deepLinkUrl,
        // internal — exposed for unit testing only
        _escapeAttr: escapeAttr,
        _shortLabel: shortLabel
    };
})(window);
