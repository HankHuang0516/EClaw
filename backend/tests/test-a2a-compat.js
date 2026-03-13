#!/usr/bin/env node
'use strict';

/**
 * Regression test for Issue #187 — A2A Protocol Compatibility Layer
 *
 * Verifies:
 * 1. GET /.well-known/agent.json returns valid platform agent card
 * 2. GET /api/a2a/agents/:publicCode returns 404 for unknown code
 * 3. POST /api/a2a/tasks/send requires auth
 * 4. POST /api/a2a/tasks/send creates task (with valid credentials)
 * 5. GET /api/a2a/tasks/:taskId retrieves task
 * 6. POST /api/a2a/tasks/:taskId/cancel cancels task
 * 7. A2A endpoints return JSON-RPC 2.0 format
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
  console.log(`\n🧪 A2A Compatibility Regression Test (${API_BASE})\n`);

  if (!DEVICE_ID || !DEVICE_SECRET) {
    console.error('❌ Missing BROADCAST_TEST_DEVICE_ID or BROADCAST_TEST_DEVICE_SECRET');
    process.exit(1);
  }

  // Test 1: Platform agent card
  console.log('Test 1: GET /.well-known/agent.json — Platform card');
  {
    const res = await fetchJSON('GET', '/.well-known/agent.json');
    assert(res.status === 200, `Status 200 (got ${res.status})`);
    assert(res.json && res.json.name === 'EClaw Platform', 'Name is "EClaw Platform"');
    assert(res.json.provider && res.json.provider.organization === 'EClaw', 'Provider is EClaw');
    assert(Array.isArray(res.json.skills) && res.json.skills.length > 0, 'Has skills array');
    assert(res.json.capabilities && res.json.capabilities.pushNotifications === true, 'Push notifications capability');
    assert(res.json.version, 'Has version');
  }

  // Test 2: Unknown agent lookup
  console.log('\nTest 2: GET /api/a2a/agents/NONEXISTENT — 404');
  {
    const res = await fetchJSON('GET', '/api/a2a/agents/ZZZZNONEXIST');
    assert(res.status === 404, `Status 404 (got ${res.status})`);
    assert(res.json && res.json.error, 'Has error object');
  }

  // Test 3: tasks/send without auth
  console.log('\nTest 3: POST /api/a2a/tasks/send — Auth required');
  {
    const res = await fetchJSON('POST', '/api/a2a/tasks/send', {
      message: { parts: [{ type: 'text', text: 'test' }] }
    });
    assert(res.status === 401, `Status 401 (got ${res.status})`);
    assert(res.json && res.json.error && res.json.error.code === -32001, 'Error code -32001');
  }

  // Test 4: tasks/send with valid auth (Bearer token = deviceSecret)
  console.log('\nTest 4: POST /api/a2a/tasks/send — Create task');
  let taskId = null;
  {
    const res = await fetchJSON('POST', '/api/a2a/tasks/send', {
      jsonrpc: '2.0',
      id: 'test-1',
      params: {
        message: {
          role: 'user',
          parts: [{ type: 'text', text: '[A2A Test] Regression test task — safe to delete' }]
        }
      }
    }, {
      Authorization: `Bearer ${DEVICE_SECRET}`
    });
    assert(res.status === 200, `Status 200 (got ${res.status})`);
    assert(res.json && res.json.jsonrpc === '2.0', 'JSON-RPC 2.0 response');
    assert(res.json && res.json.result, 'Has result');
    if (res.json && res.json.result) {
      taskId = res.json.result.id;
      assert(taskId, `Task ID: ${taskId}`);
      assert(res.json.result.status && res.json.result.status.state === 'submitted', 'Status is submitted');
      assert(res.json.result.history && res.json.result.history.length > 0, 'Has history');
    }
  }

  // Test 5: tasks/get
  if (taskId) {
    console.log('\nTest 5: GET /api/a2a/tasks/:taskId — Retrieve task');
    {
      const res = await fetchJSON('GET', `/api/a2a/tasks/${taskId}?deviceId=${DEVICE_ID}`, null, {
        Authorization: `Bearer ${DEVICE_SECRET}`
      });
      assert(res.status === 200, `Status 200 (got ${res.status})`);
      assert(res.json && res.json.result && res.json.result.id === taskId, 'Correct task ID');
      assert(res.json.result.status.state === 'submitted', 'Status still submitted');
    }

    // Test 6: tasks/cancel
    console.log('\nTest 6: POST /api/a2a/tasks/:taskId/cancel — Cancel task');
    {
      const res = await fetchJSON('POST', `/api/a2a/tasks/${taskId}/cancel`, {
        deviceId: DEVICE_ID
      }, {
        Authorization: `Bearer ${DEVICE_SECRET}`
      });
      assert(res.status === 200, `Status 200 (got ${res.status})`);
      assert(res.json && res.json.result && res.json.result.status.state === 'canceled', 'Status is canceled');
    }

    // Test 7: Verify canceled state persists
    console.log('\nTest 7: GET /api/a2a/tasks/:taskId — Verify canceled');
    {
      const res = await fetchJSON('GET', `/api/a2a/tasks/${taskId}?deviceId=${DEVICE_ID}`, null, {
        Authorization: `Bearer ${DEVICE_SECRET}`
      });
      assert(res.status === 200, `Status 200 (got ${res.status})`);
      assert(res.json && res.json.result && res.json.result.status.state === 'canceled', 'Task remains canceled');
    }
  }

  // Test 8: tasks/send with invalid message
  console.log('\nTest 8: POST /api/a2a/tasks/send — Invalid params');
  {
    const res = await fetchJSON('POST', '/api/a2a/tasks/send', {
      jsonrpc: '2.0',
      params: { message: { parts: [] } }
    }, {
      Authorization: `Bearer ${DEVICE_SECRET}`
    });
    assert(res.status === 400, `Status 400 (got ${res.status})`);
    assert(res.json && res.json.error && res.json.error.code === -32602, 'Error code -32602 (invalid params)');
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
