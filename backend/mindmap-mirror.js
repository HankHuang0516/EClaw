/**
 * Mindmap Mirror — Route A (Mirror mode) auto-pair between notes and mindmap.
 *
 * Every mission note gets a matching mindmap leaf node. Without an explicit
 * anchor the leaf hangs off a lazily-created domain node for the note's
 * category. With `note.anchor = {type:'kanban_card'|'chat_message', refId}`
 * (Phase 4) the leaf instead hangs off a lazily-created topic node bearing
 * the corresponding anchor — letting the mind-map render notes attached to
 * the specific card or chat message they were taken about.
 *
 * Ownership: this module writes directly to the `mindmap_nodes` /
 * `mindmap_edges` / `mindmap_node_anchors` tables via the shared pg pool.
 * All writes are device-scoped; a bad deviceId can never leak rows across
 * tenants because every query carries WHERE device_id = $1.
 *
 * Failure policy: every mirror call is called from mission.js AFTER the
 * source-of-truth note write has already committed. If a mirror call throws,
 * the caller logs + swallows — mindmap is a derived read model and must not
 * block note CRUD. Backfill is idempotent so a dropped write can be healed.
 */
'use strict';

const SUMMARY_CLAMP = 200;
const DEFAULT_CATEGORY = 'general';
const DEFAULT_TITLE = '(untitled note)';
const ANCHOR_LABEL_CLAMP = 80;

const PARENT_ANCHOR_TYPES = new Set(['kanban_card', 'chat_message']);

function normalizeAnchor(anchor) {
    if (!anchor || typeof anchor !== 'object') return null;
    const type = anchor.type;
    const refId = anchor.refId == null ? '' : String(anchor.refId).trim();
    if (!PARENT_ANCHOR_TYPES.has(type) || !refId) return null;
    const label = anchor.label == null ? null : clampStr(String(anchor.label).trim(), ANCHOR_LABEL_CLAMP);
    return { type, refId, label };
}

function clampStr(v, max) {
    if (v === null || v === undefined) return null;
    const s = String(v);
    return s.length > max ? s.slice(0, max) : s;
}

function normCategory(cat) {
    const c = (cat == null ? '' : String(cat)).trim();
    return (c || DEFAULT_CATEGORY).toLowerCase();
}

function displayCategory(cat) {
    const c = (cat == null ? '' : String(cat)).trim();
    return c || DEFAULT_CATEGORY;
}

function displayTitle(title) {
    const t = (title == null ? '' : String(title)).trim();
    return t || DEFAULT_TITLE;
}

async function findNodeIdForNote(pool, deviceId, noteId) {
    const r = await pool.query(
        `SELECT node_id FROM mindmap_node_anchors
         WHERE device_id = $1 AND anchor_type = 'note' AND anchor_ref = $2
         LIMIT 1`,
        [deviceId, String(noteId)]
    );
    return r.rowCount === 0 ? null : r.rows[0].node_id;
}

/**
 * Phase 4: lazy-create a topic mindmap node anchored at a specific kanban
 * card or chat message. Used when a note carries an explicit anchor so the
 * mind-map shows the note hanging off the thing it was actually written
 * about (instead of a generic category bucket).
 *
 * The node is reused across notes — many notes can hang off the same card
 * or message. Lookup is O(1) on (anchor_type, anchor_ref) thanks to the
 * existing index.
 */
async function ensureAnchoredTopicNode(pool, deviceId, entityId, anchor) {
    const norm = normalizeAnchor(anchor);
    if (!norm) return null;
    const existing = await pool.query(
        `SELECT n.id FROM mindmap_nodes n
         JOIN mindmap_node_anchors a ON a.node_id = n.id
         WHERE n.device_id = $1
           AND n.node_type = 'topic'
           AND a.anchor_type = $2
           AND a.anchor_ref = $3
         LIMIT 1`,
        [deviceId, norm.type, norm.refId]
    );
    if (existing.rowCount > 0) return existing.rows[0].id;

    const fallbackTitle = norm.type === 'kanban_card' ? '看板卡片' : '聊天訊息';
    const title = norm.label || fallbackTitle;
    const ins = await pool.query(
        `INSERT INTO mindmap_nodes (device_id, entity_id, title, summary, node_type)
         VALUES ($1, $2, $3, $4, 'topic') RETURNING id`,
        [
            deviceId,
            entityId == null ? null : entityId,
            title,
            `Auto-anchored ${norm.type} (${norm.refId.slice(0, 32)}) — notes about this item hang here.`,
        ]
    );
    const nodeId = ins.rows[0].id;
    await pool.query(
        `INSERT INTO mindmap_node_anchors (device_id, node_id, anchor_type, anchor_ref, display_label)
         VALUES ($1, $2, $3, $4, $5)`,
        [deviceId, nodeId, norm.type, norm.refId, title]
    );
    return nodeId;
}

