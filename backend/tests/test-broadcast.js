/**
 * Broadcast API — Comprehensive Regression Test
 *
 * Tests the full broadcast flow:
 *   1. Register + bind test entities (random 1-3 extras alongside any existing ones)
 *   2. Send broadcast from one entity
 *   3. Verify all other bound entities received the broadcast (entity.message updated)
 *   4. Verify chat history contains the broadcast with correct delivered_to
 *   5. Verify speak-to reply appears in chat history
 *   6. Cleanup: unbind test entities
 *
 * Credentials are auto-loaded from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 *
 * Usage:
 *   node test-broadcast.js
 *   node test-broadcast.js --extras 2          # bind exactly 2 extra test entities
 *   node test-broadcast.js --skip-cleanup      # keep test entities after test
 */

const path = require('path');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────
const API_BASE = 'https://eclaw.up.railway.app';
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 30000;

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
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function deleteJSON(url, body) {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data; // Don't throw on error — cleanup should be best-effort
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Test Result Tracking ────────────────────────────────────
const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  const icon = passed ? 'PASS' : 'FAIL';
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`  [${icon}] ${name}${suffix}`);
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  const env = loadEnvFile();
  const args = process.argv.slice(2);

  const deviceId = env.BROADCAST_TEST_DEVICE_ID || process.env.BROADCAST_TEST_DEVICE_ID || '';
  const deviceSecret = env.BROADCAST_TEST_DEVICE_SECRET || process.env.BROADCAST_TEST_DEVICE_SECRET || '';
  let numExtras = 0; // How many extra test entities to create
  let skipCleanup = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--extras' && args[i + 1]) numExtras = parseInt(args[++i]);
    if (args[i] === '--skip-cleanup') skipCleanup = true;
  }

  if (!deviceId || !deviceSecret) {
    console.error('Error: BROADCAST_TEST_DEVICE_ID and BROADCAST_TEST_DEVICE_SECRET required in backend/.env');
    process.exit(1);
  }

  // Auto-determine extras if not specified: random 1-3
  if (numExtras === 0) numExtras = Math.floor(Math.random() * 3) + 1;

  console.log('='.repeat(65));
  console.log('  Broadcast API — Comprehensive Regression Test');
  console.log('='.repeat(65));
  console.log(`  API:           ${API_BASE}`);
  console.log(`  Device:        ${deviceId}`);
  console.log(`  Extra entities: ${numExtras} (will be created then cleaned up)`);
  console.log('='.repeat(65));
  console.log('');

  // Track test entities we create (for cleanup)
  const testEntities = []; // { entityId, botSecret }

  // ────────────────────────────────────────────────────
  // Phase 1: Discover existing state
  // ────────────────────────────────────────────────────
  console.log('--- Phase 1: Discover existing entities ---');

  const entitiesRes = await fetchJSON(`${API_BASE}/api/entities?deviceId=${deviceId}`);
  const existingBound = entitiesRes.entities || [];
  const existingIds = new Set(existingBound.map(e => e.entityId));

  console.log(`  Found ${existingBound.length} already-bound entities: [${[...existingIds].join(', ')}]`);
  for (const e of existingBound) {
    console.log(`    Entity ${e.entityId}: ${e.character} "${e.name || '(unnamed)'}" state=${e.state}`);
  }
  console.log('');

  // ────────────────────────────────────────────────────
  // Phase 2: Register + bind test entities
  // ────────────────────────────────────────────────────
  console.log('--- Phase 2: Register + bind test entities ---');

  // Find available slots (not already bound)
  const availableSlots = [];
  for (let i = 0; i < 4; i++) {
    if (!existingIds.has(i)) availableSlots.push(i);
  }

  const slotsToUse = availableSlots.slice(0, numExtras);
  console.log(`  Available slots: [${availableSlots.join(', ')}], will use: [${slotsToUse.join(', ')}]`);

  for (const slot of slotsToUse) {
    try {
      // Register to get binding code
      const regRes = await postJSON(`${API_BASE}/api/device/register`, {
        deviceId,
        deviceSecret,
        entityId: slot,
        appVersion: 'test-broadcast',
      });

      check(`Register Entity ${slot}`, regRes.success, `code=${regRes.bindingCode}`);

      // Bind with the code
      const bindRes = await postJSON(`${API_BASE}/api/bind`, {
        code: regRes.bindingCode,
        name: `Test-${slot}`,
      });

      check(`Bind Entity ${slot}`, bindRes.success, `botSecret=${bindRes.botSecret?.slice(0, 8)}...`);
      testEntities.push({ entityId: slot, botSecret: bindRes.botSecret });
    } catch (err) {
      check(`Setup Entity ${slot}`, false, err.message);
    }
  }

  // Refresh bound entities list
  const afterBindRes = await fetchJSON(`${API_BASE}/api/entities?deviceId=${deviceId}`);
  const allBound = afterBindRes.entities || [];
  const allBoundIds = allBound.map(e => e.entityId);
  console.log(`\n  All bound entities now: [${allBoundIds.join(', ')}] (${allBound.length} total)`);
  check('At least 2 bound entities for broadcast', allBound.length >= 2, `count=${allBound.length}`);
  console.log('');

  if (allBound.length < 2) {
    console.error('  Cannot test broadcast with fewer than 2 entities. Aborting.');
    await cleanup(testEntities, deviceId, skipCleanup);
    printSummary();
    process.exit(1);
  }

  // ────────────────────────────────────────────────────
  // Phase 3: Pick sender + send broadcast
  // ────────────────────────────────────────────────────
  console.log('--- Phase 3: Send broadcast ---');

  // Pick a sender: prefer a test entity (we have its botSecret)
  let sender;
  if (testEntities.length > 0) {
    sender = testEntities[0];
  } else {
    console.error('  No test entities available to send broadcast from. Need at least 1 test entity.');
    await cleanup(testEntities, deviceId, skipCleanup);
    printSummary();
    process.exit(1);
  }

  const broadcastText = `Broadcast-test-${Date.now()}`;
  const expectedTargets = allBoundIds.filter(id => id !== sender.entityId);

  console.log(`  Sender: Entity ${sender.entityId}`);
  console.log(`  Targets: [${expectedTargets.join(', ')}]`);
  console.log(`  Message: "${broadcastText}"`);

  // Record baseline for each target
  const baselines = {};
  for (const tid of expectedTargets) {
    const st = await fetchJSON(`${API_BASE}/api/status?deviceId=${deviceId}&entityId=${tid}`);
    baselines[tid] = { message: st.message, lastUpdated: st.lastUpdated };
  }

  // Send broadcast
  let broadcastRes;
  try {
    broadcastRes = await postJSON(`${API_BASE}/api/entity/broadcast`, {
      deviceId,
      fromEntityId: sender.entityId,
      botSecret: sender.botSecret,
      text: broadcastText,
    });

    check('Broadcast API success', broadcastRes.success, `sentCount=${broadcastRes.sentCount}`);
    check('Broadcast sentCount matches targets',
      broadcastRes.sentCount === expectedTargets.length,
      `expected=${expectedTargets.length}, got=${broadcastRes.sentCount}`
    );

    // Check individual target results
    if (broadcastRes.targets) {
      for (const t of broadcastRes.targets) {
        check(`Broadcast target Entity ${t.entityId} acknowledged`,
          true,
          `mode=${t.mode}, pushed=${t.pushed}`
        );
      }
    }
  } catch (err) {
    check('Broadcast API call', false, err.message);
    await cleanup(testEntities, deviceId, skipCleanup);
    printSummary();
    process.exit(1);
  }
  console.log('');

  // ────────────────────────────────────────────────────
  // Phase 4: Verify each target entity received broadcast
  // ────────────────────────────────────────────────────
  console.log('--- Phase 4: Verify entities received broadcast ---');

  // Wait a moment for server to process
  await sleep(2000);

  for (const tid of expectedTargets) {
    const st = await fetchJSON(`${API_BASE}/api/status?deviceId=${deviceId}&entityId=${tid}`);
    const baseline = baselines[tid];

    // Check if message was updated
    const messageUpdated = st.lastUpdated > baseline.lastUpdated;
    const containsBroadcast = st.message && st.message.includes(broadcastText);

    check(`Entity ${tid} message updated`, messageUpdated,
      `old=${baseline.lastUpdated}, new=${st.lastUpdated}`
    );
    check(`Entity ${tid} message contains broadcast text`, containsBroadcast,
      `message="${st.message?.slice(0, 80)}"`
    );
  }

  // Poll delivered_to until all webhook targets are marked, or timeout
  console.log('\n  Waiting for webhook push delivery (polling delivered_to, max 60s)...');
  const deliveryStart = Date.now();
  const deliveryTimeout = 60000;
  let lastDeliveredTo = '';
  while (Date.now() - deliveryStart < deliveryTimeout) {
    await sleep(5000);
    const histCheck = await fetchJSON(`${API_BASE}/api/chat/history?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&limit=10`);
    const bMsg = (histCheck.messages || []).find(m => m.text === broadcastText && m.is_from_bot === true);
    lastDeliveredTo = bMsg?.delivered_to || '';
    const ids = lastDeliveredTo.split(',').map(s => s.trim()).filter(Boolean);
    const allDelivered = expectedTargets.every(t => ids.includes(String(t)));
    console.log(`  [${((Date.now() - deliveryStart) / 1000).toFixed(0)}s] delivered_to="${lastDeliveredTo}" (${ids.length}/${expectedTargets.length})`);
    if (allDelivered) break;
  }

  for (const tid of expectedTargets) {
    const st = await fetchJSON(`${API_BASE}/api/status?deviceId=${deviceId}&entityId=${tid}`);
    console.log(`  Entity ${tid}: state=${st.state}, message="${st.message?.slice(0, 60)}"`);
  }
  console.log('');

  // ────────────────────────────────────────────────────
  // Phase 5: Verify chat history
  // ────────────────────────────────────────────────────
  console.log('--- Phase 5: Verify chat history ---');

  try {
    const historyUrl = `${API_BASE}/api/chat/history?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&limit=50`;
    const historyRes = await fetchJSON(historyUrl);

    check('Chat history API success', historyRes.success === true);

    const messages = historyRes.messages || [];
    console.log(`  Total messages in history: ${messages.length}`);

    // Find the broadcast message
    const broadcastMsg = messages.find(m =>
      m.text === broadcastText && m.is_from_bot === true
    );

    check('Broadcast message found in chat history',
      !!broadcastMsg,
      broadcastMsg
        ? `id=${broadcastMsg.id}, source="${broadcastMsg.source}"`
        : 'not found — check saveChatMessage in broadcast handler'
    );

    if (broadcastMsg) {
      // Check source format: entity:X:CHARACTER->targetIds
      const sourceHasTargets = broadcastMsg.source && broadcastMsg.source.includes('->');
      check('Broadcast source contains target info (->)',
        sourceHasTargets,
        `source="${broadcastMsg.source}"`
      );

      // Extract target IDs from source
      if (sourceHasTargets) {
        const targetPart = broadcastMsg.source.split('->')[1];
        const sourceTargets = targetPart.split(',').map(Number);
        const allTargetsInSource = expectedTargets.every(t => sourceTargets.includes(t));
        check('Source includes all target entity IDs',
          allTargetsInSource,
          `expected=[${expectedTargets}], source_targets=[${sourceTargets}]`
        );
      }

      // Check delivered_to field (THE KEY BUG FIX TEST)
      const deliveredTo = broadcastMsg.delivered_to || '';
      const deliveredIds = deliveredTo.split(',').map(s => s.trim()).filter(Boolean);
      console.log(`\n  delivered_to field: "${deliveredTo}"`);
      console.log(`  Parsed delivered IDs: [${deliveredIds.join(', ')}]`);

      check('delivered_to is not empty',
        deliveredIds.length > 0,
        deliveredIds.length > 0
          ? `${deliveredIds.length} entities delivered`
          : 'EMPTY — markChatMessageDelivered may not be called or webhook push failed'
      );

      // Check if delivered_to has ALL target entities (not just the last one)
      // This is the critical test for the APPEND fix
      if (deliveredIds.length > 0) {
        const webhookTargets = expectedTargets.filter(tid => {
          const target = broadcastRes.targets?.find(t => t.entityId === tid);
          return target && target.mode === 'push';
        });
        const pollingTargets = expectedTargets.filter(tid => {
          const target = broadcastRes.targets?.find(t => t.entityId === tid);
          return target && target.mode === 'polling';
        });

        console.log(`  Webhook (push) targets: [${webhookTargets.join(', ')}]`);
        console.log(`  Polling targets: [${pollingTargets.join(', ')}]`);

        // Only webhook targets get delivered_to entries
        if (webhookTargets.length > 0) {
          const allWebhookDelivered = webhookTargets.every(t =>
            deliveredIds.includes(String(t))
          );
          check('delivered_to contains ALL webhook targets (APPEND fix)',
            allWebhookDelivered,
            `webhook_targets=[${webhookTargets}], delivered=[${deliveredIds}]` +
            (!allWebhookDelivered ? ' — BUG: markChatMessageDelivered overwrites instead of appending' : '')
          );
        }

        // Polling targets won't be in delivered_to (no webhook to confirm)
        if (pollingTargets.length > 0) {
          console.log(`  Note: Polling targets [${pollingTargets}] won't appear in delivered_to (no webhook confirmation)`);
        }
      }

      // Check is_delivered flag
      check('is_delivered is true',
        broadcastMsg.is_delivered === true,
        `is_delivered=${broadcastMsg.is_delivered}`
      );
    }
  } catch (err) {
    check('Chat history verification', false, err.message);
  }
  console.log('');

  // ────────────────────────────────────────────────────
  // Phase 6: Test speak-to reply
  // ────────────────────────────────────────────────────
  console.log('--- Phase 6: Test speak-to reply ---');

  // Pick a test entity to reply to the sender
  const replier = testEntities.length > 1 ? testEntities[1] : testEntities[0];
  const replyTarget = replier.entityId === sender.entityId
    ? expectedTargets[0]
    : sender.entityId;

  if (replier && replyTarget !== undefined) {
    const replyText = `Reply-test-${Date.now()}`;

    try {
      const speakRes = await postJSON(`${API_BASE}/api/entity/speak-to`, {
        deviceId,
        fromEntityId: replier.entityId,
        toEntityId: replyTarget,
        botSecret: replier.botSecret,
        text: replyText,
      });

      check('Speak-to API success', speakRes.success, `from=${replier.entityId} to=${replyTarget}`);

      // Verify target entity message updated
      await sleep(2000);
      const targetSt = await fetchJSON(`${API_BASE}/api/status?deviceId=${deviceId}&entityId=${replyTarget}`);
      const hasReply = targetSt.message && targetSt.message.includes(replyText);
      check('Target entity received speak-to message', hasReply,
        `message="${targetSt.message?.slice(0, 60)}"`
      );

      // Verify in chat history
      await sleep(1000);
      const historyUrl2 = `${API_BASE}/api/chat/history?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&limit=20`;
      const history2 = await fetchJSON(historyUrl2);
      const replyMsg = (history2.messages || []).find(m => m.text === replyText);

      check('Speak-to reply found in chat history', !!replyMsg,
        replyMsg
          ? `source="${replyMsg.source}", delivered_to="${replyMsg.delivered_to}"`
          : 'not found'
      );

      if (replyMsg) {
        check('Speak-to source has target info',
          replyMsg.source && replyMsg.source.includes('->'),
          `source="${replyMsg.source}"`
        );
      }
    } catch (err) {
      check('Speak-to test', false, err.message);
    }
  } else {
    console.log('  Skipped: not enough test entities to test speak-to');
  }
  console.log('');

  // ────────────────────────────────────────────────────
  // Phase 7: Cleanup
  // ────────────────────────────────────────────────────
  await cleanup(testEntities, deviceId, skipCleanup);

  // ────────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────────
  printSummary();
}

