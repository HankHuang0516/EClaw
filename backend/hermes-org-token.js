'use strict';

/**
 * hermes-org-token.js — Per-org credential scope for Hermes.
 * Card: card_1242aaa56221c42a1fe5ef87 ([Hermes/P2] H3 t2)
 * Roadmap: 🤖 Hermes Channel — H3 Private Repo Support (roadmap.html line 682)
 *
 * Problem today: Hermes uses ONE vault PAT (GIT_HUB2) with whatever scope it was
 * issued for, so a Hermes session bound to entity-A can clone/push to ANY repo
 * the PAT can reach — including orgs that entity was never assigned to.
 *
 * This module tightens that to per-org scope:
 *   - entity_org_grants maps (entity_id, org_login) → an org that entity may use.
 *   - GET /api/hermes/org-token?orgLogin=X reads the authenticated entity from
 *     the request, checks entity_org_grants, and returns a SCOPED GitHub App
 *     installation token for that org — NEVER the master PAT.
 *   - Orgs not granted to the entity → 403 + an entity_org_token_audit row.
 *
 * SECURITY: this module never returns or logs the master PAT. The only token it
 * can ever return is a per-org GitHub App installation token from
 * issueInstallationToken(). Until that infra exists, issuance is stubbed behind
 * a clear interface and the route returns 501 — but the grant-check + 403 path
 * is fully implemented and tested so cross-org access is denied from day one.
 *
 * Auth shape mirrors /api/entity-status: deviceId+deviceSecret OR
 * deviceId+botSecret(+entityId). The resolved entityId is what the grant-check
 * runs against — a caller can only ever ask for tokens as the entity it
 * authenticated as.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const safeEqual = require('./safe-equal');

let pool = null;
let devicesRef = null;

// GitHub App credentials — read lazily inside issueInstallationToken() at call
// time so that test suites can set/unset process.env between calls without
// module-level caching interfering.  Set GITHUB_APP_ID (numeric) and
// GITHUB_APP_PRIVATE_KEY (PEM) via environment.  Both are required for real
// token issuance; when either is missing the stub is used (501).

function githubApiFetch(path, method, body, token) {
    const url = `https://api.github.com${path}`;
    const headers = {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body) {
        headers['Content-Type'] = 'application/json';
    }
    return fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
}

function bindDevicesRef(devices) {
    devicesRef = devices;
}

function initTable(chatPool) {
    pool = chatPool;
    // Mirror the migration so a fresh boot has the table even before the
    // migration runner executes (same self-heal pattern as entity-status).
    return pool.query(`
        CREATE TABLE IF NOT EXISTS entity_org_grants (
            id BIGSERIAL PRIMARY KEY,
            entity_id INTEGER NOT NULL,
            device_id VARCHAR(64),
            org_login VARCHAR(255) NOT NULL,
            installation_id BIGINT,
            granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            granted_by VARCHAR(64) NOT NULL DEFAULT 'admin',
            revoked_at TIMESTAMPTZ
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_org_grants
            ON entity_org_grants(entity_id, COALESCE(device_id, ''), LOWER(org_login));
        CREATE INDEX IF NOT EXISTS idx_entity_org_grants_lookup
            ON entity_org_grants(entity_id, LOWER(org_login))
            WHERE revoked_at IS NULL;

        CREATE TABLE IF NOT EXISTS entity_org_token_audit (
            id BIGSERIAL PRIMARY KEY,
            entity_id INTEGER NOT NULL,
            device_id VARCHAR(64),
            org_login VARCHAR(255) NOT NULL,
            outcome VARCHAR(32) NOT NULL,
            detail TEXT,
            requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_entity_org_token_audit_lookup
            ON entity_org_token_audit(entity_id, requested_at DESC);
    `);
}

// ---------------------------------------------------------------------------
// Auth — resolve the calling entity from the request (same shape as
// /api/entity-status authDeviceOrBot, minus the JWT cookie path which the proxy
// does not use; proxy calls carry deviceId+botSecret+entityId).
// ---------------------------------------------------------------------------
function authEntity(req) {
    const deviceId = req.query.deviceId || req.body?.deviceId;
    const deviceSecret = req.query.deviceSecret || req.body?.deviceSecret;
    const botSecret = req.query.botSecret || req.body?.botSecret;
    const callerEntityId = parseInt(req.query.entityId || req.body?.entityId, 10) || 0;

    if (!deviceId || !devicesRef || !devicesRef[deviceId]) return null;
    const device = devicesRef[deviceId];

    // Device-secret auth must still name which entity it is acting as — per-org
    // scope is meaningless without an entity to scope it to.
    if (deviceSecret && safeEqual(device.deviceSecret, deviceSecret)) {
        if (callerEntityId > 0) return { deviceId, entityId: callerEntityId };
        return null;
    }
    if (botSecret) {
        const ents = device.entities || {};
        if (callerEntityId > 0) {
            const e = ents[callerEntityId];
            if (e && e.isBound && e.botSecret && safeEqual(e.botSecret, botSecret)) {
                return { deviceId, entityId: callerEntityId };
            }
        } else {
            const match = Object.entries(ents).find(([, e]) =>
                e && e.isBound && e.botSecret && safeEqual(e.botSecret, botSecret));
            if (match) return { deviceId, entityId: Number(match[0]) };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Grant-check — does (entity_id, org_login) have an active grant?
// Case-insensitive on org_login. Device-scoped grants (device_id set) match
// only that device; any-device grants (device_id NULL) match every device.
// ---------------------------------------------------------------------------
async function hasOrgGrant(entityId, deviceId, orgLogin) {
    if (!pool) throw new Error('pool not initialized');
    const result = await pool.query(
        `SELECT installation_id
           FROM entity_org_grants
          WHERE entity_id = $1
            AND LOWER(org_login) = LOWER($2)
            AND revoked_at IS NULL
            AND (device_id IS NULL OR device_id = $3)
          ORDER BY device_id NULLS LAST
          LIMIT 1`,
        [entityId, orgLogin, deviceId || null]
    );
    if (result.rows.length === 0) return null;
    return { installationId: result.rows[0].installation_id };
}

async function writeAudit(entityId, deviceId, orgLogin, outcome, detail) {
    if (!pool) return;
    try {
        await pool.query(
            `INSERT INTO entity_org_token_audit
                (entity_id, device_id, org_login, outcome, detail)
             VALUES ($1, $2, $3, $4, $5)`,
            [entityId, deviceId || null, orgLogin, outcome, detail ? String(detail).slice(0, 500) : null]
        );
    } catch (err) {
        console.error('[hermes-org-token] audit write failed:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Token issuance — GitHub App JWT → per-org installation token.
//
// Implements the GitHub App installation flow:
//   1. Sign a JWT with the App private key (ES256, 10-min expiry).
//   2. POST /app/installations/:installation_id/access_tokens to mint an
//      installation access token scoped to that installation only.
//   3. Return the token + expiry to the caller.
//
// The installation_id is stored on the entity_org_grants row when the grant
// is provisioned.  The App must be installed on the target org first.
//
// Returns: { available, token?, expiresAt?, reason? }
// ---------------------------------------------------------------------------
async function issueInstallationToken({ orgLogin, installationId }) {
    // Read env at call time — not module-load time — so tests can set/unset
    // process.env between invocations without caching interfering.
    const appId = parseInt(process.env.GITHUB_APP_ID || '0', 10) || 0;
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY || '';
    if (!appId || !privateKey) {
        return {
            available: false,
            reason: 'github_app_not_configured',
        };
    }
    if (!installationId) {
        return {
            available: false,
            reason: 'installation_id_not_configured_on_grant',
        };
    }

    // --- Step 1: mint a short-lived App JWT ---------------------------------
    const now = Math.floor(Date.now() / 1000);
    let appJwt;
    try {
        appJwt = jwt.sign(
            {
                iat: now,
                exp: now + 600, // 10 minutes, GitHub rejects > 10 min for App JWTs
                iss: String(appId),
            },
            privateKey,
            { algorithm: 'ES256' }
        );
    } catch (err) {
        return { available: false, reason: `jwt_sign_failed: ${err.message}` };
    }

    // --- Step 2: exchange JWT → installation access token --------------------
    let response;
    try {
        response = await githubApiFetch(
            `/app/installations/${installationId}/access_tokens`,
            'POST',
            { permissions: { contents: 'write', pull_requests: 'write' } },
            appJwt
        );
    } catch (err) {
        return { available: false, reason: `api_request_failed: ${err.message}` };
    }

    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
            const body = await response.json();
            detail = body.error || body.message || detail;
        } catch (_) {}
        return { available: false, reason: `token_exchange_failed: ${detail}` };
    }

    let tokenData;
    try {
        tokenData = await response.json();
    } catch (err) {
        return { available: false, reason: `invalid_json_response: ${err.message}` };
    }

    return {
        available: true,
        token: tokenData.token,
        expiresAt: tokenData.expires_at ? new Date(tokenData.expires_at).toISOString() : null,
    };
}

const router = express.Router();

/**
 * GET /api/hermes/org-token?orgLogin=X
 * Auth: deviceId+deviceSecret+entityId OR deviceId+botSecret(+entityId)
 *
 * Flow:
 *   1. Resolve calling entity from creds (403 if not authed).
 *   2. Require orgLogin (400 if missing).
 *   3. Grant-check (entity, org). No active grant → 403 + audit. THIS IS THE
 *      multi-tenant boundary: an entity can never get a token for an org it was
 *      not granted.
 *   4. Issue a SCOPED installation token via issueInstallationToken(). If the
 *      issuance infra is not wired → 501 + audit (NOT 403 — the grant exists,
 *      we just can't mint yet). Never returns the master PAT.
 */
