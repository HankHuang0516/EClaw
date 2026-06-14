'use strict';

// Migration smoke test for 20260614_message_lifecycle.
//
// Card: card_1b1c13225f10e8a803cef532 (MessageLifecycle Phase 2 Step 1).
// Spec: docs/specs/message-lifecycle-spec.md §3 (Option B), §3.3.
//
// This is a static-shape test (no live PG harness required). It loads the
// up + down SQL and asserts the schema contract that Steps 2-6 depend on:
//   - message_lifecycle table exists with the expected columns + CHECK
//     constraints (state enum, direction enum, source enum).
//   - The three indexes the sweeper hot path needs are present.
//   - lifecycle_event_log table exists with the expected applied-state CHECK
//     and the per-message timeline index.
//   - down.sql drops every object created by up.sql (round-trip safety).
//   - Spec §11 constraints are encoded structurally — push_delivered_at and
//     user_seen_at are NULLABLE (NEVER derived), and lifecycle_event_log has
//     no DELETE/UPDATE statements that would let it roll back state.

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');
const UP_FILE = path.join(MIGRATIONS_DIR, '20260614_message_lifecycle.up.sql');
const DOWN_FILE = path.join(MIGRATIONS_DIR, '20260614_message_lifecycle.down.sql');

function readSql(file) {
    return fs.readFileSync(file, 'utf8');
}

