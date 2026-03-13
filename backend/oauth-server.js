'use strict';

/**
 * OAuth 2.0 Authorization Server
 * Issue #190
 *
 * Supports:
 * - client_credentials grant (machine-to-machine)
 * - authorization_code grant (third-party web apps)
 * - refresh_token grant
 * - Token revocation (RFC 7009)
 * - Token introspection (RFC 7662)
 *
 * Mounted at: /api/oauth
 *
 * Scopes: read, write, entity:manage, mission:manage, admin
 */

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const JWT_SECRET = process.env.JWT_SECRET || 'eclaw-dev-secret';
const ACCESS_TOKEN_TTL = 15 * 60; // 15 minutes in seconds
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const AUTH_CODE_TTL = 10 * 60; // 10 minutes in seconds
const VALID_SCOPES = ['read', 'write', 'entity:manage', 'mission:manage', 'admin'];

module.exports = function (devices, { serverLog } = {}) {
  const router = express.Router();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
  });

  // ── Initialize database ──
  async function initOAuthDatabase() {
    try {
      const schemaPath = path.join(__dirname, 'oauth_schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      const statements = schema.split(';').filter(s => s.trim());
      for (const stmt of statements) {
        if (stmt.trim()) await pool.query(stmt);
      }
      // Migrate: widen access_token column if needed (JWT tokens > 256 chars)
      await pool.query(`ALTER TABLE oauth_tokens ALTER COLUMN access_token TYPE VARCHAR(512)`).catch(() => {});
      console.log('[OAuth] Database initialized');
    } catch (err) {
      console.error('[OAuth] Database init error:', err.message);
    }
  }

  // ── Helpers ──

  function generateSecret(len = 48) {
    return crypto.randomBytes(len).toString('hex');
  }

  function generateId(prefix = '') {
    return prefix + crypto.randomBytes(16).toString('hex');
  }

  function validateScopes(requested) {
    if (!Array.isArray(requested)) return [];
    return requested.filter(s => VALID_SCOPES.includes(s));
  }

  function validateRedirectUri(uri) {
    try {
      const url = new URL(uri);
      // Allow localhost for development
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
      // Require HTTPS for production
      return url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function authenticateDevice(req) {
    const params = { ...req.query, ...req.body };
    const { deviceId, deviceSecret } = params;
    if (deviceId && deviceSecret) {
      const device = devices[deviceId];
      if (device && device.deviceSecret === deviceSecret) {
        return { deviceId, device };
      }
    }
    // Try cookie
    if (req.cookies && req.cookies.eclaw_session) {
      try {
        const decoded = jwt.verify(req.cookies.eclaw_session, JWT_SECRET);
        if (decoded.deviceId) {
          const device = devices[decoded.deviceId];
          if (device) return { deviceId: decoded.deviceId, device };
        }
      } catch {}
    }
    return null;
  }

  function signAccessToken(clientId, deviceId, scopes) {
    return jwt.sign({
      type: 'oauth_access',
      client_id: clientId,
      device_id: deviceId,
      scope: scopes.join(' ')
    }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
  }

  // ── POST /clients — Register OAuth client ──
  router.post('/clients', async (req, res) => {
    const auth = authenticateDevice(req);
    if (!auth) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Authentication required' });
    }

    const { client_name, redirect_uris, grant_types, scopes } = req.body;

    if (!client_name || typeof client_name !== 'string' || client_name.length > 255) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'client_name required (max 255 chars)' });
    }

    // Validate redirect URIs
    const uris = Array.isArray(redirect_uris) ? redirect_uris : [];
    for (const uri of uris) {
      if (!validateRedirectUri(uri)) {
        return res.status(400).json({ error: 'invalid_request', error_description: `Invalid redirect_uri: ${uri}` });
      }
    }

    // Validate grant types
    const validGrantTypes = ['authorization_code', 'client_credentials', 'refresh_token'];
    const grants = Array.isArray(grant_types) ? grant_types.filter(g => validGrantTypes.includes(g)) : ['client_credentials'];

    const validatedScopes = validateScopes(scopes || ['read']);

    const clientId = generateId('ecl_');
    const clientSecret = generateSecret();

    try {
      await pool.query(
        `INSERT INTO oauth_clients (client_id, client_secret, client_name, redirect_uris, grant_types, scopes, owner_device_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [clientId, clientSecret, client_name, JSON.stringify(uris), JSON.stringify(grants), JSON.stringify(validatedScopes), auth.deviceId]
      );

      if (serverLog) {
        serverLog('info', 'oauth', `[OAuth] Client registered: ${client_name}`, { deviceId: auth.deviceId });
      }

      res.status(201).json({
        client_id: clientId,
        client_secret: clientSecret,
        client_name,
        redirect_uris: uris,
        grant_types: grants,
        scopes: validatedScopes
      });
    } catch (err) {
      console.error('[OAuth] Client registration error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ── GET /clients — List own clients ──
  router.get('/clients', async (req, res) => {
    const auth = authenticateDevice(req);
    if (!auth) {
      return res.status(401).json({ error: 'invalid_client' });
    }

    try {
      const result = await pool.query(
        'SELECT client_id, client_name, redirect_uris, grant_types, scopes, created_at FROM oauth_clients WHERE owner_device_id = $1',
        [auth.deviceId]
      );
      res.json({ clients: result.rows });
    } catch (err) {
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ── GET /authorize — Authorization endpoint ──
  router.get('/authorize', async (req, res) => {
    const { response_type, client_id, redirect_uri, scope, state } = req.query;

    if (response_type !== 'code') {
      return res.status(400).json({ error: 'unsupported_response_type' });
    }

    if (!client_id) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'client_id required' });
    }

    // Verify client
    try {
      const result = await pool.query('SELECT * FROM oauth_clients WHERE client_id = $1', [client_id]);
      if (result.rows.length === 0) {
        return res.status(400).json({ error: 'invalid_client' });
      }

      const client = result.rows[0];
      const grantTypes = client.grant_types || [];
      if (!grantTypes.includes('authorization_code')) {
        return res.status(400).json({ error: 'unauthorized_client', error_description: 'authorization_code grant not allowed' });
      }

      // Validate redirect_uri
      const registeredUris = client.redirect_uris || [];
      if (redirect_uri && registeredUris.length > 0 && !registeredUris.includes(redirect_uri)) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri mismatch' });
      }

      const finalRedirectUri = redirect_uri || registeredUris[0];
      if (!finalRedirectUri) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'No redirect_uri available' });
      }

      // Check auth — must be authenticated device owner
      const auth = authenticateDevice(req);
      if (!auth) {
        // Return a simple auth-required response (in production, redirect to login page)
        return res.status(401).json({
          error: 'login_required',
          error_description: 'User authentication required. Provide deviceId+deviceSecret or session cookie.',
          authorize_url: req.originalUrl
        });
      }

      // Auto-approve (first-party) — generate code
      const requestedScopes = scope ? scope.split(' ') : [];
      const allowedScopes = validateScopes(requestedScopes.length > 0 ? requestedScopes : (client.scopes || ['read']));
      const code = generateSecret(32);

      await pool.query(
        `INSERT INTO oauth_authorization_codes (code, client_id, device_id, redirect_uri, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [code, client_id, auth.deviceId, finalRedirectUri, JSON.stringify(allowedScopes), Date.now() + AUTH_CODE_TTL * 1000]
      );

      // Redirect with code
      const redirectUrl = new URL(finalRedirectUri);
      redirectUrl.searchParams.set('code', code);
      if (state) redirectUrl.searchParams.set('state', state);

      res.redirect(302, redirectUrl.toString());
    } catch (err) {
      console.error('[OAuth] Authorize error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ── POST /token — Token endpoint ──
  router.post('/token', async (req, res) => {
    const { grant_type, code, redirect_uri, client_id, client_secret, refresh_token, scope } = req.body;

    if (!grant_type) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'grant_type required' });
    }

    // Authenticate client
    const cid = client_id || req.body.client_id;
    const csecret = client_secret || req.body.client_secret;

    // Also accept Basic auth
    let authClientId = cid;
    let authClientSecret = csecret;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Basic ')) {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
      const [basicId, basicSecret] = decoded.split(':');
      authClientId = authClientId || basicId;
      authClientSecret = authClientSecret || basicSecret;
    }

    if (!authClientId || !authClientSecret) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Client credentials required' });
    }

    try {
      const clientResult = await pool.query('SELECT * FROM oauth_clients WHERE client_id = $1', [authClientId]);
      if (clientResult.rows.length === 0 || clientResult.rows[0].client_secret !== authClientSecret) {
        return res.status(401).json({ error: 'invalid_client' });
      }

      const client = clientResult.rows[0];
      const grantTypes = client.grant_types || [];

      if (!grantTypes.includes(grant_type) && grant_type !== 'refresh_token') {
        return res.status(400).json({ error: 'unsupported_grant_type' });
      }

      // ── authorization_code ──
      if (grant_type === 'authorization_code') {
        if (!code) {
          return res.status(400).json({ error: 'invalid_request', error_description: 'code required' });
        }

        const codeResult = await pool.query(
          'SELECT * FROM oauth_authorization_codes WHERE code = $1 AND client_id = $2 AND used = FALSE',
          [code, authClientId]
        );

        if (codeResult.rows.length === 0) {
          return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired code' });
        }

        const authCode = codeResult.rows[0];

        if (authCode.expires_at < Date.now()) {
          await pool.query('UPDATE oauth_authorization_codes SET used = TRUE WHERE code = $1', [code]);
          return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired' });
        }

        if (redirect_uri && authCode.redirect_uri !== redirect_uri) {
          return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        }

        // Mark code as used
        await pool.query('UPDATE oauth_authorization_codes SET used = TRUE WHERE code = $1', [code]);

        const tokenScopes = authCode.scopes || ['read'];
        return issueTokens(res, authClientId, authCode.device_id, tokenScopes);
      }

      // ── client_credentials ──
      if (grant_type === 'client_credentials') {
        const requestedScopes = scope ? scope.split(' ') : [];
        const tokenScopes = validateScopes(requestedScopes.length > 0 ? requestedScopes : (client.scopes || ['read']));
        const ownerDeviceId = client.owner_device_id;

        return issueTokens(res, authClientId, ownerDeviceId, tokenScopes);
      }

      // ── refresh_token ──
      if (grant_type === 'refresh_token') {
        if (!refresh_token) {
          return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token required' });
        }

        const tokenResult = await pool.query(
          'SELECT * FROM oauth_tokens WHERE refresh_token = $1 AND client_id = $2 AND revoked = FALSE',
          [refresh_token, authClientId]
        );

        if (tokenResult.rows.length === 0) {
          return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
        }

        const oldToken = tokenResult.rows[0];

        // Revoke old tokens
        await pool.query('UPDATE oauth_tokens SET revoked = TRUE WHERE id = $1', [oldToken.id]);

        const tokenScopes = oldToken.scopes || ['read'];
        return issueTokens(res, authClientId, oldToken.device_id, tokenScopes);
      }

      res.status(400).json({ error: 'unsupported_grant_type' });
    } catch (err) {
      console.error('[OAuth] Token error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  async function issueTokens(res, clientId, deviceId, scopes) {
    const accessToken = signAccessToken(clientId, deviceId, scopes);
    const refreshToken = generateSecret(48);
    const tokenId = generateId('tok_');

    await pool.query(
      `INSERT INTO oauth_tokens (id, access_token, refresh_token, client_id, device_id, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tokenId, accessToken, refreshToken, clientId, deviceId, JSON.stringify(scopes), Date.now() + ACCESS_TOKEN_TTL * 1000]
    );

    if (serverLog) {
      serverLog('info', 'oauth', `[OAuth] Token issued for client ${clientId}`, { deviceId });
    }

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: refreshToken,
      scope: scopes.join(' ')
    });
  }

  // ── POST /revoke — Token revocation (RFC 7009) ──
  router.post('/revoke', async (req, res) => {
    const { token, token_type_hint } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    try {
      // Try as access_token first (or if hinted)
      if (!token_type_hint || token_type_hint === 'access_token') {
        const result = await pool.query(
          'UPDATE oauth_tokens SET revoked = TRUE WHERE access_token = $1 RETURNING id',
          [token]
        );
        if (result.rowCount > 0) {
          return res.status(200).json({ success: true });
        }
      }

      // Try as refresh_token
      if (!token_type_hint || token_type_hint === 'refresh_token') {
        const result = await pool.query(
          'UPDATE oauth_tokens SET revoked = TRUE WHERE refresh_token = $1 RETURNING id',
          [token]
        );
        if (result.rowCount > 0) {
          return res.status(200).json({ success: true });
        }
      }

      // RFC 7009: respond 200 even if token not found
      res.status(200).json({ success: true });
    } catch (err) {
      console.error('[OAuth] Revoke error:', err);
      res.status(500).json({ error: 'server_error' });
    }
  });

  // ── POST /introspect — Token introspection (RFC 7662) ──
  router.post('/introspect', async (req, res) => {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ active: false });
    }

    try {
      // Verify JWT first
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch {
        return res.json({ active: false });
      }

      if (decoded.type !== 'oauth_access') {
        return res.json({ active: false });
      }

      // Check if revoked in DB
      const result = await pool.query(
        'SELECT * FROM oauth_tokens WHERE access_token = $1 AND revoked = FALSE',
        [token]
      );

      if (result.rows.length === 0) {
        return res.json({ active: false });
      }

      const tokenRow = result.rows[0];

      res.json({
        active: true,
        scope: (tokenRow.scopes || []).join(' '),
        client_id: decoded.client_id,
        device_id: decoded.device_id,
        token_type: 'Bearer',
        exp: decoded.exp,
        iat: decoded.iat
      });
    } catch (err) {
      console.error('[OAuth] Introspect error:', err);
      res.json({ active: false });
    }
  });

  return { router, initOAuthDatabase };
};
