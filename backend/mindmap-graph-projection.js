/**
 * Mindmap force-graph projection — pure mapping functions.
 *
 * Spec: docs/spec/mindmap-force-graph.md
 *
 * Builds the `{nodes, links}` payload consumed by react-force-graph-2d
 * (public/portal/mindmap.html). All functions here are pure so the unit
 * tests in tests/jest/mindmap-graph.test.js can exercise the mapping
 * without booting express or pg.
 *
 * Edge type set (MVP):
 *   parent          — kanban_cards.parent_card_id
 *   blocks          — kanban_card_dependencies.dependency_type='blocks'
 *   owner           — assigned_bots / mission_notes.created_by
 *   note_on_card    — mission_note_card_links + mindmap_node_anchors cross-correlation (note + kanban_card)
 *   chat_anchor     — kanban_cards.chat_anchor_message_id + anchor cross-correlation
 *                     (amendment A from PR #2679 review)
 *   related/references/duplicates/causes/supports/contradicts
 *                   — kanban_card_links explicit non-hierarchical edges
 *   tag             — kanban_card_tags explicit tag membership, when includeTags=true
 */

'use strict';

const SCHEMA_VERSION = 2;
const LABEL_MAX = 80;
const TITLE_MAX = 200;
const SUMMARY_MAX = 240;
const NODE_LIMIT_DEFAULT = 1000;
const EDGE_LIMIT_DEFAULT = 2000;
const NODE_LIMIT_HARD = 2000;
const EDGE_LIMIT_HARD = 4000;

const PRIORITY_VAL = { P0: 8, P1: 6, P2: 4, P3: 3 };

function clip(s, max) {
    if (s === null || s === undefined) return '';
    const str = String(s);
    return str.length > max ? str.slice(0, max) : str;
}

function parseBoolFlag(raw, def) {
    if (raw === undefined || raw === null || raw === '') return def;
    const s = String(raw).toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
    return def;
}

function clampInt(raw, def, min, max) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
}

function parseNumericCreatedBy(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && String(n) === String(v).trim() ? n : null;
}

function pickOwnerEntityId(card) {
    const bots = Array.isArray(card.assigned_bots) ? card.assigned_bots : [];
    if (bots.length > 0 && Number.isFinite(bots[0])) return bots[0];
    if (Number.isFinite(card.created_by) && card.created_by !== 0) return card.created_by;
    return null;
}

function taskVal(priority, isAutomation, status) {
    let v = PRIORITY_VAL[priority] || 4;
    if (isAutomation) v += 1;
    if (status === 'blocked') v += 1;
    return v;
}

function buildTaskNode(card, commentCount, noteCount) {
    const ownerEntityId = pickOwnerEntityId(card);
    const assigned = (Array.isArray(card.assigned_bots) ? card.assigned_bots : []).filter(Number.isFinite);
    return {
        id: `task:${card.id}`,
        sourceId: card.id,
        label: clip(card.title, LABEL_MAX),
        fullTitle: clip(card.title, TITLE_MAX),
        type: 'task',
        status: card.status || 'todo',
        priority: card.priority || 'P2',
        ownerEntityId,
        assignedEntityIds: assigned,
        reviewerEntityId: card.reviewer_entity_id == null ? null : Number(card.reviewer_entity_id),
        parentCardId: card.parent_card_id || null,
        isAutomation: !!card.is_automation,
        archived: !!card.archived,
        summary: clip((card.description || '').replace(/\s+/g, ' ').trim(), SUMMARY_MAX),
        commentCount: Number.isFinite(commentCount) ? commentCount : 0,
        noteCount: Number.isFinite(noteCount) ? noteCount : 0,
        updatedAt: card.updated_at ? new Date(card.updated_at).toISOString() : null,
        url: `/portal/kanban.html?card=${encodeURIComponent(card.id)}`,
        colorKey: `status:${card.status || 'todo'}`,
        val: taskVal(card.priority, card.is_automation, card.status),
    };
}

