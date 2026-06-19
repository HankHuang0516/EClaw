'use strict';

/**
 * hermes-org-token — card_1242aaa56221c42a1fe5ef87 ([Hermes/P2] H3 t2).
 *
 * Pins the per-org credential-scope contract:
 *   - entity-A granted org-X is allowed (issuance stubbed → 501, granted:true).
 *   - entity-A NOT granted org-Y is blocked → 403 + audit row (denied_no_grant).
 *   - Cross-org boundary: grant for org-X never leaks a token for org-Y.
 *   - Auth: bad/missing creds → 403; missing orgLogin → 400.
 *   - SECURITY: the route never returns the master PAT — only an installation
 *     token, which the stub does not produce yet (501).
 *   - Migration SQL ships entity_org_grants + audit table, replayable, with a
 *     matching down migration.
 *
 * Pool is a hermetic in-memory mock; no live PG harness required.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const mod = require('../../hermes-org-token');

// --- in-memory pool mock ---------------------------------------------------
// Stores grants + audit rows and answers the two queries the module runs:
//   - SELECT ... FROM entity_org_grants WHERE entity_id=$1 AND LOWER(org_login)=LOWER($2) ...
//   - INSERT INTO entity_org_token_audit ...
function makePool(grants) {
    const audit = [];
    const pool = {
        audit,
        async query(sql, params) {
            if (/FROM entity_org_grants/.test(sql)) {
                const [entityId, orgLogin, deviceId] = params;
                const row = grants.find(g =>
                    g.entity_id === entityId &&
                    g.org_login.toLowerCase() === String(orgLogin).toLowerCase() &&
                    !g.revoked_at &&
                    (g.device_id == null || g.device_id === deviceId));
                return { rows: row ? [{ installation_id: row.installation_id ?? null }] : [] };
            }
            if (/INSERT INTO entity_org_token_audit/.test(sql)) {
                const [entity_id, device_id, org_login, outcome, detail] = params;
                audit.push({ entity_id, device_id, org_login, outcome, detail });
                return { rows: [] };
            }
            return { rows: [] };
        },
    };
    return pool;
}

const DEVICE_ID = 'dev-1';
const DEVICE_SECRET = 'dsecret';
const BOT_SECRET = 'bsecret-A';
const ENTITY_A = 7;

function makeDevices() {
    return {
        [DEVICE_ID]: {
            deviceSecret: DEVICE_SECRET,
            entities: {
                [ENTITY_A]: { isBound: true, botSecret: BOT_SECRET },
            },
        },
    };
}

function makeApp(pool, devices) {
    mod._setPoolForTest(pool);
    mod._setDevicesForTest(devices);
    const app = express();
    app.use(express.json());
    app.use('/api/hermes', mod.router);
    return app;
}

describe('hermes-org-token — per-org credential scope', () => {
    test('entity-A granted org-X is allowed (issuance stubbed → 501, granted:true)', async () => {
        const pool = makePool([
            { entity_id: ENTITY_A, device_id: null, org_login: 'org-X', installation_id: 111 },
        ]);
        const app = makeApp(pool, makeDevices());

        const res = await request(app)
            .get('/api/hermes/org-token')
            .query({ deviceId: DEVICE_ID, botSecret: BOT_SECRET, entityId: ENTITY_A, orgLogin: 'org-X' });

        expect(res.status).toBe(501);
        expect(res.body.granted).toBe(true);
        expect(res.body.error).toBe('token_issuance_not_implemented');
        // SECURITY: no token (and certainly no PAT) is returned.
        expect(res.body.token).toBeUndefined();
        const granted = pool.audit.find(a => a.outcome === 'issuance_unavailable');
        expect(granted).toBeTruthy();
        expect(granted.org_login).toBe('org-X');
    });

    test('entity-A blocked in org-Y → 403 + audit denied_no_grant', async () => {
        const pool = makePool([
            { entity_id: ENTITY_A, device_id: null, org_login: 'org-X', installation_id: 111 },
        ]);
        const app = makeApp(pool, makeDevices());

        const res = await request(app)
            .get('/api/hermes/org-token')
            .query({ deviceId: DEVICE_ID, botSecret: BOT_SECRET, entityId: ENTITY_A, orgLogin: 'org-Y' });

        expect(res.status).toBe(403);
        expect(res.body.error).toBe('org_not_granted');
        expect(res.body.token).toBeUndefined();
        const denied = pool.audit.find(a => a.outcome === 'denied_no_grant');
        expect(denied).toBeTruthy();
        expect(denied.org_login).toBe('org-Y');
        expect(denied.entity_id).toBe(ENTITY_A);
    });

    test('org match is case-insensitive', async () => {
        const pool = makePool([
            { entity_id: ENTITY_A, device_id: null, org_login: 'Org-X', installation_id: 1 },
        ]);
        const app = makeApp(pool, makeDevices());
        const res = await request(app)
            .get('/api/hermes/org-token')
            .query({ deviceId: DEVICE_ID, botSecret: BOT_SECRET, entityId: ENTITY_A, orgLogin: 'ORG-x' });
        // grant found → not a 403; issuance stub → 501
        expect(res.status).toBe(501);
        expect(res.body.granted).toBe(true);
    });

    test('bad botSecret → 403 invalid credentials (no audit, no grant-check)', async () => {
        const pool = makePool([
            { entity_id: ENTITY_A, device_id: null, org_login: 'org-X', installation_id: 1 },
        ]);
        const app = makeApp(pool, makeDevices());
        const res = await request(app)
            .get('/api/hermes/org-token')
            .query({ deviceId: DEVICE_ID, botSecret: 'WRONG', entityId: ENTITY_A, orgLogin: 'org-X' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('Invalid credentials');
        expect(pool.audit.length).toBe(0);
    });

    test('deviceSecret auth without entityId → 403 (scope needs an entity)', async () => {
        const pool = makePool([]);
        const app = makeApp(pool, makeDevices());
        const res = await request(app)
            .get('/api/hermes/org-token')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, orgLogin: 'org-X' });
        expect(res.status).toBe(403);
    });

    test('missing orgLogin → 400', async () => {
        const pool = makePool([]);
        const app = makeApp(pool, makeDevices());
        const res = await request(app)
            .get('/api/hermes/org-token')
            .query({ deviceId: DEVICE_ID, botSecret: BOT_SECRET, entityId: ENTITY_A });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('orgLogin required');
    });

    test('device-scoped grant only matches its own device', async () => {
        // grant pinned to a DIFFERENT device → entity on DEVICE_ID is blocked.
        const pool = makePool([
            { entity_id: ENTITY_A, device_id: 'other-device', org_login: 'org-X', installation_id: 1 },
        ]);
        const app = makeApp(pool, makeDevices());
        const res = await request(app)
            .get('/api/hermes/org-token')
            .query({ deviceId: DEVICE_ID, botSecret: BOT_SECRET, entityId: ENTITY_A, orgLogin: 'org-X' });
        expect(res.status).toBe(403);
    });

    test('hasOrgGrant returns null for ungranted, installation for granted', async () => {
        const pool = makePool([
            { entity_id: ENTITY_A, device_id: null, org_login: 'org-X', installation_id: 222 },
        ]);
        mod._setPoolForTest(pool);
        expect(await mod.hasOrgGrant(ENTITY_A, DEVICE_ID, 'org-Y')).toBeNull();
        const g = await mod.hasOrgGrant(ENTITY_A, DEVICE_ID, 'org-X');
        expect(g).toEqual({ installationId: 222 });
    });

    test('issueInstallationToken: missing env vars → available:false (never the PAT)', async () => {
        const out = await mod.issueInstallationToken({ orgLogin: 'org-X', installationId: 1 });
        expect(out.available).toBe(false);
        expect(out.token).toBeUndefined();
        expect(out.reason).toMatch(/not_configured/);
    });

    test('issueInstallationToken: missing installationId → available:false', async () => {
        // Set fake env so we skip the "not configured" branch
        const origId = process.env.GITHUB_APP_ID;
        const origKey = process.env.GITHUB_APP_PRIVATE_KEY;
        process.env.GITHUB_APP_ID = '999999';
        process.env.GITHUB_APP_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n';
        try {
            const out = await mod.issueInstallationToken({ orgLogin: 'org-X', installationId: null });
            expect(out.available).toBe(false);
            expect(out.reason).toMatch(/installation_id_not_configured/);
        } finally {
            process.env.GITHUB_APP_ID = origId;
            process.env.GITHUB_APP_PRIVATE_KEY = origKey;
        }
    });

    test('issueInstallationToken: invalid private key → jwt_sign_failed', async () => {
        const origId = process.env.GITHUB_APP_ID;
        const origKey = process.env.GITHUB_APP_PRIVATE_KEY;
        process.env.GITHUB_APP_ID = '999999';
        process.env.GITHUB_APP_PRIVATE_KEY = 'not-a-valid-pem';
        try {
            const out = await mod.issueInstallationToken({ orgLogin: 'org-X', installationId: 1 });
            expect(out.available).toBe(false);
            expect(out.reason).toMatch(/jwt_sign_failed/);
        } finally {
            process.env.GITHUB_APP_ID = origId;
            process.env.GITHUB_APP_PRIVATE_KEY = origKey;
        }
    });

    test('issueInstallationToken: GitHub API error → token_exchange_failed', async () => {
        const origId = process.env.GITHUB_APP_ID;
        const origKey = process.env.GITHUB_APP_PRIVATE_KEY;
        process.env.GITHUB_APP_ID = '999999';
        // EC P-256 key pair — openssl ecparam -genkey -name prime256v1
        process.env.GITHUB_APP_PRIVATE_KEY = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIFe8oAGuj2L2qZqOPrg8W3S9pQ1W7v5y2w3N9p7Z8v6aAcGAcKBggq
hkiegZ4wHoGA8GBVAj8tF7n8L3V9z5Y1qE2mK9p4V7w5N8p1L3zQ2mH9vA
-----END EC PRIVATE KEY-----`;
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'Not Found' }) });
        try {
            const out = await mod.issueInstallationToken({ orgLogin: 'org-X', installationId: 1 });
            expect(out.available).toBe(false);
            expect(out.reason).toMatch(/token_exchange_failed/);
        } finally {
            globalThis.fetch = origFetch;
            process.env.GITHUB_APP_ID = origId;
            process.env.GITHUB_APP_PRIVATE_KEY = origKey;
        }
    });

    test('issueInstallationToken: success → returns scoped token with expiry', async () => {
        const origId = process.env.GITHUB_APP_ID;
        const origKey = process.env.GITHUB_APP_PRIVATE_KEY;
        process.env.GITHUB_APP_ID = '999999';
        // EC P-256 key pair — openssl ecparam -genkey -name prime256v1
        process.env.GITHUB_APP_PRIVATE_KEY = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIFe8oAGuj2L2qZqOPrg8W3S9pQ1W7v5y2w3N9p7Z8v6aAcGAcKBggq
hkiegZ4wHoGA8GBVAj8tF7n8L3V9z5Y1qE2mK9p4V7w5N8p1L3zQ2mH9vA
-----END EC PRIVATE KEY-----`;
        const origFetch = globalThis.fetch;
        const fakeToken = 'ghs_fake_installation_token_abc123';
        const fakeExpiry = new Date(Date.now() + 3600 * 1000).toISOString();
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => ({ token: fakeToken, expires_at: fakeExpiry }),
        });
        try {
            const out = await mod.issueInstallationToken({ orgLogin: 'my-org', installationId: 123456 });
            expect(out.available).toBe(true);
            expect(out.token).toBe(fakeToken);
            expect(out.expiresAt).toBe(fakeExpiry);
        } finally {
            globalThis.fetch = origFetch;
            process.env.GITHUB_APP_ID = origId;
            process.env.GITHUB_APP_PRIVATE_KEY = origKey;
        }
    });
});

describe('20260617_entity_org_grants migration', () => {
    const dir = path.join(__dirname, '..', '..', 'migrations');
    const up = fs.readFileSync(path.join(dir, '20260617_entity_org_grants.up.sql'), 'utf8');
    const down = fs.readFileSync(path.join(dir, '20260617_entity_org_grants.down.sql'), 'utf8');

    test('creates entity_org_grants with entity_id, org_login, granted_at (replayable)', () => {
        expect(up).toMatch(/CREATE TABLE IF NOT EXISTS entity_org_grants/);
        expect(up).toMatch(/entity_id\s+INTEGER NOT NULL/);
        expect(up).toMatch(/org_login\s+VARCHAR\(255\) NOT NULL/);
        expect(up).toMatch(/granted_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
    });

    test('ships the audit table and is replayable (IF NOT EXISTS everywhere)', () => {
        expect(up).toMatch(/CREATE TABLE IF NOT EXISTS entity_org_token_audit/);
        // every CREATE TABLE / INDEX is guarded
        const creates = up.match(/CREATE (?:TABLE|UNIQUE INDEX|INDEX)/g) || [];
        const guarded = up.match(/CREATE (?:TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS/g) || [];
        expect(guarded.length).toBe(creates.length);
        expect(creates.length).toBeGreaterThan(0);
    });

    test('down migration drops every object', () => {
        expect(down).toMatch(/DROP TABLE IF EXISTS entity_org_grants/);
        expect(down).toMatch(/DROP TABLE IF EXISTS entity_org_token_audit/);
    });

    test('migration never stores a token (security invariant)', () => {
        // no column named anything like token/pat in the grants/audit tables
        expect(up).not.toMatch(/token\s+(VARCHAR|TEXT)/i);
        expect(up).not.toMatch(/\bpat\b\s+(VARCHAR|TEXT)/i);
    });
});
