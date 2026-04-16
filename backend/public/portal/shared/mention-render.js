/**
 * Mention Render — client-side helpers to render mention tokens as chips
 * and to inspect tokens embedded in message text.
 *
 * Token format (matches backend mention-parser):
 *   <@xxxxxx>   where xxxxxx is a 6-char publicCode (a-z0-9)
 *   @all        literal broadcast keyword
 *
 * All render functions expect already-escaped HTML as input, so they
 * match the POST-escapeHtml form of the token (`&lt;@xxxxxx&gt;`).
 */
(function (global) {
    'use strict';

    // Post-escape token pattern (matches `&lt;@xxxxxx&gt;`)
    const ESCAPED_TOKEN_RE = /&lt;@([a-z0-9]{6})&gt;/g;
    // @all in escaped HTML
    const ESCAPED_ALL_RE = /(^|\s)@all(?=\s|$|[^\w])/g;

    /**
     * Replace mention tokens in already-escaped HTML with styled chip spans.
     *
     * @param {string} escapedHtml - escaped message text
     * @param {object} [entityMap] - optional { publicCode: { name, isCrossDevice? } }
     * @returns {string} HTML with tokens replaced by chip spans
     */
    function renderMentionTokens(escapedHtml, entityMap) {
        if (!escapedHtml) return escapedHtml;
        const map = entityMap || {};
        let out = escapedHtml.replace(ESCAPED_TOKEN_RE, (match, code) => {
            const hit = map[code];
            const name = hit && hit.name ? hit.name : code;
            const cross = hit && hit.isCrossDevice ? ' mention-chip-cross' : '';
            // Note: name is already-untrusted — re-escape to be safe
            const div = document.createElement('div');
            div.textContent = name;
            return `<span class="mention-chip${cross}" data-code="${code}" title="@${div.innerHTML}#${code}" onclick="openMentionProfile('${code}')" style="cursor:pointer;">@${div.innerHTML}</span>`;
        });
        out = out.replace(ESCAPED_ALL_RE, (m, lead) => {
            return `${lead}<span class="mention-chip mention-chip-all" title="@all">@all</span>`;
        });
        return out;
    }

    /**
     * Extract mention codes from raw (unescaped) text.
     * Useful for sendMessage() to compute cross-device targets.
     *
     * @param {string} rawText
     * @returns {string[]} array of publicCodes (in order of appearance, deduped)
     */
    function extractMentionCodes(rawText) {
        if (!rawText) return [];
        const out = [];
        const seen = new Set();
        const re = /<@([a-z0-9]{6})>/g;
        let m;
        while ((m = re.exec(rawText)) !== null) {
            if (!seen.has(m[1])) {
                seen.add(m[1]);
                out.push(m[1]);
            }
        }
        return out;
    }

    /**
     * Check whether raw text contains the @all literal.
     * @param {string} rawText
     * @returns {boolean}
     */
    function hasAllToken(rawText) {
        if (!rawText) return false;
        return /(^|\s)@all(?=\s|$|[^\w])/i.test(rawText);
    }

    global.MentionRender = {
        renderMentionTokens,
        extractMentionCodes,
        hasAllToken
    };
})(window);
