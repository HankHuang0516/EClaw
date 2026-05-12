/**
 * Mention Parser — parses @ tokens inside chat messages and decides routing.
 *
 * Supported token formats (all map to the same Mention shape internally):
 *   <@xxxxxx>  — entity mention by 6-char publicCode (a-z0-9). Same- or
 *                cross-device. Always preferred for cross-device mentions.
 *   <@N>       — entity mention by numeric entityId (same-device only).
 *                Inside angle brackets so it pairs naturally with the
 *                publicCode form.
 *   @#N        — entity mention by entityId with explicit hash prefix.
 *                Bots tend to write this naturally (looks like a slot
 *                reference). Same-device only.
 *   @N         — entity mention by bare entityId. Same-device only. Word
 *                boundaries enforced via lookbehind/lookahead so emails
 *                like `user@1corp.com` and version strings like `@2pm`
 *                don't false-positive.
 *   @all       — literal broadcast keyword (case-insensitive, word-bounded).
 *
 * Resolution preference: 6-char alnum tokens are tried as publicCode first.
 * If publicCode lookup fails, the token is left unresolved (we never silently
 * downgrade to entityId for the bracket form to avoid surprising matches).
 *
 * Responsibilities:
 *   1. Resolve every recognised token to a Mention object
 *   2. Produce cleanText (no tokens) for Gatekeeper detection
 *   3. Produce displayText (tokens → @name) for push payload readability
 *   4. Decide routing: none / broadcast (for @all) / speakTo (for ≥1 mention)
 *   5. Provide stripMentionTokens() so Gatekeeper can ignore token strings
 *
 * This module is pure (no DB access, no side effects). Caller injects the
 * in-memory devices map and publicCodeIndex so it stays unit-testable.
 */
'use strict';

// ── Token regexes ──────────────────────────────────────────────────────────
// publicCode form (bracketed): <@xxxxxx> — canonical, what the chat input
// autocomplete inserts. xxxxxx is exactly 6 lowercase a-z0-9 chars.
const PUBLIC_CODE_TOKEN_RE = /<@([a-z0-9]{6})>/g;

// publicCode form (bare): @xxxxxx — what LLMs naturally write (Slack/Twitter
// convention). Same 6-char [a-z0-9] payload, but no surrounding brackets.
// Lookbehind excludes `@`, word chars, and `<` so we never:
//   - re-match inside an already-matched <@xxxxxx>
//   - match an email like user@gmail1.com (gmail1 IS 6 chars [a-z0-9], but
//     publicCodeIndex lookup will fail → unresolved → no routing side effect)
// Lookahead `(?![\w])` enforces word boundary after the 6 chars.
const PUBLIC_CODE_BARE_RE = /(?<![\w@<])@([a-z0-9]{6})(?![\w])/g;

// entityId — bracketed: <@N> where N is 1-3 digits.
const ENTITY_ID_BRACKET_RE = /<@(\d{1,3})>/g;

// entityId — hash-prefixed bare: @#N. Word boundaries enforced via
// (?<![\w@]) (no preceding word char or @) and (?![\w]) (no trailing
// word char). The 1-3 digit cap prevents matching giant numbers.
const ENTITY_ID_HASH_RE = /(?<![\w@])@#(\d{1,3})(?![\w])/g;

// entityId — bare: @N. Same boundary rules as @#N.
const ENTITY_ID_BARE_RE = /(?<![\w@])@(\d{1,3})(?![\w])/g;

