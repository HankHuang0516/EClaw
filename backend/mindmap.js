/**
 * Mindmap MVP — Schema + CRUD + AI traverse
 *
 * Mounted at: /api/mindmap
 *
 * Card #19: 心智圖 MVP — 多層次 Zoom + Mini-map + 聚焦模式渲染架構.
 * Phases 1-3 ship the data layer + portal UI; Phase 4 adds the AI traverse
 * endpoint that reads a BFS subgraph anchored at a node and asks Claude to
 * reason across it.
 *
 * Dual-auth (deviceSecret OR botSecret+entityId) on every endpoint.
 * All rows are scoped by `device_id` — never leak between devices.
 *
 * Routes:
 *   POST   /node                        Create node
 *   GET    /node/:id                    Node detail (+ anchors + comments)
 *   PATCH  /node/:id                    Update title/summary/position/node_type/is_subgraph_root/parent_node_id
 *   DELETE /node/:id                    Delete node (cascade edges/anchors/comments via FK)
 *   GET    /subgraph?root=ID&depth=N    BFS N-hop subgraph rooted at node (nodes + edges)
 *   GET    /neighbors/:id               1-hop neighbors + connecting edges (for focus mode)
 *   POST   /edge                        Create edge
 *   DELETE /edge/:id                    Delete edge
 *   POST   /node/:id/anchor             Attach an external anchor to a node
 *   DELETE /anchor/:id                  Detach an anchor
 *   POST   /node/:id/comment            Leave a comment on a node
 *   GET    /node/:id/comments           List comments on a node
 *   POST   /traverse                    AI reasoning over a BFS subgraph (Phase 4)
 */

'use strict';

const express = require('express');
const safeEqual = require('./safe-equal');
const { callAnthropic } = require('./anthropic-client');
const mindmapMirror = require('./mindmap-mirror');
const graphProjection = require('./mindmap-graph-projection');

const NODE_TYPES = new Set(['domain', 'topic', 'leaf', 'concept']);
const EDGE_TYPES = new Set(['relates_to', 'causes', 'extends', 'opposes', 'parent_of']);
const ANCHOR_TYPES = new Set(['kanban_card', 'chat_message', 'note', 'file', 'url']);

const MAX_TRAVERSE_DEPTH = 4;
const MAX_TRAVERSE_NODES = 500;

