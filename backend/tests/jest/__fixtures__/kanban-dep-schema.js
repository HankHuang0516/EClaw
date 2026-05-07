'use strict';

/**
 * Shared pg-mem fixture for kanban dep-chain tests (PR-DCA + PR-DCB).
 *
 * Mac_F sign-off 2026-05-07: extract MINIMAL_SCHEMA so DCA and DCB don't drift.
 * Narrow scope — schema setup only, no broader test framework abstraction.
 *
 * The full backend/kanban_schema.sql cannot be loaded under pg-mem (computed
 * `DEFAULT (encode(gen_random_bytes…))`, `ALTER COLUMN TYPE … USING`,
 * partial-index `WHERE`); this fixture mirrors only the table shapes the
 * dep-chain code actually exercises.
 */

const { newDb } = require('pg-mem');

const MINIMAL_SCHEMA = `
    CREATE TABLE kanban_cards (
        id VARCHAR(48) PRIMARY KEY,
        device_id VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL,
        has_dependencies BOOLEAN DEFAULT FALSE,
        dependency_status VARCHAR(16) DEFAULT 'ready',
        status VARCHAR(16) DEFAULT 'todo'
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
    return { pool, db };
}

async function insertCard(pool, id, deviceId, title) {
    await pool.query(
        `INSERT INTO kanban_cards (id, device_id, title) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [id, deviceId, title || `card ${id}`]
    );
}

async function insertEdge(pool, deviceId, from, to) {
    await pool.query(
        `INSERT INTO kanban_card_dependencies (device_id, card_id, depends_on_card_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (device_id, card_id, depends_on_card_id) DO NOTHING`,
        [deviceId, from, to]
    );
}

async function reset(pool) {
    await pool.query('DELETE FROM kanban_card_dependencies');
    await pool.query('DELETE FROM kanban_cards');
}

module.exports = { MINIMAL_SCHEMA, bootstrap, insertCard, insertEdge, reset };
