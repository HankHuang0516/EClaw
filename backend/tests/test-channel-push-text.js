/**
 * Channel Push Text Delivery — Regression Test
 *
 * Validates that when a client sends a message to a channel-bound entity,
 * the callback payload includes the correct `text` field.
 *
 * Regression: Entity #3 received "I didn't receive any text" because the
 * plugin's parseBody overwrote a pre-parsed req.body with {}.
 *
 * Strategy:
 *   1. Provision a channel account with test-sink as callback
 *   2. Bind an entity via channel API
 *   3. Client sends a message via POST /api/client/speak
 *   4. Poll test-sink to verify the callback payload has correct `text`
 *   5. Cleanup
 *
 * Usage:
 *   node test-channel-push-text.js
 *   node test-channel-push-text.js --local
 *
 * Credentials from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 */

const path = require('path');
const fs   = require('fs');

const args    = process.argv.slice(2);
const isLocal = args.includes('--local');
const API_BASE = isLocal ? 'http://localhost:3000' : 'https://eclawbot.com';

const POLL_INTERVAL_MS = 1500;
const MAX_WAIT_MS      = 15000;

// ── .env loader ─────────────────────────────────────────────────────────────
function loadEnvFile() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvFile();

const DEVICE_ID     = process.env.BROADCAST_TEST_DEVICE_ID;
const DEVICE_SECRET = process.env.BROADCAST_TEST_DEVICE_SECRET;

if (!DEVICE_ID || !DEVICE_SECRET) {
  console.error('Missing BROADCAST_TEST_DEVICE_ID / BROADCAST_TEST_DEVICE_SECRET');
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}`); }
}

async function api(method, endpoint, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${endpoint}`, opts);
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🔗 Channel Push Text Delivery Test — ${API_BASE}\n`);

  let channelApiKey = null;
  let testEntityId  = null;
  let botSecret     = null;

  try {
    // 1. Provision a channel account
    console.log('Step 1: Provision channel account');
    const provRes = await api('POST', '/api/channel/provision-device', {
      deviceId: DEVICE_ID,
      deviceSecret: DEVICE_SECRET,
      label: 'push-text-test'
    });
    assert(provRes.status === 200 || provRes.status === 201, `Provision status ${provRes.status}`);
    channelApiKey = provRes.data?.channel_api_key;
    assert(!!channelApiKey, 'Got channel_api_key');

    // 2. Register callback pointing to test-sink
    console.log('Step 2: Register callback (test-sink)');
    const sinkUrl = `${API_BASE}/api/channel/test-sink`;
    const regRes = await api('POST', '/api/channel/register', {
      channel_api_key: channelApiKey,
      callback_url: sinkUrl,
      callback_token: 'test-push-text-token'
    });
    assert(regRes.data?.success === true, 'Register callback OK');

    // 3. Find a free entity slot and bind
    console.log('Step 3: Bind entity');
    const bindRes = await api('POST', '/api/channel/bind', {
      channel_api_key: channelApiKey,
      name: 'PushTextTest'
    });
    assert(bindRes.data?.success === true, `Bind OK, entity=${bindRes.data?.entityId}`);
    testEntityId = bindRes.data?.entityId;
    botSecret    = bindRes.data?.botSecret;

    // 4. Clear test-sink before sending
    await api('DELETE', `/api/channel/test-sink?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);

    // 5. Client sends a text message
    const testText = `Push text test ${Date.now()}`;
    console.log(`Step 4: Client speaks "${testText}" to entity ${testEntityId}`);
    const speakRes = await api('POST', '/api/client/speak', {
      deviceId: DEVICE_ID,
      deviceSecret: DEVICE_SECRET,
      entityId: testEntityId,
      text: testText,
      source: 'test'
    });
    assert(speakRes.data?.success === true, 'Client speak OK');

    // 6. Poll test-sink for the callback payload
    console.log('Step 5: Poll test-sink for callback payload');
    let callbackPayload = null;
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const sinkRes = await api('GET', `/api/channel/test-sink?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);
      const messages = sinkRes.data?.messages || [];
      // Find the message for our entity
      const match = messages.find(m =>
        m.entityId === testEntityId && m.text === testText
      );
      if (match) {
        callbackPayload = match;
        break;
      }
    }

    assert(callbackPayload !== null, 'Callback received by test-sink');
    if (callbackPayload) {
      assert(callbackPayload.text === testText, `text field matches: "${callbackPayload.text}"`);
      assert(callbackPayload.event === 'message', `event is "message"`);
      assert(callbackPayload.from === 'test', `from is "test"`);
      assert(callbackPayload.entityId === testEntityId, `entityId matches`);
      assert(typeof callbackPayload.timestamp === 'number', 'timestamp is number');
    } else {
      failed += 4;
      console.error('  ✗ (skipped text/event/from/entity checks — no callback received)');
    }

  } finally {
    // Cleanup
    console.log('\nCleanup:');
    if (channelApiKey && testEntityId !== null) {
      await api('POST', '/api/channel/unbind', {
        channel_api_key: channelApiKey,
        entityId: testEntityId
      });
      console.log(`  Unbound entity ${testEntityId}`);
    }
    if (channelApiKey) {
      await api('DELETE', '/api/channel/register', {
        channel_api_key: channelApiKey
      });
      // Revoke the provisioned account
      await api('DELETE', `/api/channel/provision-device?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&channel_api_key=${channelApiKey}`);
      console.log('  Deleted channel account');
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