function buildNoteNode(note) {
    const ownerEntityId = parseNumericCreatedBy(note.created_by);
    return {
        id: `note:${note.id}`,
        sourceId: note.id,
        label: clip(note.title, LABEL_MAX),
        fullTitle: clip(note.title, TITLE_MAX),
        type: 'note',
        category: note.category || 'general',
        ownerEntityId,
        summary: clip((note.content || '').replace(/\s+/g, ' ').trim(), SUMMARY_MAX),
        updatedAt: note.updated_at ? new Date(note.updated_at).toISOString() : null,
        url: `/portal/mission.html?note=${encodeURIComponent(note.id)}`,
        colorKey: `note:${note.category || 'general'}`,
        val: 4,
    };
}

function buildOwnerNode(entityId, entityRecord) {
    const label = (entityRecord && (entityRecord.character || entityRecord.name)) || `Entity ${entityId}`;
    return {
        id: `owner:${entityId}`,
        sourceId: String(entityId),
        label: clip(label, LABEL_MAX),
        fullTitle: clip(label, TITLE_MAX),
        type: 'owner',
        ownerEntityId: entityId,
        avatar: (entityRecord && entityRecord.avatar) || null,
        colorKey: 'owner',
        val: 6,
    };
}


function buildTagNode(tag) {
    return {
        id: `tag:${tag.slug}`,
        sourceId: tag.slug,
        label: clip(tag.label || tag.slug, LABEL_MAX),
        fullTitle: clip(tag.label || tag.slug, TITLE_MAX),
        type: 'tag',
        slug: tag.slug,
        colorKey: 'tag',
        val: Math.max(3, Math.min(10, Number(tag.card_count) || 3)),
    };
}

function buildChatNode(messageId, displayLabel) {
    const label = displayLabel || `chat #${String(messageId).slice(0, 8)}`;
    return {
        id: `chat:${messageId}`,
        sourceId: messageId,
        label: clip(label, LABEL_MAX),
        fullTitle: clip(label, TITLE_MAX),
        type: 'chat',
        url: `/portal/chat.html?msg=${encodeURIComponent(messageId)}`,
        colorKey: 'chat',
        val: 3,
    };
}

function buildLink({ id, source, target, type, weight, evidence, directional }) {
    return {
        id,
        source,
        target,
        type,
        label: type,
        weight,
        directional: !!directional,
        colorKey: `edge:${type}`,
        evidence,
    };
}

/**
 * Apply node/edge caps. Drops trailing nodes after `limitNodes` (the caller
 * is responsible for sorting first), then drops any links whose endpoints
 * fell off, then caps total links at `limitEdges`. Returns truncation counts.
 */
function applyCaps(nodes, links, limitNodes, limitEdges) {
    let truncatedNodes = 0;
    let truncatedLinks = 0;
    if (nodes.length > limitNodes) {
        truncatedNodes = nodes.length - limitNodes;
        nodes.length = limitNodes;
    }
    const keptIds = new Set(nodes.map(n => n.id));
    const survivingLinks = links.filter(l => keptIds.has(l.source) && keptIds.has(l.target));
    truncatedLinks += links.length - survivingLinks.length;
    links.length = 0;
    links.push(...survivingLinks);
    if (links.length > limitEdges) {
        truncatedLinks += links.length - limitEdges;
        links.length = limitEdges;
    }
    return { truncatedNodes, truncatedLinks };
}

/**
 * Sort task cards before truncation per spec §8.2: non-archived first,
 * non-done first, P0→P3, then most recently updated. Mutates the array.
 */
function sortCardsForCap(cards) {
    const prio = { P0: 0, P1: 1, P2: 2, P3: 3 };
    cards.sort((a, b) => {
        const aArch = a.archived ? 1 : 0, bArch = b.archived ? 1 : 0;
        if (aArch !== bArch) return aArch - bArch;
        const aDone = a.status === 'done' ? 1 : 0, bDone = b.status === 'done' ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        const ap = prio[a.priority] ?? 4, bp = prio[b.priority] ?? 4;
        if (ap !== bp) return ap - bp;
        const at = a.updated_at ? new Date(a.updated_at).getTime() : 0;
        const bt = b.updated_at ? new Date(b.updated_at).getTime() : 0;
        return bt - at;
    });
}

/**
 * Parse query params off the request, returning a normalized options object.
 * `isDeviceAuth` toggles the default scope (device for deviceSecret,
 * entity for botSecret).
 */
