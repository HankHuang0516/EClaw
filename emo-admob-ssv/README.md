# emo-admob-ssv

**Server-side verifier for Google AdMob rewarded-ad SSV callbacks.**
Part of the emotional-value app pipeline (Epic母卡 `card_6d0f2746`, task `I3 —
card_be214172a938b839886b3cbd`).

Quota for the free emotional apps is **only** granted from a validated
server-side-verification (SSV) callback — never on client "reward earned"
signals — so nobody can 白嫖 the free quota by faking an ad view.

This package is intentionally **standalone** (no server infra dependencies) so
it can be dropped into the I2 gateway once the Railway token lands, or into any
Express app.

## Install

```bash
npm install
```

## Usage — as an Express plug-in

```js
const express = require('express');
const {
  KeyCache,
  InMemoryReplayGuard,
  InMemoryRateLimiter,
  createHandler,
} = require('emo-admob-ssv');

const keyCache    = new KeyCache({ diskCachePath: '/tmp/admob-keys.json' });
const replayGuard = new InMemoryReplayGuard();  // TODO(prod): swap for Redis
const rateLimiter = new InMemoryRateLimiter();  // TODO(prod): swap for Redis

const app = express();

// The URL you register in AdMob → Rewarded ad unit → SSV callback URL.
app.get('/admob/ssv', createHandler({
  keyCache,
  replayGuard,
  rateLimiter,
  onValidReward: async ({ deviceId, amount, transactionId, rewardItem }) => {
    // Bump the device's daily quota — MUST be idempotent on transactionId.
    await db.tx(async (t) => {
      const already = await t.oneOrNone(
        'SELECT 1 FROM admob_credits WHERE transaction_id = $1', [transactionId],
      );
      if (already) return;
      await t.none(
        'INSERT INTO admob_credits(transaction_id, device_id, amount, item) VALUES ($1,$2,$3,$4)',
        [transactionId, deviceId, amount, rewardItem],
      );
      await t.none(
        'UPDATE emo_quota SET remaining = remaining + $1 WHERE device_id = $2',
        [amount, deviceId],
      );
    });
  },
}));

app.listen(3000);
```

## Client-side (Android): set `custom_data` = deviceId

Because AdMob's `user_id` field is set by the SDK (Google-scoped, not
device-scoped), the client MUST also pass the local `deviceId` into
`custom_data` before calling `RewardedAd.show()`:

```kotlin
val ssv = ServerSideVerificationOptions.Builder()
  .setCustomData(deviceIdFromLocalStorage)  // plain-string form
  // OR base64url-JSON: {"deviceId":"...", "nonce":"..."} for extra binding
  .build()
rewardedAd.setServerSideVerificationOptions(ssv)
rewardedAd.show(activity) { /* … */ }
```

The verifier reads `custom_data`, resolves the deviceId, and hands it to
`onValidReward`. **Never trust `user_id` for quota** — it's set by Google, not
by us.

## What the verifier checks (in order)

1. **Rate limit** — per `user_id`, default 5/min (fraud guard).
2. **Timestamp freshness** — `timestamp` within ±60s of `Date.now()`.
3. **Anti-replay** — `transaction_id` unseen in last 24h.
4. **Public key lookup** — cache-miss on `key_id` forces a fresh fetch of
   `https://gstatic.com/admob/reward/verifier-keys.json` (key rotation).
5. **ECDSA-SHA256 signature verify** over the pre-`&signature=&key_id=`
   query prefix (per AdMob SSV spec).
6. **Device binding** — resolve `deviceId` from `custom_data`.

On success we commit the replay slot **after** all checks pass.

## Rejection reasons

`{valid:false, reason}` — one of:

| reason              | meaning                                            |
| ------------------- | -------------------------------------------------- |
| `malformed`         | missing required field / bad timestamp / no txId   |
| `missing_signature` | no `signature=` in query                           |
| `missing_key_id`    | no `key_id=` in query                              |
| `unknown_key_id`    | `key_id` absent even after a forced refetch        |
| `bad_signature`     | ECDSA verify failed                                |
| `stale_timestamp`   | timestamp not within ±freshness window             |
| `replay`            | `transaction_id` already credited                  |
| `rate_limit`        | `user_id` exceeded per-minute cap                  |
| `bad_custom_data`   | couldn't resolve a deviceId from `custom_data`     |

The handler always responds `200` even on rejection (so AdMob doesn't
retry-storm); the body carries the reason for debugging.

## Standalone verify

If you want to run the verifier without Express:

```js
const {
  verifyCallback, KeyCache, InMemoryReplayGuard, InMemoryRateLimiter,
} = require('emo-admob-ssv');

const result = await verifyCallback(
  { rawQuery: 'ad_network=…&signature=…&key_id=…' },
  {
    keyCache: new KeyCache(),
    replayGuard: new InMemoryReplayGuard(),
    rateLimiter: new InMemoryRateLimiter(),
  },
);
// result: { valid, reason?, deviceId?, rewardAmount?, transactionId?, rewardItem? }
```

## Prod-hardening TODO

- Replace `InMemoryReplayGuard` + `InMemoryRateLimiter` with Redis-backed
  implementations before we serve traffic from >1 replica (both are stateless
  in-process only).
- Point `KeyCache.diskCachePath` at a persistent volume so cold starts don't
  re-fetch on every boot.
- Wire `logger` to the caller's structured logger (defaults to no-op).

## Tests

```bash
npm install
npm test
npm run typecheck
```

The test suite uses **synthetic P-256 keys** because Google does not publish
stable SSV test vectors — the AdMob test-ad path signs live and only prod
verifier keys accept those signatures. The crypto primitives exercised here
(ECDSA-SHA256, DER, web-safe base64) are identical to the production path.

## Spec references

- AdMob Android SSV: https://developers.google.com/admob/android/ssv
- Google verifier keys: https://gstatic.com/admob/reward/verifier-keys.json