async function ensureCategoryDomainNode(pool, deviceId, entityId, category) {
    const norm = normCategory(category);
    const existing = await pool.query(
        `SELECT n.id FROM mindmap_nodes n
         JOIN mindmap_node_anchors a ON a.node_id = n.id
         WHERE n.device_id = $1
           AND n.node_type = 'domain'
           AND a.anchor_type = 'note_category'
           AND a.anchor_ref = $2
         LIMIT 1`,
        [deviceId, norm]
    );
    if (existing.rowCount > 0) return existing.rows[0].id;

    const title = displayCategory(category);
    const ins = await pool.query(
        `INSERT INTO mindmap_nodes (device_id, entity_id, title, summary, node_type)
         VALUES ($1, $2, $3, $4, 'domain') RETURNING id`,
        [
            deviceId,
            entityId == null ? null : entityId,
            title,
            `Auto-generated category domain for "${title}" notes (mirror mode).`,
        ]
    );
    const nodeId = ins.rows[0].id;
    await pool.query(
        `INSERT INTO mindmap_node_anchors (device_id, node_id, anchor_type, anchor_ref, display_label)
         VALUES ($1, $2, 'note_category', $3, $4)`,
        [deviceId, nodeId, norm, title]
    );
    return nodeId;
}

async function ensureParentOfEdge(pool, deviceId, childId, parentId) {
    if (!childId || !parentId || childId === parentId) return null;
    const existing = await pool.query(
        `SELECT id FROM mindmap_edges
         WHERE device_id = $1
           AND source_node_id = $2
           AND target_node_id = $3
           AND edge_type = 'parent_of'
         LIMIT 1`,
        [deviceId, parentId, childId]
    );
    if (existing.rowCount > 0) return existing.rows[0].id;
    const ins = await pool.query(
        `INSERT INTO mindmap_edges (device_id, source_node_id, target_node_id, edge_type)
         VALUES ($1, $2, $3, 'parent_of') RETURNING id`,
        [deviceId, parentId, childId]
    );
    return ins.rows[0].id;
}

async function mirrorNoteCreate(pool, deviceId, entityId, note) {
    if (!note || !note.id) throw new Error('note.id required');

    const existing = await findNodeIdForNote(pool, deviceId, note.id);
    if (existing) return { nodeId: existing, created: false };

    // Phase 4: explicit anchor wins. Note hangs off the specific card /
    // chat-message node so the mind-map shows the relationship.
    const anchor = normalizeAnchor(note.anchor);
    let parentId;
    let parentKind;
    if (anchor) {
        parentId = await ensureAnchoredTopicNode(pool, deviceId, entityId, anchor);
        parentKind = anchor.type;
    } else {
        parentId = await ensureCategoryDomainNode(pool, deviceId, entityId, note.category);
        parentKind = 'category';
    }

    const title = displayTitle(note.title);
    const summary = clampStr(note.content, SUMMARY_CLAMP);

    const nodeRes = await pool.query(
        `INSERT INTO mindmap_nodes (device_id, entity_id, title, summary, node_type, parent_node_id)
         VALUES ($1, $2, $3, $4, 'leaf', $5) RETURNING id`,
        [deviceId, entityId == null ? null : entityId, title, summary, parentId]
    );
    const nodeId = nodeRes.rows[0].id;

    await pool.query(
        `INSERT INTO mindmap_node_anchors (device_id, node_id, anchor_type, anchor_ref, display_label)
         VALUES ($1, $2, 'note', $3, $4)`,
        [deviceId, nodeId, String(note.id), title]
    );
    await ensureParentOfEdge(pool, deviceId, nodeId, parentId);
    return { nodeId, created: true, parentNodeId: parentId, parentKind };
}

