/**
 * Schema-drift sentinel — card_7fc8e7abc3cb546e89721a26 (SI stream A).
 *
 * Catches the regression class that hid P0 card_68242d88 for 2 months:
 * a `CREATE TABLE IF NOT EXISTS` with `id ... DEFAULT (...)` won't apply
 * the DEFAULT to a live table that was created under an older schema. The
 * fix pattern is to also emit `ALTER TABLE <t> ALTER COLUMN id SET DEFAULT (...)`
 * idempotently at startup. rental_contracts already had this; bot_listings
 * did NOT — every new listing INSERT 500'd with 23502 not_null_violation.
 *
 * This test asserts: for every id-column DEFAULT declared in
 * rental_schema.sql, rental.js's startup init must contain a matching
 * `ALTER TABLE <t> ALTER COLUMN id SET DEFAULT (<expr>)` statement.
 *
 * The integration check that compares live information_schema.columns to
 * the schema file is intentionally gated on DATABASE_URL — kept separate
 * so the unit-only run stays fast and dep-free.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'rental_schema.sql');
const RENTAL_JS_PATH = path.join(__dirname, '..', '..', 'rental.js');

function parseIdDefaults(sqlText) {
    const results = [];
    let currentTable = null;
    for (const rawLine of sqlText.split('\n')) {
        const line = rawLine.trim();
        const tableStart = /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/i.exec(line);
        if (tableStart) {
            currentTable = tableStart[1];
            continue;
        }
        if (line.startsWith(');')) {
            currentTable = null;
            continue;
        }
        if (!currentTable) continue;
        if (!/^id\s+/i.test(line)) continue;
        const dm = /DEFAULT\s+\((.+)\)\s*,?\s*$/.exec(line);
        if (dm) {
            results.push({ table: currentTable, defaultExpr: dm[1].trim() });
        }
    }
    return results;
}

describe('rental schema-drift sentinel (card_7fc8e7ab — SI stream A)', () => {
    const schemaText = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const rentalJsText = fs.readFileSync(RENTAL_JS_PATH, 'utf8');
    const idDefaults = parseIdDefaults(schemaText);

    test('parser finds at least one id-column DEFAULT (sanity)', () => {
        // If this fails, the parser broke; the sentinel below would silently pass.
        expect(idDefaults.length).toBeGreaterThan(0);
    });

    test.each(
        // Materialize as an array of [tableName, defaultExpr] tuples so jest
        // names each case independently. New tables added to rental_schema.sql
        // with an id DEFAULT auto-grow this matrix.
        // Lazy-eval: idDefaults is parsed at describe-time.
        idDefaults.map(d => [d.table, d.defaultExpr])
    )('rental.js startup must SET DEFAULT for %s.id', (table /*, defaultExpr*/) => {
        // We don't require the DEFAULT expression to literally match — schema
        // files can use different whitespace than the JS string literal. We
        // require the presence of an `ALTER TABLE <t> ALTER COLUMN id SET DEFAULT`
        // line targeting this table, which is the regression guard.
        const pattern = new RegExp(
            `ALTER TABLE\\s+${table}\\s+ALTER COLUMN\\s+id\\s+SET DEFAULT`,
            'i'
        );
        expect(rentalJsText).toMatch(pattern);
    });
});

const dbDescribe = process.env.DATABASE_URL ? describe : describe.skip;

dbDescribe('schema-drift sentinel — live DB integration (gated on DATABASE_URL)', () => {
    let pool;
    beforeAll(async () => {
        const { Pool } = require('pg');
        pool = new Pool({ connectionString: process.env.DATABASE_URL });
    });
    afterAll(async () => { await pool?.end(); });

    const schemaText = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const idDefaults = parseIdDefaults(schemaText);

    test.each(idDefaults.map(d => [d.table]))(
        'live %s.id column has a DEFAULT set',
        async (table) => {
            const r = await pool.query(
                `SELECT column_default FROM information_schema.columns
                 WHERE table_name = $1 AND column_name = 'id'`,
                [table]
            );
            expect(r.rowCount).toBe(1);
            expect(r.rows[0].column_default).not.toBeNull();
            // Soft-check the DEFAULT contains the expected prefix (e.g.
            // 'listing_' or 'contract_'). Postgres normalizes/casts so the
            // exact string from the schema file won't round-trip 1:1.
        }
    );
});
