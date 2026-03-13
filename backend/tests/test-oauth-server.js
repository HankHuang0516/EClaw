#!/usr/bin/env node
'use strict';

/**
 * Regression test for Issue #190 — OAuth 2.0 Authorization Server
 *
 * Verifies:
 * 1. POST /api/oauth/clients — Client registration (requires device auth)
 * 2. POST /api/oauth/clients — Rejects unauthenticated requests
 * 3. POST /api/oauth/token — client_credentials grant flow
 * 4. POST /api/oauth/token — Rejects invalid client credentials
 * 5. POST /api/oauth/introspect — Token introspection
 * 6. POST /api/oauth/revoke — Token revocation
 * 7. POST /api/oauth/introspect — Revoked token reports inactive
 * 8. POST /api/oauth/token — refresh_token grant flow
 *
 * Requires: BROADCAST_TEST_DEVICE_ID + BROADCAST_TEST_DEVICE_SECRET in backend/.env
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const API_BASE = process.env.API_BASE || 'https://eclawbot.com';
const DEVICE_ID = process.env.BROADCAST_TEST_DEVICE_ID;
const DEVICE_SECRET = process.env.BROADCAST_TEST_DEVICE_SECRET;

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

async function fetchJSON(method, urlPath, body, headers = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${urlPath}`, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function main() {
  console.log(`\n🧪 OAuth 2.0 Server Regression Test (${API_BASE})\n`);

  if (!DEVICE_ID || !DEVICE_SECRET) {
    console.error('❌ Missing BROADCAST_TEST_DEVICE_ID or BROADCAST_TEST_DEVICE_SECRET');
    process.exit(1);
  }

  // Test 1: Client registration requires auth
  console.log('Test 1: POST /api/oauth/clients — Requires auth');
  {
    const res = await fetchJSON('POST', '/api/oauth/clients', {
      client_name: 'Test Client'
    });
    assert(res.status === 401, `Status 401 (got ${res.status})`);
  }

  // Test 2: Register OAuth client
  console.log('\nTest 2: POST /api/oauth/clients — Register client');
  let clientId, clientSecret;
  {
    const res = await fetchJSON('POST', '/api/oauth/clients', {
      deviceId: DEVICE_ID,
      deviceSecret: DEVICE_SECRET,
      client_name: 'Regression Test Client',
      grant_types: ['client_credentials', 'refresh_token'],
      scopes: ['read', 'write']
    });
    assert(res.status === 201, `Status 201 (got ${res.status})`);
    assert(res.json && res.json.client_id, `Has client_id: ${res.json?.client_id?.substring(0, 10)}...`);
    assert(res.json && res.json.client_secret, 'Has client_secret');
    assert(res.json && res.json.client_name === 'Regression Test Client', 'Correct name');
    clientId = res.json?.client_id;
    clientSecret = res.json?.client_secret;
  }

  if (!clientId || !clientSecret) {
    console.error('❌ Cannot proceed — client registration failed');
    process.exit(1);
  }

  // Test 3: client_credentials flow
  console.log('\nTest 3: POST /api/oauth/token — client_credentials');
  let accessToken, refreshToken;
  {
    const res = await fetchJSON('POST', '/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'read write'
    });
    assert(res.status === 200, `Status 200 (got ${res.status})`);
    assert(res.json && res.json.access_token, 'Has access_token');
    assert(res.json && res.json.token_type === 'Bearer', 'Token type is Bearer');
    assert(res.json && res.json.expires_in > 0, `Expires in ${res.json?.expires_in}s`);
    assert(res.json && res.json.refresh_token, 'Has refresh_token');
    assert(res.json && res.json.scope, `Scope: ${res.json?.scope}`);
    accessToken = res.json?.access_token;
    refreshToken = res.json?.refresh_token;
  }

  // Test 4: Invalid client credentials
  console.log('\nTest 4: POST /api/oauth/token — Invalid credentials');
  {
    const res = await fetchJSON('POST', '/api/oauth/token', {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: 'wrong-secret'
    });
    assert(res.status === 401, `Status 401 (got ${res.status})`);
    assert(res.json && res.json.error === 'invalid_client', 'Error: invalid_client');
  }

  // Test 5: Token introspection
  if (accessToken) {
    console.log('\nTest 5: POST /api/oauth/introspect — Active token');
    {
      const res = await fetchJSON('POST', '/api/oauth/introspect', {
        token: accessToken
      });
      assert(res.status === 200, `Status 200 (got ${res.status})`);
      assert(res.json && res.json.active === true, 'Token is active');
      assert(res.json && res.json.client_id === clientId, 'Correct client_id');
      assert(res.json && res.json.scope, `Scope: ${res.json?.scope}`);
    }
  }

  // Test 6: Token revocation
  if (accessToken) {
    console.log('\nTest 6: POST /api/oauth/revoke — Revoke token');
    {
      const res = await fetchJSON('POST', '/api/oauth/revoke', {
        token: accessToken,
        token_type_hint: 'access_token'
      });
      assert(res.status === 200, `Status 200 (got ${res.status})`);
      assert(res.json && res.json.success === true, 'Revocation successful');
    }

    // Test 7: Introspect revoked token
    console.log('\nTest 7: POST /api/oauth/introspect — Revoked token');
    {
      const res = await fetchJSON('POST', '/api/oauth/introspect', {
        token: accessToken
      });
      assert(res.status === 200, `Status 200 (got ${res.status})`);
      assert(res.json && res.json.active === false, 'Token is inactive after revocation');
    }
  }

  // Test 8: Refresh token flow
  if (refreshToken) {
    console.log('\nTest 8: POST /api/oauth/token — refresh_token');
    {
      const res = await fetchJSON('POST', '/api/oauth/token', {
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken
      });
      assert(res.status === 200, `Status 200 (got ${res.status})`);
      assert(res.json && res.json.access_token, 'New access_token issued');
      assert(res.json && res.json.refresh_token, 'New refresh_token issued');
      assert(res.json && res.json.access_token !== accessToken, 'New token is different');
    }
  }

  // Test 9: Unsupported grant type
  console.log('\nTest 9: POST /api/oauth/token — Unsupported grant');
  {
    const res = await fetchJSON('POST', '/api/oauth/token', {
      grant_type: 'password',
      client_id: clientId,
      client_secret: clientSecret
    });
    assert(res.status === 400, `Status 400 (got ${res.status})`);
    assert(res.json && res.json.error === 'unsupported_grant_type', 'Error: unsupported_grant_type');
  }

  // Test 10: Introspect invalid token
  console.log('\nTest 10: POST /api/oauth/introspect — Invalid token');
  {
    const res = await fetchJSON('POST', '/api/oauth/introspect', {
      token: 'not-a-valid-jwt-token'
    });
    assert(res.status === 200, `Status 200 (got ${res.status})`);
    assert(res.json && res.json.active === false, 'Invalid token reports inactive');
  }

  // Summary
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('All tests passed! ✅\n');
}

main().catch(err => {
  console.error('Test runner error:', err.message);
  process.exit(1);
});
