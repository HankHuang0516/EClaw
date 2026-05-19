/**
 * History Link Render — detects `his_<message_id>` tokens in message text and
 * renders them as clickable chips that scroll to (and flash) the referenced
 * bubble, or fall back to a small preview if the message is not currently
 * rendered.
 *
 * Token form: `his_<uuid>` where <uuid> is the canonical 8-4-4-4-12 hex UUID
 * of messages.id. Word-boundary delimited so "thishis_" or trailing letters
 * after the last hex block won't match.
 *
 * Runs after DOMPurify — receives already-escaped HTML.
 */
(function (global) {
    'use strict';

    // UUID form (case-insensitive). `messages.id` is a UUID, not a SERIAL.
    // Word boundary at the start handles "見 his_..." / "(his_..." etc; we
    // anchor the end with a lookahead that rejects an extra hex/hyphen so a
    // token like "his_<uuid>abcd" doesn't partial-match.
    const HIS_RE = /\bhis_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/gi;
    const UUID_GUARD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    function normalizeMessageId(value) {
        const id = String(value || '').trim().toLowerCase();
        return UUID_GUARD.test(id) ? id : '';
    }

    function extractFirstMessageId(value) {
        const direct = normalizeMessageId(value);
        if (direct) return direct;
        const match = String(value || '').match(HIS_RE);
        if (!match || !match.length) return '';
        const token = String(match[0] || '').replace(/^his_/i, '');
        return normalizeMessageId(token);
    }

    function renderHisLinks(escapedHtml) {
        if (!escapedHtml) return escapedHtml;
        return escapedHtml.replace(HIS_RE, (match, id) => {
            const normalized = normalizeMessageId(id);
            if (!normalized) return match;
            return buildChipHtml(normalized);
        });
    }

    function buildChipHtml(msgId) {
        const safeId = normalizeMessageId(msgId);
        if (!safeId) return '';
        return `<span class="his-link" data-msg-id="${safeId}" onclick="openHistoryMessage('${safeId}')" title="his_${safeId}">` +
               `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:3px;">` +
               `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>` +
               `</svg>his_${safeId}</span>`;
    }

    global.HisLinkRender = {
        renderHisLinks,
        normalizeMessageId,
        extractFirstMessageId,
        _re: HIS_RE
    };
})(window);
