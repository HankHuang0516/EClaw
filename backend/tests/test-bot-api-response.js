/**
 * Bot E-claw API Response Rate — Regression Test
 *
 * Verifies bots call POST /api/transform (via exec+curl) instead of replying
 * with plain webhook text (which is silently discarded by the server).
 *
 * Device ID is resolved in this order:
 *   1. --device CLI argument
 *   2. TEST_DEVICE_ID in backend/.env
 *   3. TEST_DEVICE_ID environment variable
 *
 * Usage:
 *   node test-bot-api-response.js                          # uses .env
 *   node test-bot-api-response.js --device DEVICE_ID       # explicit
 *   node test-bot-api-response.js --entity 0 --count 5     # options
 */

const path = require('path');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────
const API_BASE = 'https://eclaw.up.railway.app';
const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 120000;
const BETWEEN_TESTS_MS = 3000;
const TARGET_RATE = 90;

// ── Auto-load .env ──────────────────────────────────────────
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

// ── Test Cases ──────────────────────────────────────────────
// Each case has:
//   category  — what capability is being tested
//   purpose   — why this matters / what to fix if it fails
//   q         — the question sent to the bot
//   validate  — regex/fn to verify the *content* is correct
//
// A test PASSes if the bot called the API (message changed from default).
// Content validation is a secondary check reported separately.

// Tests are ordered so the first 10 cover ALL 6 categories (for regression suite).
// Full 20 can be run manually with --count 20.
const TEST_CASES = [
  // ── 1. arithmetic (core smoke test) ──
  {
    category: 'arithmetic',
    purpose: 'Simplest API call test — if this fails, push template is broken',
    q: 'What is 2+2?',
    validate: m => /4/.test(m),
  },
  // ── 2. factual ──
  {
    category: 'factual',
    purpose: 'Single-word factual answer — verifies message field is populated',
    q: 'What is the capital of Japan?',
    validate: m => /tokyo/i.test(m),
  },
  // ── 3. translation (UTF-8) ──
  {
    category: 'translation',
    purpose: 'Japanese output — tests UTF-8 / CJK in API message field',
    q: 'Say hello in Japanese',
    validate: m => /こんにち|konnichiwa/i.test(m),
  },
  // ── 4. list (multi-token) ──
  {
    category: 'list',
    purpose: 'Comma-separated list — tests multi-item response in message field',
    q: 'Name 3 fruits',
    validate: m => /apple|banana|orange|mango|grape|berry|melon|pear|peach/i.test(m),
  },
  // ── 5. open-ended ──
  {
    category: 'open-ended',
    purpose: 'Open-ended response — verifies API usage even without a fixed answer',
    q: 'Name a country in Africa',
    validate: m => m.length > 1,
  },
  // ── 6. edge ──
  {
    category: 'edge',
    purpose: 'Single-word animal answer — tests minimal-length API responses',
    q: 'What animal says meow?',
    validate: m => /cat/i.test(m),
  },
  // ── 7. arithmetic ──
  {
    category: 'arithmetic',
    purpose: 'Verify bot handles division and returns numeric result via API',
    q: 'What is 100 divided by 4?',
    validate: m => /25/.test(m),
  },
  // ── 8. factual ──
  {
    category: 'factual',
    purpose: 'Science fact — checks bot can deliver short factual content via API',
    q: 'What is H2O?',
    validate: m => /water/i.test(m),
  },
  // ── 9. translation ──
  {
    category: 'translation',
    purpose: 'French output — tests accented Latin characters',
    q: 'Translate hello to French',
    validate: m => /bonjour/i.test(m),
  },
  // ── 10. edge ──
  {
    category: 'edge',
    purpose: 'Numeric-only answer (7) — ensures short numbers trigger API call',
    q: 'How many days in a week?',
    validate: m => /7|seven/i.test(m),
  },

  // ── Extended tests (run with --count 20) ──────────────────
  {
    category: 'arithmetic',
    purpose: 'Multiplication — tests numeric response formatting',
    q: 'What is 7 times 8?',
    validate: m => /56/.test(m),
  },
  {
    category: 'factual',
    purpose: 'Literary knowledge — tests longer entity names in message field',
    q: 'Who wrote Romeo and Juliet?',
    validate: m => /shakespeare/i.test(m),
  },
  {
    category: 'factual',
    purpose: 'Geography — verifies open-ended responses still use API',
    q: 'What is the largest ocean?',
    validate: m => /pacific/i.test(m),
  },
  {
    category: 'factual',
    purpose: 'Biology — number-based factual answer',
    q: 'How many legs does a spider have?',
    validate: m => /8/.test(m),
  },
  {
    category: 'translation',
    purpose: 'Korean output — tests Hangul encoding through exec+curl',
    q: 'Translate thank you to Korean',
    validate: m => /감사|고마|gomawo|kamsahamnida/i.test(m),
  },
  {
    category: 'translation',
    purpose: 'German output — tests special chars (ü) in curl JSON payload',
    q: 'Say goodbye in German',
    validate: m => /tsch[uü]ss|auf wiedersehen|goodbye/i.test(m),
  },
  {
    category: 'list',
    purpose: 'Sequential numbers — tests structured output formatting',
    q: 'Count from 1 to 5',
    validate: m => /1.*2.*3.*4.*5/s.test(m),
  },
  {
    category: 'open-ended',
    purpose: 'Creative response — any valid programming language name',
    q: 'Name a programming language',
    validate: m => m.length > 1,
  },
  {
    category: 'open-ended',
    purpose: 'Opposite/antonym — tests conceptual reasoning + API call',
    q: 'What is the opposite of hot?',
    validate: m => /cold|cool/i.test(m),
  },
  {
    category: 'edge',
    purpose: 'Boolean fact — tests yes-type short answer via API',
    q: 'Is the sun a star?',
    validate: m => /yes|star/i.test(m),
  },
];

