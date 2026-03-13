#!/usr/bin/env node
'use strict';

/**
 * Regression test for Issue #189 — Interactive API Docs (OpenAPI/Swagger)
 *
 * Verifies:
 * 1. GET /api/docs returns 200 with HTML (Swagger UI)
 * 2. GET /api/docs/openapi.yaml returns valid YAML
 * 3. GET /api/docs/openapi.json returns valid JSON with required fields
 * 4. OpenAPI spec contains critical paths and schemas
 *
 * No credentials needed.
 */

const API_BASE = process.env.API_BASE || 'https://eclawbot.com';

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

async function fetchJSON(path) {
  const res = await fetch(`${API_BASE}${path}`);
  const body = await res.text();
  return { status: res.status, headers: res.headers, body, json: () => { try { return JSON.parse(body); } catch { return null; } } };
}

async function main() {
  console.log(`\n🧪 API Docs Regression Test (${API_BASE})\n`);

  // Test 1: Swagger UI HTML
  console.log('Test 1: GET /api/docs — Swagger UI');
  {
    const res = await fetch(`${API_BASE}/api/docs/`, { redirect: 'follow' });
    const body = await res.text();
    assert(res.status === 200, `Status 200 (got ${res.status})`);
    assert(body.includes('swagger') || body.includes('Swagger') || body.includes('openapi'), 'Response contains Swagger/OpenAPI content');
    assert(body.includes('html'), 'Response is HTML');
  }

  // Test 2: Raw YAML spec
  console.log('\nTest 2: GET /api/docs/openapi.yaml — Raw spec');
  {
    const res = await fetchJSON('/api/docs/openapi.yaml');
    assert(res.status === 200, `Status 200 (got ${res.status})`);
    assert(res.body.includes('openapi:'), 'Contains openapi version field');
    assert(res.body.includes('paths:'), 'Contains paths section');
    assert(res.body.includes('/api/client/speak'), 'Contains /api/client/speak path');
    assert(res.body.includes('/api/entity/agent-card'), 'Contains /api/entity/agent-card path');
  }

  // Test 3: JSON spec
  console.log('\nTest 3: GET /api/docs/openapi.json — JSON spec');
  {
    const res = await fetchJSON('/api/docs/openapi.json');
    assert(res.status === 200, `Status 200 (got ${res.status})`);
    const spec = res.json();
    assert(spec !== null, 'Valid JSON');
    assert(spec.openapi && spec.openapi.startsWith('3.'), `OpenAPI 3.x (got ${spec.openapi})`);
    assert(spec.info && spec.info.title === 'EClaw Platform API', `Title is "EClaw Platform API"`);
    assert(spec.paths, 'Has paths object');

    // Critical paths check
    const requiredPaths = [
      '/api/health',
      '/api/device/register',
      '/api/bind',
      '/api/client/speak',
      '/api/entity/speak-to',
      '/api/entity/broadcast',
      '/api/entity/agent-card',
      '/api/entity/lookup',
      '/api/mission/dashboard',
      '/api/auth/login',
      '/api/auth/register',
      '/api/transform'
    ];
    for (const p of requiredPaths) {
      assert(spec.paths[p], `Path ${p} exists`);
    }

    // Schema check
    assert(spec.components && spec.components.schemas, 'Has component schemas');
    const requiredSchemas = ['Entity', 'AgentCard', 'MissionDashboard', 'TodoItem', 'Error'];
    for (const s of requiredSchemas) {
      assert(spec.components.schemas[s], `Schema ${s} exists`);
    }

    // Security schemes
    assert(spec.components.securitySchemes, 'Has security schemes');
    assert(spec.components.securitySchemes.DeviceSecret, 'DeviceSecret scheme');
    assert(spec.components.securitySchemes.BotSecret, 'BotSecret scheme');
    assert(spec.components.securitySchemes.CookieAuth, 'CookieAuth scheme');
    assert(spec.components.securitySchemes.BearerAuth, 'BearerAuth scheme');
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