async function mirrorNoteUpdate(pool, deviceId, entityId, note) {
    if (!note || !note.id) return null;

    const nodeId = await findNodeIdForNote(pool, deviceId, note.id);
    if (!nodeId) return mirrorNoteCreate(pool, deviceId, entityId, note);

    const title = displayTitle(note.title);
    const summary = clampStr(note.content, SUMMARY_CLAMP);

    await pool.query(
        `UPDATE mindmap_nodes
         SET title = $1, summary = $2, updated_at = NOW()
         WHERE id = $3 AND device_id = $4`,
        [title, summary, nodeId, deviceId]
    );
    await pool.query(
        `UPDATE mindmap_node_anchors
         SET display_label = $1
         WHERE device_id = $2 AND node_id = $3 AND anchor_type = 'note'`,
        [title, deviceId, nodeId]
    );

    // Phase 4: re-parent if the anchor changed (or appeared/disappeared).
    // `note.anchor === null` is treated as an explicit clear — fall back to
    // category. `undefined` means caller didn't touch anchor; leave parent.
    const anchor = normalizeAnchor(note.anchor);
    const anchorTouched = note.anchor !== undefined;
    const categoryTouched = note.category !== undefined;

    if (anchorTouched || categoryTouched) {
        let newParentId;
        if (anchor) {
            newParentId = await ensureAnchoredTopicNode(pool, deviceId, entityId, anchor);
        } else {
            // No (or cleared) anchor: fall back to category domain. If
            // category wasn't touched either, look it up from the existing
            // node so we don't accidentally re-parent to 'general'.
            newParentId = await ensureCategoryDomainNode(pool, deviceId, entityId, note.category);
        }
        await pool.query(
            `UPDATE mindmap_nodes SET parent_node_id = $1
             WHERE id = $2 AND device_id = $3`,
            [newParentId, nodeId, deviceId]
        );
        await pool.query(
            `DELETE FROM mindmap_edges
             WHERE device_id = $1 AND target_node_id = $2 AND edge_type = 'parent_of'`,
            [deviceId, nodeId]
        );
        await ensureParentOfEdge(pool, deviceId, nodeId, newParentId);
    }
    return { nodeId, updated: true };
}

async function mirrorNoteDelete(pool, deviceId, noteId) {
    if (!noteId) return null;
    const nodeId = await findNodeIdForNote(pool, deviceId, noteId);
    if (!nodeId) return null;
    await pool.query(
        `DELETE FROM mindmap_nodes WHERE id = $1 AND device_id = $2`,
        [nodeId, deviceId]
    );
    return { nodeId, deleted: true };
}

async function mirrorBackfill(pool, deviceId, entityId, notes) {
    const result = { total: 0, created: 0, skipped: 0, errors: 0 };
    for (const note of (notes || [])) {
        result.total++;
        try {
            const r = await mirrorNoteCreate(pool, deviceId, entityId, note);
            if (r.created) result.created++;
            else result.skipped++;
        } catch (err) {
            result.errors++;
            console.error(`[MindmapMirror] backfill failed for note ${note && note.id}:`, err.message);
        }
    }
    return result;
}

module.exports = {
    mirrorNoteCreate,
    mirrorNoteUpdate,
    mirrorNoteDelete,
    mirrorBackfill,
    normalizeAnchor,
    _internal: {
        ensureCategoryDomainNode,
        ensureAnchoredTopicNode,
        ensureParentOfEdge,
        findNodeIdForNote,
        normCategory,
        normalizeAnchor,
        displayCategory,
        displayTitle,
        clampStr,
        SUMMARY_CLAMP,
        DEFAULT_CATEGORY,
        DEFAULT_TITLE,
        ANCHOR_LABEL_CLAMP,
        PARENT_ANCHOR_TYPES,
    },
};