// ── Helpers ─────────────────────────────────────────────────
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getEntityStatus(deviceId, entityId) {
  return fetchJSON(`${API_BASE}/api/status?deviceId=${deviceId}&entityId=${entityId}`);
}

// ── Single Test Runner ──────────────────────────────────────
async function runSingleTest(deviceId, entityId, testCase, testNum) {
  const { q, validate, category } = testCase;

  const before = await getEntityStatus(deviceId, entityId);
  const baselineMsg = before.message;
  const baselineTs = before.lastUpdated;

  process.stdout.write(`  [${String(testNum).padStart(2)}] (${category.padEnd(10)}) "${q}" ... `);
  await postJSON(`${API_BASE}/api/client/speak`, {
    deviceId, entityId, text: q, source: 'automated_test',
  });

  const startTime = Date.now();
  let current;
  while (Date.now() - startTime < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);
    current = await getEntityStatus(deviceId, entityId);
    if (current.lastUpdated > baselineTs && current.message !== baselineMsg) break;
  }

  const waitMs = Date.now() - startTime;
  const newMsg = current?.message || '';
  const isDefault = ['Zzz...', 'Waiting...', '...', ''].includes(newMsg);
  const apiCalled = !isDefault && current.lastUpdated > baselineTs;
  const contentCorrect = validate(newMsg);
  const passed = apiCalled;

  if (passed && contentCorrect) {
    console.log(`PASS  (${(waitMs / 1000).toFixed(1)}s) -> "${newMsg}"`);
  } else if (passed && !contentCorrect) {
    console.log(`PASS* (${(waitMs / 1000).toFixed(1)}s) -> "${newMsg}" [unexpected content]`);
  } else {
    console.log(`FAIL  (${(waitMs / 1000).toFixed(1)}s) -> "${newMsg}" [no API call]`);
  }

  return { passed, message: newMsg, waitMs, contentCorrect, category };
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const envVars = loadEnvFile();
  const args = process.argv.slice(2);

  let deviceId = '';
  let entityId = 1;
  let count = 10;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--device' && args[i + 1]) deviceId = args[++i];
    if (args[i] === '--entity' && args[i + 1]) entityId = parseInt(args[++i]);
    if (args[i] === '--count' && args[i + 1]) count = parseInt(args[++i]);
  }

  // Fallback: .env -> environment variable
  if (!deviceId) deviceId = envVars.TEST_DEVICE_ID || process.env.TEST_DEVICE_ID || '';
  const deviceSecret = envVars.TEST_DEVICE_SECRET || process.env.TEST_DEVICE_SECRET || '';

  if (!deviceId) {
    console.error('Error: Device ID is required.');
    console.error('');
    console.error('  Option 1: Add TEST_DEVICE_ID=your-device-id to backend/.env');
    console.error('  Option 2: node test-bot-api-response.js --device YOUR_DEVICE_ID');
    console.error('  Option 3: set TEST_DEVICE_ID environment variable');
    process.exit(1);
  }

  const tests = TEST_CASES.slice(0, Math.min(count, TEST_CASES.length));

  console.log('='.repeat(65));
  console.log('  Bot E-claw API Response Rate — Regression Test');
  console.log('='.repeat(65));
  console.log(`  API:      ${API_BASE}`);
  console.log(`  Device:   ${deviceId}`);
  console.log(`  Entity:   ${entityId}`);
  console.log(`  Tests:    ${tests.length}`);
  console.log(`  Target:   >= ${TARGET_RATE}%`);
  console.log(`  Timeout:  ${MAX_WAIT_MS / 1000}s per test`);
  console.log('='.repeat(65));
  console.log('');

  const results = [];
  for (let i = 0; i < tests.length; i++) {
    const result = await runSingleTest(deviceId, entityId, tests[i], i + 1);
    results.push(result);
    if (i < tests.length - 1) await sleep(BETWEEN_TESTS_MS);
  }

  // ── Log / Telemetry API Verification ──
  console.log('');
  console.log('--- Log / Telemetry API Verification ---');
  if (deviceSecret) {
    try {
      const telUrl = `${API_BASE}/api/device-telemetry?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&type=api_req`;
      const telRes = await fetchJSON(telUrl);
      if (telRes.success && telRes.entries) {
        const actions = telRes.entries.map(e => e.action);
        const hasClientSpeak = actions.some(a => a.includes('/api/client/speak'));
        const hasStatus = actions.some(a => a.includes('/api/status'));
        const withDuration = telRes.entries.filter(e => e.duration != null && e.duration > 0);
        console.log(`  [${hasClientSpeak ? 'PASS' : 'FAIL'}] Telemetry logged POST /api/client/speak`);
        console.log(`  [${hasStatus ? 'PASS' : 'FAIL'}] Telemetry logged GET /api/status`);
        console.log(`  [PASS] Telemetry captured ${telRes.entries.length} API calls (${withDuration.length} with duration)`);
        if (!hasClientSpeak) failed++;
        if (!hasStatus) failed++;
      } else {
        console.log('  [FAIL] Telemetry API returned no entries');
        failed++;
      }

      const logUrl = `${API_BASE}/api/logs?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&limit=50`;
      const logRes = await fetchJSON(logUrl);
      console.log(`  [${logRes.success ? 'PASS' : 'FAIL'}] Server log API accessible (${logRes.count || 0} entries)`);
      if (!logRes.success) failed++;
    } catch (err) {
      console.log(`  [FAIL] Log/Telemetry verification: ${err.message}`);
      failed++;
    }
  } else {
    console.log('  [SKIP] TEST_DEVICE_SECRET not set in .env — add it to enable telemetry verification');
  }

  // ── Summary ──
  console.log('');
  console.log('='.repeat(65));
  console.log('  SUMMARY');
  console.log('='.repeat(65));

  const passed = results.filter(r => r.passed).length;
  const contentOk = results.filter(r => r.passed && r.contentCorrect).length;
  const failed = results.filter(r => !r.passed).length;
  const avgWait = (results.reduce((s, r) => s + r.waitMs, 0) / results.length / 1000).toFixed(1);
  const rate = ((passed / results.length) * 100).toFixed(1);

  console.log(`  Total:             ${results.length}`);
  console.log(`  API called (PASS): ${passed}`);
  console.log(`  Content correct:   ${contentOk}`);
  console.log(`  Failed:            ${failed}`);
  console.log(`  Success rate:      ${rate}%`);
  console.log(`  Avg response time: ${avgWait}s`);

  // ── Per-category breakdown ──
  const categories = [...new Set(TEST_CASES.map(t => t.category))];
  console.log('');
  console.log('  Per-category:');
  for (const cat of categories) {
    const catResults = results.filter((_, i) => tests[i] && tests[i].category === cat);
    if (catResults.length === 0) continue;
    const catPass = catResults.filter(r => r.passed).length;
    const catRate = ((catPass / catResults.length) * 100).toFixed(0);
    const icon = catPass === catResults.length ? '+' : '-';
    console.log(`    [${icon}] ${cat.padEnd(12)} ${catPass}/${catResults.length} (${catRate}%)`);
  }

  // ── Failed test details with fix guidance ──
  if (failed > 0) {
    console.log('');
    console.log('-'.repeat(65));
    console.log('  FAILED TESTS — Diagnostic Guide');
    console.log('-'.repeat(65));
    results.forEach((r, i) => {
      if (!r.passed) {
        const tc = tests[i];
        console.log(`  [${i + 1}] ${tc.category} | "${tc.q}"`);
        console.log(`      Got:     "${r.message}"`);
        console.log(`      Purpose: ${tc.purpose}`);
        console.log(`      Fix:     ${getDiagnosticHint(tc.category, r.message)}`);
        console.log('');
      }
    });
  }

  // ── Content mismatches (API called but wrong answer) ──
  const contentFails = results.filter(r => r.passed && !r.contentCorrect);
  if (contentFails.length > 0) {
    console.log('');
    console.log('-'.repeat(65));
    console.log('  CONTENT MISMATCHES (API called, but answer unexpected)');
    console.log('-'.repeat(65));
    results.forEach((r, i) => {
      if (r.passed && !r.contentCorrect) {
        console.log(`  [${i + 1}] "${tests[i].q}" -> "${r.message}"`);
      }
    });
    console.log('  Note: These still count as PASS (bot used the API correctly).');
    console.log('  Content issues are usually model quality, not push format.');
  }

  console.log('');
  const rateNum = parseFloat(rate);
  if (rateNum >= TARGET_RATE) {
    console.log(`  RESULT: PASS — ${rate}% >= ${TARGET_RATE}%`);
  } else {
    console.log(`  RESULT: FAIL — ${rate}% < ${TARGET_RATE}%`);
  }
  console.log('='.repeat(65));

  process.exit(failed > 0 ? 1 : 0);
}

// ── Diagnostic hints per category ───────────────────────────
function getDiagnosticHint(category, message) {
  const isDefault = ['Zzz...', 'Waiting...', '...', ''].includes(message);

  if (isDefault) {
    return 'Bot did not call API at all. Check: (1) push notification ACTION REQUIRED header in index.js, '
      + '(2) pre-filled curl template has correct botSecret/deviceId/entityId, '
      + '(3) server idle timer not overwriting response (should be 5+ min).';
  }

  switch (category) {
    case 'arithmetic':
      return 'Bot called API but math is wrong. Likely a model quality issue, not a push format problem.';
    case 'factual':
      return 'Bot called API but factual answer is wrong. Model quality issue — not actionable in push format.';
    case 'translation':
      return 'Check UTF-8 encoding in curl -d JSON payload. Ensure server parses request body with express.json().';
    case 'list':
      return 'Multi-item response may be truncated. Check message field length limit in /api/transform.';
    case 'open-ended':
      return 'Bot echoed the question or returned empty. Check if push instruction says "replace YOUR_REPLY_HERE".';
    case 'edge':
      return 'Short/trivial answer may not have triggered API call. Bot may skip API for single-char responses.';
    default:
      return 'Investigate push notification format and bot webhook logs.';
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
