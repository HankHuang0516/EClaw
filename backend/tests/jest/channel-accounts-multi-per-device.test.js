'use strict';

/**
 * Regression: channel_accounts must allow MANY accounts per device (audit spinoff card_4d9786fc).
 *
 * Bug: createTables() runs the idempotent `DROP CONSTRAINT channel_accounts_device_id_key`
 * migration BEFORE `CREATE TABLE channel_accounts (... UNIQUE(device_id))`. On a FRESH DB the
 * table does not exist when the DROP runs, so the DROP is a no-op; the CREATE then re-adds
 * UNIQUE(device_id) and it survives forever. A device's 2nd /provision then fails LOUD with a
 * unique violation (createChannelAccount is a plain INSERT → returns null → 500), even though
 * the schema's own comment says "Allow multiple channel accounts per device (each plugin gets
 * its own account)".
 *
 * Fix: do NOT declare UNIQUE(device_id) in the CREATE TABLE. Row identity is `channel_api_key
 * UNIQUE` (a fresh key per provision). The DROP migration stays for legacy DBs that still have
 * the constraint. This source-grep pins the invariant: re-introducing the device_id unique
 * constraint in the table definition fails here.
 */

const fs = require('fs');
const path = require('path');

const dbSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'db.js'), 'utf8');

function channelAccountsCreateBlock() {
    const start = dbSrc.indexOf('CREATE TABLE IF NOT EXISTS channel_accounts');
    expect(start).toBeGreaterThan(-1);
    // up to the closing of the CREATE TABLE statement
    const end = dbSrc.indexOf(')\n        `', start);
    return dbSrc.slice(start, end > start ? end : start + 600);
}

describe('channel_accounts: many-per-device (no UNIQUE(device_id) in CREATE TABLE)', () => {
    test('the CREATE TABLE channel_accounts block does NOT declare UNIQUE(device_id)', () => {
        const block = channelAccountsCreateBlock();
        expect(block).not.toMatch(/UNIQUE\s*\(\s*device_id\s*\)/);
    });

    test('row identity is still preserved by channel_api_key UNIQUE', () => {
        const block = channelAccountsCreateBlock();
        expect(block).toMatch(/channel_api_key\s+TEXT\s+NOT NULL\s+UNIQUE/);
    });

    test('the legacy DROP CONSTRAINT migration is retained for existing DBs', () => {
        expect(dbSrc).toMatch(/DROP CONSTRAINT channel_accounts_device_id_key/);
        // and it must remain guarded by an existence check (idempotent)
        expect(dbSrc).toMatch(/constraint_name = 'channel_accounts_device_id_key'/);
    });
});
