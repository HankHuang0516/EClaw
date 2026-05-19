/**
 * ChatMessageRender — shared text-chip pipeline used by both chat.html and
 * kanban card comments / descriptions. Centralises the chip render order so
 * the two surfaces can never silently diverge again.
 *
 * Input is already-escaped HTML (post escapeHtml or post linkifyText). The
 * chain runs in the order each downstream module expects:
 *
 *   MentionRender → NoteLinkRender → EntityLinkRender → HisLinkRender
 *     → AutolinkChip → R2LinkRender
 *
 * Surface flags let kanban skip features that don't belong on a card-comment
 * surface (e.g. R2 attachment cards belong to chat messages, not card
 * comments — kanban shows attachments separately via its own attachment list).
 *
 * Each helper module is feature-detected; missing modules degrade gracefully
 * to "no chip" pass-through, so this file does not require import order
 * changes in the host page.
 */
(function (global) {
    'use strict';

    /**
     * @param {string} escapedHtml  Already-escaped HTML (do NOT pass raw text)
     * @param {Object} [opts]
     * @param {'chat'|'kanban'} [opts.surface='chat']
     * @param {Object} [opts.mentionEntityMap]  publicCode → { name, isCrossDevice }
     * @param {boolean} [opts.skipR2=false]  Force-skip R2 link replacement (chat
     *        passes `false`; kanban passes `false` too — both want R2 cards.
     *        Reserved for special surfaces like email export that need raw URLs.)
     * @returns {string} HTML with chips applied
     */
    function renderTextChips(escapedHtml, opts) {
        if (escapedHtml == null) return '';
        let html = String(escapedHtml);
        const o = opts || {};
        const surface = o.surface || 'chat';
        const mentionMap = o.mentionEntityMap || {};

        if (global.MentionRender && typeof global.MentionRender.renderMentionTokens === 'function') {
            html = global.MentionRender.renderMentionTokens(html, mentionMap);
        }
        if (global.NoteLinkRender && typeof global.NoteLinkRender.renderNoteLinks === 'function') {
            html = global.NoteLinkRender.renderNoteLinks(html);
        }
        if (global.EntityLinkRender && typeof global.EntityLinkRender.renderEntityLinks === 'function') {
            html = global.EntityLinkRender.renderEntityLinks(html);
        }
        if (global.HisLinkRender && typeof global.HisLinkRender.renderHisLinks === 'function') {
            html = global.HisLinkRender.renderHisLinks(html);
        }
        if (global.AutolinkChip && typeof global.AutolinkChip.render === 'function') {
            html = global.AutolinkChip.render(html);
        }
        if (!o.skipR2 && global.R2LinkRender && typeof global.R2LinkRender.replaceR2Links === 'function') {
            html = global.R2LinkRender.replaceR2Links(html);
        }

        // Surface hook reserved for future per-surface trims (e.g. strip
        // reactions/attachments from kanban). Currently no-op — both surfaces
        // share the full chip set.
        void surface;

        return html;
    }

    /**
     * Convenience: escape raw text first, then run the chip pipeline. Use
     * this from kanban where the input is plain text rather than already
     * escaped HTML. Chat keeps its own escapeHtml + linkifyText path because
     * it needs the URL list for inline image / link preview rendering.
     */
    function renderTextChipsFromRaw(rawText, opts) {
        const div = document.createElement('div');
        div.textContent = rawText == null ? '' : String(rawText);
        return renderTextChips(div.innerHTML, opts);
    }

    function normalizeHistoryMessageId(value) {
        if (global.HisLinkRender && typeof global.HisLinkRender.normalizeMessageId === 'function') {
            return global.HisLinkRender.normalizeMessageId(value);
        }
        return '';
    }

    function extractFirstHistoryMessageId(rawText) {
        if (global.HisLinkRender && typeof global.HisLinkRender.extractFirstMessageId === 'function') {
            return global.HisLinkRender.extractFirstMessageId(rawText);
        }
        return normalizeHistoryMessageId(rawText);
    }

    global.ChatMessageRender = {
        renderTextChips,
        renderTextChipsFromRaw,
        normalizeHistoryMessageId,
        extractFirstHistoryMessageId
    };
})(window);