function parseGraphOptions(query, { isDeviceAuth, callerEntityId }) {
    const scopeRaw = (query.scope || '').toString().toLowerCase();
    const scope = ['device', 'entity'].includes(scopeRaw)
        ? scopeRaw
        : (isDeviceAuth ? 'device' : 'entity');
    const includeOwnersRaw = (query.includeOwners || '').toString().toLowerCase();
    const includeOwners = ['none', 'active', 'all'].includes(includeOwnersRaw)
        ? includeOwnersRaw : 'active';
    return {
        scope,
        callerEntityId,
        includeArchived: parseBoolFlag(query.includeArchived, false),
        includeDone: parseBoolFlag(query.includeDone, false),
        includeNotes: parseBoolFlag(query.includeNotes, true),
        includeOwners,
        includeNeighbors: parseBoolFlag(query.includeNeighbors, scope === 'entity'),
        includeTextFallbackRefs: parseBoolFlag(query.includeTextFallbackRefs, false),
        includeTags: parseBoolFlag(query.includeTags, false),
        limitNodes: clampInt(query.limitNodes, NODE_LIMIT_DEFAULT, 1, NODE_LIMIT_HARD),
        limitEdges: clampInt(query.limitEdges, EDGE_LIMIT_DEFAULT, 1, EDGE_LIMIT_HARD),
    };
}

/**
 * Core projection — pure. Takes pre-fetched DB rows and the device entity
 * map, returns the final {nodes, links, stats} payload. The route in
 * mindmap.js is responsible for running the SQL batches and supplying these
 * inputs; this function does the mapping.
 */
