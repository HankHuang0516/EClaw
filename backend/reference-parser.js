'use strict';

/**
 * reference-parser.js — detect 智慧引用 prefixes in plain message text.
 *
 * Pure scanner: no DB / async. Callers (channel push, webhook push) feed the
 * parsed refs into a lookup helper to build the context block the receiving
 * bot sees, so the bot can TRULY understand what's being referenced instead
 * of guessing from an opaque ID.
 *
 * Recognised prefixes (mirrors client-side frontend modules but scans plain
 * text, not HTML):
 *   card_<hex>       — kanban card (EntityLinkRender handles frontend)
 *   review_<slug>    — agent review (AutolinkChip handles frontend)
 *   src://<kind>/<type>/<id>[#anchor]  — source-anchor token (AutolinkChip)
 *
 * Intentionally NOT scanned here:
 *   note_<hex>       — NoteLinkRender frontend; separate context hook planned
 *   @mention / his_  — owned by mention-parser.js
 */

const CARD_RE   = /\bcard_([a-f0-9]{8}(?:[a-f0-9]{16}|-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?)\b/gi;
const REVIEW_RE = /\breview_([a-zA-Z0-9_-]{6,})\b/g;
const SRC_RE    = /\bsrc:\/\/([a-z]+)\/([a-z]+)\/([a-f0-9]{8,})(#[a-z0-9-]+)?\b/gi;

/**
 * Scan a plain message for reference tokens.
 * @param {string} text
 * @returns {Array<{refType:'card'|'review'|'src', refId:string, raw:string, anchor?:string, kind?:string, innerType?:string}>}
 *   Deduplicated, preserves order of first occurrence.
 */
function scanReferences(text) {
    if (!text || typeof text !== 'string') return [];
    const seen = new Set();
    const out = [];

    const push = (ref) => {
        const key = ref.refType + ':' + ref.refId;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(ref);
    };

    let m;
    // card_xxx
    CARD_RE.lastIndex = 0;
    while ((m = CARD_RE.exec(text)) !== null) {
        const id = 'card_' + m[1].toLowerCase();
        push({ refType: 'card', refId: id, raw: m[0] });
    }
    // review_xxx
    REVIEW_RE.lastIndex = 0;
    while ((m = REVIEW_RE.exec(text)) !== null) {
        const id = 'review_' + m[1];
        push({ refType: 'review', refId: id, raw: m[0] });
    }
    // src://kind/type/id[#anchor]
    SRC_RE.lastIndex = 0;
    while ((m = SRC_RE.exec(text)) !== null) {
        const kind = m[1].toLowerCase();
        const innerType = m[2].toLowerCase();
        const innerId = m[3].toLowerCase();
        const anchor = m[4] || null;
        const refId = `src://${kind}/${innerType}/${innerId}${anchor || ''}`;
        push({
            refType: 'src',
            refId,
            raw: m[0],
            anchor,
            kind,
            innerType,
            innerId,
        });
    }

    return out;
}

/**
 * Build the [REFERENCES — CONTEXT] block appended to the receiving bot's text.
 *
 * Takes a list of already-resolved refs (caller runs the DB lookup) and
 * produces a text block telling the bot what each ID actually points to.
 *
 * Each resolved entry has:
 *   { refType, refId, resolved: true|false, title?, status?, priority?,
 *     lastComment?, anchor?, error? }
 *
 * Unresolved refs include `{ resolved:false, error:'not_found'|'unsupported' }`
 * so the bot knows the ID was typed but couldn't be expanded, rather than
 * silently dropping the reference.
 */
function buildReferencesBlock(resolvedRefs) {
    if (!Array.isArray(resolvedRefs) || resolvedRefs.length === 0) return '';

    const lines = resolvedRefs.map((r) => {
        if (!r.resolved) {
            const reason = r.error === 'not_found' ? 'not found'
                : r.error === 'unsupported' ? 'type not indexed yet'
                : 'lookup failed';
            return `  • ${r.refId} — (${reason})`;
        }
        const parts = [];
        if (r.title) parts.push(`"${r.title}"`);
        if (r.status) parts.push(`status: ${r.status}`);
        if (r.priority) parts.push(`priority: ${r.priority}`);
        if (r.anchor) parts.push(`anchor: ${r.anchor}`);
        const head = `  • ${r.refId} — ${parts.join(', ') || '(no metadata)'}`;
        if (r.lastComment) {
            const c = String(r.lastComment).replace(/\s+/g, ' ').slice(0, 140);
            return `${head}\n      last comment: "${c}"`;
        }
        return head;
    });

    const countNoun = resolvedRefs.length === 1 ? 'reference' : 'references';
    const header = `[REFERENCES — CONTEXT] The user's message cites ${resolvedRefs.length} ${countNoun}; expanded below so you can understand what they refer to without guessing:`;
    return `${header}\n${lines.join('\n')}`;
}

module.exports = {
    scanReferences,
    buildReferencesBlock,
    // Exposed for unit tests / debug
    _CARD_RE: CARD_RE,
    _REVIEW_RE: REVIEW_RE,
    _SRC_RE: SRC_RE,
};
