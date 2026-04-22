/**
 * Unit tests for mindmap-mirror (Route A — Mirror mode).
 *
 * Uses an in-memory fake pool that mimics the Postgres pool surface
 * (`.query(sql, params)` returning `{ rowCount, rows }`) just enough to
 * exercise the mirror helpers end-to-end without a live DB.
 *
 * The fake models three tables — mindmap_nodes, mindmap_edges,
 * mindmap_node_anchors — and supports just the SQL shapes the mirror
 * issues. It's deliberately narrow: the point is to verify the mirror's
 * behaviour (idempotency, parent_of wiring, category domain reuse), not
 * to reimplement Postgres.
 */
'use strict';

const mirror = require('../../mindmap-mirror');

function makeFakePool() {
    let nodeSeq = 1;
    let edgeSeq = 1;
    let anchorSeq = 1;
    const nodes = [];
    const edges = [];
    const anchors = [];

    function uuid(prefix, n) {
        const hex = n.toString(16).padStart(12, '0');
        return `${prefix.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${hex}`;
    }

    async function query(sql, params) {
        const norm = sql.replace(/\s+/g, ' ').trim();

        // findNodeIdForNote
        if (norm.startsWith("SELECT node_id FROM mindmap_node_anchors WHERE device_id = $1 AND anchor_type = 'note' AND anchor_ref = $2")) {
            const [deviceId, noteId] = params;
            const row = anchors.find(a =>
                a.device_id === deviceId && a.anchor_type === 'note' && a.anchor_ref === String(noteId)
            );
            return row
                ? { rowCount: 1, rows: [{ node_id: row.node_id }] }
                : { rowCount: 0, rows: [] };
        }

        // ensureCategoryDomainNode lookup
        if (norm.startsWith("SELECT n.id FROM mindmap_nodes n JOIN mindmap_node_anchors a ON a.node_id = n.id")) {
            const [deviceId, normCat] = params;
            const anchor = anchors.find(a =>
                a.device_id === deviceId && a.anchor_type === 'note_category' && a.anchor_ref === normCat
            );
            if (!anchor) return { rowCount: 0, rows: [] };
            const node = nodes.find(n => n.id === anchor.node_id && n.node_type === 'domain');
            return node
                ? { rowCount: 1, rows: [{ id: node.id }] }
                : { rowCount: 0, rows: [] };
        }

        // ensureParentOfEdge lookup
        if (norm.startsWith("SELECT id FROM mindmap_edges WHERE device_id = $1 AND source_node_id = $2 AND target_node_id = $3 AND edge_type = 'parent_of'")) {
            const [deviceId, source, target] = params;
            const edge = edges.find(e =>
                e.device_id === deviceId && e.source_node_id === source && e.target_node_id === target && e.edge_type === 'parent_of'
            );
            return edge ? { rowCount: 1, rows: [{ id: edge.id }] } : { rowCount: 0, rows: [] };
        }

        // INSERT node (domain or leaf)
        if (norm.startsWith('INSERT INTO mindmap_nodes')) {
            const [deviceId, entityId, title, summary, ...rest] = params;
            const isLeaf = norm.includes("'leaf'");
            const node = {
                id: uuid('node', nodeSeq++),
                device_id: deviceId,
                entity_id: entityId,
                title,
                summary,
                node_type: isLeaf ? 'leaf' : 'domain',
                parent_node_id: isLeaf ? rest[0] : null,
            };
            nodes.push(node);
            return { rowCount: 1, rows: [{ id: node.id }] };
        }

        // INSERT anchor (note or note_category) — anchor_type is a SQL literal,
        // not a placeholder, so it must be parsed from the VALUES clause.
        if (norm.startsWith('INSERT INTO mindmap_node_anchors')) {
            const [deviceId, nodeId, anchor_ref, display_label] = params;
            const anchor_type = norm.includes("'note_category'") ? 'note_category' : 'note';
            const row = {
                id: uuid('anch', anchorSeq++),
                device_id: deviceId,
                node_id: nodeId,
                anchor_type,
                anchor_ref,
                display_label,
            };
            anchors.push(row);
            return { rowCount: 1, rows: [row] };
        }

        // INSERT edge (parent_of)
        if (norm.startsWith('INSERT INTO mindmap_edges')) {
            const [deviceId, source, target] = params;
            const edge = {
                id: uuid('edge', edgeSeq++),
                device_id: deviceId,
                source_node_id: source,
                target_node_id: target,
                edge_type: 'parent_of',
            };
            edges.push(edge);
            return { rowCount: 1, rows: [{ id: edge.id }] };
        }

        // UPDATE node (title/summary)
        if (norm.startsWith('UPDATE mindmap_nodes SET title = $1, summary = $2')) {
            const [title, summary, nodeId, deviceId] = params;
            const node = nodes.find(n => n.id === nodeId && n.device_id === deviceId);
            if (!node) return { rowCount: 0, rows: [] };
            node.title = title;
            node.summary = summary;
            return { rowCount: 1, rows: [node] };
        }

        // UPDATE anchor display_label
        if (norm.startsWith('UPDATE mindmap_node_anchors SET display_label = $1')) {
            const [label, deviceId, nodeId] = params;
            let n = 0;
            for (const a of anchors) {
                if (a.device_id === deviceId && a.node_id === nodeId && a.anchor_type === 'note') {
                    a.display_label = label;
                    n++;
                }
            }
            return { rowCount: n, rows: [] };
        }

        // UPDATE node parent_node_id
        if (norm.startsWith('UPDATE mindmap_nodes SET parent_node_id = $1')) {
            const [parentId, nodeId, deviceId] = params;
            const node = nodes.find(n => n.id === nodeId && n.device_id === deviceId);
            if (!node) return { rowCount: 0, rows: [] };
            node.parent_node_id = parentId;
            return { rowCount: 1, rows: [node] };
        }

        // DELETE parent_of edges targeting a node (before re-linking on category change)
        if (norm.startsWith("DELETE FROM mindmap_edges WHERE device_id = $1 AND target_node_id = $2 AND edge_type = 'parent_of'")) {
            const [deviceId, nodeId] = params;
            const before = edges.length;
            for (let i = edges.length - 1; i >= 0; i--) {
                const e = edges[i];
                if (e.device_id === deviceId && e.target_node_id === nodeId && e.edge_type === 'parent_of') {
                    edges.splice(i, 1);
                }
            }
            return { rowCount: before - edges.length, rows: [] };
        }

        // DELETE node (cascade simulated)
        if (norm.startsWith('DELETE FROM mindmap_nodes WHERE id = $1 AND device_id = $2')) {
            const [nodeId, deviceId] = params;
            const idx = nodes.findIndex(n => n.id === nodeId && n.device_id === deviceId);
            if (idx < 0) return { rowCount: 0, rows: [] };
            nodes.splice(idx, 1);
            for (let i = edges.length - 1; i >= 0; i--) {
                if (edges[i].source_node_id === nodeId || edges[i].target_node_id === nodeId) edges.splice(i, 1);
            }
            for (let i = anchors.length - 1; i >= 0; i--) {
                if (anchors[i].node_id === nodeId) anchors.splice(i, 1);
            }
            return { rowCount: 1, rows: [{ id: nodeId }] };
        }

        throw new Error(`Fake pool: unhandled SQL\n${norm}`);
    }

    return { query, _state: { nodes, edges, anchors } };
}

