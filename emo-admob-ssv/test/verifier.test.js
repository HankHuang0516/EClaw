'use strict';

const {
  verifyCallback,
  KeyCache,
  InMemoryReplayGuard,
  InMemoryRateLimiter,
  REASONS,
} = require('../src');
const { generateTestKey, signQuery, makeFetchStub } = require('./helpers');

function baseFields(overrides = {}) {
  return {
    ad_network: '5450213213286189855',
    ad_unit: '1234/5678',
    reward_amount: '10',
    reward_item: 'coins',
    timestamp: String(Date.now()),
    transaction_id: 'txn-' + Math.random().toString(36).slice(2),
    user_id: 'user-A',
    custom_data: 'dev-hank-emulator-001',
    ...overrides,
  };
}

function buildDeps({ keyId = 'kid-1', keyPem, ttlMs = 60_000, now, fetchImpl } = {}) {
  const keyCache = new KeyCache({
    url: 'https://gstatic.example/keys.json',
    ttlMs,
    fetchImpl: fetchImpl || makeFetchStub([{ keyId, pem: keyPem }]),
    now,
  });
  return {
    keyCache,
    replayGuard: new InMemoryReplayGuard({ now }),
    rateLimiter: new InMemoryRateLimiter({ now }),
    now,
  };
}

