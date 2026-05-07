'use strict';

/**
 * kanban-dependencies-cycle.test.js (PR-DCA)
 *
 * Real SQL execution via pg-mem against a hand-rolled minimal schema
 * mirroring the dep-chain DDL added to backend/kanban_schema.sql in this
 * PR. We do NOT load the full kanban_schema.sql here because pg-mem cannot
 * parse a few statements the live schema relies on (computed `DEFAULT
 * (encode(gen_random_bytes…))`, `ALTER COLUMN TYPE … USING`, partial-index
 * `WHERE`); those are tested elsewhere in CI. The dep-chain DDL itself is
 * plain ANSI-shape syntax and pg-mem runs it faithfully — sufficient for
 * Mac_F's hard-gate cycle-detection coverage.
 *
 * Mac_F sign-off 2026-05-07 explicitly allowed this fallback shape:
 *   "if pg-mem cannot faithfully run the recursive CTE/function, do not
 *    fake a green test … keep pg-mem for route/idempotency tests".
 */

const { newDb } = require('pg-mem');

const { detectDependencyCycle } = require('../../kanban-dependencies');

const DEVICE = 'test-dev';

// Minimal schema covering only the dep-chain surface this PR introduces
// plus the stub `kanban_cards` row table required for the FK constraint.
const MINIMAL_SCHEMA = `
    CREATE TABLE kanban_cards (
        id VARCHAR(48) PRIMARY KEY,
        device_id VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL,
        has_dependencies BOOLEAN DEFAULT FALSE,
        dependency_status VARCHAR(16) DEFAULT 'ready'
    );

    CREATE TABLE kanban_card_dependencies (
        id BIGSERIAL PRIMARY KEY,
        device_id VARCHAR(64) NOT NULL,
        card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        depends_on_card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        dependency_type VARCHAR(16) DEFAULT 'blocks',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        created_by INTEGER NOT NULL DEFAULT 0,
        UNIQUE(device_id, card_id, depends_on_card_id)
    );

    CREATE INDEX idx_kanban_dependencies_card ON kanban_card_dependencies(device_id, card_id);
    CREATE INDEX idx_kanban_dependencies_depends_on ON kanban_card_dependencies(device_id, depends_on_card_id);
    CREATE INDEX idx_kanban_dependencies_type ON kanban_card_dependencies(device_id, dependency_type);
`;

async function bootstrap() {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    await pool.query(MINIMAL_SCHEMA);
    return { pool };
}

async function insertCard(pool, id) {
    await pool.query(
        `INSERT INTO kanban_cards (id, device_id, title) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [id, DEVICE, `card ${id}`]
    );
}

async function insertEdge(pool, from, to) {
    await pool.query(
        `INSERT INTO kanban_card_dependencies (device_id, card_id, depends_on_card_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (device_id, card_id, depends_on_card_id) DO NOTHING`,
        [DEVICE, from, to]
    );
}

describe('detectDependencyCycle (PR-DCA)', () => {
    let pool;

    beforeAll(async () => {
        ({ pool } = await bootstrap());
    });

    beforeEach(async () => {
        await pool.query('DELETE FROM kanban_card_dependencies');
        await pool.query('DELETE FROM kanban_cards');
        for (const id of ['A', 'B', 'C', 'D', 'E']) {
            await insertCard(pool, id);
        }
    });

    test('self-reference (A→A) is always a cycle', async () => {
        await expect(detectDependencyCycle(pool, DEVICE, 'A', 'A')).resolves.toBe(true);
    });

    test('direct: A→B exists; adding B→A is rejected', async () => {
        await insertEdge(pool, 'A', 'B');
        await expect(detectDependencyCycle(pool, DEVICE, 'B', 'A')).resolves.toBe(true);
    });

    test('transitive: A→B and B→C exist; adding C→A is rejected', async () => {
        await insertEdge(pool, 'A', 'B');
        await insertEdge(pool, 'B', 'C');
        await expect(detectDependencyCycle(pool, DEVICE, 'C', 'A')).resolves.toBe(true);
    });

    test('parallel chains (A→B, A→C, B→D, C→D): adding E→A is NOT a cycle', async () => {
        await insertEdge(pool, 'A', 'B');
        await insertEdge(pool, 'A', 'C');
        await insertEdge(pool, 'B', 'D');
        await insertEdge(pool, 'C', 'D');
        await expect(detectDependencyCycle(pool, DEVICE, 'E', 'A')).resolves.toBe(false);
    });

    test('happy path: empty graph, adding A→B is NOT a cycle', async () => {
        await expect(detectDependencyCycle(pool, DEVICE, 'A', 'B')).resolves.toBe(false);
    });

    test('cross-device isolation: edges in another device do not bleed across', async () => {
        await insertEdge(pool, 'A', 'B');
        await expect(detectDependencyCycle(pool, 'other-dev', 'B', 'A')).resolves.toBe(false);
    });

    test('rejects missing required args', async () => {
        await expect(detectDependencyCycle(pool, DEVICE, 'A', null)).rejects.toThrow(/required/);
        await expect(detectDependencyCycle(null, DEVICE, 'A', 'B')).rejects.toThrow(/required/);
    });
});
