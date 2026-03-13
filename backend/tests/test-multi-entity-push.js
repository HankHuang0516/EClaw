/**
 * Multi-Entity Push — Regression Test (Issue #181)
 *
 * Verifies that POST /api/client/speak with an array of entityIds
 * delivers push to ALL target entities, regardless of binding type mix.
 *
 * Tests:
 *   1. Send speak to array of entity IDs → all get processed (no silent skip)
 *   2. Response includes results for every target entity
 *   3. server_logs contain client_push entries for each entity (or diagnostic "skipped" entries)
 *   4. Single entity still works (non-regression)
 *
 * Credentials from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 *
 * Usage:
 *   node test-multi-entity-push.js
 */

const path = require('path');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────
const API_BASE = 'https://eclawbot.com';

// ── .env loader ─────────────────────────────────────────────
function loadEnvFile() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return {};
  const vars = {};
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx > 0) vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
  return vars;
}

// ── Helpers ─────────────────────────────────────────────────
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

// ── Test Result Tracking ────────────────────────────────────
const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  const icon = passed ? 'PASS' : 'FAIL';
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`  [${icon}] ${name}${suffix}`);
}

// ── Main ────────────────────────────────────────────────────
(async () => {
  console.log('\n══ Multi-Entity Push Regression Test (Issue #181) ══\n');

  const env = loadEnvFile();
  const deviceId = env.BROADCAST_TEST_DEVICE_ID;
  const deviceSecret = env.BROADCAST_TEST_DEVICE_SECRET;

  if (!deviceId || !deviceSecret) {
    console.error('Missing BROADCAST_TEST_DEVICE_ID or BROADCAST_TEST_DEVICE_SECRET in backend/.env');
    process.exit(1);
  }

  const timestamp = Date.now();

  // ── 1. Probe device by sending speak to entity 0 ──
  console.log('── 1. Verifying device accessibility ──');
  const { status: probeStatus } = await postJSON(`${API_BASE}/api/client/speak`, {
    deviceId, deviceSecret, entityId: 0, text: '[test-181] probe', source: 'regression_test'
  });
  check('Device accessible via client/speak', probeStatus === 200 || probeStatus === 429, `status=${probeStatus}`);

  // ── 2. Send speak to array of entity IDs ──
  console.log('\n── 2. POST /api/client/speak with entityId array ──');
  const testText = `[test-181] multi-entity push test ${timestamp}`;

  // Send to ALL entity slots (0-3) including unbound ones — tests resilience
  const targetIds = [0, 1, 2, 3];
  const { status: speakStatus, data: speakData } = await postJSON(`${API_BASE}/api/client/speak`, {
    deviceId, deviceSecret,
    entityId: targetIds,
    text: testText,
    source: 'regression_test'
  });

  check('Speak request succeeds (not 500)', speakStatus !== 500, `status=${speakStatus}`);
  check('Speak response has success field', speakData.success !== undefined, `success=${speakData.success}`);

  if (speakData.targets) {
    check('Response contains targets array', Array.isArray(speakData.targets), `length=${speakData.targets.length}`);

    // Verify every target entity has a result in the response (no silent drops)
    for (const eId of targetIds) {
      const target = speakData.targets.find(t => t.entityId === eId);
      check(`Entity ${eId} has result in response`, !!target,
        target ? `pushed=${target.pushed}, reason=${target.reason}` : 'MISSING from targets');
    }

    // Verify broadcast flag
    if (targetIds.length > 1) {
      check('Broadcast flag set for multi-entity', speakData.broadcast === true);
    }
  }

  // ── 3. Check server_logs for client_push entries ──
  console.log('\n── 3. Checking server_logs for push records ──');
  const logsUrl = `${API_BASE}/api/logs?deviceId=${deviceId}&deviceSecret=${deviceSecret}&category=client_push&limit=20&since=${timestamp - 5000}`;
  const logs = await fetchJSON(logsUrl);
  const pushLogs = (logs.logs || logs || []);

  check('Server logs returned', Array.isArray(pushLogs), `count=${pushLogs.length}`);

  // For each target entity, there should be SOME log entry (push OK, push failed, no webhook, or skipped)
  for (const eId of targetIds) {
    const entityLog = pushLogs.find(l =>
      l.message && l.message.includes(`Entity ${eId}`)
    );
    check(`Entity ${eId} has client_push log entry`, !!entityLog,
      entityLog ? `${entityLog.level}: ${entityLog.message.substring(0, 80)}` : 'NO LOG FOUND');
  }

  // ── 4. Single entity speak (non-regression) ──
  console.log('\n── 4. Single entity speak (non-regression) ──');
  const singleText = `[test-181] single entity test ${timestamp}`;
  const { status: singleStatus, data: singleData } = await postJSON(`${API_BASE}/api/client/speak`, {
    deviceId, deviceSecret,
    entityId: 0,
    text: singleText,
    source: 'regression_test'
  });
  check('Single entity speak succeeds', singleStatus === 200 || singleStatus === 429, `status=${singleStatus}`);
  if (singleStatus === 200) {
    check('Single entity response has targets', Array.isArray(singleData.targets), `length=${singleData.targets?.length}`);
    check('Single entity broadcast=false', singleData.broadcast === false);
  }

  // ── Summary ──
  console.log('\n══ Summary ══');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`  ${passed} passed, ${failed} failed out of ${results.length} checks`);

  if (failed > 0) {
    console.log('\n  Failed checks:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`    ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
})();