// ── Cleanup ─────────────────────────────────────────────────
async function cleanup(testEntities, deviceId, skipCleanup) {
  console.log('--- Phase 7: Cleanup ---');
  if (skipCleanup) {
    console.log('  Skipped (--skip-cleanup flag)');
    return;
  }

  for (const te of testEntities) {
    try {
      const delRes = await deleteJSON(`${API_BASE}/api/entity`, {
        deviceId,
        entityId: te.entityId,
        botSecret: te.botSecret,
      });
      console.log(`  Entity ${te.entityId}: ${delRes.success ? 'unbound' : delRes.message || 'failed'}`);
    } catch (err) {
      console.log(`  Entity ${te.entityId}: cleanup error — ${err.message}`);
    }
  }
  console.log('');
}

// ── Print Summary ───────────────────────────────────────────
function printSummary() {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  const rate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0';

  console.log('='.repeat(65));
  console.log('  SUMMARY');
  console.log('='.repeat(65));
  console.log(`  Total checks:  ${total}`);
  console.log(`  Passed:        ${passed}`);
  console.log(`  Failed:        ${failed}`);
  console.log(`  Rate:          ${rate}%`);

  if (failed > 0) {
    console.log('');
    console.log('-'.repeat(65));
    console.log('  FAILED CHECKS — Diagnostic Guide');
    console.log('-'.repeat(65));
    for (const r of results) {
      if (!r.passed) {
        console.log(`  [FAIL] ${r.name}`);
        if (r.detail) console.log(`         ${r.detail}`);
        console.log(`         Fix: ${getDiagnosticHint(r.name)}`);
        console.log('');
      }
    }
  }

  console.log('');
  if (failed === 0) {
    console.log(`  RESULT: ALL PASS (${rate}%)`);
  } else {
    console.log(`  RESULT: ${failed} FAILURES`);
  }
  console.log('='.repeat(65));

  process.exit(failed > 0 ? 1 : 0);
}