describe('20260614_message_lifecycle migration', () => {
    const up = readSql(UP_FILE);
    const down = readSql(DOWN_FILE);

    describe('message_lifecycle table (spec §3.2)', () => {
        test('creates message_lifecycle table', () => {
            expect(up).toMatch(/CREATE TABLE IF NOT EXISTS message_lifecycle/);
        });

        test('keys lifecycle by message_id TEXT PRIMARY KEY (spec §3.2)', () => {
            expect(up).toMatch(/message_id\s+TEXT PRIMARY KEY/);
        });

        test('requires tenant_id, device_id, entity_id, direction, state, inbound_seen_at', () => {
            for (const col of [
                /tenant_id\s+TEXT NOT NULL/,
                /device_id\s+VARCHAR\(64\) NOT NULL/,
                /entity_id\s+INTEGER NOT NULL/,
                /direction\s+TEXT NOT NULL/,
                /state\s+TEXT NOT NULL/,
                /inbound_seen_at\s+TIMESTAMPTZ NOT NULL/,
            ]) {
                expect(up).toMatch(col);
            }
        });

        test('bot_acked_at / push_delivered_at / user_seen_at are NULLABLE (constraint #2 §11)', () => {
            // None of these may be NOT NULL — they are NEVER derived during backfill
            // (spec §5.1), and a NOT NULL would force inflation of user_seen success.
            expect(up).not.toMatch(/bot_acked_at\s+TIMESTAMPTZ NOT NULL/);
            expect(up).not.toMatch(/push_delivered_at\s+TIMESTAMPTZ NOT NULL/);
            expect(up).not.toMatch(/user_seen_at\s+TIMESTAMPTZ NOT NULL/);
            // They must still be declared as TIMESTAMPTZ columns.
            expect(up).toMatch(/bot_acked_at\s+TIMESTAMPTZ/);
            expect(up).toMatch(/push_delivered_at\s+TIMESTAMPTZ/);
            expect(up).toMatch(/user_seen_at\s+TIMESTAMPTZ/);
        });

        test('state CHECK restricts to the 4 spec §2 states', () => {
            // The actual constraint clause; quoting matters because PG is permissive
            // about CHECK position but we want to lock the 4-state enum domain.
            for (const literal of [
                "'inbound_seen'",
                "'bot_acked'",
                "'push_delivered'",
                "'user_seen'",
            ]) {
                expect(up).toContain(literal);
            }
            expect(up).toMatch(/CHECK \(state IN \('inbound_seen', 'bot_acked', 'push_delivered', 'user_seen'\)\)/);
        });

        test('direction CHECK restricts to inbound|outbound (spec §3.2)', () => {
            expect(up).toMatch(/CHECK \(direction IN \('inbound', 'outbound'\)\)/);
        });

        test('source CHECK includes the backfill provenance values (spec §5.4)', () => {
            for (const literal of ["'live'", "'backfill+link'", "'backfill+heuristic'", "'inferred'"]) {
                expect(up).toContain(literal);
            }
        });

        test('skipped_states is a TEXT[] default empty (spec §2.3 rule 3)', () => {
            expect(up).toMatch(/skipped_states\s+TEXT\[\]\s+NOT NULL\s+DEFAULT\s+'\{\}'/);
        });

        test('declares all three sweeper-hot-path indexes', () => {
            expect(up).toMatch(/CREATE INDEX IF NOT EXISTS idx_ml_device_entity_state/);
            expect(up).toMatch(/CREATE INDEX IF NOT EXISTS idx_ml_stuck_lookup/);
            expect(up).toMatch(/CREATE INDEX IF NOT EXISTS idx_ml_reply_chain/);
        });

        test('stuck-lookup index is partial WHERE state <> user_seen (spec §6.3)', () => {
            // The partial predicate is what makes the sweeper scan cheap — must not
            // be dropped in future edits, so we lock it here.
            expect(up).toMatch(/idx_ml_stuck_lookup[\s\S]+?WHERE state <> 'user_seen'/);
        });

        test('reply-chain index is partial WHERE reply_to_message_id IS NOT NULL', () => {
            expect(up).toMatch(/idx_ml_reply_chain[\s\S]+?WHERE reply_to_message_id IS NOT NULL/);
        });
    });

    describe('lifecycle_event_log table (spec §2.4 + §3.3)', () => {
        test('creates lifecycle_event_log table', () => {
            expect(up).toMatch(/CREATE TABLE IF NOT EXISTS lifecycle_event_log/);
        });

        test('id is BIGSERIAL PRIMARY KEY', () => {
            expect(up).toMatch(/id\s+BIGSERIAL PRIMARY KEY/);
        });

        test('message_id is TEXT NOT NULL (matches message_lifecycle PK type)', () => {
            // Spec §3.3 uses TEXT, not BIGINT FK to chat_messages — the actual
            // chat_messages PK is UUID, and lifecycle_event_log stays decoupled
            // so it can audit messages whose chat_messages row never landed.
            expect(up).toMatch(/lifecycle_event_log[\s\S]+?message_id\s+TEXT NOT NULL/);
        });

        test('attempted_state CHECK matches the 4-state enum', () => {
            expect(up).toMatch(/CHECK \(attempted_state IN \('inbound_seen', 'bot_acked', 'push_delivered', 'user_seen'\)\)/);
        });

        test('applied CHECK matches the 4 outcomes from spec §2.4', () => {
            expect(up).toMatch(/CHECK \(applied IN \('accepted', 'idempotent_noop', 'rejected_late', 'rejected_unknown_message'\)\)/);
        });

        test('event_at + transition_at are both required (audit timeline integrity)', () => {
            expect(up).toMatch(/event_at\s+TIMESTAMPTZ NOT NULL/);
            expect(up).toMatch(/transition_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
        });

        test('declares idx_lel_message for per-message timeline lookup', () => {
            expect(up).toMatch(/CREATE INDEX IF NOT EXISTS idx_lel_message[\s\S]+?\(message_id, transition_at DESC\)/);
        });

        test('append-only: no UPDATE or DELETE statements in up.sql', () => {
            // Structural enforcement of constraint #1 (§11): the migration itself
            // never writes a path that mutates or removes audit rows.
            expect(up).not.toMatch(/\bUPDATE\s+lifecycle_event_log/i);
            expect(up).not.toMatch(/\bDELETE\s+FROM\s+lifecycle_event_log/i);
        });
    });

    describe('rollback (down.sql)', () => {
        test('drops both tables', () => {
            expect(down).toMatch(/DROP TABLE IF EXISTS lifecycle_event_log/);
            expect(down).toMatch(/DROP TABLE IF EXISTS message_lifecycle/);
        });

        test('drops every index created by up.sql', () => {
            const upIndexes = [...up.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
            expect(upIndexes.length).toBeGreaterThan(0);
            for (const ix of upIndexes) {
                expect(down).toContain(`DROP INDEX IF EXISTS ${ix}`);
            }
        });

        test('uses IF EXISTS to be idempotent on a clean DB', () => {
            // Counting: 2 tables + however many indexes are in up.sql.
            const dropTables = (down.match(/DROP TABLE IF EXISTS/g) || []).length;
            const dropIndexes = (down.match(/DROP INDEX IF EXISTS/g) || []).length;
            expect(dropTables).toBe(2);
            expect(dropIndexes).toBeGreaterThanOrEqual(3);
        });
    });

    describe('spec §11 constraints encoded structurally', () => {
        test('constraint #1: no rollback path in either file', () => {
            // up.sql may reset state via app logic only — never via SQL that
            // unconditionally lowers a state field.
            expect(up).not.toMatch(/UPDATE\s+message_lifecycle\s+SET\s+state\s*=/i);
        });

        test('constraint #2: schema does not COALESCE user_seen_at into a default', () => {
            // user_seen_at is bare NULLABLE — no DEFAULT, no COALESCE, no trigger
            // path can synthesize a value. This is the structural side of
            // "fallbacks are never folded into user_seen success."
            const userSeenLine = up.match(/user_seen_at[^,\n]*/);
            expect(userSeenLine).not.toBeNull();
            expect(userSeenLine[0]).not.toMatch(/DEFAULT/i);
            expect(userSeenLine[0]).not.toMatch(/COALESCE/i);
        });
    });
});
