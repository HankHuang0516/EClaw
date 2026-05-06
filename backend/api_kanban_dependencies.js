/**
 * Kanban Card Dependencies API
 * Task #42: Bidirectional dependency chain system
 */

const express = require('express');
const { Pool } = require('pg');
const router = express.Router();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

/**
 * Add dependency relationship between cards
 * POST /api/mission/card/:cardId/dependency
 */
router.post('/card/:cardId/dependency', async (req, res) => {
    try {
        const { cardId } = req.params;
        const { deviceId, entityId, botSecret, dependsOnCardId, dependencyType = 'blocks' } = req.body;

        // Validate auth (simplified for prototype)
        if (!deviceId || !entityId || !botSecret) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        // Validate cards exist
        const cardsExist = await pool.query(`
            SELECT id FROM kanban_cards
            WHERE device_id = $1 AND id IN ($2, $3)
        `, [deviceId, cardId, dependsOnCardId]);

        if (cardsExist.rows.length !== 2) {
            return res.status(404).json({ success: false, error: 'One or both cards not found' });
        }

        // Check for cycle before adding dependency
        const cycleCheck = await pool.query(`
            SELECT detect_dependency_cycle($1, $2, $3) as has_cycle
        `, [deviceId, cardId, dependsOnCardId]);

        if (cycleCheck.rows[0].has_cycle) {
            return res.status(400).json({
                success: false,
                error: 'Adding this dependency would create a cycle',
                cycleDetected: true
            });
        }

        // Add dependency relationship
        const result = await pool.query(`
            INSERT INTO kanban_card_dependencies
            (device_id, card_id, depends_on_card_id, dependency_type, created_by)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (device_id, card_id, depends_on_card_id)
            DO UPDATE SET dependency_type = EXCLUDED.dependency_type
            RETURNING *
        `, [deviceId, cardId, dependsOnCardId, dependencyType, entityId]);

        res.json({
            success: true,
            dependency: result.rows[0],
            message: `Dependency added: Card ${cardId} depends on Card ${dependsOnCardId}`
        });

    } catch (err) {
        console.error('Add dependency error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * Remove dependency relationship
 * DELETE /api/mission/card/:cardId/dependency/:dependsOnCardId
 */
router.delete('/card/:cardId/dependency/:dependsOnCardId', async (req, res) => {
    try {
        const { cardId, dependsOnCardId } = req.params;
        const { deviceId, entityId, botSecret } = req.body;

        // Validate auth
        if (!deviceId || !entityId || !botSecret) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        // Remove dependency
        const result = await pool.query(`
            DELETE FROM kanban_card_dependencies
            WHERE device_id = $1 AND card_id = $2 AND depends_on_card_id = $3
            RETURNING *
        `, [deviceId, cardId, dependsOnCardId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Dependency not found' });
        }

        res.json({
            success: true,
            removed: result.rows[0],
            message: `Dependency removed: Card ${cardId} no longer depends on Card ${dependsOnCardId}`
        });

    } catch (err) {
        console.error('Remove dependency error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * Get all dependencies for a card
 * GET /api/mission/card/:cardId/dependencies
 */
router.get('/card/:cardId/dependencies', async (req, res) => {
    try {
        const { cardId } = req.params;
        const { deviceId, entityId, botSecret } = req.query;

        // Validate auth
        if (!deviceId || !entityId || !botSecret) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        // Get dependencies this card depends on
        const dependsOn = await pool.query(`
            SELECT d.*, c.title as depends_on_title, c.status as depends_on_status
            FROM kanban_card_dependencies d
            JOIN kanban_cards c ON d.depends_on_card_id = c.id
            WHERE d.device_id = $1 AND d.card_id = $2
            ORDER BY d.created_at
        `, [deviceId, cardId]);

        // Get dependencies that depend on this card
        const dependents = await pool.query(`
            SELECT d.*, c.title as dependent_title, c.status as dependent_status
            FROM kanban_card_dependencies d
            JOIN kanban_cards c ON d.card_id = c.id
            WHERE d.device_id = $1 AND d.depends_on_card_id = $2
            ORDER BY d.created_at
        `, [deviceId, cardId]);

        // Get dependency status summary
        const statusSummary = await pool.query(`
            SELECT dependency_status, has_dependencies
            FROM kanban_cards
            WHERE device_id = $1 AND id = $2
        `, [deviceId, cardId]);

        res.json({
            success: true,
            cardId,
            dependsOn: dependsOn.rows,
            dependents: dependents.rows,
            status: statusSummary.rows[0] || { dependency_status: 'ready', has_dependencies: false },
            summary: {
                dependsOnCount: dependsOn.rows.length,
                dependentsCount: dependents.rows.length,
                blockedByCount: dependsOn.rows.filter(d => d.depends_on_status !== 'done').length
            }
        });

    } catch (err) {
        console.error('Get dependencies error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * Get dependency chain visualization data
 * GET /api/mission/dependencies/graph
 */
router.get('/dependencies/graph', async (req, res) => {
    try {
        const { deviceId, entityId, botSecret, rootCardId } = req.query;

        // Validate auth
        if (!deviceId || !entityId || !botSecret) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        // Get all dependencies for the device or specific root card
        let query, params;
        if (rootCardId) {
            // Get dependency subgraph starting from root card
            query = `
                WITH RECURSIVE dependency_tree AS (
                    -- Start from root card
                    SELECT
                        id, title, status, dependency_status,
                        ARRAY[id] as path,
                        0 as depth
                    FROM kanban_cards
                    WHERE device_id = $1 AND id = $2

                    UNION

                    -- Find all cards that depend on cards in current tree
                    SELECT
                        c.id, c.title, c.status, c.dependency_status,
                        dt.path || c.id as path,
                        dt.depth + 1 as depth
                    FROM dependency_tree dt
                    JOIN kanban_card_dependencies d ON dt.id = d.depends_on_card_id
                    JOIN kanban_cards c ON d.card_id = c.id
                    WHERE c.device_id = $1
                    AND NOT c.id = ANY(dt.path) -- Prevent infinite recursion
                    AND dt.depth < 10 -- Limit depth
                )
                SELECT DISTINCT * FROM dependency_tree ORDER BY depth, title
            `;
            params = [deviceId, rootCardId];
        } else {
            // Get all cards with dependencies
            query = `
                SELECT DISTINCT
                    c.id, c.title, c.status, c.dependency_status, c.has_dependencies
                FROM kanban_cards c
                LEFT JOIN kanban_card_dependencies d1 ON c.id = d1.card_id
                LEFT JOIN kanban_card_dependencies d2 ON c.id = d2.depends_on_card_id
                WHERE c.device_id = $1
                AND (c.has_dependencies = TRUE OR d2.id IS NOT NULL)
                AND c.archived = FALSE
                ORDER BY c.title
            `;
            params = [deviceId];
        }

        const cards = await pool.query(query, params);

        // Get all dependency relationships
        const dependencies = await pool.query(`
            SELECT
                d.*,
                c1.title as card_title,
                c2.title as depends_on_title
            FROM kanban_card_dependencies d
            JOIN kanban_cards c1 ON d.card_id = c1.id
            JOIN kanban_cards c2 ON d.depends_on_card_id = c2.id
            WHERE d.device_id = $1
            ORDER BY d.created_at
        `, [deviceId]);

        // Build graph structure
        const nodes = cards.rows.map(card => ({
            id: card.id,
            title: card.title,
            status: card.status,
            dependencyStatus: card.dependency_status,
            hasDependencies: card.has_dependencies,
            depth: card.depth || 0
        }));

        const edges = dependencies.rows.map(dep => ({
            from: dep.depends_on_card_id,
            to: dep.card_id,
            type: dep.dependency_type,
            id: dep.id
        }));

        res.json({
            success: true,
            graph: {
                nodes,
                edges,
                metadata: {
                    totalCards: nodes.length,
                    totalDependencies: edges.length,
                    rootCardId: rootCardId || null
                }
            }
        });

    } catch (err) {
        console.error('Get dependency graph error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * Validate dependency chain for cycles
 * POST /api/mission/dependencies/validate
 */
router.post('/dependencies/validate', async (req, res) => {
    try {
        const { deviceId, entityId, botSecret, cardId, dependsOnCardId } = req.body;

        // Validate auth
        if (!deviceId || !entityId || !botSecret) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        // Check for cycle
        const cycleCheck = await pool.query(`
            SELECT detect_dependency_cycle($1, $2, $3) as has_cycle
        `, [deviceId, cardId, dependsOnCardId]);

        const hasCycle = cycleCheck.rows[0].has_cycle;

        res.json({
            success: true,
            validation: {
                cardId,
                dependsOnCardId,
                hasCycle,
                isValid: !hasCycle,
                message: hasCycle
                    ? 'This dependency would create a cycle and is not allowed'
                    : 'This dependency is valid and can be added'
            }
        });

    } catch (err) {
        console.error('Validate dependency error:', err);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

module.exports = router;