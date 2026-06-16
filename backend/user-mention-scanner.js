/**
 * User-Mention Scanner — card_db71f4423cb1697f9935f460
 *
 * Detects `@<user_display_name>` tokens inside chat messages and resolves
 * them to the device whose owner has that display name. Triggers an extra
 * push notification ("you were mentioned") on top of the existing
 * cross-device push.
 *
 * Coexistence with backend/mention-parser.js — this scanner deliberately
 * defers to the entity-mention parser on any token that the parser would
 * already claim:
 *   - `@all`                              (broadcast keyword)
 *   - `@<6-char-alnum>` / `<@xxxxxx>`     (entity publicCode)
 *   - `@<digits>` / `@#<digits>` / `<@N>` (entity entityId)
 * For these the scanner skips the token entirely so we never collide with
 * the existing routing logic. Any other `@<word>` that isn't already
 * claimed is fair game for display-name resolution.
 *
 * Resolution rules:
 *   - Case-insensitive (display names are user-set free text — strict case
 *     would lose the feature for most users).
 *   - Word-boundary on both sides (Unicode-aware) so `email@example.com`,
 *     `@2pm`, version strings, etc. do NOT match.
 *   - Longest-prefix match against the index keys, so a display name
 *     "HankDev" wins over "Hank" when both exist and the text says
 *     `@HankDev`.
 *   - Display names containing spaces match the form `@"Display Name"`
 *     (quoted) only. Bare `@Display Name` would be ambiguous (where does
 *     the name end?) so we require the quote.
 *   - ReDoS-safe: no backtracking regexes. The whole scan is an indexOf
 *     walk + Map lookups. Hard cap of MAX_TOKENS_PER_MESSAGE prevents
 *     pathological inputs (e.g. 100k `@@@@` chars) from consuming CPU.
 *   - Per-message dedupe: at most one match per recipient deviceId — even
 *     if the same display name appears 100 times, the recipient gets one
 *     push event.
 *
 * Globe-user generalization: works for every device worldwide. No
 * allowlist, no per-tenant code paths, no language-specific assumptions
 * (the boundary check uses \p{L}\p{N}_ Unicode property escapes so CJK,
 * Cyrillic, Arabic, emoji-bearing names all parse the same way).
 *
 * Pure module — no DB access, no I/O. Caller injects the
 * userDisplayNameIndex (built once at startup, kept fresh on PUT
 * /api/device/user-profile). Easy to unit-test.
 */
'use strict';

// Hard cap on the number of `@` positions we'll examine per message.
// 256 is comfortably more than any real chat message and prevents a 1 MB
// payload of `@@@@…` from O(n) walking the whole index per `@`.
const MAX_TOKENS_PER_MESSAGE = 256;

// Maximum length of the token we even bother to compare to the index.
// devices.user_display_name is capped at 64 codepoints upstream, so any
// `@` token longer than 128 chars (allow some slack for combining marks)
// cannot match anything. Stops `@`+10MB-of-text from costing real time.
const MAX_TOKEN_SCAN_LEN = 128;

const UNICODE_WORD_RE = /[\p{L}\p{N}_]/u;
const ASCII_DIGIT_RE = /^\d+$/;
const ALPHANUM_LOWER_RE = /^[a-z0-9]+$/;

/**
 * Normalize a display name to its index key form. Done at both index-build
 * time and lookup time so we always compare apples to apples.
 *
 * Steps:
 *   1. Unicode NFKC normalize (so half/full-width, ligatures, etc. fold).
 *   2. Lowercase (case-insensitive matching).
 *   3. Trim + collapse internal whitespace to single space.
 *
 * Returns null for null/non-string/empty input — those never index/match.
 */
function normalizeNameKey(name) {
    if (name === null || name === undefined) return null;
    if (typeof name !== 'string') return null;
    // NFKC is the right form for visual identity matching (collapses ligatures,
    // half-width / full-width variants, compatibility composites).
    let s;
    try {
        s = name.normalize('NFKC');
    } catch (e) {
        // Older runtimes without NFKC — fall back to NFC.
        try { s = name.normalize('NFC'); } catch (e2) { s = name; }
    }
    s = s.toLowerCase().trim().replace(/\s+/g, ' ');
    return s.length > 0 ? s : null;
}

