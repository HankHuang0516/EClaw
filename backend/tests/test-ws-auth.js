// Test: gatewayFetch() WebSocket transport with SETUP_PASSWORD
// Uses Eclaw_0 on Railway for testing
const WebSocket = require('ws');

// Make WebSocket available globally for gatewayFetch
global.WebSocket = WebSocket;

// Import the gateway functions by extracting them from index.js context
// Since index.js doesn't export them, we test the WebSocket protocol directly

const crypto = require('crypto');
const GATEWAY_URL = 'wss://clawdbot-railway-template-production-e663.up.railway.app';
const HTTP_URL = 'https://clawdbot-railway-template-production-e663.up.railway.app/tools/invoke';
const GATEWAY_TOKEN = '1a712b828ffc1b3d3a94978b7e9805be1591b175f3ee11637840e4437e49d232';
const SETUP_PASSWORD = 'asasas123';
const SETUP_USERNAME = 'admin';

async function testWsFlow() {
  console.log('=== Testing WebSocket Gateway Transport ===\n');

  // Test 1: Connect
  console.log('[Test 1] WebSocket connect + auth...');
  const ws = new WebSocket(GATEWAY_URL, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${SETUP_USERNAME}:${SETUP_PASSWORD}`).toString('base64'),
      'Origin': `https://clawdbot-railway-template-production-e663.up.railway.app`
    }
  });

  const conn = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Connect timeout')); }, 10000);

    ws.on('open', () => {
      const id = 'test-1';
      ws.send(JSON.stringify({
        type: 'req', id, method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'openclaw-probe', version: 'dev', platform: 'node', mode: 'probe' },
          role: 'operator', scopes: ['operator.admin'],
          auth: { token: GATEWAY_TOKEN, password: SETUP_PASSWORD },
          caps: [],
          userAgent: 'eclaw-backend/1.0'
        }
      }));

      const onMsg = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'event') return;
        if (msg.type === 'res' && msg.id === id) {
          ws.removeListener('message', onMsg);
          clearTimeout(timeout);
          if (msg.ok) {
            console.log('  [PASS] Connected successfully');
            resolve({ ws, reqId: 1 });
          } else {
            ws.close();
            reject(new Error(`Connect failed: ${JSON.stringify(msg.error)}`));
          }
        }
      };
      ws.on('message', onMsg);
    });

    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });

  // Set up persistent handler
  const pending = new Map();
  conn.ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type !== 'res') return;
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
    } catch (e) { /* ignore */ }
  });

  async function invoke(method, params, timeoutMs = 10000) {
    const id = `test-${++conn.reqId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      conn.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  // Test 2: sessions.list
  console.log('\n[Test 2] sessions.list...');
  const listResult = await invoke('sessions.list', {});
  if (listResult.ok) {
    const sessions = listResult.payload?.sessions || [];
    console.log(`  [PASS] Got ${sessions.length} session(s)`);
    if (sessions.length > 0) {
      console.log(`  Session key: ${sessions[0].key}`);
    }
  } else {
    console.log(`  [FAIL] ${JSON.stringify(listResult.error)}`);
  }

  // Test 3: chat.send
  console.log('\n[Test 3] chat.send (with idempotencyKey)...');
  const sessionKey = listResult.payload?.sessions?.[0]?.key || 'main';
  const sendResult = await invoke('chat.send', {
    sessionKey,
    message: '[SYSTEM:TEST] WebSocket transport test. Reply OK.',
    idempotencyKey: crypto.randomUUID()
  });
  if (sendResult.ok) {
    console.log(`  [PASS] Message sent, runId: ${sendResult.payload?.runId?.substring(0, 8)}...`);
  } else {
    console.log(`  [FAIL] ${JSON.stringify(sendResult.error)}`);
  }

  // Test 4: chat.send with non-existent session (should return error)
  console.log('\n[Test 4] chat.send with bad session key...');
  const badResult = await invoke('chat.send', {
    sessionKey: 'non-existent-session-key-12345',
    message: 'test',
    idempotencyKey: crypto.randomUUID()
  });
  if (!badResult.ok) {
    console.log(`  [PASS] Got expected error: ${badResult.error?.message?.substring(0, 80)}`);
  } else {
    console.log(`  [INFO] Server accepted bad session key (might create new session)`);
  }

  conn.ws.close();
  console.log('\n=== All tests completed ===');
  process.exit(0);
}

testWsFlow().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});

setTimeout(() => { console.log('[TIMEOUT]'); process.exit(1); }, 30000);
