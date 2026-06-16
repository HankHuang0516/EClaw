'use strict';

const fs = require('fs');
const path = require('path');

const dbSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'db.js'), 'utf8');

describe('db.js bootstrap — pgcrypto extension auto-enable (card_c2612cb2)', () => {
    test('createTables() issues CREATE EXTENSION IF NOT EXISTS pgcrypto', () => {
        expect(dbSrc).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/);
    });

    test('pgcrypto bootstrap fires BEFORE the devices table create (so id DEFAULTs work on first run)', () => {
        const pgcryptoIdx = dbSrc.indexOf('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        const devicesIdx = dbSrc.indexOf('CREATE TABLE IF NOT EXISTS devices');
        expect(pgcryptoIdx).toBeGreaterThan(-1);
        expect(devicesIdx).toBeGreaterThan(-1);
        expect(pgcryptoIdx).toBeLessThan(devicesIdx);
    });

    test('pgcrypto failure is soft-handled with warn (matches pgvector pattern)', () => {
        // Mirror chat-embedding.js: CREATE EXTENSION may be privileged-only on
        // hosted PG; we warn and continue rather than crash boot
        expect(dbSrc).toMatch(/try\s*{\s*await client\.query\('CREATE EXTENSION IF NOT EXISTS pgcrypto'\);[\s\S]*?catch\s*\(err\)\s*{[\s\S]*?console\.warn\(/);
    });

    test('warn message names the consequence (gen_random_bytes DEFAULTs will fail) so DB admins know what to do', () => {
        expect(dbSrc).toMatch(/gen_random_bytes/);
        expect(dbSrc).toMatch(/pgcrypto CREATE EXTENSION failed/);
    });

    test('comment references card_c2612cb2 source of the bug', () => {
        expect(dbSrc).toMatch(/card_c2612cb2/);
    });

    test('does NOT use top-level await (would break Node ≤16) — extension call is inside async function', () => {
        // The CREATE EXTENSION must be inside the existing createTables() async fn,
        // not a new top-level await. Verify by checking it's not the first line of
        // a non-async block.
        const lines = dbSrc.split('\n');
        const pgcryptoLineIdx = lines.findIndex(l => l.includes("'CREATE EXTENSION IF NOT EXISTS pgcrypto'"));
        expect(pgcryptoLineIdx).toBeGreaterThan(-1);
        // Walk up to find the nearest async function — should find one
        let foundAsync = false;
        for (let i = pgcryptoLineIdx; i >= 0; i--) {
            if (/async\s+function\s+\w+/.test(lines[i])) { foundAsync = true; break; }
        }
        expect(foundAsync).toBe(true);
    });
});
