'use strict';

/**
 * Explicit non-hierarchical Kanban card links.
 *
 * Separate from parent/automation and dependency/blocking edges: these links
 * are for force-graph/reference semantics such as related/references/duplicates
 * and must not participate in dependency cycle rules.
 */

const express = require('express');
const { Pool } = require('pg');
const safeEqual = require('./safe-equal');

const VALID_RELATION_TYPES = new Set([
    'related',
    'references',
    'duplicates',
    'causes',
    'supports',
    'contradicts',
]);

module.exports = function (devices, options = {}) {
    const router = express.Router();
    const pool = options.pool || new Pool({
        connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
    });

    function findEntityByCredentials(deviceId, entityId, botSecret) {
        const device = devices[deviceId];
        if (!device) return null;
        const entity = (device.entities || {})[entityId];
        if (!entity || !safeEqual(entity.botSecret, botSecret)) return null;
        return entity;
    }

    function findDeviceByCredentials(deviceId, deviceSecret) {
        const device = devices[deviceId];
        if (!device || !safeEqual(device.deviceSecret, deviceSecret)) return null;
        return device;
    }

    function authenticate(req, res) {
        const params = { ...req.query, ...req.body };
        const { deviceId, deviceSecret, botSecret, entityId } = params;

        if (!deviceId) {
            res.status(400).json({ success: false, error: 'Missing deviceId' });
            return null;
        }

        if (deviceSecret) {
            const device = findDeviceByCredentials(deviceId, deviceSecret);
            if (device) return { deviceId, entityId: entityId ? parseInt(entityId, 10) : null };
        }

        if (botSecret) {
            const parsedEntityId = parseInt(entityId || 0, 10);
            const entity = findEntityByCredentials(deviceId, parsedEntityId, botSecret);
            if (entity) return { deviceId, entityId: parsedEntityId };
        }

        if (!deviceSecret && !botSecret) {
            res.status(400).json({ success: false, error: 'Missing deviceSecret or botSecret' });
        } else {
            res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        return null;
    }

    function normalizeRelationType(raw) {
        return String(raw || 'related').trim().toLowerCase();
    }

    async function cardExistsInDevice(cardId, deviceId, queryable = pool) {
        const { rows } = await queryable.query(
            'SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2 LIMIT 1',
            [cardId, deviceId]
        );
        return rows.length > 0;
    }

    function mapLinkRow(row) {
        return {
            id: row.id,
            sourceCardId: row.source_card_id,
            targetCardId: row.target_card_id,
            relationType: row.relation_type,
            createdBy: row.created_by,
            createdAt: row.created_at,
            sourceTitle: row.source_title,
            sourceStatus: row.source_status,
            targetTitle: row.target_title,
            targetStatus: row.target_status,
        };
    }

    // POST /card/:cardId/link — idempotently create a non-hierarchical link.
    router.post('/card/:cardId/link', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId, entityId } = auth;
        const { cardId } = req.params;
        const { targetCardId } = req.body || {};
        const relationType = normalizeRelationType(req.body && req.body.relationType);

        if (!targetCardId) {
            return res.status(400).json({ success: false, error: 'Missing targetCardId' });
        }
        if (!VALID_RELATION_TYPES.has(relationType)) {
            return res.status(400).json({ success: false, error: `Invalid relationType (allowed: ${[...VALID_RELATION_TYPES].join(', ')})` });
        }
        if (cardId === targetCardId) {
            return res.status(400).json({ success: false, error: 'A card cannot link to itself' });
        }

        try {
            if (!(await cardExistsInDevice(cardId, deviceId))) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }
            if (!(await cardExistsInDevice(targetCardId, deviceId))) {
                return res.status(404).json({ success: false, error: 'Target card not found' });
            }

            // Pre-check keeps the route idempotent even in lightweight test DBs
            // whose ON CONFLICT emulation can diverge from PostgreSQL.
            const existing = await pool.query(
                `SELECT id, created_at, created_by
                 FROM kanban_card_links
                 WHERE device_id = $1 AND source_card_id = $2 AND target_card_id = $3 AND relation_type = $4
                 LIMIT 1`,
                [deviceId, cardId, targetCardId, relationType]
            );
            if (existing.rows.length > 0) {
                return res.json({
                    success: true,
                    created: false,
                    link: {
                        id: existing.rows[0].id,
                        sourceCardId: cardId,
                        targetCardId,
                        relationType,
                        createdBy: existing.rows[0].created_by,
                        createdAt: existing.rows[0].created_at,
                    },
                });
            }

            const inserted = await pool.query(
                `INSERT INTO kanban_card_links
                    (device_id, source_card_id, target_card_id, relation_type, created_by)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (device_id, source_card_id, target_card_id, relation_type) DO NOTHING
                 RETURNING id, created_at`,
                [deviceId, cardId, targetCardId, relationType, entityId || 0]
            );

            return res.json({
                success: true,
                created: inserted.rows.length > 0,
                link: {
                    id: inserted.rows[0] && inserted.rows[0].id,
                    sourceCardId: cardId,
                    targetCardId,
                    relationType,
                    createdBy: entityId || 0,
                    createdAt: inserted.rows[0] && inserted.rows[0].created_at,
                },
            });
        } catch (err) {
            console.error('[KanbanLinks] POST link error:', err);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    // GET /card/:cardId/links — list outgoing and incoming explicit links.
    router.get('/card/:cardId/links', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { cardId } = req.params;

        try {
            if (!(await cardExistsInDevice(cardId, deviceId))) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }
            const { rows } = await pool.query(
                `SELECT l.id, l.source_card_id, l.target_card_id, l.relation_type, l.created_by, l.created_at,
                        src.title AS source_title, src.status AS source_status,
                        tgt.title AS target_title, tgt.status AS target_status
                 FROM kanban_card_links l
                 JOIN kanban_cards src ON src.id = l.source_card_id AND src.device_id = l.device_id
                 JOIN kanban_cards tgt ON tgt.id = l.target_card_id AND tgt.device_id = l.device_id
                 WHERE l.device_id = $1 AND (l.source_card_id = $2 OR l.target_card_id = $2)
                 ORDER BY l.created_at, l.id`,
                [deviceId, cardId]
            );
            const outgoing = [];
            const incoming = [];
            for (const row of rows) {
                const link = mapLinkRow(row);
                if (row.source_card_id === cardId) outgoing.push(link);
                if (row.target_card_id === cardId) incoming.push(link);
            }
            res.json({ success: true, cardId, outgoing, incoming, links: rows.map(mapLinkRow) });
        } catch (err) {
            console.error('[KanbanLinks] GET links error:', err);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    // DELETE /card/:cardId/link/:targetCardId?relationType=related
    router.delete('/card/:cardId/link/:targetCardId', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { cardId, targetCardId } = req.params;
        const relationType = normalizeRelationType(req.query.relationType || (req.body && req.body.relationType));

        if (!VALID_RELATION_TYPES.has(relationType)) {
            return res.status(400).json({ success: false, error: `Invalid relationType (allowed: ${[...VALID_RELATION_TYPES].join(', ')})` });
        }

        try {
            const result = await pool.query(
                `DELETE FROM kanban_card_links
                 WHERE device_id = $1 AND source_card_id = $2 AND target_card_id = $3 AND relation_type = $4`,
                [deviceId, cardId, targetCardId, relationType]
            );
            res.json({ success: true, deleted: result.rowCount, sourceCardId: cardId, targetCardId, relationType });
        } catch (err) {
            console.error('[KanbanLinks] DELETE link error:', err);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    // GET /card-links/graph — device-scoped explicit-link edge dump.
    router.get('/card-links/graph', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;

        try {
            const nodesQ = await pool.query(
                `SELECT DISTINCT c.id, c.title, c.status
                 FROM kanban_cards c
                 WHERE c.device_id = $1
                   AND c.id IN (
                     SELECT source_card_id FROM kanban_card_links WHERE device_id = $1
                     UNION
                     SELECT target_card_id FROM kanban_card_links WHERE device_id = $1
                   )
                 ORDER BY c.id`,
                [deviceId]
            );
            const edgesQ = await pool.query(
                `SELECT source_card_id, target_card_id, relation_type, created_at, created_by
                 FROM kanban_card_links
                 WHERE device_id = $1
                 ORDER BY created_at, id`,
                [deviceId]
            );
            res.json({
                success: true,
                graph: {
                    nodes: nodesQ.rows.map(n => ({ id: n.id, title: n.title, status: n.status })),
                    edges: edgesQ.rows.map(e => ({
                        from: e.source_card_id,
                        to: e.target_card_id,
                        type: e.relation_type,
                        createdAt: e.created_at,
                        createdBy: e.created_by,
                    })),
                },
            });
        } catch (err) {
            console.error('[KanbanLinks] GET graph error:', err);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    return { router };
};