// ── Markdown code-span stripping ─────────────────────────────────────────────
// Markdown renders @tokens inside code spans as literal text, not routing
// targets.  Strip them before running mention regexes so a example like
// "use `@00vt9i` as shown" is not mis-routed.
//
// Strategy: fenced code blocks first (```…```), then inline code (`…`).
// We replace with a placeholder that contains no `@` so subsequent regexes
// provably cannot re-emit it.
const MARKDOWN_FENCED_CODE_RE = /```[\s\S]*?```/g;
const MARKDOWN_INLINE_CODE_RE = /`[^`\n]+`/g;
const _CODE_PLACEHOLDER = '\x00CODE\x00';
const _CODE_PLACEHOLDER_RE = /\x00CODE\x00/g;

// @all literal — must be a standalone word.
const ALL_TOKEN_RE=/(^|\s)@all/i;
// Global form for stripping @all (sequential .replace() needs the /g flag).
const ALL_TOKEN_GLOBAL_RE = /(^|\s)@all(?=\s|$|[^\w])/gi;

/**
 * Parse mention tokens from raw text and resolve them against the in-memory
 * device map / publicCodeIndex.
 *
 * @param {string} text
 * @param {object} ctx
 * @param {string} ctx.senderDeviceId - sender device, used to flag cross-device
 *                                      and to resolve same-device entityId tokens.
 * @param {object} ctx.devices - in-memory devices map.
 * @param {object} ctx.publicCodeIndex - publicCode -> { deviceId, entityId }.
 * @returns {ParseResult}
 *
 * ParseResult:
 *   text: original text (unchanged)
 *   displayText: tokens replaced with @name (unresolved tokens left as-is)
 *   cleanText: tokens stripped entirely, whitespace normalised
 *   hasAll: boolean — @all literal present
 *   mentions: Mention[] — resolved entity mentions, deduped by publicCode
 *   unresolved: string[] — token contents that failed to resolve
 *
 * Mention:
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

    // Strip markdown code spans (inline `code` and fenced ```code```) before
    // parsing.  Markdown renders tokens inside code spans as literal text, not
    // routing targets; stripping prevents e.g. "use `@00vt9i` as shown" from
    // being mis-routed.
    const stripped = text
        .replace(MARKDOWN_FENCED_CODE_RE, _CODE_PLACEHOLDER)
        .replace(MARKDOWN_INLINE_CODE_RE, _CODE_PLACEHOLDER);

    // @all literal — test on markdown-stripped text so `@all` inside a code
    // block is not treated as a broadcast trigger.
    if (ALL_TOKEN_RE.test(stripped)) result.hasAll = true;

    const seenPublicCodes = new Set();

    // Resolve a numeric entityId against the sender device. Returns the
    // entity object on success, or null on failure (out of range, unbound,
    // or no publicCode). Adds to result.mentions/unresolved as appropriate.
    const resolveEntityId = (eid) => {
        if (!Number.isFinite(eid) || eid < 0) {
            result.unresolved.push(`#${eid}`);
            return;
        }
        const senderDevice = devices[senderDeviceId];
        const entity = senderDevice && senderDevice.entities && senderDevice.entities[eid];
        if (!entity || !entity.isBound || !entity.publicCode) {
            result.unresolved.push(`#${eid}`);
            return;
        }
        if (seenPublicCodes.has(entity.publicCode)) return; // already added via another form
        seenPublicCodes.add(entity.publicCode);
        result.mentions.push({
            publicCode: entity.publicCode,
            deviceId: senderDeviceId,
            entityId: eid,
            name: entity.name || `Entity ${eid}`,
            isCrossDevice: false,
            isBound: true
        });
    };

    // 1. publicCode tokens — <@xxxxxx> (bracketed) and @xxxxxx (bare).
    //    Both shapes resolve identically; bracketed form is the chat input
    //    canonical and is preferred when the message originates from the UI.
    //    The bare form is what LLMs naturally write and is parsed as a
    //    convenience so routing intent in `@codex hi` style still works.
    let m;
    const resolvePublicCodeToken = (code) => {
        if (seenPublicCodes.has(code)) return;
        const target = publicCodeIndex[code];
        if (!target) {
            result.unresolved.push(code);
            return;
        }
        const device = devices[target.deviceId];
        const entity = device && device.entities && device.entities[target.entityId];
        if (!entity || !entity.isBound) {
            result.unresolved.push(code);
            return;
        }
        seenPublicCodes.add(code);
        result.mentions.push({
            publicCode: code,
            deviceId: target.deviceId,
            entityId: target.entityId,
            name: entity.name || `Entity ${target.entityId}`,
            isCrossDevice: target.deviceId !== senderDeviceId,
            isBound: true
        });
    };

    PUBLIC_CODE_TOKEN_RE.lastIndex = 0;
    while ((m = PUBLIC_CODE_TOKEN_RE.exec(stripped)) !== null) {
        resolvePublicCodeToken(m[1]);
    }

    PUBLIC_CODE_BARE_RE.lastIndex = 0;
    while ((m = PUBLIC_CODE_BARE_RE.exec(stripped)) !== null) {
        resolvePublicCodeToken(m[1]);
    }

    // 2. entityId tokens — <@N>, @#N, @N (in that order; later forms only
    //    add new entityIds since resolveEntityId dedupes by publicCode).
    for (const re of [ENTITY_ID_BRACKET_RE, ENTITY_ID_HASH_RE, ENTITY_ID_BARE_RE]) {
        re.lastIndex = 0;
        while ((m = re.exec(stripped)) !== null) {
            resolveEntityId(parseInt(m[1], 10));
        }
    }

    // 3. displayText: replace each recognised token form with @name.
    //    Order matches resolution order so a `<@123456>` (resolved as
    //    publicCode) is replaced before the bracketed-digit pass sees it.
    const replaceWithName = (regex, lookup) => {
        result.displayText = result.displayText.replace(regex, (match, captured) => {
            const hit = lookup(captured);
            return hit ? `@${hit.name}` : match;
        });
    };
    replaceWithName(PUBLIC_CODE_TOKEN_RE, (code) =>
        result.mentions.find(x => x.publicCode === code));
    replaceWithName(PUBLIC_CODE_BARE_RE, (code) =>
        result.mentions.find(x => x.publicCode === code));
    const findByEntityId = (id) => {
        const eid = parseInt(id, 10);
        return result.mentions.find(x => !x.isCrossDevice && x.entityId === eid);
    };
    replaceWithName(ENTITY_ID_BRACKET_RE, findByEntityId);
    replaceWithName(ENTITY_ID_HASH_RE, findByEntityId);
    replaceWithName(ENTITY_ID_BARE_RE, findByEntityId);

    // 4. cleanText: strip every token form + @all + code placeholders; collapse whitespace.
    //    Uses `stripped` (markdown removed) so code-span tokens are not re-stripped.
    result.cleanText = stripped
        .replace(PUBLIC_CODE_TOKEN_RE, '')
        .replace(PUBLIC_CODE_BARE_RE, '')
        .replace(ENTITY_ID_BRACKET_RE, '')
        .replace(ENTITY_ID_HASH_RE, '')
        .replace(ENTITY_ID_BARE_RE, '')
        .replace(ALL_TOKEN_GLOBAL_RE, '$1')
        .replace(_CODE_PLACEHOLDER_RE, '')
        .replace(/\s+/g, ' ')
        .trim();

    return result;
}