function projectGraph({
    cards,
    initialCardIds,
    depRows,
    cardLinkRows = [],
    tagRows = [],
    noteCardLinkRows = [],
    commentCounts,
    noteCounts,
    notes,
    anchorRows,
    entityMap,
    options,
}) {
    const commentByCard = new Map(commentCounts.map(r => [r.card_id, r.cnt]));
    const noteByCard = new Map(noteCounts.map(r => [r.card_id, r.cnt]));

    const cardIds = new Set(cards.map(c => c.id));
    const noteIds = new Set(notes.map(n => n.id));

    // Group anchors by mindmap node so each node's anchor-set is queryable.
    const anchorsByNode = new Map();
    for (const a of anchorRows) {
        if (!anchorsByNode.has(a.node_id)) anchorsByNode.set(a.node_id, []);
        anchorsByNode.get(a.node_id).push(a);
    }

    const nodes = [];
    const links = [];
    const nodeIdSet = new Set();
    const ownerNeed = new Set();
    const sourceCounts = { task: 0, note: 0, owner: 0, chat: 0, tag: 0 };

    // ── Task nodes ──
    for (const c of cards) {
        const node = buildTaskNode(c, commentByCard.get(c.id) || 0, noteByCard.get(c.id) || 0);
        nodes.push(node);
        nodeIdSet.add(node.id);
        sourceCounts.task++;
        const owner = pickOwnerEntityId(c);
        if (owner != null) ownerNeed.add(owner);
        for (const eid of (Array.isArray(c.assigned_bots) ? c.assigned_bots : [])) {
            if (Number.isFinite(eid)) ownerNeed.add(eid);
        }
        if (c.reviewer_entity_id != null) ownerNeed.add(Number(c.reviewer_entity_id));
    }

    // ── Note nodes ──
    if (options.includeNotes) {
        for (const n of notes) {
            const node = buildNoteNode(n);
            nodes.push(node);
            nodeIdSet.add(node.id);
            sourceCounts.note++;
            if (node.ownerEntityId != null) ownerNeed.add(node.ownerEntityId);
        }
    }

    // ── Owner nodes ──
    if (options.includeOwners !== 'none') {
        const ownerCandidates = options.includeOwners === 'all'
            ? new Set([
                ...ownerNeed,
                ...Object.keys(entityMap || {}).map(k => parseInt(k, 10)).filter(Number.isFinite),
            ])
            : ownerNeed;
        for (const eid of ownerCandidates) {
            const id = `owner:${eid}`;
            if (nodeIdSet.has(id)) continue;
            nodes.push(buildOwnerNode(eid, entityMap && entityMap[eid]));
            nodeIdSet.add(id);
            sourceCounts.owner++;
        }
    }

    // ── Tag nodes ──
    if (options.includeTags) {
        const bySlug = new Map();
        for (const r of tagRows || []) {
            if (!cardIds.has(r.card_id) || !r.slug) continue;
            if (!bySlug.has(r.slug)) {
                bySlug.set(r.slug, { slug: r.slug, label: r.label || r.slug, card_count: 0 });
            }
            bySlug.get(r.slug).card_count += 1;
        }
        for (const tag of [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug))) {
            const id = `tag:${tag.slug}`;
            if (nodeIdSet.has(id)) continue;
            nodes.push(buildTagNode(tag));
            nodeIdSet.add(id);
            sourceCounts.tag++;
        }
    }

    // ── Chat nodes ── (amendment A: chat_message becomes a first-class graph node)
    // Source 1: kanban_cards.chat_anchor_message_id pinned at file-time.
    // Source 2: mindmap_node_anchors cross-correlation (a mindmap_node bridges
    //           note↔chat or card↔chat anchors).
    const chatMsgIds = new Set();
    for (const c of cards) {
        if (c.chat_anchor_message_id) chatMsgIds.add(c.chat_anchor_message_id);
    }
    for (const [, anchors] of anchorsByNode) {
        const chatAnchors = anchors.filter(a => a.anchor_type === 'chat_message');
        if (chatAnchors.length === 0) continue;
        const hasIncluded = anchors.some(a =>
            (a.anchor_type === 'kanban_card' && cardIds.has(a.anchor_ref)) ||
            (a.anchor_type === 'note' && noteIds.has(a.anchor_ref))
        );
        if (!hasIncluded) continue;
        for (const ca of chatAnchors) chatMsgIds.add(ca.anchor_ref);
    }
    for (const msgId of chatMsgIds) {
        const id = `chat:${msgId}`;
        if (nodeIdSet.has(id)) continue;
        nodes.push(buildChatNode(msgId));
        nodeIdSet.add(id);
        sourceCounts.chat++;
    }

    // ── Edges ──
    const edgeCounts = {
        parent: 0,
        blocks: 0,
        owner: 0,
        note_on_card: 0,
        chat_anchor: 0,
        tag: 0,
        related: 0,
        references: 0,
        duplicates: 0,
        causes: 0,
        supports: 0,
        contradicts: 0,
    };

    // 1. Parent edges (only when both endpoints in result set)
    for (const c of cards) {
        if (!c.parent_card_id || !cardIds.has(c.parent_card_id)) continue;
        links.push(buildLink({
            id: `parent:${c.parent_card_id}:${c.id}`,
            source: `task:${c.parent_card_id}`,
            target: `task:${c.id}`,
            type: 'parent',
            weight: 2,
            evidence: 'kanban_cards.parent_card_id',
            directional: true,
        }));
        edgeCounts.parent++;
    }

    // 2. Blocks edges (kanban_card_dependencies)
    for (const d of depRows) {
        if (!cardIds.has(d.card_id) || !cardIds.has(d.depends_on_card_id)) continue;
        if ((d.dependency_type || 'blocks') !== 'blocks') continue;
        links.push(buildLink({
            id: `blocks:${d.depends_on_card_id}:${d.card_id}`,
            source: `task:${d.depends_on_card_id}`,
            target: `task:${d.card_id}`,
            type: 'blocks',
            weight: 3,
            evidence: 'kanban_card_dependencies',
            directional: true,
        }));
        edgeCounts.blocks++;
    }

    // 3. Explicit non-hierarchical card links (kanban_card_links)
    for (const l of cardLinkRows) {
        if (!cardIds.has(l.source_card_id) || !cardIds.has(l.target_card_id)) continue;
        const relationType = String(l.relation_type || 'related').toLowerCase();
        const directional = ['references', 'causes', 'supports', 'contradicts'].includes(relationType);
        links.push(buildLink({
            id: `card_link:${relationType}:${l.source_card_id}:${l.target_card_id}`,
            source: `task:${l.source_card_id}`,
            target: `task:${l.target_card_id}`,
            type: relationType,
            weight: relationType === 'duplicates' ? 2 : 1.5,
            evidence: 'kanban_card_links',
            directional,
        }));
        edgeCounts[relationType] = (edgeCounts[relationType] || 0) + 1;
    }

    // 4. Tag edges (optional explicit clustering hubs)
    if (options.includeTags) {
        const seenTagLinks = new Set();
        for (const r of tagRows || []) {
            if (!cardIds.has(r.card_id) || !r.slug) continue;
            const src = `tag:${r.slug}`;
            const target = `task:${r.card_id}`;
            const key = `${src}|${target}`;
            if (!nodeIdSet.has(src) || seenTagLinks.has(key)) continue;
            seenTagLinks.add(key);
            links.push(buildLink({
                id: `tag:${r.slug}:${r.card_id}`,
                source: src,
                target,
                type: 'tag',
                weight: 1.8,
                evidence: 'kanban_card_tags',
                directional: false,
            }));
            edgeCounts.tag++;
        }
    }

    // 4. Owner edges
    if (options.includeOwners !== 'none') {
        for (const c of cards) {
            const bots = Array.isArray(c.assigned_bots) ? c.assigned_bots : [];
            for (const eid of bots) {
                if (!Number.isFinite(eid) || !nodeIdSet.has(`owner:${eid}`)) continue;
                links.push(buildLink({
                    id: `owner:${eid}:task:${c.id}`,
                    source: `owner:${eid}`,
                    target: `task:${c.id}`,
                    type: 'owner',
                    weight: 1,
                    evidence: 'kanban_cards.assigned_bots',
                    directional: false,
                }));
                edgeCounts.owner++;
            }
        }
        for (const n of notes) {
            const eid = parseNumericCreatedBy(n.created_by);
            if (eid == null || !nodeIdSet.has(`owner:${eid}`)) continue;
            links.push(buildLink({
                id: `owner:${eid}:note:${n.id}`,
                source: `owner:${eid}`,
                target: `note:${n.id}`,
                type: 'owner',
                weight: 1,
                evidence: 'mission_notes.created_by',
                directional: false,
            }));
            edgeCounts.owner++;
        }
    }

    // 4. note_on_card edges via first-class mission_note_card_links
    const seenNoteCard = new Set();
    for (const l of noteCardLinkRows) {
        if (!noteIds.has(l.note_id) || !cardIds.has(l.card_id)) continue;
        const key = `${l.note_id}->${l.card_id}`;
        if (seenNoteCard.has(key)) continue;
        seenNoteCard.add(key);
        links.push(buildLink({
            id: `note_card_link:${l.note_id}:${l.card_id}`,
            source: `note:${l.note_id}`,
            target: `task:${l.card_id}`,
            type: 'note_on_card',
            weight: 2.2,
            evidence: 'mission_note_card_links',
        }));
        edgeCounts.note_on_card++;
    }

    // 5. note_on_card edges via mindmap_node_anchors cross-correlation
    for (const [, anchors] of anchorsByNode) {
        const cardAnchors = anchors.filter(a => a.anchor_type === 'kanban_card');
        const noteAnchors = anchors.filter(a => a.anchor_type === 'note');
        if (cardAnchors.length === 0 || noteAnchors.length === 0) continue;
        for (const na of noteAnchors) {
            if (!nodeIdSet.has(`note:${na.anchor_ref}`)) continue;
            for (const ca of cardAnchors) {
                if (!nodeIdSet.has(`task:${ca.anchor_ref}`)) continue;
                const key = `${na.anchor_ref}|${ca.anchor_ref}`;
                if (seenNoteCard.has(key)) continue;
                seenNoteCard.add(key);
                links.push(buildLink({
                    id: `note_on_card:${na.anchor_ref}:${ca.anchor_ref}`,
                    source: `note:${na.anchor_ref}`,
                    target: `task:${ca.anchor_ref}`,
                    type: 'note_on_card',
                    weight: 2,
                    evidence: 'mindmap_node_anchors',
                    directional: false,
                }));
                edgeCounts.note_on_card++;
            }
        }
    }

    // 6. chat_anchor edges — amendment A
    //    6a) kanban_cards.chat_anchor_message_id direct field
    for (const c of cards) {
        const mid = c.chat_anchor_message_id;
        if (!mid || !nodeIdSet.has(`chat:${mid}`)) continue;
        links.push(buildLink({
            id: `chat_anchor:task:${c.id}:${mid}`,
            source: `task:${c.id}`,
            target: `chat:${mid}`,
            type: 'chat_anchor',
            weight: 1,
            evidence: 'kanban_cards.chat_anchor_message_id',
            directional: false,
        }));
        edgeCounts.chat_anchor++;
    }
    //    6b) mindmap_node_anchors cross-correlation (note↔chat / card↔chat)
    const seenChat = new Set();
    for (const [, anchors] of anchorsByNode) {
        const chatAnchors = anchors.filter(a => a.anchor_type === 'chat_message');
        if (chatAnchors.length === 0) continue;
        const noteAnchors = anchors.filter(a => a.anchor_type === 'note');
        const cardAnchors = anchors.filter(a => a.anchor_type === 'kanban_card');
        for (const ca of chatAnchors) {
            const chatId = `chat:${ca.anchor_ref}`;
            if (!nodeIdSet.has(chatId)) continue;
            for (const na of noteAnchors) {
                const src = `note:${na.anchor_ref}`;
                if (!nodeIdSet.has(src)) continue;
                const key = `${src}|${chatId}`;
                if (seenChat.has(key)) continue;
                seenChat.add(key);
                links.push(buildLink({
                    id: `chat_anchor:note:${na.anchor_ref}:${ca.anchor_ref}`,
                    source: src,
                    target: chatId,
                    type: 'chat_anchor',
                    weight: 1,
                    evidence: 'mindmap_node_anchors',
                    directional: false,
                }));
                edgeCounts.chat_anchor++;
            }
            for (const cda of cardAnchors) {
                const src = `task:${cda.anchor_ref}`;
                if (!nodeIdSet.has(src)) continue;
                const key = `${src}|${chatId}`;
                if (seenChat.has(key)) continue;
                seenChat.add(key);
                links.push(buildLink({
                    id: `chat_anchor:task:${cda.anchor_ref}:${ca.anchor_ref}`,
                    source: src,
                    target: chatId,
                    type: 'chat_anchor',
                    weight: 1,
                    evidence: 'mindmap_node_anchors',
                    directional: false,
                }));
                edgeCounts.chat_anchor++;
            }
        }
    }

    // ── Caps ──
    const { truncatedNodes, truncatedLinks } = applyCaps(
        nodes, links, options.limitNodes, options.limitEdges
    );

    // After truncation, re-tally source counts so they match `nodes`.
    const finalSourceCounts = { task: 0, note: 0, owner: 0, chat: 0, tag: 0 };
    for (const n of nodes) {
        if (finalSourceCounts[n.type] !== undefined) finalSourceCounts[n.type]++;
    }
    const finalEdgeCounts = {};
    for (const l of links) {
        finalEdgeCounts[l.type] = (finalEdgeCounts[l.type] || 0) + 1;
    }
    for (const key of Object.keys(edgeCounts)) {
        if (finalEdgeCounts[key] === undefined) finalEdgeCounts[key] = 0;
    }

    return {
        nodes,
        links,
        stats: {
            nodeCount: nodes.length,
            linkCount: links.length,
            truncated: truncatedNodes > 0 || truncatedLinks > 0,
            truncatedNodes,
            truncatedLinks,
            sourceCounts: finalSourceCounts,
            edgeCounts: finalEdgeCounts,
            initialCardScope: initialCardIds.size,
        },
    };
}

module.exports = {
    SCHEMA_VERSION,
    NODE_LIMIT_DEFAULT,
    EDGE_LIMIT_DEFAULT,
    NODE_LIMIT_HARD,
    EDGE_LIMIT_HARD,
    LABEL_MAX,
    SUMMARY_MAX,
    PRIORITY_VAL,
    clip,
    parseBoolFlag,
    clampInt,
    parseNumericCreatedBy,
    pickOwnerEntityId,
    taskVal,
    buildTaskNode,
    buildNoteNode,
    buildOwnerNode,
    buildTagNode,
    buildChatNode,
    buildLink,
    applyCaps,
    sortCardsForCap,
    parseGraphOptions,
    projectGraph,
};
