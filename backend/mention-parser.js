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

// @all literal — must be a standalone word.
const ALL_TOKEN_RE = /(^|\s)@all(?=\s|$|[^\w])/i;
// Global form for stripping @all (sequential .replace() needs the /g flag).
const ALL_TOKEN_GLOBAL_RE = /(^|\s)@all(?=\s|$|[^\w])/gi;

function isMentionBoundaryBefore(text, atIndex) {
    if (atIndex <= 0) return true;
    const ch = text[atIndex - 1];
    return !(/[\p{L}\p{N}_@<]/u.test(ch));
}

function isMentionBoundaryAfter(text, endIndex) {
    if (endIndex >= text.length) return true;
    const ch = text[endIndex];
    return !(/[\p{L}\p{N}_]/u.test(ch));
}

function buildSameDeviceNameCandidates(senderDeviceId, devices) {
    const senderDevice = devices && devices[senderDeviceId];
    const entities = senderDevice && senderDevice.entities;
    if (!entities) return [];

    const seen = new Set();
    const out = [];
    for (const [entityIdRaw, entity] of Object.entries(entities)) {
        const entityId = parseInt(entityIdRaw, 10);
        if (!entity || !entity.isBound || !entity.publicCode || !Number.isFinite(entityId)) continue;
        const names = [entity.name, entity.character]
            .filter(v => typeof v === 'string')
            .map(v => v.trim())
            .filter(Boolean);
        for (const label of names) {
            const key = `${label}::${entity.publicCode}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                label,
                entityId,
                publicCode: entity.publicCode,
                deviceId: senderDeviceId,
                name: entity.name || entity.character || `Entity ${entityId}`,
                isCrossDevice: false,
                isBound: true
            });
        }
    }

    out.sort((a, b) => b.label.length - a.label.length);
    return out;
}

// Markdown code spans — examples / docs inside backticks must NOT route.
// Replace each code-span region with same-length whitespace so character
// indices stay aligned (in case any caller relies on them later) but no
// @-token inside survives the regex passes. Fenced blocks first so the
// inline single-backtick pass doesn't gobble triple-backtick fences.
function maskCodeSpansForRouting(text) {
    return text
        .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
        .replace(/`[^`\n]+`/g, (m) => ' '.repeat(m.length));
}

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

    // Mask code spans so example tokens in backticks don't route. Routing
    // detection runs against `routedText`; displayText/cleanText continue
    // to operate on the original `text` (display untouched, cleanText
    // still strips token characters for Gatekeeper).
    const routedText = maskCodeSpansForRouting(text);

    // @all literal
    if (ALL_TOKEN_RE.test(routedText)) result.hasAll = true;

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
    const namedMentionSpans = [];
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
    while ((m = PUBLIC_CODE_TOKEN_RE.exec(routedText)) !== null) {
        resolvePublicCodeToken(m[1]);
    }

    PUBLIC_CODE_BARE_RE.lastIndex = 0;
    while ((m = PUBLIC_CODE_BARE_RE.exec(routedText)) !== null) {
        resolvePublicCodeToken(m[1]);
    }

    // 2. entityId tokens — <@N>, @#N, @N (in that order; later forms only
    //    add new entityIds since resolveEntityId dedupes by publicCode).
    for (const re of [ENTITY_ID_BRACKET_RE, ENTITY_ID_HASH_RE, ENTITY_ID_BARE_RE]) {
        re.lastIndex = 0;
        while ((m = re.exec(routedText)) !== null) {
            resolveEntityId(parseInt(m[1], 10));
        }
    }

    // 3. same-device display-name mentions — `@阿尼雅_Codex5.5` and the
    //    common disambiguated form `@阿尼雅_Codex5.5 #6`. Historically the
    //    system only supported ASCII-ish publicCode / entityId tokens, so
    //    Chinese display-name mentions never routed. We intentionally keep
    //    this same-device-only to avoid ambiguous cross-device name matches.
    const sameDeviceNameCandidates = buildSameDeviceNameCandidates(senderDeviceId, devices);
    for (let at = routedText.indexOf('@'); at !== -1; at = routedText.indexOf('@', at + 1)) {
        if (!isMentionBoundaryBefore(routedText, at)) continue;
        const tail = routedText.slice(at + 1);
        for (const candidate of sameDeviceNameCandidates) {
            if (!tail.startsWith(candidate.label)) continue;
            const afterName = at + 1 + candidate.label.length;
            let end = afterName;
            const suffixMatch = routedText.slice(afterName).match(/^[\s　]*#(\d{1,3})(?![\p{L}\p{N}_])/u);
            if (suffixMatch && parseInt(suffixMatch[1], 10) === candidate.entityId) {
                end = afterName + suffixMatch[0].length;
            }
            if (!isMentionBoundaryAfter(routedText, end)) continue;
            if (!seenPublicCodes.has(candidate.publicCode)) {
                seenPublicCodes.add(candidate.publicCode);
                result.mentions.push({
                    publicCode: candidate.publicCode,
                    deviceId: candidate.deviceId,
                    entityId: candidate.entityId,
                    name: candidate.name,
                    isCrossDevice: false,
                    isBound: true
                });
            }
            namedMentionSpans.push({
                start: at,
                end,
                hit: {
                    publicCode: candidate.publicCode,
                    deviceId: candidate.deviceId,
                    entityId: candidate.entityId,
                    name: candidate.name,
                    isCrossDevice: false,
                    isBound: true
                },
                literal: routedText.slice(at, end)
            });
            break;
        }
    }

    // 4+5. Build displayText and cleanText by scanning routedText (code spans
    //      masked) and splicing replacements into the ORIGINAL text. This way
    //      backtick-wrapped tokens are preserved as-is in both outputs:
    //      display keeps the literal backticks visible, and Gatekeeper sees
    //      the full code-span content (only tokens outside backticks vanish).
    const findByEntityId = (id) => {
        const eid = parseInt(id, 10);
        return result.mentions.find(x => !x.isCrossDevice && x.entityId === eid);
    };
    const findByPublicCode = (code) =>
        result.mentions.find(x => x.publicCode === code);

    // Order matches resolution order: PUBLIC_CODE_TOKEN_RE first claims
    // <@xxxxxx> ranges so ENTITY_ID_BRACKET_RE can't reinterpret <@123456>.
    const passes = [
        { re: PUBLIC_CODE_TOKEN_RE, lookup: findByPublicCode },
        { re: PUBLIC_CODE_BARE_RE,  lookup: findByPublicCode },
        { re: ENTITY_ID_BRACKET_RE, lookup: findByEntityId },
        { re: ENTITY_ID_HASH_RE,    lookup: findByEntityId },
        { re: ENTITY_ID_BARE_RE,    lookup: findByEntityId },
    ];
    const spans = namedMentionSpans.slice();
    for (const { re, lookup } of passes) {
        re.lastIndex = 0;
        let mm;
        while ((mm = re.exec(routedText)) !== null) {
            spans.push({
                start: mm.index,
                end: mm.index + mm[0].length,
                hit: lookup(mm[1]),
                literal: mm[0],
            });
        }
    }
    // Sort by start; first occurrence at a position wins (later passes drop).
    spans.sort((a, b) => a.start - b.start);
    const filteredSpans = [];
    let lastEnd = -1;
    for (const s of spans) {
        if (s.start < lastEnd) continue; // overlapping later match — skip
        filteredSpans.push(s);
        lastEnd = s.end;
    }

    const sliceWith = (replacer) => {
        let out = '';
        let cursor = 0;
        for (const s of filteredSpans) {
            out += text.substring(cursor, s.start);
            out += replacer(s);
            cursor = s.end;
        }
        out += text.substring(cursor);
        return out;
    };
    result.displayText = sliceWith((s) => s.hit ? `@${s.hit.name}` : s.literal);

    // cleanText: strip recognised tokens (outside code spans) + @all,
    // collapse whitespace. Tokens inside code spans are left intact so
    // Gatekeeper still sees the full code-span content.
    result.cleanText = sliceWith(() => '')
        .replace(ALL_TOKEN_GLOBAL_RE, '$1')
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
 * Strip every recognised mention token form + @all literal from text.
 * Used by Gatekeeper so token syntax never reaches sensitive-word detection.
 */
function stripMentionTokens(text) {
    if (!text || typeof text !== 'string') return text;
    return text
        .replace(PUBLIC_CODE_TOKEN_RE, '')
        .replace(PUBLIC_CODE_BARE_RE, '')
        .replace(ENTITY_ID_BRACKET_RE, '')
        .replace(ENTITY_ID_HASH_RE, '')
        .replace(ENTITY_ID_BARE_RE, '')
        .replace(ALL_TOKEN_GLOBAL_RE, '$1')
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