describe('verifyCallback', () => {
  const kp = generateTestKey();
  const KEY_ID = 'kid-1';

  test('accepts a valid callback', async () => {
    const now = Date.now();
    const fields = baseFields({ timestamp: String(now) });
    const rawQuery = signQuery(fields, { keyId: KEY_ID, privateKey: kp.privateKey });
    const deps = buildDeps({ keyId: KEY_ID, keyPem: kp.pem, now: () => now });

    const r = await verifyCallback({ rawQuery }, deps);
    expect(r).toMatchObject({
      valid: true,
      deviceId: 'dev-hank-emulator-001',
      rewardAmount: 10,
      transactionId: fields.transaction_id,
      rewardItem: 'coins',
    });
  });

  test('rejects tampered signature (single-byte flip)', async () => {
    const now = Date.now();
    const fields = baseFields({ timestamp: String(now) });
    const rawQuery = signQuery(fields, { keyId: KEY_ID, privateKey: kp.privateKey });
    // Flip a byte inside `reward_amount` — payload changes, signature no longer matches.
    const tampered = rawQuery.replace('reward_amount=10', 'reward_amount=99');
    const deps = buildDeps({ keyId: KEY_ID, keyPem: kp.pem, now: () => now });

    const r = await verifyCallback({ rawQuery: tampered }, deps);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe(REASONS.BAD_SIGNATURE);
  });

  test('rejects replayed transaction_id', async () => {
    const now = Date.now();
    const fields = baseFields({ timestamp: String(now) });
    const rawQuery = signQuery(fields, { keyId: KEY_ID, privateKey: kp.privateKey });
    const deps = buildDeps({ keyId: KEY_ID, keyPem: kp.pem, now: () => now });

    const first = await verifyCallback({ rawQuery }, deps);
    expect(first.valid).toBe(true);
    const second = await verifyCallback({ rawQuery }, deps);
    expect(second.valid).toBe(false);
    expect(second.reason).toBe(REASONS.REPLAY);
  });

  test('rejects stale timestamp (>60s off)', async () => {
    const now = Date.now();
    const fields = baseFields({ timestamp: String(now - 120_000) }); // 2 min old
    const rawQuery = signQuery(fields, { keyId: KEY_ID, privateKey: kp.privateKey });
    const deps = buildDeps({ keyId: KEY_ID, keyPem: kp.pem, now: () => now });

    const r = await verifyCallback({ rawQuery }, deps);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe(REASONS.STALE_TIMESTAMP);
  });

  test('unknown key_id triggers refetch, then unknown → reject', async () => {
    const now = Date.now();
    const fields = baseFields({ timestamp: String(now) });
    // Sign with kp but claim a key_id that isn't in Google's response.
    const rawQuery = signQuery(fields, { keyId: 'kid-EVIL', privateKey: kp.privateKey });
    const fetchImpl = makeFetchStub([{ keyId: KEY_ID, pem: kp.pem }]); // no "kid-EVIL"
    const deps = buildDeps({ keyId: KEY_ID, keyPem: kp.pem, now: () => now, fetchImpl });

    const r = await verifyCallback({ rawQuery }, deps);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe(REASONS.UNKNOWN_KEY_ID);
    // On cache-miss for unknown key we still force a refresh; here Google's
    // response also lacked the key, so the retry consumed a fetch.
    expect(fetchImpl.calls).toBeGreaterThanOrEqual(1);
  });

  test('unknown key_id triggers refetch that DELIVERS the rotated key → accept', async () => {
    const now = Date.now();
    // Rotate: new keypair issued under a new keyId that isn't in initial cache.
    const kp2 = generateTestKey();
    const NEW_KID = 'kid-2';
    const fields = baseFields({ timestamp: String(now) });
    const rawQuery = signQuery(fields, { keyId: NEW_KID, privateKey: kp2.privateKey });

    // Fetch stub returns BOTH old + new keys — simulating Google publishing the rotation.
    const fetchImpl = makeFetchStub([
      { keyId: KEY_ID, pem: kp.pem },
      { keyId: NEW_KID, pem: kp2.pem },
    ]);
    const deps = buildDeps({ now: () => now, fetchImpl });

    const r = await verifyCallback({ rawQuery }, deps);
    expect(r.valid).toBe(true);
    expect(fetchImpl.calls).toBeGreaterThanOrEqual(1);
  });

  test('rate limit: 6th call from same user_id in a minute → rate_limit', async () => {
    const now = Date.now();
    const deps = buildDeps({ keyId: KEY_ID, keyPem: kp.pem, now: () => now });
    let last;
    for (let i = 0; i < 6; i++) {
      const fields = baseFields({
        timestamp: String(now),
        transaction_id: `txn-${i}`,
        user_id: 'flood-user',
      });
      const rawQuery = signQuery(fields, { keyId: KEY_ID, privateKey: kp.privateKey });
      last = await verifyCallback({ rawQuery }, deps);
    }
    expect(last.valid).toBe(false);
    expect(last.reason).toBe(REASONS.RATE_LIMIT);
  });

  test('missing signature / key_id → malformed reasons', async () => {
    const deps = buildDeps({ keyId: KEY_ID, keyPem: kp.pem });
    const r1 = await verifyCallback({ rawQuery: 'ad_network=1&timestamp=1' }, deps);
    expect(r1.valid).toBe(false);
    expect(r1.reason).toBe(REASONS.MALFORMED);
  });

  test('base64url custom_data JSON resolves deviceId', async () => {
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify({ deviceId: 'dev-encoded-42', nonce: 'x' }))
      .toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const fields = baseFields({ timestamp: String(now), custom_data: payload });
    const rawQuery = signQuery(fields, { keyId: KEY_ID, privateKey: kp.privateKey });
    const deps = buildDeps({ keyId: KEY_ID, keyPem: kp.pem, now: () => now });

    const r = await verifyCallback({ rawQuery }, deps);
    expect(r.valid).toBe(true);
    expect(r.deviceId).toBe('dev-encoded-42');
  });

  test('empty custom_data → bad_custom_data', async () => {
    const now = Date.now();
    const fields = baseFields({ timestamp: String(now), custom_data: '' });
    const rawQuery = signQuery(fields, { keyId: KEY_ID, privateKey: kp.privateKey });
    const deps = buildDeps({ keyId: KEY_ID, keyPem: kp.pem, now: () => now });

    const r = await verifyCallback({ rawQuery }, deps);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe(REASONS.BAD_CUSTOM_DATA);
  });
});
