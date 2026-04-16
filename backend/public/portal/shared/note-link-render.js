/**
 * Note Link Render — client-side helper to detect Note ID patterns in
 * message text and render them as clickable chips that open a modal.
 *
 * Recognised patterns (in already-escaped HTML):
 *   1. Full UUID:  xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  (36 chars)
 *   2. Short prefix preceded by "note" / "Note" context:
 *      "Note a51136e1", "note: a51136e1", "note a51136e1"
 *
 * All render functions expect already-escaped HTML as input (post-DOMPurify
 * or post-escapeHtml), consistent with MentionRender.
 */
(function (global) {
    'use strict';

    // Full UUID pattern (hex-8-4-4-4-12)
    const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

    // Short note ID — 8 hex chars preceded by "note" keyword (case-insensitive)
    // Matches: "Note a51136e1", "note:a51136e1", "Note: a51136e1", "note a51136e1"
    const SHORT_NOTE_RE = /\b(note)\s*[:：]?\s*([0-9a-f]{8})\b/gi;

    // Cache: short prefix → full noteId (populated on successful API fetches)
    const resolvedIds = {};

    /**
     * Replace Note ID patterns in already-escaped HTML with clickable chip spans.
     *
     * @param {string} escapedHtml - escaped/sanitised message HTML
     * @returns {string} HTML with note IDs replaced by clickable chips
     */
    function renderNoteLinks(escapedHtml) {
        if (!escapedHtml) return escapedHtml;

        // Split HTML into code/non-code segments to avoid transforming inside <code>/<pre>
        // Simple approach: split by code blocks, only transform odd segments (outside code)
        const parts = escapedHtml.split(/(<code[\s>][\s\S]*?<\/code>|<pre[\s>][\s\S]*?<\/pre>)/gi);

        for (let i = 0; i < parts.length; i++) {
            // Even indices = outside code, odd = inside code tags
            if (i % 2 === 1) continue;

            // Phase 1: replace full UUIDs
            parts[i] = parts[i].replace(UUID_RE, (match, uuid) => {
                const short = uuid.substring(0, 8);
                resolvedIds[short] = uuid;
                return buildChip(uuid, short);
            });

            // Phase 2: replace "Note <shortId>" patterns
            parts[i] = parts[i].replace(SHORT_NOTE_RE, (match, noteWord, shortId) => {
                const fullId = resolvedIds[shortId] || shortId;
                return buildChip(fullId, shortId);
            });
        }

        return parts.join('');
    }

    function buildChip(noteId, displayId) {
        return `<span class="note-link" data-note-id="${noteId}" onclick="openNoteModal('${noteId}')" title="Note ${displayId}">` +
               `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:3px;">` +
               `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>` +
               `</svg>${displayId}</span>`;
    }

    /**
     * Store a resolved short→full mapping (called after successful API fetch).
     */
    function cacheResolvedId(shortId, fullId) {
        resolvedIds[shortId] = fullId;
    }

    /**
     * Get cached full ID for a short prefix, if available.
     */
    function getResolvedId(shortId) {
        return resolvedIds[shortId] || null;
    }

    global.NoteLinkRender = {
        renderNoteLinks,
        cacheResolvedId,
        getResolvedId
    };
})(window);
