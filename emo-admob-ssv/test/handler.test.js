'use strict';

const {
  createHandler,
  KeyCache,
  InMemoryReplayGuard,
  InMemoryRateLimiter,
} = require('../src');
const { generateTestKey, signQuery, makeFetchStub } = require('./helpers');

function fakeReq(rawQuery) {
  const params = Object.fromEntries(new URLSearchParams(rawQuery));
  return { originalUrl: '/admob/ssv?' + rawQuery, query: params };
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

describe('createHandler', () => {
  const kp = generateTestKey();
  const KEY_ID = 'kid-1';

  function build({ onValidReward, now, freshnessMs } = {}) {
    const nowFn = now || Date.now;
    return createHandler({
      keyCache: new KeyCache({
        url: 'https://gstatic.example/keys.json',
        fetchImpl: makeFetchStub([{ keyId: KEY_ID, pem: kp.pem }]),
        now: nowFn,
      }),
      replayGuard: new InMemoryReplayGuard({ now: nowFn }),
      rateLimiter: new InMemoryRateLimiter({ now: nowFn }),
      onValidReward: onValidReward || (async () => {}),
      freshnessMs,
      now: nowFn,
    });
  }

  test('valid callback → 200 ok=true + hook fired', async () => {
    const now = Date.now();
    const hookCalls = [];
    const handler = build({
      onValidReward: async (r) => { hookCalls.push(r); },
      now: () => now,
    });
    const fields = {
      ad_network: '1', ad_unit: '2', reward_amount: '5', reward_item: 'x',
      timestamp: String(now), transaction_id: 't-1', user_id: 'u',
      custom_data: 'dev-abc',
    };
    const raw = signQuery(fields, { keyId: KEY_ID, privateKey: kp.privateKey });
    const res = fakeRes();
    await handler(fakeReq(raw), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(hookCalls).toEqual([{
      deviceId: 'dev-abc', amount: 5, transactionId: 't-1', rewardItem: 'x',
    }]);
  });

  test('invalid callback → 200 ok=false + hook NOT fired', async () => {
    const now = Date.now();
    let hookFired = false;
    const handler = build({
      onValidReward: async () => { hookFired = true; },
      now: () => now,
    });
    const fields = {
      ad_network: '1', ad_unit: '2', reward_amount: '5', reward_item: 'x',
      timestamp: String(now), transaction_id: 't-2', user_id: 'u',
      custom_data: 'dev-abc',
    };
    const raw = signQuery(fields, { keyId: KEY_ID, privateKey: kp.privateKey })
      .replace('reward_amount=5', 'reward_amount=999');
    const res = fakeRes();
    await handler(fakeReq(raw), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(hookFired).toBe(false);
  });

  test('hook throws → 500 hook_error', async () => {
    const now = Date.now();
    const handler = build({
      onValidReward: async () => { throw new Error('db down'); },
      now: () => now,
    });
    const fields = {
      ad_network: '1', ad_unit: '2', reward_amount: '5', reward_item: 'x',
      timestamp: String(now), transaction_id: 't-3', user_id: 'u',
      custom_data: 'dev-abc',
    };
    const raw = signQuery(fields, { keyId: KEY_ID, privateKey: kp.privateKey });
    const res = fakeRes();
    await handler(fakeReq(raw), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ ok: false, reason: 'hook_error' });
  });
});