/**
 * Would this @-token already be claimed by mention-parser.js? If yes, skip
 * it here so the two systems never collide.
 *
 * @publicCode form: 6 lowercase alnum chars (then word-bounded).
 * @entityId form:   1-3 digits (`@123`, `@#123`).
 * @all literal:     case-insensitive 'all'.
 */
function isClaimedByEntityParser(token) {
    if (!token) return false;
    const lower = token.toLowerCase();
    if (lower === 'all') return true;
    // Bare entityId: 1-3 ASCII digits.
    if (ASCII_DIGIT_RE.test(token) && token.length <= 3) return true;
    // publicCode: exactly 6 lowercase alnum chars (the parser bare form).
    if (token.length === 6 && ALPHANUM_LOWER_RE.test(lower)) return true;
    return false;
}

/**
 * Build a userDisplayName -> Set<deviceId> index from the in-memory
 * devices map. Devices without a userDisplayName are skipped. Empty/null
 * normalize results are skipped.
 *
 * Returns { index, keysByLength } where keysByLength is the index keys
 * sorted by length descending — used by longest-prefix matching so the
 * scanner picks "HankDev" over "Hank" when both exist.
 */
function buildIndex(devices) {
    const index = new Map(); // normalizedKey -> Set<deviceId>
    if (!devices || typeof devices !== 'object') {
        return { index, keysByLength: [] };
    }
    for (const deviceId of Object.keys(devices)) {
        const dev = devices[deviceId];
        if (!dev) continue;
        const name = dev.userDisplayName;
        const key = normalizeNameKey(name);
        if (!key) continue;
        if (!index.has(key)) index.set(key, new Set());
        index.get(key).add(deviceId);
    }
    const keysByLength = Array.from(index.keys()).sort((a, b) => b.length - a.length);
    return { index, keysByLength };
}

/**
 * Has the position before atIndex a word boundary? Mirrors mention-parser.js
 * isMentionBoundaryBefore so the two scanners agree on what "@" looks like
 * in context.
 */
function boundaryBefore(text, atIndex) {
    if (atIndex <= 0) return true;
    const ch = text[atIndex - 1];
    // Don't match if preceded by word char, '@', or '<' (latter would put us
    // inside `<@xxxxxx>` which the entity parser owns).
    return !(/[\p{L}\p{N}_@<]/u.test(ch));
}

function boundaryAfter(text, endIndex) {
    if (endIndex >= text.length) return true;
    return !UNICODE_WORD_RE.test(text[endIndex]);
}

/**
 * Walk forward from `start` collecting word-character codepoints. Returns
 * { token, end } where token is the lowercased word (empty if no word
 * char), and end is the index just past the last word char. Stops at the
 * configured max length so a pathological all-letters payload can't blow
 * up CPU.
 */
function readWordToken(text, start) {
    let i = start;
    const max = Math.min(text.length, start + MAX_TOKEN_SCAN_LEN);
    while (i < max && UNICODE_WORD_RE.test(text[i])) i++;
    if (i === start) return { token: '', end: i };
    return { token: text.slice(start, i).toLowerCase(), end: i };
}

/**
 * For a `@"quoted display name"` form, read until the closing quote (or
 * end of line / max length). Returns { token, end } or null if the form
 * doesn't apply at start.
 */
function readQuotedToken(text, start) {
    const ch = text[start];
    if (ch !== '"') return null;
    const max = Math.min(text.length, start + 1 + MAX_TOKEN_SCAN_LEN);
    let i = start + 1;
    while (i < max && text[i] !== '"' && text[i] !== '\n') i++;
    if (i >= text.length || text[i] !== '"') return null; // no closing quote
    const inner = text.slice(start + 1, i);
    if (!inner) return null;
    return { token: inner, end: i + 1, isQuoted: true };
}