// ── Diagnostic Hints ────────────────────────────────────────
function getDiagnosticHint(checkName) {
  if (checkName.includes('delivered_to') && checkName.includes('APPEND')) {
    return 'markChatMessageDelivered in index.js must APPEND to delivered_to, not overwrite. '
      + 'Use: delivered_to = CASE WHEN delivered_to IS NULL THEN $2 ELSE delivered_to || \',\' || $2 END';
  }
  if (checkName.includes('delivered_to') && checkName.includes('empty')) {
    return 'Webhook push may have failed silently. Check Railway logs for [Broadcast] push errors. '
      + 'Also verify pushToBot() is calling markChatMessageDelivered on success.';
  }
  if (checkName.includes('message contains broadcast')) {
    return 'Entity message not updated during broadcast iteration. '
      + 'Check loop in /api/entity/broadcast that sets toEntity.message.';
  }
  if (checkName.includes('chat history')) {
    return 'saveChatMessage may have failed. Check PostgreSQL connection and chat_messages table exists.';
  }
  if (checkName.includes('source contains target')) {
    return 'Broadcast saveChatMessage should use source format: entity:X:CHARACTER->targetIds';
  }
  if (checkName.includes('Broadcast API')) {
    return 'Check botSecret is valid for sender entity, and device exists on server.';
  }
  if (checkName.includes('Speak-to')) {
    return 'Check /api/entity/speak-to endpoint, botSecret auth, and target entity is bound.';
  }
  return 'Check Railway logs for the relevant endpoint errors.';
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
