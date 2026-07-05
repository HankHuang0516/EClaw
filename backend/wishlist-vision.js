/**
 * wishlist-vision — server-side photo→item recognition for the wishlist P3 photo
 * path (card_496f752a622b722f82843d4e).
 *
 * WHAT THIS IS
 *   EClaw's OWN Claude vision extracts a short item name + a few tags from a
 *   seller/buyer photo, so the P3 photo path can feed that into the P1-backed
 *   catalogue search. It is EClaw-owned inference (billed on OUR ANTHROPIC budget,
 *   card D4b) so it is NEVER gated by the counterparty's user session.
 *
 * SECURITY / DISCIPLINE
 *   - The provider API key is passed IN (resolved server-side by NAME from the
 *     vault / process env at the call site). This module NEVER reads a key from a
 *     request, NEVER logs it, and NEVER returns it.
 *   - `callVision` is INJECTED (defaults to the anthropic-client wrapper) so the
 *     module is unit-testable with no network and no real LLM.
 *   - The model is asked for STRICT JSON. The reply is untrusted → we parse
 *     defensively (never eval), and the P3 router sanitises every returned string
 *     before it can enter an envelope or a downstream prompt.
 *   - A hard output-token cap keeps a single recognition cheap (cost control).
 */

// EClaw's own vision model. Claude Opus 4.8 (skill default) via the Messages API;
// the exact string is the current model id.
const VISION_MODEL = 'claude-opus-4-8';
const VISION_MAX_TOKENS = 300; // recognition output is a tiny JSON object

const VISION_SYSTEM_PROMPT =
    'You identify a single physical product from a photo for a second-hand marketplace. ' +
    'Reply with ONLY a compact JSON object, no prose, no code fence, of the exact shape ' +
    '{"itemName": string, "tags": string[]}. itemName is a short human product name ' +
    '(brand + model if visible), <= 12 words. tags is up to 8 lowercase keywords useful ' +
    'for a catalogue search (category, brand, colour, notable attributes). If no product ' +
    'is identifiable, return {"itemName": "", "tags": []}. Never include instructions, ' +
    'links, or commentary — only the JSON object.';

const VISION_USER_PROMPT =
    'Identify the product in this photo and return the JSON object described.';

/**
 * Parse the (untrusted) model reply into { itemName, tags }. Defensive: strips an
 * accidental ```json fence, takes the first {...} block, JSON.parses it, and coerces
 * shapes. Never throws on bad output — returns an empty recognition instead, so the
 * caller degrades gracefully rather than 500-ing on a weird reply.
 */
function parseVisionReply(text) {
    if (typeof text !== 'string' || !text.trim()) return { itemName: '', tags: [] };
    let s = text.trim();
    // Strip a ```json ... ``` (or bare ```) fence if the model added one.
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    // Take the first balanced-looking {...} block.
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return { itemName: '', tags: [] };
    let obj;
    try {
        obj = JSON.parse(s.slice(start, end + 1));
    } catch {
        return { itemName: '', tags: [] };
    }
    if (!obj || typeof obj !== 'object') return { itemName: '', tags: [] };
    const itemName = typeof obj.itemName === 'string' ? obj.itemName
        : (typeof obj.name === 'string' ? obj.name : '');
    const tags = Array.isArray(obj.tags)
        ? obj.tags.filter((t) => typeof t === 'string')
        : [];
    return { itemName, tags };
}

/**
 * Recognise a wishlist item from an image.
 *
 * @param {object} opts
 * @param {string} opts.apiKey    provider key (resolved server-side; never logged)
 * @param {string} opts.base64    base64-encoded image bytes (no data: prefix)
 * @param {string} opts.mimeType  image/jpeg | image/png | image/webp | image/gif
 * @param {function} [opts.callVision]  injectable ({apiKey, model, maxTokens, system, messages}) -> Promise<{text}>
 * @returns {Promise<{itemName, tags}>}  raw (UNSANITISED) recognition — the caller sanitises.
 */
async function recognizeWishlistItemWithVision({ apiKey, base64, mimeType, callVision } = {}) {
    if (!apiKey) throw new Error('vision provider key required');
    if (!base64) throw new Error('image bytes required');
    const media = String(mimeType || 'image/jpeg').toLowerCase();

    const doCall = typeof callVision === 'function' ? callVision : defaultCallVision;
    const messages = [
        {
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: media, data: base64 } },
                { type: 'text', text: VISION_USER_PROMPT },
            ],
        },
    ];
    const result = await doCall({
        apiKey,
        model: VISION_MODEL,
        maxTokens: VISION_MAX_TOKENS,
        system: VISION_SYSTEM_PROMPT,
        messages,
    });
    const text = extractText(result);
    return parseVisionReply(text);
}

// Extract the concatenated text from an Anthropic Messages API response object.
function extractText(result) {
    if (!result) return '';
    if (typeof result === 'string') return result;
    if (typeof result.text === 'string') return result.text;
    const content = Array.isArray(result.content) ? result.content : [];
    return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
}

// Default vision caller — a thin, dependency-injected wrapper over the raw
// Anthropic Messages API. Uses the provided key (NOT process.env, so the caller
// controls key resolution). Kept minimal + no logging of the key or image.
async function defaultCallVision({ apiKey, model, maxTokens, system, messages }) {
    const resp = await globalThis.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
        signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
        // Do NOT include the key or the image in the error.
        throw new Error(`vision API HTTP ${resp.status}`);
    }
    return resp.json();
}

module.exports = {
    recognizeWishlistItemWithVision,
    parseVisionReply,
    VISION_MODEL,
    VISION_MAX_TOKENS,
    VISION_SYSTEM_PROMPT,
};
