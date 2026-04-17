/**
 * Note Link Render — client-side helper to detect Note ID patterns in
 * message text and render them as clickable chips that open a modal.
 *
 * Recognised patterns (in already-escaped HTML):
 *   1. "Note" + full UUID:  Note a51136e1-f0fd-44f0-83ef-f9b2d0731b5a
 *   2. "Note" + short prefix: Note a51136e1, note: a51136e1
 *
 * Bare UUIDs without "Note" prefix are NOT matched to avoid false positives
 * with deviceId, deviceSecret, session IDs, etc.
 *
 * All render functions expect already-escaped HTML as input (post-DOMPurify
 * or post-escapeHtml), consistent with MentionRender.
 */
(function (global) {
    'use strict';

    // Keyword alternation: ASCII "note/notes" (with \b) or CJK "筆記/笔记/備忘/备忘".
    // Two capture groups — exactly one is non-empty per match. Case-insensitive via 'i' flag.
    const NOTE_KW = '(?:\\b(note|notes)|(筆記|笔记|備忘|备忘))';

    // Keyword + full UUID
    // Matches: "Note a51136e1-...", "note: a51136e1-...", "Note：a51136e1-...", "筆記 a51136e1-..."
    const UUID_NOTE_RE = new RegExp(NOTE_KW + '\\s*[:：#＃]?\\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\b', 'gi');

    // Keyword + short 8-char hex ID
    // Matches: "Note a51136e1", "note:a51136e1", "筆記 a51136e1"
    const SHORT_NOTE_RE = new RegExp(NOTE_KW + '\\s*[:：#＃]?\\s*([0-9a-f]{8})\\b', 'gi');

    // Markdown renders `backtick-wrapped` IDs as <code>ID</code>, and the code-segment
    // skip in renderNoteLinks() hides them from the patterns above. Match
    // "<keyword> <code>ID</code>" explicitly before the split.
    const CODE_UUID_NOTE_RE = new RegExp(NOTE_KW + '\\s*[:：#＃]?\\s*<code[^>]*>\\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\s*</code>', 'gi');
    const CODE_SHORT_NOTE_RE = new RegExp(NOTE_KW + '\\s*[:：#＃]?\\s*<code[^>]*>\\s*([0-9a-f]{8})\\s*</code>', 'gi');

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

        // Phase 0: "note <code>fullUUID</code>" → chip placeholder (consumes the <code> wrapper)
        escapedHtml = escapedHtml.replace(CODE_UUID_NOTE_RE, (match, asciiKw, cjkKw, uuid) => {
            const short = uuid.substring(0, 8);
            resolvedIds[short] = uuid;
            return queueChip(uuid, short);
        });
        // Phase 0b: "note <code>shortId</code>" → chip placeholder
        escapedHtml = escapedHtml.replace(CODE_SHORT_NOTE_RE, (match, asciiKw, cjkKw, shortId) => {
            const fullId = resolvedIds[shortId] || shortId;
            return queueChip(fullId, shortId);
        });

        // Split HTML into code/non-code segments to avoid transforming inside <code>/<pre>
        const parts = escapedHtml.split(/(<code[\s>][\s\S]*?<\/code>|<pre[\s>][\s\S]*?<\/pre>)/gi);

        for (let i = 0; i < parts.length; i++) {
            // Even indices = outside code, odd = inside code tags
            if (i % 2 === 1) continue;

            // Phase 1: replace "<keyword> <fullUUID>" patterns with placeholders
            parts[i] = parts[i].replace(UUID_NOTE_RE, (match, asciiKw, cjkKw, uuid) => {
                const short = uuid.substring(0, 8);
                resolvedIds[short] = uuid;
                return queueChip(uuid, short);
            });

            // Phase 2: replace "<keyword> <shortId>" patterns with placeholders
            // (only matches short IDs not already consumed by Phase 1)
            parts[i] = parts[i].replace(SHORT_NOTE_RE, (match, asciiKw, cjkKw, shortId) => {
                const fullId = resolvedIds[shortId] || shortId;
                return queueChip(fullId, shortId);
            });
        }

        return flushChips(parts.join(''));
    }

    // Placeholder system to prevent Phase 2 from matching inside Phase 1's output
    const CHIP_PLACEHOLDER_PREFIX = '\x00NOTECHIP[';
    const CHIP_PLACEHOLDER_SUFFIX = ']\x00';
    const pendingChips = [];

    function queueChip(noteId, displayId) {
        const idx = pendingChips.length;
        pendingChips.push({ noteId, displayId });
        return `${CHIP_PLACEHOLDER_PREFIX}${idx}${CHIP_PLACEHOLDER_SUFFIX}`;
    }

    function flushChips(html) {
        const result = html.replace(/\x00NOTECHIP\[(\d+)\]\x00/g, (m, idx) => {
            const c = pendingChips[parseInt(idx)];
            return buildChipHtml(c.noteId, c.displayId);
        });
        pendingChips.length = 0;
        return result;
    }

    function buildChipHtml(noteId, displayId) {
        return `<span class="note-link" data-note-id="${noteId}" onclick="openNoteModal('${noteId}')" title="${displayId}">` +
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
