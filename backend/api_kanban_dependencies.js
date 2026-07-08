'use strict';

/**
 * Kanban card dependency-chain HTTP API (PR-DCB).
 *
 * Mounted under /api/mission. Auth model matches kanban.js — botSecret OR
 * deviceSecret per device. All routes are strictly device-scoped: cards in
 * other devices behave as 404 (no leak), per Mac_F sign-off 2026-05-07.
 *
 * Uses the iterative-BFS detectDependencyCycle() helper from PR-DCA — no
 * PL/pgSQL `detect_dependency_cycle()` function call (that path was dropped
 * in PR-DCA because the schema-init `;`-splitter cannot host function bodies).
 *
 * Pool is injectable via options.pool so jest can drive it under pg-mem.
 */

const express = require('express');
const { Pool } = require('pg');
const safeEqual = require('./safe-equal');
const extractCreds = require('./extract-creds');
const { detectDependencyCycle } = require('./kanban-dependencies');

const VALID_DEPENDENCY_TYPES = new Set(['blocks', 'requires', 'related']);

// PR-DCC: device-scoped advisory lock namespace. Mac_F sign-off 2026-05-07 β′
// — namespace + hashtext(deviceId) serializes dep-edge writes per device so
// the cycle-check ↔ INSERT window is closed (transitive cycles included).
const DEP_LOCK_NAMESPACE = 0x44434843; // 'DCHC' — Dep-Chain Cycle

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
        // Accepts secrets via query/body (legacy) OR X-Device-Secret /
        // X-Bot-Secret headers (secret-leakage hardening). Additive: query/body
        // still take precedence so existing callers are unaffected.
        const { deviceId, deviceSecret, botSecret, entityId } = extractCreds(req);

        if (!deviceId) {
            res.status(400).json({ success: false, error: 'Missing deviceId' });
            return null;
        }

        if (deviceSecret) {
            const device = findDeviceByCredentials(deviceId, deviceSecret);
            if (device) return { deviceId, entityId: entityId ? parseInt(entityId, 10) : null };
        }

        if (botSecret) {
            const entity = findEntityByCredentials(deviceId, parseInt(entityId || 0, 10), botSecret);
            if (entity) return { deviceId, entityId: parseInt(entityId, 10) };
        }

        if (!deviceSecret && !botSecret) {
            res.status(400).json({ success: false, error: 'Missing deviceSecret or botSecret' });
        } else {
            res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        return null;
    }

    async function cardExistsInDevice(cardId, deviceId, queryable) {
        const q = queryable || pool;
        const { rows } = await q.query(
            'SELECT id FROM kanban_cards WHERE id = $1 AND device_id = $2 LIMIT 1',
            [cardId, deviceId]
        );
        return rows.length > 0;
    }

    // POST /card/:cardId/dependency
    router.post('/card/:cardId/dependency', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId, entityId } = auth;
        const { cardId } = req.params;
        const { dependsOnCardId, dependencyType = 'blocks' } = req.body || {};

        if (!dependsOnCardId) {
            return res.status(400).json({ success: false, error: 'Missing dependsOnCardId' });
        }
        if (!VALID_DEPENDENCY_TYPES.has(dependencyType)) {
            return res.status(400).json({ success: false, error: `Invalid dependencyType (allowed: ${[...VALID_DEPENDENCY_TYPES].join(', ')})` });
        }
        if (cardId === dependsOnCardId) {
            return res.status(400).json({ success: false, error: 'A card cannot depend on itself' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Acquire device-scoped lock first; releases automatically on COMMIT/ROLLBACK.
            await client.query(
                'SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)',
                [DEP_LOCK_NAMESPACE, deviceId]
            );

            if (!(await cardExistsInDevice(cardId, deviceId, client))) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Card not found' });
            }
            if (!(await cardExistsInDevice(dependsOnCardId, deviceId, client))) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Dependency card not found' });
            }

            if (await detectDependencyCycle(client, deviceId, cardId, dependsOnCardId)) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    error: 'Adding this dependency would create a cycle',
                    cycleDetected: true
                });
            }

            const existing = await client.query(
                `SELECT id FROM kanban_card_dependencies
                 WHERE device_id = $1 AND card_id = $2 AND depends_on_card_id = $3
                 LIMIT 1`,
                [deviceId, cardId, dependsOnCardId]
            );

            if (existing.rows.length > 0) {
                await client.query('COMMIT');
                return res.json({ success: true, created: false, cardId, dependsOnCardId, dependencyType });
            }

            await client.query(
                `INSERT INTO kanban_card_dependencies
                    (device_id, card_id, depends_on_card_id, dependency_type, created_by)
                 VALUES ($1, $2, $3, $4, $5)`,
                [deviceId, cardId, dependsOnCardId, dependencyType, entityId || 0]
            );

            await client.query('COMMIT');
            res.json({ success: true, created: true, cardId, dependsOnCardId, dependencyType });
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (_) { /* best-effort */ }
            console.error('[KanbanDeps] POST dependency error:', err);
            res.status(500).json({ success: false, error: 'Internal server error' });
        } finally {
            client.release();
        }
    });

    // DELETE /card/:cardId/dependency/:dependsOnCardId
    router.delete('/card/:cardId/dependency/:dependsOnCardId', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { cardId, dependsOnCardId } = req.params;

        try {
            const result = await pool.query(
                `DELETE FROM kanban_card_dependencies
                 WHERE device_id = $1 AND card_id = $2 AND depends_on_card_id = $3`,
                [deviceId, cardId, dependsOnCardId]
            );
            res.json({ success: true, deleted: result.rowCount, cardId, dependsOnCardId });
        } catch (err) {
            console.error('[KanbanDeps] DELETE dependency error:', err);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    // GET /card/:cardId/dependencies — what this card depends on
    router.get('/card/:cardId/dependencies', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { cardId } = req.params;

        try {
            if (!(await cardExistsInDevice(cardId, deviceId))) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }
            const { rows } = await pool.query(
                `SELECT d.depends_on_card_id, d.dependency_type, d.created_at,
                        c.title, c.status
                 FROM kanban_card_dependencies d
                 JOIN kanban_cards c
                     ON c.id = d.depends_on_card_id AND c.device_id = d.device_id
                 WHERE d.device_id = $1 AND d.card_id = $2
                 ORDER BY d.created_at`,
                [deviceId, cardId]
            );
            res.json({
                success: true,
                cardId,
                dependencies: rows.map(r => ({
                    cardId: r.depends_on_card_id,
                    title: r.title,
                    status: r.status,
                    type: r.dependency_type,
                    createdAt: r.created_at
                }))
            });
        } catch (err) {
            console.error('[KanbanDeps] GET dependencies error:', err);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    // GET /card/:cardId/dependents — what depends on this card
    router.get('/card/:cardId/dependents', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { cardId } = req.params;

        try {
            if (!(await cardExistsInDevice(cardId, deviceId))) {
                return res.status(404).json({ success: false, error: 'Card not found' });
            }
            const { rows } = await pool.query(
                `SELECT d.card_id, d.dependency_type, d.created_at,
                        c.title, c.status
                 FROM kanban_card_dependencies d
                 JOIN kanban_cards c
                     ON c.id = d.card_id AND c.device_id = d.device_id
                 WHERE d.device_id = $1 AND d.depends_on_card_id = $2
                 ORDER BY d.created_at`,
                [deviceId, cardId]
            );
            res.json({
                success: true,
                cardId,
                dependents: rows.map(r => ({
                    cardId: r.card_id,
                    title: r.title,
                    status: r.status,
                    type: r.dependency_type,
                    createdAt: r.created_at
                }))
            });
        } catch (err) {
            console.error('[KanbanDeps] GET dependents error:', err);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    // GET /dependencies/graph — device-scoped node+edge dump
    router.get('/dependencies/graph', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;

        try {
            const nodesQ = await pool.query(
                `SELECT DISTINCT c.id, c.title, c.status
                 FROM kanban_cards c
                 WHERE c.device_id = $1
                   AND c.id IN (
                     SELECT card_id FROM kanban_card_dependencies WHERE device_id = $1
                     UNION
                     SELECT depends_on_card_id FROM kanban_card_dependencies WHERE device_id = $1
                   )
                 ORDER BY c.id`,
                [deviceId]
            );
            const edgesQ = await pool.query(
                `SELECT card_id, depends_on_card_id, dependency_type, created_at
                 FROM kanban_card_dependencies
                 WHERE device_id = $1
                 ORDER BY created_at`,
                [deviceId]
            );
            res.json({
                success: true,
                graph: {
                    nodes: nodesQ.rows.map(n => ({ id: n.id, title: n.title, status: n.status })),
                    edges: edgesQ.rows.map(e => ({
                        from: e.card_id,
                        to: e.depends_on_card_id,
                        type: e.dependency_type,
                        createdAt: e.created_at
                    }))
                }
            });
        } catch (err) {
            console.error('[KanbanDeps] GET graph error:', err);
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    });

    return { router };
};
