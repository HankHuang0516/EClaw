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

const { newDb, DataType } = require('pg-mem');

const MINIMAL_SCHEMA = `
    CREATE TABLE kanban_cards (
        id VARCHAR(48) PRIMARY KEY,
        device_id VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT DEFAULT '',
        priority VARCHAR(8) DEFAULT 'P2',
        assigned_bots JSONB DEFAULT '[]'::jsonb,
        created_by INTEGER DEFAULT 0,
        reviewer_entity_id INTEGER DEFAULT NULL,
        status_changed_at TIMESTAMPTZ DEFAULT NOW(),
        stale_threshold_ms BIGINT DEFAULT 10800000,
        done_retention_ms BIGINT DEFAULT 604800000,
        archived BOOLEAN DEFAULT FALSE,
        is_automation BOOLEAN DEFAULT FALSE,
        parent_card_id VARCHAR(48) DEFAULT NULL,
        is_auto_generated BOOLEAN DEFAULT FALSE,
        dispatch_mode VARCHAR(20) DEFAULT 'immediate',
        pending_dispatch BOOLEAN DEFAULT FALSE,
        chat_anchor_message_id TEXT DEFAULT NULL,
        chat_anchor_coord JSONB DEFAULT NULL,
        requires_screenshot_review BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        has_dependencies BOOLEAN DEFAULT FALSE,
        dependency_status VARCHAR(16) DEFAULT 'ready',
        status VARCHAR(16) DEFAULT 'todo'
    );



    CREATE TABLE kanban_comments (
        id UUID PRIMARY KEY,
        card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        device_id VARCHAR(64) NOT NULL,
        from_entity_id INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL DEFAULT '',
        is_system BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE kanban_notes (
        id UUID PRIMARY KEY,
        card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        device_id VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        from_entity_id INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE kanban_files (
        id UUID PRIMARY KEY,
        card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        device_id VARCHAR(64) NOT NULL,
        filename VARCHAR(255) NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        mime_type VARCHAR(128) DEFAULT NULL,
        file_size BIGINT DEFAULT NULL,
        uploaded_by INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        file_id TEXT DEFAULT NULL
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

    CREATE TABLE kanban_card_links (
        id BIGSERIAL PRIMARY KEY,
        device_id VARCHAR(64) NOT NULL,
        source_card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        target_card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        relation_type VARCHAR(24) NOT NULL DEFAULT 'related',
        created_by INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(device_id, source_card_id, target_card_id, relation_type),
        CHECK (source_card_id <> target_card_id)
    );

    CREATE INDEX idx_kanban_card_links_source ON kanban_card_links(device_id, source_card_id);
    CREATE INDEX idx_kanban_card_links_target ON kanban_card_links(device_id, target_card_id);
    CREATE INDEX idx_kanban_card_links_relation ON kanban_card_links(device_id, relation_type);


    CREATE TABLE kanban_tags (
        id BIGSERIAL PRIMARY KEY,
        device_id VARCHAR(64) NOT NULL,
        slug VARCHAR(80) NOT NULL,
        label VARCHAR(120) NOT NULL,
        created_by INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(device_id, slug)
    );

    CREATE TABLE kanban_card_tags (
        device_id VARCHAR(64) NOT NULL,
        card_id VARCHAR(48) NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        tag_id BIGINT NOT NULL REFERENCES kanban_tags(id) ON DELETE CASCADE,
        created_by INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY(device_id, card_id, tag_id)
    );

    CREATE INDEX idx_kanban_tags_device_slug ON kanban_tags(device_id, slug);
    CREATE INDEX idx_kanban_card_tags_card ON kanban_card_tags(device_id, card_id);
    CREATE INDEX idx_kanban_card_tags_tag ON kanban_card_tags(device_id, tag_id);
`;

async function bootstrap() {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    // PR-DCC: pg-mem does not ship `pg_advisory_xact_lock`. Register as a no-op
    // so the locked POST path executes; real mutual-exclusion proof lives in
    // tests gated behind RUN_PG_INTEGRATION=1 (real PG only).
    db.public.registerFunction({
        name: 'pg_advisory_xact_lock',
        args: [DataType.integer, DataType.integer],
        returns: DataType.text,
        implementation: () => null,
    });
    // hashtext(text)::int — pg-mem lacks it; deterministic 32-bit FNV-1a is
    // close enough for tests that only need stable per-deviceId integers.
    db.public.registerFunction({
        name: 'hashtext',
        args: [DataType.text],
        returns: DataType.integer,
        implementation: (s) => {
            let h = 0x811c9dc5;
            for (let i = 0; i < (s || '').length; i++) {
                h ^= s.charCodeAt(i);
                h = Math.imul(h, 0x01000193);
            }
            return h | 0;
        },
    });
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

async function insertLink(pool, deviceId, source, target, relationType = 'related') {
    await pool.query(
        `INSERT INTO kanban_card_links (device_id, source_card_id, target_card_id, relation_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (device_id, source_card_id, target_card_id, relation_type) DO NOTHING`,
        [deviceId, source, target, relationType]
    );
}


async function insertTag(pool, deviceId, cardId, rawSlug, label) {
    const slug = String(rawSlug).trim().toLowerCase();
    const tag = await pool.query(
        `INSERT INTO kanban_tags (device_id, slug, label)
         VALUES ($1, $2, $3)
         ON CONFLICT (device_id, slug) DO UPDATE SET label = EXCLUDED.label
         RETURNING id`,
        [deviceId, slug, label || slug]
    );
    await pool.query(
        `INSERT INTO kanban_card_tags (device_id, card_id, tag_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (device_id, card_id, tag_id) DO NOTHING`,
        [deviceId, cardId, tag.rows[0].id]
    );
}

async function reset(pool) {
    await pool.query('DELETE FROM kanban_card_tags');
    await pool.query('DELETE FROM kanban_tags');
    await pool.query('DELETE FROM kanban_card_links');
    await pool.query('DELETE FROM kanban_card_dependencies');
    await pool.query('DELETE FROM kanban_cards');
}

module.exports = { MINIMAL_SCHEMA, bootstrap, insertCard, insertEdge, insertLink, insertTag, reset };
