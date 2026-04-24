/**
 * R2 Link Render — strip raw Cloudflare R2 presigned URLs out of chat message
 * HTML and replace them with safer attachment cards.
 *
 * Why: R2 presigned URLs are bearer tokens valid for the full expiry window
 * (default 10 min). If one ends up in a chat bubble as plain text or as a
 * clickable link, anyone who can see the message (screenshot, forward,
 * cross-device sync) can exfiltrate the file for the rest of that window —
 * and the access key ID embedded in the query string is visible too.
 *
 * This helper is applied AFTER markdown/linkify post-processing and it:
 *   1. Finds <a href="…r2.cloudflarestorage.com…">…</a> and replaces them
 *      with an attachment card (📎 filename + 📥 download button) whose
 *      click handlers re-fetch a fresh signed URL from /api/files/:id.
 *   2. Finds <img src="…r2.cloudflarestorage.com…"> (rare — e.g. markdown
 *      `![alt](r2url)` from a bot) and collapses them to the same card so
 *      the src attribute stops leaking the URL.
 *   3. Legacy / unparseable R2 URLs (no fileId in path) fall back to a
 *      muted "legacy file" chip that still opens the raw link — otherwise
 *      historical messages would become un-openable.
 *
 * The expected path shape from backend/files.js line 199 is
 *   /{bucket}/files/{deviceId}/{fileId}/{filename}
 * where fileId is a uuidv4 — we validate that before rendering the card
 * so random R2 URLs that don't match our upload layout fall through.
 *
 * Consumers must provide previewAttachment(fileId) and
 * downloadAttachment(fileId, filename) globals (chat.html does).
 * For read-only surfaces (share-chat.html), pass { interactive: false }
 * and the card renders as an inert chip — no click handlers.
 */
(function (global) {
    'use strict';

    const R2_HOST_RE = /\.r2\.cloudflarestorage\.com$/i;
    const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    function isR2Url(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            const u = new URL(url);
            return R2_HOST_RE.test(u.hostname);
        } catch (_) { return false; }
    }

    function parseR2Url(url) {
        if (!isR2Url(url)) return null;
        try {
            const u = new URL(url);
            const parts = u.pathname.split('/').filter(Boolean);
            const idx = parts.indexOf('files');
            if (idx < 0 || parts.length < idx + 4) return null;
            const fileId = parts[idx + 2];
            if (!FILE_ID_RE.test(fileId)) return null;
            let filename;
            try {
                filename = decodeURIComponent(parts.slice(idx + 3).join('/'));
            } catch (_) {
                filename = parts.slice(idx + 3).join('/');
            }
            return { fileId, filename: filename || 'file' };
        } catch (_) { return null; }
    }

    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function labelFor(key, fallback) {
        if (global.i18n && typeof global.i18n.t === 'function') {
            const v = global.i18n.t(key);
            if (v && v !== key) return v;
        }
        return fallback;
    }

    function buildCard(parsed, opts) {
        const fileId = escapeAttr(parsed.fileId);
        const filename = escapeAttr(parsed.filename);
        const interactive = !opts || opts.interactive !== false;
        const dlLabel = escapeAttr(labelFor('chat_file_download', 'Download'));

        if (!interactive) {
            return '<span class="r2-attachment-card r2-inert" title="' + filename + '">' +
                   '<span class="r2-attachment-icon">📎</span>' +
                   '<span class="r2-attachment-name">' + filename + '</span>' +
                   '</span>';
        }

        return '<span class="r2-attachment-card" data-file-id="' + fileId + '">' +
               '<span class="r2-attachment-icon" onclick="if(typeof previewAttachment===\'function\')previewAttachment(\'' + fileId + '\')">📎</span>' +
               '<span class="r2-attachment-name" onclick="if(typeof previewAttachment===\'function\')previewAttachment(\'' + fileId + '\')">' + filename + '</span>' +
               '<button type="button" class="r2-attachment-btn" onclick="event.preventDefault();event.stopPropagation();if(typeof downloadAttachment===\'function\')downloadAttachment(\'' + fileId + '\',\'' + filename + '\')">📥 ' + dlLabel + '</button>' +
               '</span>';
    }

    function buildLegacyChip(url) {
        const esc = escapeAttr(url);
        const label = escapeAttr(labelFor('chat_legacy_file', 'legacy file'));
        return '<span class="r2-legacy-chip" title="Legacy file link">📎 ' +
               '<a href="' + esc + '" target="_blank" rel="noopener" class="r2-legacy-link">' + label + '</a>' +
               '</span>';
    }

    function replaceR2Links(html, opts) {
        if (!html || typeof html !== 'string') return html;
        let out = html;

        // <a href="…r2…">INNER</a>  → card (or legacy chip if unparseable)
        const anchorRe = /<a\b[^>]*?href=["']([^"']*r2\.cloudflarestorage\.com[^"']*)["'][^>]*>[\s\S]*?<\/a>/gi;
        out = out.replace(anchorRe, (match, href) => {
            const parsed = parseR2Url(href);
            return parsed ? buildCard(parsed, opts) : buildLegacyChip(href);
        });

        // <img src="…r2…" …>  → card (or legacy chip)
        const imgRe = /<img\b[^>]*?src=["']([^"']*r2\.cloudflarestorage\.com[^"']*)["'][^>]*?>/gi;
        out = out.replace(imgRe, (match, src) => {
            const parsed = parseR2Url(src);
            return parsed ? buildCard(parsed, opts) : buildLegacyChip(src);
        });

        return out;
    }

    const api = { isR2Url, parseR2Url, replaceR2Links };
    global.R2LinkRender = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
