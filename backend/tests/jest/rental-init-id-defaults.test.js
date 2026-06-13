/**
 * Regression: initRentalDatabase must re-assert the id-column DEFAULT on
 * bot_listings AND rental_contracts every startup. CREATE TABLE IF NOT EXISTS
 * is a no-op when the table already exists, so any prior migration that lost
 * the DEFAULT silently breaks every subsequent INSERT with
 *   23502 null value in column "id" of relation "bot_listings"
 *
 * Origin: card_68242d883b51c3b6ceda09cb — production POST /api/rental/listing
 * 500'd on every entity because the live bot_listings.id had no DEFAULT.
 * Mac_F's April listing succeeded under the old UUID DEFAULT, then a schema
 * change to VARCHAR(48) DEFAULT ('listing_' || ...) never reached prod.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const issued = [];

jest.mock('pg', () => {
    class FakePool {
        async connect() {
            return {
                query: async (sql) => { issued.push(String(sql).trim()); return { rows: [], rowCount: 0 }; },
                release: () => {},
            };
        }
        async query(sql) { issued.push(String(sql).trim()); return { rows: [], rowCount: 0 }; }
    }
    return { Pool: jest.fn().mockImplementation(() => new FakePool()) };
});

jest.mock('fs', () => {
    const real = jest.requireActual('fs');
    return {
        ...real,
        readFileSync: jest.fn((p, enc) => {
            if (typeof p === 'string' && p.endsWith('rental_schema.sql')) return '';
            return real.readFileSync(p, enc);
        }),
    };
});

const rental = require('../../rental');

const noopAuth = (_req, _res, next) => next();
const stubWallet = {
    withTransaction: async () => { throw new Error('not_used_in_init_tests'); },
    LEDGER_TYPES: {},
};
const api = rental({ authMiddleware: noopAuth, walletModule: stubWallet });

describe('rental: initRentalDatabase re-asserts id-column DEFAULTs (card_68242d88)', () => {
    beforeEach(() => { issued.length = 0; });

    test('emits ALTER TABLE bot_listings ALTER COLUMN id SET DEFAULT listing_...', async () => {
        await api.initRentalDatabase();
        const match = issued.find(q =>
            /ALTER TABLE\s+bot_listings\s+ALTER COLUMN\s+id\s+SET DEFAULT/i.test(q)
            && /'listing_'\s*\|\|\s*encode\(gen_random_bytes\(12\),\s*'hex'\)/i.test(q)
        );
        expect(match).toBeTruthy();
    });

    test('emits ALTER TABLE rental_contracts ALTER COLUMN id SET DEFAULT contract_... (parallel guard)', async () => {
        await api.initRentalDatabase();
        const match = issued.find(q =>
            /ALTER TABLE\s+rental_contracts\s+ALTER COLUMN\s+id\s+SET DEFAULT/i.test(q)
            && /'contract_'\s*\|\|\s*encode\(gen_random_bytes\(12\),\s*'hex'\)/i.test(q)
        );
        expect(match).toBeTruthy();
    });
});

describe('rental.js source-level regression (card_68242d88)', () => {
    test('rental.js literally contains the bot_listings.id SET DEFAULT statement', () => {
        const src = fs.readFileSync.getMockImplementation()
            ? require('fs').readFileSync(path.join(__dirname, '..', '..', 'rental.js'), 'utf8')
            : '';
        // Sanity: read the real file via the un-mocked real fs
        const real = jest.requireActual('fs');
        const text = real.readFileSync(path.join(__dirname, '..', '..', 'rental.js'), 'utf8');
        expect(text).toMatch(/ALTER TABLE bot_listings ALTER COLUMN id SET DEFAULT \('listing_' \|\| encode\(gen_random_bytes\(12\), 'hex'\)\)/);
    });
});
