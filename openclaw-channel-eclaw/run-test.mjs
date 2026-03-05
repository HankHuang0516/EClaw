/**
 * Live E2E test for E-Claw Channel API
 * Usage: node run-test.mjs
 */

const API_BASE = 'https://eclawbot.com';
const API_KEY = 'eck_3599c00bfca690d8b58f3b264fce6638ce6407ba8dbe0571f4b10b24461568aa';
const API_SECRET = 'ecs_6cabd9d5def0538079db2dd3b404c88e5829e96d6e2fbb7d83601814c162361a';
const ENTITY_ID = 0;
const TEST_SLOT = 'run-' + Date.now();

const BCAST_DEVICE_ID = '2a0ad04d-9107-4250-b8be-ecd565983fb2';
const BCAST_DEVICE_SECRET = '77c91d51-7677-4c1f-aece-fe26fd651d6d-cfff4f91-6883-4450-b17d-1ae1cf4085b4';

const CALLBACK_URL = API_BASE + '/api/channel/test-sink?slot=' + TEST_SLOT;
const CALLBACK_TOKEN = 'tok-' + Math.random().toString(36).slice(2);

function log(label, data) {
  console.log('\n-- ' + label + ' --');
  console.log(JSON.stringify(data, null, 2));
}

async function post(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path, params) {
  const qs = new URLSearchParams(params || {}).toString();
  const res = await fetch(API_BASE + path + '?' + qs);
  return res.json();
}

async function del(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  console.log('=== E-Claw Channel API Live Test ===');
  console.log('Callback URL: ' + CALLBACK_URL);

  // 1. Register
  console.log('\n[1] Registering callback...');
  const regData = await post('/api/channel/register', {
    channel_api_key: API_KEY, channel_api_secret: API_SECRET,
    callback_url: CALLBACK_URL, callback_token: CALLBACK_TOKEN,
  });
  log('Register', regData);
  if (!regData.success) { console.error('FAILED: Register'); process.exit(1); }
  const { deviceId, accountId } = regData;
  console.log('OK deviceId=' + deviceId + '  accountId=' + accountId);
  (regData.entities || []).forEach(e =>
    console.log('  entity ' + e.entityId + ': isBound=' + e.isBound + '  boundToThisAccount=' + e.boundToThisAccount)
  );

  // 2. Bind
  console.log('\n[2] Binding entity ' + ENTITY_ID + '...');
  const bindData = await post('/api/channel/bind', {
    channel_api_key: API_KEY, channel_api_secret: API_SECRET,
    entityId: ENTITY_ID, name: 'TestBot',
  });
  log('Bind', bindData);
  if (!bindData.success) { console.error('FAILED: Bind'); process.exit(1); }
  const botSecret = bindData.botSecret;
  console.log('OK botSecret=' + botSecret.slice(0,8) + '...  publicCode=' + bindData.publicCode);

  // 3. Send bot message
  console.log('\n[3] Sending bot message (entity->user)...');
  const msgData = await post('/api/channel/message', {
    channel_api_key: API_KEY, deviceId, entityId: ENTITY_ID,
    botSecret, message: 'Hello from E2E test!', state: 'IDLE',
  });
  log('Message', msgData);
  console.log(msgData.success ? 'OK message delivered' : 'NOTE not delivered (expected if no active user session)');

  // 4. Simulate user→entity message (triggers channel callback push)
  console.log('\n[4] Simulating user speak to entity ' + ENTITY_ID + '...');
  const speakData = await post('/api/client/speak', {
    deviceId, entityId: ENTITY_ID,
    text: 'Hello bot, this is a test user message!',
    source: 'test-client',
  });
  log('Client Speak', speakData);
  if (speakData.success) {
    console.log('OK user message sent — waiting 500ms for async push...');
    await new Promise(r => setTimeout(r, 500));
  } else {
    console.warn('WARN client/speak failed: ' + (speakData.message || JSON.stringify(speakData)));
  }

  // 5. Check test-sink — should now contain the callback payload
  console.log('\n[5] Checking test-sink for callback...');
  const sinkData = await get('/api/channel/test-sink', {
    deviceId: BCAST_DEVICE_ID, deviceSecret: BCAST_DEVICE_SECRET, slot: TEST_SLOT,
  });
  log('Test Sink', sinkData);
  const count = sinkData.payloads?.length ?? 0;
  if (count > 0) {
    console.log('OK ' + count + ' callback(s) received in test-sink!');
    sinkData.payloads.forEach((p, i) =>
      console.log('  [' + i + '] event=' + p.payload?.event + '  from=' + p.payload?.from + '  text=' + p.payload?.text)
    );
  } else {
    console.error('FAIL no callbacks in test-sink — push routing may be broken');
  }

  // 6. Cleanup
  console.log('\n[6] Cleanup...');
  const unrData = await del('/api/channel/register', {
    channel_api_key: API_KEY, channel_api_secret: API_SECRET,
  });
  log('Unregister', unrData);

  const dRes = await fetch(
    API_BASE + '/api/channel/test-sink?slot=' + TEST_SLOT +
    '&deviceId=' + BCAST_DEVICE_ID + '&deviceSecret=' + BCAST_DEVICE_SECRET,
    { method: 'DELETE' }
  );
  log('Sink cleared', await dRes.json());

  console.log('\n=== DONE ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
