#!/usr/bin/env node
'use strict';

/**
 * Regression test for Issue #188 — Go and Rust SDK Support
 *
 * Verifies:
 * 1. OpenAPI spec at /api/docs/openapi.json is valid and generator-ready
 * 2. Spec contains required operationIds (needed for SDK method names)
 * 3. Spec has component schemas (needed for SDK model generation)
 * 4. SDK generation script exists and is executable
 * 5. SDK README files exist with correct content
 *
 * No credentials needed.
 */

const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE || 'https://eclawbot.com';
const ROOT_DIR = path.resolve(__dirname, '..', '..');

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

async function main() {
  console.log(`\n🧪 SDK Generation Regression Test (${API_BASE})\n`);

  // Test 1: OpenAPI spec is valid JSON
  console.log('Test 1: GET /api/docs/openapi.json — Valid spec');
  let spec;
  {
    const res = await fetch(`${API_BASE}/api/docs/openapi.json`);
    const body = await res.text();
    assert(res.status === 200, `Status 200 (got ${res.status})`);
    try {
      spec = JSON.parse(body);
      assert(true, 'Valid JSON');
    } catch {
      assert(false, 'Valid JSON — parse failed');
      console.error('Cannot continue without valid spec');
      process.exit(1);
    }
    assert(spec.openapi && spec.openapi.startsWith('3.'), `OpenAPI 3.x version (${spec.openapi})`);
  }

  // Test 2: Spec has operationIds (required for SDK method naming)
  console.log('\nTest 2: OperationIds for SDK generation');
  {
    const requiredOps = [
      'getHealth', 'registerDevice', 'clientSpeak', 'entitySpeakTo',
      'entityBroadcast', 'getMissionDashboard', 'addTodo',
      'setAgentCard', 'lookupEntity', 'login', 'register',
      'transform', 'a2aTaskSend', 'oauthToken'
    ];
    let allPaths = {};
    for (const [pathKey, methods] of Object.entries(spec.paths || {})) {
      for (const [method, config] of Object.entries(methods)) {
        if (config.operationId) {
          allPaths[config.operationId] = `${method.toUpperCase()} ${pathKey}`;
        }
      }
    }
    for (const op of requiredOps) {
      assert(allPaths[op], `operationId "${op}" exists → ${allPaths[op] || 'MISSING'}`);
    }
  }

  // Test 3: Component schemas for model generation
  console.log('\nTest 3: Component schemas');
  {
    const schemas = spec.components?.schemas || {};
    const required = ['Entity', 'AgentCard', 'MissionDashboard', 'TodoItem', 'Error', 'SpeakTarget', 'UserInfo'];
    for (const s of required) {
      assert(schemas[s], `Schema "${s}" exists`);
    }
    // Verify schemas have properties (not empty stubs)
    for (const s of required) {
      if (schemas[s]) {
        const hasProps = schemas[s].properties && Object.keys(schemas[s].properties).length > 0;
        assert(hasProps, `Schema "${s}" has properties`);
      }
    }
  }

  // Test 4: Security schemes for auth generation
  console.log('\nTest 4: Security schemes');
  {
    const schemes = spec.components?.securitySchemes || {};
    assert(schemes.DeviceSecret, 'DeviceSecret scheme');
    assert(schemes.BotSecret, 'BotSecret scheme');
    assert(schemes.BearerAuth, 'BearerAuth scheme');
    assert(schemes.CookieAuth, 'CookieAuth scheme');
  }

  // Test 5: SDK generation script exists
  console.log('\nTest 5: SDK infrastructure files');
  {
    const generateScript = path.join(ROOT_DIR, 'sdk', 'generate.sh');
    assert(fs.existsSync(generateScript), 'sdk/generate.sh exists');

    const goReadme = path.join(ROOT_DIR, 'sdk', 'go', 'README.md');
    assert(fs.existsSync(goReadme), 'sdk/go/README.md exists');
    if (fs.existsSync(goReadme)) {
      const content = fs.readFileSync(goReadme, 'utf8');
      assert(content.includes('eclaw'), 'Go README references eclaw package');
    }

    const rustReadme = path.join(ROOT_DIR, 'sdk', 'rust', 'README.md');
    assert(fs.existsSync(rustReadme), 'sdk/rust/README.md exists');
    if (fs.existsSync(rustReadme)) {
      const content = fs.readFileSync(rustReadme, 'utf8');
      assert(content.includes('eclaw'), 'Rust README references eclaw crate');
    }
  }

  // Test 6: Spec servers config
  console.log('\nTest 6: Server configuration');
  {
    const servers = spec.servers || [];
    assert(servers.length > 0, 'Has server entries');
    const hasProd = servers.some(s => s.url && s.url.includes('eclawbot.com'));
    assert(hasProd, 'Has production server URL');
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