/**
 * Decide the routing strategy from a parse result.
 *
 *   - @all present → broadcast mode (ignore individual mentions)
 *   - ≥1 entity mention → parallel speakTo
 *   - Otherwise → 'none' (caller handles via existing entityId logic)
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
 * Strip every recognised mention token form + @all literal + markdown code
 * spans from text.  Used by Gatekeeper so token syntax never reaches
 * sensitive-word detection.
 */
function stripMentionTokens(text) {
    if (!text || typeof text !== 'string') return text;
    return text
        // Strip markdown code spans first so tokens inside them are removed.
        .replace(MARKDOWN_FENCED_CODE_RE, _CODE_PLACEHOLDER)
        .replace(MARKDOWN_INLINE_CODE_RE, _CODE_PLACEHOLDER)
        .replace(PUBLIC_CODE_TOKEN_RE, '')
        .replace(PUBLIC_CODE_BARE_RE, '')
        .replace(ENTITY_ID_BRACKET_RE, '')
        .replace(ENTITY_ID_HASH_RE, '')
        .replace(ENTITY_ID_BARE_RE, '')
        .replace(ALL_TOKEN_GLOBAL_RE, '$1')
        .replace(_CODE_PLACEHOLDER_RE, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Build a JSON-safe payload for chat_messages.mentions storage and
 * eclaw_context injection. Returns null when nothing to store.
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
    // Regex exports kept for compatibility with any consumer that imported them.
    MENTION_TOKEN_RE: PUBLIC_CODE_TOKEN_RE,
    PUBLIC_CODE_TOKEN_RE,
    PUBLIC_CODE_BARE_RE,
    ENTITY_ID_BRACKET_RE,
    ENTITY_ID_HASH_RE,
    ENTITY_ID_BARE_RE,
    ALL_TOKEN_RE
};
