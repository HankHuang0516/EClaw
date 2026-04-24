'use strict';

/**
 * reference-resolver.js — async DB lookup layer for 智慧引用 references.
 *
 * Takes the output of reference-parser.js::scanReferences() and resolves each
 * ref to a structured entry with `{ resolved:true, title, status, priority,
 * lastComment }` (or `{ resolved:false, error:'not_found'|'unsupported' }`).
 *
 * Kept separate from reference-parser so the scanner stays a pure sync module
 * (no DB import, easy to unit test).
 */

const CARD_HEX_ONLY_RE = /^[a-f0-9]+$/i;

/**
 * Resolve a single card_ ref against kanban_cards. Handles short-prefix IDs
 * (8-12 hex) the same way GET /card/:id does: exact match first, then LIKE
 * prefix; if 2+ rows share a short prefix, mark as not_found so the bot
 * disambiguates instead of picking the wrong card.
 */
async function resolveCardRef(pool, deviceId, cardId) {
    let finalId = cardId;
    const body = cardId.startsWith('card_') ? cardId.slice(5) : cardId;
    if (CARD_HEX_ONLY_RE.test(body) && body.length >= 6 && body.length <= 12) {
        const match = await pool.query(
            `SELECT id FROM kanban_cards
             WHERE device_id = $1 AND (id = $2 OR id LIKE $3 OR id LIKE $4)
             ORDER BY created_at DESC LIMIT 2`,
            [deviceId, cardId, body + '%', 'card_' + body + '%']
        );
        if (match.rows.length === 1) finalId = match.rows[0].id;
        // 2+ matches → fall through, exact-match query below will 404.
    }

    const result = await pool.query(
        `SELECT id, title, status, priority FROM kanban_cards
         WHERE id = $1 AND device_id = $2`,
        [finalId, deviceId]
    );
    if (result.rows.length === 0) return { resolved: false, error: 'not_found' };

    const row = result.rows[0];
    let lastComment = null;
    try {
        const c = await pool.query(
            `SELECT text FROM kanban_comments
             WHERE card_id = $1 AND is_system = false
             ORDER BY created_at DESC LIMIT 1`,
            [row.id]
        );
        if (c.rows.length) lastComment = c.rows[0].text;
    } catch (_) { /* best-effort */ }

    return {
        resolved: true,
        title: row.title,
        status: row.status,
        priority: row.priority,
        lastComment,
        canonicalId: row.id,
    };
}

/**
 * Resolve a list of parsed references (from scanReferences()) against the DB
 * for a specific device. Returns an array of resolved entries with the same
 * shape reference-parser::buildReferencesBlock expects.
 */
async function resolveReferences(pool, deviceId, refs) {
    if (!Array.isArray(refs) || refs.length === 0) return [];
    if (!pool || !deviceId) return [];

    return Promise.all(refs.map(async (ref) => {
        const base = { refType: ref.refType, refId: ref.refId };
        if (ref.anchor) base.anchor = ref.anchor;

        try {
            if (ref.refType === 'card') {
                const r = await resolveCardRef(pool, deviceId, ref.refId);
                return { ...base, ...r };
            }
            if (ref.refType === 'src' && ref.kind === 'kanban' && ref.innerType === 'card') {
                // src://kanban/card/<id>[#anchor] — treat as card lookup
                const r = await resolveCardRef(pool, deviceId, 'card_' + ref.innerId);
                return { ...base, ...r };
            }
            // review_ and non-kanban src:// are not indexed yet
            return { ...base, resolved: false, error: 'unsupported' };
        } catch (err) {
            return { ...base, resolved: false, error: 'lookup_failed', _errMsg: String(err && err.message || err) };
        }
    }));
}

module.exports = {
    resolveReferences,
    resolveCardRef,
};
