/**
 * Mention Parser — parses @ tokens inside chat messages and decides routing.
 *
 * Token format:
 *   <@xxxxxx>  — entity mention, where xxxxxx is a 6-char publicCode (a-z0-9)
 *   @all       — literal broadcast keyword (whole-word, case-insensitive)
 *
 * Responsibilities:
 *   1. Parse a raw message, resolve each token against publicCodeIndex
 *   2. Produce a cleanText (no tokens) for Gatekeeper detection
 *   3. Produce a displayText (tokens → @name) for push payload readability
 *   4. Decide routing: none / broadcast (for @all) / speakTo (for ≥1 entity mention)
 *   5. Provide stripMentionTokens() so Gatekeeper can ignore token strings
 *
 * This module is pure (no DB access, no side effects). It takes the in-memory
 * devices map and publicCodeIndex as input so it remains easy to unit-test.
 */
'use strict';

// Entity mention token: <@xxxxxx> where xxxxxx is publicCode (6 lowercase alnum)
const MENTION_TOKEN_RE = /<@([a-z0-9]{6})>/g;
// @all literal — must be a standalone word (preceded by start/whitespace, followed by end/non-word)
const ALL_TOKEN_RE = /(^|\s)@all(?=\s|$|[^\w])/i;

/**
 * Parse mention tokens from raw text and resolve them against publicCodeIndex.
 *
 * @param {string} text
 * @param {object} ctx
 * @param {string} ctx.senderDeviceId - used to flag cross-device mentions
 * @param {object} ctx.devices - in-memory devices map (for entity name + bound check)
 * @param {object} ctx.publicCodeIndex - code -> { deviceId, entityId }
 * @returns {ParseResult}
 *
 * ParseResult shape:
 *   text: original text (unchanged)
 *   displayText: tokens replaced with @name (unresolved tokens left as-is)
 *   cleanText: tokens stripped entirely (whitespace normalized)
 *   hasAll: boolean — @all literal present
 *   mentions: Mention[] — resolved entity mentions (deduped by publicCode)
 *   unresolved: string[] — publicCodes that failed to resolve
 *
 * Mention shape:
 *   { publicCode, deviceId, entityId, name, isCrossDevice, isBound }
 */
function parseMentions(text, ctx) {
    const result = {
        text: text || '',
        displayText: text || '',
        cleanText: text || '',
        hasAll: false,
        mentions: [],
        unresolved: []
    };
    if (!text || typeof text !== 'string') return result;

    const senderDeviceId = ctx && ctx.senderDeviceId;
    const devices = (ctx && ctx.devices) || {};
    const publicCodeIndex = (ctx && ctx.publicCodeIndex) || {};

    // @all literal
    if (ALL_TOKEN_RE.test(text)) result.hasAll = true;

    // Entity tokens — dedup by publicCode (user may @ the same entity twice)
    const seen = new Set();
    let m;
    MENTION_TOKEN_RE.lastIndex = 0;
    while ((m = MENTION_TOKEN_RE.exec(text)) !== null) {
        const code = m[1];
        if (seen.has(code)) continue;
        seen.add(code);

        const target = publicCodeIndex[code];
        if (!target) {
            result.unresolved.push(code);
            continue;
        }
        const device = devices[target.deviceId];
        const entity = device && device.entities && device.entities[target.entityId];
        if (!entity || !entity.isBound) {
            result.unresolved.push(code);
            continue;
        }
        result.mentions.push({
            publicCode: code,
            deviceId: target.deviceId,
            entityId: target.entityId,
            name: entity.name || `Entity ${target.entityId}`,
            isCrossDevice: target.deviceId !== senderDeviceId,
            isBound: true
        });
    }

    // displayText: replace known tokens with @name; leave unresolved tokens as-is
    result.displayText = text.replace(MENTION_TOKEN_RE, (match, code) => {
        const hit = result.mentions.find(x => x.publicCode === code);
        return hit ? `@${hit.name}` : match;
    });

    // cleanText: strip all tokens + @all; collapse multiple whitespace
    result.cleanText = text
        .replace(MENTION_TOKEN_RE, '')
        .replace(/(^|\s)@all(?=\s|$|[^\w])/gi, '$1')
        .replace(/\s+/g, ' ')
        .trim();

    return result;
}

/**
 * Decide the routing strategy from a parse result.
 *
 * Per product spec:
 *   - @all present → broadcast mode (ignore any individual mentions)
 *   - ≥1 entity mention → parallel speakTo (no threshold for fallback to broadcast)
 *   - Otherwise → 'none' (caller handles via existing entityId logic)
 *
 * @param {ParseResult} parseResult
 * @returns {{ mode: 'none'|'broadcast'|'speakTo', broadcast: boolean, targets: Mention[] }}
 */
function decideRouting(parseResult) {
    if (!parseResult) return { mode: 'none', broadcast: false, targets: [] };
    if (parseResult.hasAll) {
        return { mode: 'broadcast', broadcast: true, targets: [] };
    }
    if (parseResult.mentions && parseResult.mentions.length > 0) {
        return { mode: 'speakTo', broadcast: false, targets: parseResult.mentions.slice() };
    }
    return { mode: 'none', broadcast: false, targets: [] };
}

/**
 * Strip mention tokens (and @all literal) from text.
 * Used by Gatekeeper pre-check so token syntax does not leak into detection.
 *
 * @param {string} text
 * @returns {string}
 */
function stripMentionTokens(text) {
    if (!text || typeof text !== 'string') return text;
    return text
        .replace(MENTION_TOKEN_RE, '')
        .replace(/(^|\s)@all(?=\s|$|[^\w])/gi, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Build a JSON-safe payload for DB storage (chat_messages.mentions) and
 * eclaw_context injection. Returns null when there is nothing to store.
 *
 * @param {ParseResult} parseResult
 * @returns {object|null}
 */
function toContextPayload(parseResult) {
    if (!parseResult) return null;
    const hasContent = parseResult.hasAll ||
        (parseResult.mentions && parseResult.mentions.length > 0) ||
        (parseResult.unresolved && parseResult.unresolved.length > 0);
    if (!hasContent) return null;
    return {
        hasAll: !!parseResult.hasAll,
        mentions: (parseResult.mentions || []).map(m => ({
            publicCode: m.publicCode,
            deviceId: m.deviceId,
            entityId: m.entityId,
            name: m.name,
            isCrossDevice: !!m.isCrossDevice,
            ...(m.blocked ? { blocked: true, blockReason: m.blockReason || 'blocked' } : {})
        })),
        ...(parseResult.unresolved && parseResult.unresolved.length > 0
            ? { unresolved: parseResult.unresolved }
            : {})
    };
}

module.exports = {
    parseMentions,
    decideRouting,
    stripMentionTokens,
    toContextPayload,
    MENTION_TOKEN_RE,
    ALL_TOKEN_RE
};