const DEVICE_ID = 'device-A';
const ENTITY_ID = 2;

describe('mindmap-mirror — Route A mirror mode', () => {
    it('mirrorNoteCreate creates a leaf node + note anchor + parent_of edge to a domain node', async () => {
        const pool = makeFakePool();
        const note = { id: 'note-1', title: 'First note', content: 'hello world', category: 'ideas' };
        const r = await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID, note);
        expect(r.created).toBe(true);

        const { nodes, edges, anchors } = pool._state;
        expect(nodes).toHaveLength(2);
        const domain = nodes.find(n => n.node_type === 'domain');
        const leaf = nodes.find(n => n.node_type === 'leaf');
        expect(domain.title).toBe('ideas');
        expect(leaf.title).toBe('First note');
        expect(leaf.summary).toBe('hello world');
        expect(leaf.parent_node_id).toBe(domain.id);

        // Anchor points back to the note
        const noteAnchor = anchors.find(a => a.anchor_type === 'note');
        expect(noteAnchor.node_id).toBe(leaf.id);
        expect(noteAnchor.anchor_ref).toBe('note-1');

        // Category anchor on the domain for O(1) lookup next time
        const catAnchor = anchors.find(a => a.anchor_type === 'note_category');
        expect(catAnchor.node_id).toBe(domain.id);
        expect(catAnchor.anchor_ref).toBe('ideas');

        // parent_of edge from domain → leaf
        const edge = edges.find(e => e.edge_type === 'parent_of');
        expect(edge.source_node_id).toBe(domain.id);
        expect(edge.target_node_id).toBe(leaf.id);
    });

    it('two notes with the same category reuse one domain node', async () => {
        const pool = makeFakePool();
        await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n1', title: 'one', content: '', category: 'work' });
        await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n2', title: 'two', content: '', category: 'work' });

        const { nodes, edges } = pool._state;
        const domains = nodes.filter(n => n.node_type === 'domain');
        const leaves = nodes.filter(n => n.node_type === 'leaf');
        expect(domains).toHaveLength(1);
        expect(leaves).toHaveLength(2);
        expect(leaves.every(l => l.parent_node_id === domains[0].id)).toBe(true);
        expect(edges.filter(e => e.edge_type === 'parent_of')).toHaveLength(2);
    });

    it('category is normalized — "Ideas" and "ideas" resolve to the same domain', async () => {
        const pool = makeFakePool();
        await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n1', title: 'a', content: '', category: 'Ideas' });
        await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n2', title: 'b', content: '', category: 'ideas' });
        const domains = pool._state.nodes.filter(n => n.node_type === 'domain');
        expect(domains).toHaveLength(1);
    });

    it('missing/empty category falls back to DEFAULT_CATEGORY', async () => {
        const pool = makeFakePool();
        await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n1', title: 'a', content: '' });
        await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n2', title: 'b', content: '', category: '' });
        const domains = pool._state.nodes.filter(n => n.node_type === 'domain');
        expect(domains).toHaveLength(1);
        expect(domains[0].title).toBe('general');
    });

    it('content longer than SUMMARY_CLAMP is truncated to 200 chars', async () => {
        const pool = makeFakePool();
        const longContent = 'x'.repeat(500);
        await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n1', title: 'a', content: longContent, category: 'c' });
        const leaf = pool._state.nodes.find(n => n.node_type === 'leaf');
        expect(leaf.summary.length).toBe(200);
    });

    it('mirrorNoteCreate is idempotent — second call skips creation', async () => {
        const pool = makeFakePool();
        const note = { id: 'n1', title: 'a', content: '', category: 'c' };
        const r1 = await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID, note);
        const r2 = await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID, note);
        expect(r1.created).toBe(true);
        expect(r2.created).toBe(false);
        expect(r2.nodeId).toBe(r1.nodeId);
        expect(pool._state.nodes).toHaveLength(2);
    });

    it('mirrorNoteUpdate syncs title and summary on the existing leaf', async () => {
        const pool = makeFakePool();
        await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n1', title: 'old', content: 'old body', category: 'c' });
        await mirror.mirrorNoteUpdate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n1', title: 'new title', content: 'new body' });
        const leaf = pool._state.nodes.find(n => n.node_type === 'leaf');
        expect(leaf.title).toBe('new title');
        expect(leaf.summary).toBe('new body');
        const anchor = pool._state.anchors.find(a => a.anchor_type === 'note');
        expect(anchor.display_label).toBe('new title');
    });

    it('mirrorNoteUpdate with a new category repositions the leaf under a new domain', async () => {
        const pool = makeFakePool();
        await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n1', title: 'a', content: '', category: 'old' });
        const leafId = pool._state.nodes.find(n => n.node_type === 'leaf').id;
        await mirror.mirrorNoteUpdate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n1', title: 'a', content: '', category: 'new' });
        const domains = pool._state.nodes.filter(n => n.node_type === 'domain');
        expect(domains).toHaveLength(2);
        const newDomain = domains.find(d => d.title === 'new');
        const leaf = pool._state.nodes.find(n => n.id === leafId);
        expect(leaf.parent_node_id).toBe(newDomain.id);
        const parentEdges = pool._state.edges.filter(e => e.edge_type === 'parent_of' && e.target_node_id === leafId);
        expect(parentEdges).toHaveLength(1);
        expect(parentEdges[0].source_node_id).toBe(newDomain.id);
    });

    it('mirrorNoteUpdate creates a node if none existed yet (upsert behaviour)', async () => {
        const pool = makeFakePool();
        const r = await mirror.mirrorNoteUpdate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n1', title: 'a', content: '', category: 'c' });
        expect(r.created).toBe(true);
        expect(pool._state.nodes.filter(n => n.node_type === 'leaf')).toHaveLength(1);
    });

    it('mirrorNoteDelete removes the leaf and cascades edges + anchors', async () => {
        const pool = makeFakePool();
        await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n1', title: 'a', content: '', category: 'c' });
        const { nodes, edges, anchors } = pool._state;
        const leafId = nodes.find(n => n.node_type === 'leaf').id;
        await mirror.mirrorNoteDelete(pool, DEVICE_ID, 'n1');
        expect(nodes.find(n => n.id === leafId)).toBeUndefined();
        expect(edges.filter(e => e.target_node_id === leafId)).toHaveLength(0);
        expect(anchors.filter(a => a.node_id === leafId)).toHaveLength(0);
        // Domain stays put for the (now-empty) category
        expect(nodes.filter(n => n.node_type === 'domain')).toHaveLength(1);
    });

    it('mirrorNoteDelete is a no-op for a note that was never mirrored', async () => {
        const pool = makeFakePool();
        const r = await mirror.mirrorNoteDelete(pool, DEVICE_ID, 'never-mirrored');
        expect(r).toBeNull();
    });

    it('mirrorBackfill processes a batch and is idempotent on re-run', async () => {
        const pool = makeFakePool();
        const notes = [
            { id: 'n1', title: 'a', content: '', category: 'c' },
            { id: 'n2', title: 'b', content: '', category: 'c' },
            { id: 'n3', title: 'c', content: '', category: 'other' },
        ];
        const r1 = await mirror.mirrorBackfill(pool, DEVICE_ID, ENTITY_ID, notes);
        expect(r1).toEqual({ total: 3, created: 3, skipped: 0, errors: 0 });

        const r2 = await mirror.mirrorBackfill(pool, DEVICE_ID, ENTITY_ID, notes);
        expect(r2).toEqual({ total: 3, created: 0, skipped: 3, errors: 0 });

        expect(pool._state.nodes.filter(n => n.node_type === 'leaf')).toHaveLength(3);
        expect(pool._state.nodes.filter(n => n.node_type === 'domain')).toHaveLength(2);
    });

    it('empty title / empty content still produce a valid node with default title', async () => {
        const pool = makeFakePool();
        await mirror.mirrorNoteCreate(pool, DEVICE_ID, ENTITY_ID,
            { id: 'n1', title: '', content: '', category: 'c' });
        const leaf = pool._state.nodes.find(n => n.node_type === 'leaf');
        expect(leaf.title).toBe('(untitled note)');
    });
});
