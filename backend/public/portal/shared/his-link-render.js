/**
 * History Link Render — detects `his_<message_id>` tokens in message text and
 * renders them as clickable chips that scroll to (and flash) the referenced
 * bubble, or fall back to a small preview if the message is not currently
 * rendered.
 *
 * Token form: `his_123` where 123 is the numeric messages.id (SERIAL).
 * Word-boundary delimited so "thishis_" / "his_abc" don't match.
 *
 * Runs after DOMPurify — receives already-escaped HTML.
 */
(function (global) {
    'use strict';

    // Numeric-only id (matches messages.id SERIAL). Word-boundary on both sides
    // so tokens embedded in prose/markdown work: "見 his_123 的上下文" → chip.
    const HIS_RE = /\bhis_(\d+)\b/g;

    // Inside <code>/<pre> we still want to show the chip form, so we allow the
    // regex to run across code-wrapped tokens too (differs from NoteLinkRender,
    // which preserves literal IDs inside code). Bot prompt will typically emit
    // bare tokens without backticks.

    function renderHisLinks(escapedHtml) {
        if (!escapedHtml) return escapedHtml;
        return escapedHtml.replace(HIS_RE, (_match, id) => buildChipHtml(id));
    }

    function buildChipHtml(msgId) {
        const safeId = String(msgId).replace(/[^0-9]/g, '');
        return `<span class="his-link" data-msg-id="${safeId}" onclick="openHistoryMessage('${safeId}')" title="his_${safeId}">` +
               `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:3px;">` +
               `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>` +
               `</svg>his_${safeId}</span>`;
    }

    global.HisLinkRender = {
        renderHisLinks,
        _re: HIS_RE
    };
})(window);