function isUuid(s) {
    return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function clampStr(v, max) {
    if (v === null || v === undefined) return null;
    const s = String(v);
    return s.length > max ? s.slice(0, max) : s;
}

/**
 * Factory. `devices` is the shared in-memory device map from index.js so we
 * can reuse the exact same dual-auth pattern (deviceSecret OR botSecret+entityId).
 */
function createMindmapModule(devices) {
    let pool = null;

    const router = express.Router();

    // POST /traverse wraps an Anthropic call. Without this bucket a
    // botSecret holder could loop the endpoint and drain credits. Keyed by
    // deviceId+entityId (owner caller falls into an 'owner' bucket).
    const TRAVERSE_WINDOW_MS = 3600000; // 1 hour
    const TRAVERSE_MAX_PER_HOUR = 15;   // lower than chat (20/hr) — traverse
                                        // is heavier and less interactive
    const traverseRateLimit = {};

    function traverseRateKey(deviceId, entityId) {
        return `${deviceId}:${entityId == null ? 'owner' : entityId}`;
    }

    function checkTraverseRateLimit(deviceId, entityId) {
        const key = traverseRateKey(deviceId, entityId);
        const now = Date.now();
        const entry = traverseRateLimit[key];
        if (!entry || now - entry.windowStart > TRAVERSE_WINDOW_MS) {
            traverseRateLimit[key] = { count: 1, windowStart: now };
            return { allowed: true, remaining: TRAVERSE_MAX_PER_HOUR - 1 };
        }
        if (entry.count >= TRAVERSE_MAX_PER_HOUR) {
            return {
                allowed: false,
                retryAfterMs: TRAVERSE_WINDOW_MS - (now - entry.windowStart),
                remaining: 0,
            };
        }
        entry.count++;
        return { allowed: true, remaining: TRAVERSE_MAX_PER_HOUR - entry.count };
    }

    // Same GC cadence as ai-support.js — prune keys whose windows lapsed
    // more than one full window ago so the map can't grow unbounded.
    const traverseGcHandle = setInterval(() => {
        const now = Date.now();
        for (const key of Object.keys(traverseRateLimit)) {
            if (now - traverseRateLimit[key].windowStart > TRAVERSE_WINDOW_MS * 2) {
                delete traverseRateLimit[key];
            }
        }
    }, 1800000);
    if (traverseGcHandle.unref) traverseGcHandle.unref();

    async function initMindmapTables(p) {
        if (!p) return;
        pool = p;
        try {
            await p.query(`
                CREATE TABLE IF NOT EXISTS mindmap_nodes (
                    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    device_id         VARCHAR(64) NOT NULL,
                    entity_id         INTEGER,
                    title             TEXT NOT NULL,
                    summary           TEXT,
                    node_type         VARCHAR(16),
                    parent_node_id    UUID,
                    is_subgraph_root  BOOLEAN DEFAULT FALSE,
                    position          JSONB,
                    created_at        TIMESTAMPTZ DEFAULT NOW(),
                    updated_at        TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await p.query(`CREATE INDEX IF NOT EXISTS idx_mindmap_nodes_device ON mindmap_nodes(device_id)`);
            await p.query(`CREATE INDEX IF NOT EXISTS idx_mindmap_nodes_parent ON mindmap_nodes(parent_node_id)`);

            await p.query(`
                CREATE TABLE IF NOT EXISTS mindmap_edges (
                    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    device_id       VARCHAR(64) NOT NULL,
                    source_node_id  UUID NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
                    target_node_id  UUID NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
                    edge_type       VARCHAR(16),
                    weight          REAL DEFAULT 1.0,
                    created_at      TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await p.query(`CREATE INDEX IF NOT EXISTS idx_mindmap_edges_device ON mindmap_edges(device_id)`);
            await p.query(`CREATE INDEX IF NOT EXISTS idx_mindmap_edges_source ON mindmap_edges(source_node_id)`);
            await p.query(`CREATE INDEX IF NOT EXISTS idx_mindmap_edges_target ON mindmap_edges(target_node_id)`);

            await p.query(`
                CREATE TABLE IF NOT EXISTS mindmap_node_anchors (
                    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    device_id     VARCHAR(64) NOT NULL,
                    node_id       UUID NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
                    anchor_type   VARCHAR(16) NOT NULL,
                    anchor_ref    TEXT NOT NULL,
                    display_label TEXT,
                    created_at    TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await p.query(`CREATE INDEX IF NOT EXISTS idx_mindmap_anchors_node ON mindmap_node_anchors(node_id)`);
            await p.query(`CREATE INDEX IF NOT EXISTS idx_mindmap_anchors_ref  ON mindmap_node_anchors(anchor_type, anchor_ref)`);

            await p.query(`
                CREATE TABLE IF NOT EXISTS mindmap_node_comments (
                    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    device_id  VARCHAR(64) NOT NULL,
                    node_id    UUID NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
                    entity_id  INTEGER,
                    text       TEXT NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await p.query(`CREATE INDEX IF NOT EXISTS idx_mindmap_comments_node ON mindmap_node_comments(node_id, created_at DESC)`);

            console.log('[Mindmap] Schema ready');
        } catch (err) {
            console.error('[Mindmap] Schema init error:', err.message);
        }
    }

    // ── Dual auth. Returns the authenticated deviceId or null. ──
    function authenticate(req, res) {
        const params = { ...req.query, ...req.body };
        const { deviceId, deviceSecret, botSecret, entityId } = params;

        if (!deviceId) {
            res.status(400).json({ success: false, error: 'Missing deviceId' });
            return null;
        }
        const device = devices && devices[deviceId];
        if (!device) {
            res.status(401).json({ success: false, error: 'Invalid credentials' });
            return null;
        }

        if (deviceSecret) {
            if (safeEqual(device.deviceSecret, deviceSecret)) return deviceId;
        }
        if (botSecret && entityId !== undefined) {
            const entity = (device.entities || {})[entityId];
            if (entity && safeEqual(entity.botSecret, botSecret)) return deviceId;
        }
        if (!deviceSecret && !botSecret) {
            res.status(400).json({ success: false, error: 'Missing deviceSecret or botSecret' });
            return null;
        }
        res.status(401).json({ success: false, error: 'Invalid credentials' });
        return null;
    }

    function getEntityId(req) {
        const raw = (req.body && req.body.entityId) ?? (req.query && req.query.entityId);
        if (raw === undefined || raw === null || raw === '') return null;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : null;
    }

    function requirePool(res) {
        if (!pool) {
            res.status(503).json({ success: false, error: 'Database unavailable' });
            return false;
        }
        return true;
    }

    // ─── POST /node ──────────────────────────────────────────────────────────
    router.post('/node', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;

        const { title, summary, node_type, parent_node_id, is_subgraph_root, position } = req.body || {};
        if (!title || typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({ success: false, error: 'Missing title' });
        }
        if (node_type && !NODE_TYPES.has(node_type)) {
            return res.status(400).json({ success: false, error: `Invalid node_type (want one of: ${[...NODE_TYPES].join(', ')})` });
        }
        if (parent_node_id && !isUuid(parent_node_id)) {
            return res.status(400).json({ success: false, error: 'Invalid parent_node_id' });
        }

        try {
            if (parent_node_id) {
                const parent = await pool.query(
                    'SELECT id FROM mindmap_nodes WHERE id = $1 AND device_id = $2',
                    [parent_node_id, deviceId]
                );
                if (parent.rowCount === 0) {
                    return res.status(400).json({ success: false, error: 'parent_node_id not found on this device' });
                }
            }
            const entityId = getEntityId(req);
            const positionJson = position && typeof position === 'object' ? JSON.stringify(position) : null;
            const result = await pool.query(
                `INSERT INTO mindmap_nodes
                    (device_id, entity_id, title, summary, node_type, parent_node_id, is_subgraph_root, position)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
                 RETURNING *`,
                [
                    deviceId,
                    entityId,
                    clampStr(title, 500),
                    clampStr(summary, 8000),
                    node_type || null,
                    parent_node_id || null,
                    !!is_subgraph_root,
                    positionJson,
                ]
            );
            res.json({ success: true, node: result.rows[0] });
        } catch (err) {
            console.error('[Mindmap] POST /node failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── GET /node/:id ───────────────────────────────────────────────────────
    router.get('/node/:id', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ success: false, error: 'Invalid node id' });

        try {
            const [node, anchors, comments] = await Promise.all([
                pool.query('SELECT * FROM mindmap_nodes WHERE id = $1 AND device_id = $2', [id, deviceId]),
                pool.query('SELECT * FROM mindmap_node_anchors WHERE node_id = $1 AND device_id = $2 ORDER BY created_at', [id, deviceId]),
                pool.query('SELECT * FROM mindmap_node_comments WHERE node_id = $1 AND device_id = $2 ORDER BY created_at', [id, deviceId]),
            ]);
            if (node.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Node not found' });
            }
            res.json({
                success: true,
                node: node.rows[0],
                anchors: anchors.rows,
                comments: comments.rows,
            });
        } catch (err) {
            console.error('[Mindmap] GET /node/:id failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── PATCH /node/:id ─────────────────────────────────────────────────────
    router.patch('/node/:id', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ success: false, error: 'Invalid node id' });

        const allowed = ['title', 'summary', 'node_type', 'parent_node_id', 'is_subgraph_root', 'position'];
        const patch = {};
        for (const k of allowed) {
            if (k in (req.body || {})) patch[k] = req.body[k];
        }
        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ success: false, error: 'No allowed fields in body' });
        }
        if (patch.node_type !== undefined && patch.node_type !== null && !NODE_TYPES.has(patch.node_type)) {
            return res.status(400).json({ success: false, error: 'Invalid node_type' });
        }
        if (patch.parent_node_id !== undefined && patch.parent_node_id !== null && !isUuid(patch.parent_node_id)) {
            return res.status(400).json({ success: false, error: 'Invalid parent_node_id' });
        }
        if (patch.parent_node_id === id) {
            return res.status(400).json({ success: false, error: 'Node cannot be its own parent' });
        }

        const sets = [];
        const params = [];
        let i = 1;
        for (const [k, v] of Object.entries(patch)) {
            if (k === 'position') {
                sets.push(`position = $${i++}::jsonb`);
                params.push(v && typeof v === 'object' ? JSON.stringify(v) : null);
            } else if (k === 'title') {
                if (typeof v !== 'string' || !v.trim()) return res.status(400).json({ success: false, error: 'Invalid title' });
                sets.push(`title = $${i++}`); params.push(clampStr(v, 500));
            } else if (k === 'summary') {
                sets.push(`summary = $${i++}`); params.push(clampStr(v, 8000));
            } else if (k === 'is_subgraph_root') {
                sets.push(`is_subgraph_root = $${i++}`); params.push(!!v);
            } else {
                sets.push(`${k} = $${i++}`); params.push(v);
            }
        }
        sets.push(`updated_at = NOW()`);
        params.push(id, deviceId);

        try {
            if (patch.parent_node_id) {
                const parent = await pool.query(
                    'SELECT id FROM mindmap_nodes WHERE id = $1 AND device_id = $2',
                    [patch.parent_node_id, deviceId]
                );
                if (parent.rowCount === 0) {
                    return res.status(400).json({ success: false, error: 'parent_node_id not found on this device' });
                }
            }
            const result = await pool.query(
                `UPDATE mindmap_nodes SET ${sets.join(', ')}
                 WHERE id = $${i++} AND device_id = $${i++}
                 RETURNING *`,
                params
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Node not found' });
            }
            res.json({ success: true, node: result.rows[0] });
        } catch (err) {
            console.error('[Mindmap] PATCH /node/:id failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── DELETE /node/:id ────────────────────────────────────────────────────
    router.delete('/node/:id', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ success: false, error: 'Invalid node id' });

        try {
            const result = await pool.query(
                'DELETE FROM mindmap_nodes WHERE id = $1 AND device_id = $2 RETURNING id',
                [id, deviceId]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Node not found' });
            }
            res.json({ success: true, deleted: result.rows[0].id });
        } catch (err) {
            console.error('[Mindmap] DELETE /node/:id failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── GET /neighbors/:id ──────────────────────────────────────────────────
    router.get('/neighbors/:id', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ success: false, error: 'Invalid node id' });

        try {
            const center = await pool.query(
                'SELECT * FROM mindmap_nodes WHERE id = $1 AND device_id = $2',
                [id, deviceId]
            );
            if (center.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Node not found' });
            }
            const edges = await pool.query(
                `SELECT * FROM mindmap_edges
                 WHERE device_id = $1 AND (source_node_id = $2 OR target_node_id = $2)`,
                [deviceId, id]
            );
            const neighborIds = new Set();
            for (const e of edges.rows) {
                if (e.source_node_id !== id) neighborIds.add(e.source_node_id);
                if (e.target_node_id !== id) neighborIds.add(e.target_node_id);
            }
            const neighbors = neighborIds.size === 0 ? { rows: [] } : await pool.query(
                `SELECT * FROM mindmap_nodes
                 WHERE device_id = $1 AND id = ANY($2::uuid[])`,
                [deviceId, [...neighborIds]]
            );
            res.json({
                success: true,
                center: center.rows[0],
                neighbors: neighbors.rows,
                edges: edges.rows,
            });
        } catch (err) {
            console.error('[Mindmap] GET /neighbors/:id failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── GET /subgraph?root=ID&depth=N ───────────────────────────────────────
    router.get('/subgraph', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;
        const root = req.query.root;
        const depth = Math.min(MAX_TRAVERSE_DEPTH, Math.max(1, parseInt(req.query.depth, 10) || 1));
        if (!root || !isUuid(root)) {
            return res.status(400).json({ success: false, error: 'Invalid root id' });
        }

        try {
            const seed = await pool.query(
                'SELECT id FROM mindmap_nodes WHERE id = $1 AND device_id = $2',
                [root, deviceId]
            );
            if (seed.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Root node not found' });
            }

            // BFS by expanding frontier through edges, one hop at a time.
            const visited = new Set([root]);
            let frontier = [root];
            const allEdges = [];
            for (let hop = 0; hop < depth && frontier.length > 0 && visited.size < MAX_TRAVERSE_NODES; hop++) {
                const edges = await pool.query(
                    `SELECT * FROM mindmap_edges
                     WHERE device_id = $1
                       AND (source_node_id = ANY($2::uuid[]) OR target_node_id = ANY($2::uuid[]))`,
                    [deviceId, frontier]
                );
                const nextFrontier = [];
                for (const e of edges.rows) {
                    allEdges.push(e);
                    for (const nid of [e.source_node_id, e.target_node_id]) {
                        if (!visited.has(nid)) {
                            visited.add(nid);
                            nextFrontier.push(nid);
                            if (visited.size >= MAX_TRAVERSE_NODES) break;
                        }
                    }
                    if (visited.size >= MAX_TRAVERSE_NODES) break;
                }
                frontier = nextFrontier;
            }

            const uniqueEdges = Array.from(new Map(allEdges.map(e => [e.id, e])).values());
            const nodes = await pool.query(
                `SELECT * FROM mindmap_nodes WHERE device_id = $1 AND id = ANY($2::uuid[])`,
                [deviceId, [...visited]]
            );
            res.json({
                success: true,
                root,
                depth,
                truncated: visited.size >= MAX_TRAVERSE_NODES,
                nodes: nodes.rows,
                edges: uniqueEdges,
            });
        } catch (err) {
            console.error('[Mindmap] GET /subgraph failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── POST /edge ──────────────────────────────────────────────────────────
    router.post('/edge', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;
        const { source_node_id, target_node_id, edge_type, weight } = req.body || {};
        if (!isUuid(source_node_id) || !isUuid(target_node_id)) {
            return res.status(400).json({ success: false, error: 'Invalid source_node_id or target_node_id' });
        }
        if (source_node_id === target_node_id) {
            return res.status(400).json({ success: false, error: 'Edge source and target must differ' });
        }
        if (edge_type && !EDGE_TYPES.has(edge_type)) {
            return res.status(400).json({ success: false, error: `Invalid edge_type (want one of: ${[...EDGE_TYPES].join(', ')})` });
        }
        const w = weight === undefined ? 1.0 : parseFloat(weight);
        if (!Number.isFinite(w)) {
            return res.status(400).json({ success: false, error: 'Invalid weight' });
        }

        try {
            // Confirm both endpoints belong to this device.
            const both = await pool.query(
                `SELECT id FROM mindmap_nodes
                 WHERE device_id = $1 AND id = ANY($2::uuid[])`,
                [deviceId, [source_node_id, target_node_id]]
            );
            if (both.rowCount !== 2) {
                return res.status(400).json({ success: false, error: 'Both nodes must exist on this device' });
            }
            const result = await pool.query(
                `INSERT INTO mindmap_edges (device_id, source_node_id, target_node_id, edge_type, weight)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [deviceId, source_node_id, target_node_id, edge_type || null, w]
            );
            res.json({ success: true, edge: result.rows[0] });
        } catch (err) {
            console.error('[Mindmap] POST /edge failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── DELETE /edge/:id ────────────────────────────────────────────────────
    router.delete('/edge/:id', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ success: false, error: 'Invalid edge id' });

        try {
            const result = await pool.query(
                'DELETE FROM mindmap_edges WHERE id = $1 AND device_id = $2 RETURNING id',
                [id, deviceId]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Edge not found' });
            }
            res.json({ success: true, deleted: result.rows[0].id });
        } catch (err) {
            console.error('[Mindmap] DELETE /edge/:id failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── POST /node/:id/anchor ───────────────────────────────────────────────
    router.post('/node/:id/anchor', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ success: false, error: 'Invalid node id' });
        const { anchor_type, anchor_ref, display_label } = req.body || {};
        if (!ANCHOR_TYPES.has(anchor_type)) {
            return res.status(400).json({ success: false, error: `Invalid anchor_type (want one of: ${[...ANCHOR_TYPES].join(', ')})` });
        }
        if (!anchor_ref || typeof anchor_ref !== 'string' || !anchor_ref.trim()) {
            return res.status(400).json({ success: false, error: 'Missing anchor_ref' });
        }

        try {
            const node = await pool.query(
                'SELECT id FROM mindmap_nodes WHERE id = $1 AND device_id = $2',
                [id, deviceId]
            );
            if (node.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Node not found' });
            }
            const result = await pool.query(
                `INSERT INTO mindmap_node_anchors (device_id, node_id, anchor_type, anchor_ref, display_label)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [deviceId, id, anchor_type, clampStr(anchor_ref, 500), clampStr(display_label, 300)]
            );
            res.json({ success: true, anchor: result.rows[0] });
        } catch (err) {
            console.error('[Mindmap] POST /node/:id/anchor failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── DELETE /anchor/:id ──────────────────────────────────────────────────
    router.delete('/anchor/:id', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ success: false, error: 'Invalid anchor id' });

        try {
            const result = await pool.query(
                'DELETE FROM mindmap_node_anchors WHERE id = $1 AND device_id = $2 RETURNING id',
                [id, deviceId]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Anchor not found' });
            }
            res.json({ success: true, deleted: result.rows[0].id });
        } catch (err) {
            console.error('[Mindmap] DELETE /anchor/:id failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── POST /node/:id/comment ──────────────────────────────────────────────
    router.post('/node/:id/comment', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ success: false, error: 'Invalid node id' });
        const text = req.body && req.body.text;
        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ success: false, error: 'Missing text' });
        }
        try {
            const node = await pool.query(
                'SELECT id FROM mindmap_nodes WHERE id = $1 AND device_id = $2',
                [id, deviceId]
            );
            if (node.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Node not found' });
            }
            const entityId = getEntityId(req);
            const result = await pool.query(
                `INSERT INTO mindmap_node_comments (device_id, node_id, entity_id, text)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [deviceId, id, entityId, clampStr(text, 4000)]
            );
            res.json({ success: true, comment: result.rows[0] });
        } catch (err) {
            console.error('[Mindmap] POST /node/:id/comment failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── POST /traverse ─────────────────────────────────────────────────────
    // Phase 4: AI reasoning over a BFS subgraph anchored at root_node_id.
    // Fetches up to MAX_TRAVERSE_NODES nodes + their edges (depth clamped to
    // MAX_TRAVERSE_DEPTH), serializes them into a compact outline, and asks
    // Claude to answer the caller's question using only that subgraph.
    router.post('/traverse', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;

        const { root_node_id, question, entityId } = req.body || {};
        const gate = checkTraverseRateLimit(deviceId, entityId);
        if (!gate.allowed) {
            res.set('Retry-After', Math.ceil(gate.retryAfterMs / 1000));
            return res.status(429).json({
                success: false,
                error: 'Rate limit exceeded',
                retryAfterMs: gate.retryAfterMs,
                limit: TRAVERSE_MAX_PER_HOUR,
                windowMs: TRAVERSE_WINDOW_MS,
            });
        }

        if (!isUuid(root_node_id)) {
            return res.status(400).json({ success: false, error: 'Invalid root_node_id' });
        }
        if (!question || typeof question !== 'string' || !question.trim()) {
            return res.status(400).json({ success: false, error: 'Missing question' });
        }
        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(503).json({ success: false, error: 'AI unavailable (ANTHROPIC_API_KEY not set)' });
        }
        const depth = Math.min(MAX_TRAVERSE_DEPTH, Math.max(1, parseInt(req.body.depth, 10) || 2));

        try {
            const seed = await pool.query(
                'SELECT id FROM mindmap_nodes WHERE id = $1 AND device_id = $2',
                [root_node_id, deviceId]
            );
            if (seed.rowCount === 0) {
                return res.status(404).json({ success: false, error: 'Root node not found' });
            }

            // Identical BFS to GET /subgraph — kept inline so the two routes
            // can evolve independently (e.g. traverse may later weight edges).
            const visited = new Set([root_node_id]);
            let frontier = [root_node_id];
            const allEdges = [];
            for (let hop = 0; hop < depth && frontier.length > 0 && visited.size < MAX_TRAVERSE_NODES; hop++) {
                const edges = await pool.query(
                    `SELECT * FROM mindmap_edges
                     WHERE device_id = $1
                       AND (source_node_id = ANY($2::uuid[]) OR target_node_id = ANY($2::uuid[]))`,
                    [deviceId, frontier]
                );
                const nextFrontier = [];
                for (const e of edges.rows) {
                    allEdges.push(e);
                    for (const nid of [e.source_node_id, e.target_node_id]) {
                        if (!visited.has(nid)) {
                            visited.add(nid);
                            nextFrontier.push(nid);
                            if (visited.size >= MAX_TRAVERSE_NODES) break;
                        }
                    }
                    if (visited.size >= MAX_TRAVERSE_NODES) break;
                }
                frontier = nextFrontier;
            }

            const uniqueEdges = Array.from(new Map(allEdges.map(e => [e.id, e])).values());
            const nodeRows = await pool.query(
                `SELECT id, title, summary, node_type FROM mindmap_nodes
                 WHERE device_id = $1 AND id = ANY($2::uuid[])`,
                [deviceId, [...visited]]
            );

            const nodesById = new Map(nodeRows.rows.map(n => [n.id, n]));
            const rootRow = nodesById.get(root_node_id);
            const shortId = (id) => id.slice(0, 8);

            // Titles clamped to 120 alongside the existing summary/200 clamp.
            // A 500-node subgraph × long titles would blow a multi-KB prompt
            // otherwise; 120 is enough for any real human-written node title.
            const nodeLines = nodeRows.rows.map(n => {
                const typeTag = n.node_type ? `(${n.node_type})` : '(node)';
                const marker = n.id === root_node_id ? ' [ROOT]' : '';
                const summary = n.summary ? ` — ${clampStr(n.summary, 200)}` : '';
                return `- [${shortId(n.id)}]${marker} "${clampStr(n.title, 120)}" ${typeTag}${summary}`;
            });
            const edgeLines = uniqueEdges.map(e => {
                const src = nodesById.get(e.source_node_id);
                const tgt = nodesById.get(e.target_node_id);
                if (!src || !tgt) return null;
                const rel = e.edge_type || 'relates_to';
                return `- [${shortId(e.source_node_id)}] "${clampStr(src.title, 120)}" --(${rel})--> [${shortId(e.target_node_id)}] "${clampStr(tgt.title, 120)}"`;
            }).filter(Boolean);

            const systemPrompt = [
                'You are a reasoning engine over a mindmap subgraph.',
                'Use ONLY the nodes and edges provided. Do not invent nodes.',
                'When you reference a node, cite its short id in brackets like [a1b2c3d4].',
                'Be concise: answer in 2-6 sentences plus an optional bulleted path of reasoning.',
                'If the subgraph does not contain enough information, say so plainly.',
            ].join('\n');

            const userMessage = [
                `Root node: [${shortId(root_node_id)}] "${clampStr(rootRow?.title, 120) || '(unknown)'}"`,
                `Depth: ${depth}, Nodes: ${nodeRows.rows.length}, Edges: ${uniqueEdges.length}`,
                '',
                'Nodes:',
                nodeLines.join('\n') || '(none)',
                '',
                'Edges:',
                edgeLines.join('\n') || '(none)',
                '',
                `Question: ${clampStr(question, 2000)}`,
            ].join('\n');

            const result = await callAnthropic(systemPrompt, [
                { role: 'user', content: userMessage },
            ]);
            const answerText = (result.content || [])
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('\n')
                .trim();

            res.json({
                success: true,
                root: root_node_id,
                depth,
                truncated: visited.size >= MAX_TRAVERSE_NODES,
                node_count: nodeRows.rows.length,
                edge_count: uniqueEdges.length,
                visited_node_ids: [...visited],
                answer: answerText || '(no answer produced)',
            });
        } catch (err) {
            console.error('[Mindmap] POST /traverse failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── POST /mirror/backfill ───────────────────────────────────────────────
    // Route A (Mirror mode) one-shot backfill: ensures every note in
    // mission_dashboard.notes has a matching mindmap leaf node + note anchor.
    // Idempotent — re-running only creates nodes for notes that still lack one.
    router.post('/mirror/backfill', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;
        const entityId = getEntityId(req);
        try {
            const dash = await pool.query(
                'SELECT notes FROM mission_dashboard WHERE device_id = $1',
                [deviceId]
            );
            const notes = (dash.rows[0] && dash.rows[0].notes) || [];
            const result = await mindmapMirror.mirrorBackfill(pool, deviceId, entityId, notes);
            res.json({ success: true, ...result });
        } catch (err) {
            console.error('[Mindmap] POST /mirror/backfill failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── GET /node/:id/comments ──────────────────────────────────────────────
    router.get('/node/:id/comments', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;
        const { id } = req.params;
        if (!isUuid(id)) return res.status(400).json({ success: false, error: 'Invalid node id' });
        try {
            const result = await pool.query(
                `SELECT * FROM mindmap_node_comments
                 WHERE node_id = $1 AND device_id = $2
                 ORDER BY created_at ASC`,
                [id, deviceId]
            );
            res.json({ success: true, comments: result.rows });
        } catch (err) {
            console.error('[Mindmap] GET /node/:id/comments failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── GET /graph ─────────────────────────────────────────────────────────
    // Force-graph projection (react-force-graph-2d native shape).
    // Spec: docs/spec/mindmap-force-graph.md (PR #2679).
    //
    // Returns {success, graph:{nodes, links}, stats, meta}.
    // Composes data across kanban_cards + kanban_card_dependencies +
    // kanban_comments/notes + mission_notes + mindmap_node_anchors so the
    // frontend gets a single payload usable by ForceGraph2D directly.
    router.get('/graph', async (req, res) => {
        const deviceId = authenticate(req, res);
        if (!deviceId) return;
        if (!requirePool(res)) return;

        const callerEntityId = getEntityId(req);
        const isDeviceAuth = !!req.query.deviceSecret;
        const options = graphProjection.parseGraphOptions(req.query, { isDeviceAuth, callerEntityId });
        if (options.scope === 'entity' && options.callerEntityId == null) {
            return res.status(400).json({
                success: false,
                error: 'scope=entity requires entityId',
            });
        }

        try {
            // 1) Cards in scope. We over-fetch by 2× node limit so the
            //    deterministic sort+truncate happens in projectGraph rather
            //    than at the SQL boundary (keeps test fixtures simpler).
            const cardWhere = ['device_id = $1'];
            const cardArgs = [deviceId];
            let p = 2;
            if (!options.includeArchived) cardWhere.push('archived = FALSE');
            if (!options.includeDone) cardWhere.push("status <> 'done'");
            if (options.scope === 'entity') {
                cardWhere.push(
                    `(assigned_bots @> $${p}::jsonb OR created_by = $${p + 1} OR reviewer_entity_id = $${p + 1})`
                );
                cardArgs.push(JSON.stringify([options.callerEntityId]), options.callerEntityId);
                p += 2;
            }
            const hardCardCap = Math.min(options.limitNodes * 2, graphProjection.NODE_LIMIT_HARD * 2);
            const cardSql = `
                SELECT id, title, description, priority, status, parent_card_id, is_automation,
                       assigned_bots, created_by, reviewer_entity_id, chat_anchor_message_id,
                       archived, updated_at
                FROM kanban_cards
                WHERE ${cardWhere.join(' AND ')}
                ORDER BY
                    CASE WHEN archived THEN 1 ELSE 0 END,
                    CASE WHEN status = 'done' THEN 1 ELSE 0 END,
                    CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
                    updated_at DESC NULLS LAST
                LIMIT ${hardCardCap}
            `;
            const cardsResult = await pool.query(cardSql, cardArgs);
            let cards = cardsResult.rows;
            const initialCardIds = new Set(cards.map(c => c.id));

            // 1a) Neighbor expansion (entity scope): pull parent + dep
            //     neighbors that aren't already in scope so cross-edges resolve.
            let neighborIds = new Set();
            if (options.includeNeighbors && cards.length > 0) {
                for (const c of cards) {
                    if (c.parent_card_id && !initialCardIds.has(c.parent_card_id)) {
                        neighborIds.add(c.parent_card_id);
                    }
                }
            }

            // 2) Dependencies + explicit card links (also seeds neighborIds)
            const depsResult = cards.length === 0 ? { rows: [] } : await pool.query(
                `SELECT card_id, depends_on_card_id, dependency_type
                 FROM kanban_card_dependencies
                 WHERE device_id = $1
                   AND (card_id = ANY($2::varchar[]) OR depends_on_card_id = ANY($2::varchar[]))`,
                [deviceId, [...initialCardIds]]
            );
            const cardLinksResult = cards.length === 0 ? { rows: [] } : await pool.query(
                `SELECT source_card_id, target_card_id, relation_type
                 FROM kanban_card_links
                 WHERE device_id = $1
                   AND (source_card_id = ANY($2::varchar[]) OR target_card_id = ANY($2::varchar[]))`,
                [deviceId, [...initialCardIds]]
            );
            if (options.includeNeighbors) {
                for (const d of depsResult.rows) {
                    if (!initialCardIds.has(d.card_id)) neighborIds.add(d.card_id);
                    if (!initialCardIds.has(d.depends_on_card_id)) neighborIds.add(d.depends_on_card_id);
                }
                for (const l of cardLinksResult.rows) {
                    if (!initialCardIds.has(l.source_card_id)) neighborIds.add(l.source_card_id);
                    if (!initialCardIds.has(l.target_card_id)) neighborIds.add(l.target_card_id);
                }
            }

            // 1b) Fetch neighbor card rows
            if (neighborIds.size > 0) {
                const neighborRows = await pool.query(
                    `SELECT id, title, description, priority, status, parent_card_id, is_automation,
                            assigned_bots, created_by, reviewer_entity_id, chat_anchor_message_id,
                            archived, updated_at
                     FROM kanban_cards
                     WHERE device_id = $1 AND id = ANY($2::varchar[])`,
                    [deviceId, [...neighborIds]]
                );
                cards = cards.concat(neighborRows.rows);
            }

            const allCardIds = [...new Set(cards.map(c => c.id))];

            // 3) Aggregate counts
            const [commentCounts, noteCounts] = allCardIds.length === 0
                ? [{ rows: [] }, { rows: [] }]
                : await Promise.all([
                    pool.query(
                        `SELECT card_id, COUNT(*)::int AS cnt FROM kanban_comments
                         WHERE device_id = $1 AND card_id = ANY($2::varchar[]) GROUP BY card_id`,
                        [deviceId, allCardIds]
                    ),
                    pool.query(
                        `SELECT card_id, COUNT(*)::int AS cnt FROM kanban_notes
                         WHERE device_id = $1 AND card_id = ANY($2::varchar[]) GROUP BY card_id`,
                        [deviceId, allCardIds]
                    ),
                ]);

            // 4) Mission notes — canonical source is mission_dashboard.notes JSONB.
            let notes = [];
            if (options.includeNotes) {
                const noteWhere = ['md.device_id = $1'];
                const noteArgs = [deviceId];
                let np = 2;
                if (options.scope === 'entity') {
                    noteWhere.push(`note->>'createdBy' = $${np}`);
                    noteArgs.push(`entity_${options.callerEntityId}`);
                    np++;
                }
                const noteSql = `
                    SELECT
                        note->>'id' AS id,
                        COALESCE(note->>'title', '') AS title,
                        COALESCE(note->>'content', '') AS content,
                        COALESCE(note->>'category', 'general') AS category,
                        CASE
                            WHEN note->>'createdBy' LIKE 'entity_%' THEN substring(note->>'createdBy' FROM 8)
                            ELSE note->>'createdBy'
                        END AS created_by,
                        CASE
                            WHEN (note->>'updatedAt') ~ '^[0-9]+$' THEN to_timestamp((note->>'updatedAt')::double precision / 1000)
                            ELSE NULL
                        END AS updated_at
                    FROM mission_dashboard md
                    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(md.notes, '[]'::jsonb)) AS n(note)
                    WHERE ${noteWhere.join(' AND ')}
                      AND COALESCE(note->>'id', '') <> ''
                    ORDER BY CASE WHEN (note->>'updatedAt') ~ '^[0-9]+$' THEN (note->>'updatedAt')::bigint ELSE 0 END DESC
                    LIMIT ${hardCardCap}
                `;
                const notesResult = await pool.query(noteSql, noteArgs);
                notes = notesResult.rows;
            }

            const noteIds = [...new Set(notes.map(n => n.id).filter(Boolean))];
            const noteCardLinksResult = (noteIds.length === 0 && allCardIds.length === 0) ? { rows: [] } : await pool.query(
                `SELECT note_id, card_id
                 FROM mission_note_card_links
                 WHERE device_id = $1
                   AND (note_id = ANY($2::varchar[]) OR card_id = ANY($3::varchar[]))`,
                [deviceId, noteIds, allCardIds]
            );

            // 5) Mindmap anchors (cross-correlation: note↔card, note↔chat, card↔chat)
            const anchorsResult = await pool.query(
                `SELECT node_id, anchor_type, anchor_ref, display_label
                 FROM mindmap_node_anchors
                 WHERE device_id = $1 AND anchor_type IN ('kanban_card','note','chat_message')`,
                [deviceId]
            );

            // Sort cards before projection so cap-truncation prefers active P0 work.
            graphProjection.sortCardsForCap(cards);

            const projection = graphProjection.projectGraph({
                cards,
                initialCardIds,
                depRows: depsResult.rows,
                cardLinkRows: cardLinksResult.rows,
                noteCardLinkRows: noteCardLinksResult.rows,
                commentCounts: commentCounts.rows,
                noteCounts: noteCounts.rows,
                notes,
                anchorRows: anchorsResult.rows,
                entityMap: (devices && devices[deviceId] && devices[deviceId].entities) || {},
                options,
            });

            res.json({
                success: true,
                graph: { nodes: projection.nodes, links: projection.links },
                stats: projection.stats,
                meta: {
                    generatedAt: new Date().toISOString(),
                    deviceId,
                    scope: options.scope,
                    entityId: options.scope === 'entity' ? options.callerEntityId : null,
                    schemaVersion: graphProjection.SCHEMA_VERSION,
                    layoutStorageKey: `mindmap:force-layout:v1:${deviceId}:${options.scope}:${options.scope === 'entity' ? options.callerEntityId : 'owner'}`,
                },
            });
        } catch (err) {
            console.error('[Mindmap] GET /graph failed:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return {
        router,
        initMindmapTables,
        // Exported for unit tests:
        _internal: { isUuid, clampStr, NODE_TYPES, EDGE_TYPES, ANCHOR_TYPES, MAX_TRAVERSE_DEPTH, MAX_TRAVERSE_NODES, graphProjection },
    };
}

module.exports = createMindmapModule;
