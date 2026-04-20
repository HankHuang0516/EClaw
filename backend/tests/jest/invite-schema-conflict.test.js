/**
 * Regression: invite_codes schema conflict.
 *
 * Two files used to CREATE TABLE IF NOT EXISTS invite_codes with
 * incompatible columns:
 *   - auth_schema.sql:171 — legacy device-based (owner_device_id, ...)
 *   - invite_schema.sql:9 — Phase-5 user-based (owner_user_id, ...)
 * In prod, whichever ran first silently won (CREATE IF NOT EXISTS),
 * leaving the loser's columns undefined. growth.js went around the
 * problem via invite_redemptions.
 *
 * This test locks in the de-conflict fix: auth_schema.sql is the
 * sole source of truth for invite_codes; invite_schema.sql only
 * owns invite_redemptions.
 */

const fs = require('fs');
const path = require('path');

const authSchema = fs.readFileSync(
    path.join(__dirname, '..', '..', 'auth_schema.sql'),
    'utf8'
);
const inviteSchema = fs.readFileSync(
    path.join(__dirname, '..', '..', 'invite_schema.sql'),
    'utf8'
);

describe('invite_codes schema has a single source of truth', () => {
    test('auth_schema.sql creates invite_codes (legacy device-based)', () => {
        expect(authSchema).toMatch(/CREATE TABLE IF NOT EXISTS invite_codes\b/);
        // Sanity on legacy columns
        expect(authSchema).toMatch(/owner_device_id\b/);
        expect(authSchema).toMatch(/used_by_device_id\b/);
    });

    test('invite_schema.sql does NOT create invite_codes', () => {
        expect(inviteSchema).not.toMatch(/CREATE TABLE IF NOT EXISTS invite_codes\b/);
    });

    test('invite_schema.sql does NOT create the Phase-5 idx_invite_owner index', () => {
        // Was: CREATE INDEX IF NOT EXISTS idx_invite_owner ON invite_codes(owner_user_id)
        // That index references a column that does not exist in the legacy table.
        expect(inviteSchema).not.toMatch(/idx_invite_owner\b/);
    });

    test('invite_schema.sql still owns invite_redemptions (used by growth.js)', () => {
        expect(inviteSchema).toMatch(/CREATE TABLE IF NOT EXISTS invite_redemptions\b/);
        expect(inviteSchema).toMatch(/FOREIGN KEY \(code\)\s+REFERENCES invite_codes\(code\)/);
    });

    test('only one invite_codes CREATE in the whole backend/*.sql tree', () => {
        const backendDir = path.join(__dirname, '..', '..');
        const sqlFiles = fs.readdirSync(backendDir).filter(f => f.endsWith('.sql'));
        const creators = [];
        for (const f of sqlFiles) {
            const src = fs.readFileSync(path.join(backendDir, f), 'utf8');
            if (/CREATE TABLE IF NOT EXISTS invite_codes\b/.test(src)) {
                creators.push(f);
            }
        }
        expect(creators).toEqual(['auth_schema.sql']);
    });
});