/**
 * Scan `text` for user-display-name mentions. Returns an array of unique
 * matches in first-occurrence order:
 *
 *   [{ deviceId, displayName, matchedKey, matchedAt, isQuoted }]
 *
 * `displayName` is the canonical-cased value from devices[deviceId].
 * `matchedKey` is the normalized key used for lookup (lowercase, NFKC).
 * `matchedAt` is the byte index of the leading `@` in the original text.
 *
 * The scanner dedupes per deviceId — even if the same user is `@`-ed
 * many times in one message, the result contains one entry per device.
 */
function findUserMentions(text, ctx) {
    const out = [];
    if (!text || typeof text !== 'string') return out;
    if (!ctx) return out;

    const devices = ctx.devices || {};
    const senderDeviceId = ctx.senderDeviceId || null;
    let index, keysByLength;
    if (ctx.userDisplayNameIndex && ctx.userDisplayNameIndex.index) {
        // Caller passed a prebuilt index.
        index = ctx.userDisplayNameIndex.index;
        keysByLength = ctx.userDisplayNameIndex.keysByLength
            || Array.from(index.keys()).sort((a, b) => b.length - a.length);
    } else {
        const built = buildIndex(devices);
        index = built.index;
        keysByLength = built.keysByLength;
    }

    if (index.size === 0) return out; // nobody has a display name set yet

    const seenDeviceIds = new Set();
    let scanned = 0;

    for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
        if (++scanned > MAX_TOKENS_PER_MESSAGE) break;
        if (!boundaryBefore(text, at)) continue;

        // Try quoted form first: `@"Display Name with spaces"`.
        const quoted = readQuotedToken(text, at + 1);
        let token = null;
        let endIndex = -1;
        let isQuoted = false;
        if (quoted) {
            token = quoted.token;
            endIndex = quoted.end;
            isQuoted = true;
        } else {
            const word = readWordToken(text, at + 1);
            if (!word.token) continue;       // bare `@` with no word after
            token = word.token;
            endIndex = word.end;
        }

        // Quoted form has its own closing quote as boundary; bare form
        // needs a Unicode word boundary AFTER the token.
        if (!isQuoted && !boundaryAfter(text, endIndex)) continue;

        // Defer entity-parser-claimed tokens. Quoted form is never an
        // entity-parser token (those don't accept quotes), so only check
        // for the bare form.
        if (!isQuoted && isClaimedByEntityParser(token)) continue;

        const normalized = normalizeNameKey(token);
        if (!normalized) continue;

        // Longest-prefix match: pick the longest index key that is a
        // prefix of the token AND has a word boundary at the prefix end.
        // For the quoted form, exact-equality is enough.
        let matchedKey = null;
        if (isQuoted) {
            if (index.has(normalized)) matchedKey = normalized;
        } else {
            for (const key of keysByLength) {
                if (key.length > normalized.length) continue;
                if (normalized === key) { matchedKey = key; break; }
                // Prefix + the next char in the original token must be a
                // word boundary (so "Hank" doesn't false-match inside
                // "Hankering"). Since `token` is lowercased ascii-or-unicode
                // and `key` is normalized, compare against `normalized` here.
                if (normalized.startsWith(key)) {
                    const nextCh = normalized[key.length];
                    if (!nextCh || !UNICODE_WORD_RE.test(nextCh)) {
                        matchedKey = key;
                        break;
                    }
                }
            }
        }
        if (!matchedKey) continue;

        const deviceIds = index.get(matchedKey);
        if (!deviceIds || deviceIds.size === 0) continue;

        for (const deviceId of deviceIds) {
            // Self-mention suppression: don't push the sender's own device.
            // That would be every message you wrote about yourself buzzing
            // your own phone.
            if (senderDeviceId && deviceId === senderDeviceId) continue;
            if (seenDeviceIds.has(deviceId)) continue;
            seenDeviceIds.add(deviceId);
            const canonical = (devices[deviceId] && devices[deviceId].userDisplayName) || matchedKey;
            out.push({
                deviceId,
                displayName: canonical,
                matchedKey,
                matchedAt: at,
                isQuoted
            });
        }
    }

    return out;
}

module.exports = {
    normalizeNameKey,
    isClaimedByEntityParser,
    buildIndex,
    findUserMentions,
    // Exposed for tests:
    MAX_TOKENS_PER_MESSAGE,
    MAX_TOKEN_SCAN_LEN
};