router.get('/org-token', async (req, res) => {
    const auth = authEntity(req);
    if (!auth) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    const orgLogin = String(req.query.orgLogin || '').trim();
    if (!orgLogin) {
        return res.status(400).json({ success: false, error: 'orgLogin required' });
    }
    if (!pool) {
        return res.status(500).json({ success: false, error: 'pool not initialized' });
    }

    try {
        const grant = await hasOrgGrant(auth.entityId, auth.deviceId, orgLogin);
        if (!grant) {
            await writeAudit(auth.entityId, auth.deviceId, orgLogin, 'denied_no_grant',
                'entity has no active grant for this org');
            // Deliberately generic message — do not leak whether the org exists.
            return res.status(403).json({
                success: false,
                error: 'org_not_granted',
                message: 'This entity is not granted access to the requested org.',
            });
        }

        const issued = await issueInstallationToken({
            orgLogin,
            installationId: grant.installationId,
        });

        if (!issued.available) {
            await writeAudit(auth.entityId, auth.deviceId, orgLogin, 'issuance_unavailable',
                issued.reason || 'issuance stub');
            return res.status(501).json({
                success: false,
                error: 'token_issuance_not_implemented',
                reason: issued.reason || 'github_app_installation_token_issuance_not_configured',
                message: 'Org grant verified, but scoped GitHub App installation-token '
                    + 'issuance is not yet wired. See hermes-org-token.js issueInstallationToken().',
                granted: true,
                orgLogin,
            });
        }

        await writeAudit(auth.entityId, auth.deviceId, orgLogin, 'granted', null);
        // SECURITY: only the per-org installation token is returned here.
        return res.json({
            success: true,
            orgLogin,
            token: issued.token,
            expiresAt: issued.expiresAt || null,
            scope: 'installation',
        });
    } catch (err) {
        console.error('[hermes-org-token] org-token error:', err.message);
        return res.status(500).json({ success: false, error: 'internal' });
    }
});

module.exports = {
    router,
    bindDevicesRef,
    initTable,
    // exported for tests + future grant-management routes
    authEntity,
    hasOrgGrant,
    writeAudit,
    issueInstallationToken,
    _setPoolForTest(p) { pool = p; },
    _setDevicesForTest(d) { devicesRef = d; },
    _githubApiFetch: githubApiFetch,
};
