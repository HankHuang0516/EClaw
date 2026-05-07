/**
 * Kanban card dependency-chain helpers (PR-DCA).
 *
 * Restored after PR #2481 → PR #2494 cleanup, per Mac_F (#1) sign-off 2026-05-07
 * card_92363a55c53eef7b672024e9. PR-DCA scope: schema + cycle detection only.
 * Router mount lives in PR-DCB (api_kanban_dependencies.js).
 *
 * Cycle detection runs as an iterative BFS over the dependency graph rather
 * than a PL/pgSQL recursive CTE: keeps the migration compatible with the
 * `;`-splitter in initKanbanDatabase() and stays testable under pg-mem,
 * which has spotty `WITH RECURSIVE` support across versions.
 */

'use strict';

/**
 * Returns true if inserting (cardId → dependsOnCardId) would close a cycle.
 *
 * Walk semantics: starting at dependsOnCardId, follow `card_id → depends_on_card_id`
 * edges. If we ever land on cardId, the proposed edge would create a cycle.
 *
 * Self-reference (cardId === dependsOnCardId) is rejected up front.
 */
async function detectDependencyCycle(pool, deviceId, cardId, dependsOnCardId) {
    if (!pool || !deviceId || !cardId || !dependsOnCardId) {
        throw new Error('detectDependencyCycle: pool, deviceId, cardId, dependsOnCardId all required');
    }
    if (cardId === dependsOnCardId) return true;

    const visited = new Set([dependsOnCardId]);
    const queue = [dependsOnCardId];

    while (queue.length > 0) {
        const node = queue.shift();
        const { rows } = await pool.query(
            'SELECT depends_on_card_id FROM kanban_card_dependencies WHERE device_id = $1 AND card_id = $2',
            [deviceId, node]
        );
        for (const row of rows) {
            const next = row.depends_on_card_id;
            if (next === cardId) return true;
            if (!visited.has(next)) {
                visited.add(next);
                queue.push(next);
            }
        }
    }
    return false;
}

module.exports = { detectDependencyCycle };
