# Dream Buddy rewarded-message integration

This change is limited to Dream Buddy. It does not alter other app personas or advertiser accounts.

## Device API

Mount: `/api/app-bot/ads`. The existing device credential extractor authenticates the owner; use `X-Device-Secret` rather than putting the secret in a URL. Device identity is still required. These endpoints fail closed while device persistence is initializing or the database is unavailable.

- `GET /quota`: UTC quota date and remaining messages, calculated from the existing `app_bot_quota` table (8 daily messages plus validated ad bonuses minus usage).
- `POST /sessions` with `{ "platform": "ios" }` or `android`: creates a cryptographically random, two-hour, device-bound challenge. Reward is 6 messages. Session creation is rate-limited.
- `GET /sessions/:id`: owner-only `pending`, `expired`, or `rewarded` status. A pending or expired result is not permission to grant credits locally.
- `/api/chat/history` now also accepts existing header credentials, while retaining legacy query credential compatibility.

## Google callback

`GET /ssv` is a public callback, not a device-authenticated endpoint. Verify ECDSA/SHA-256 against Google's official public-key endpoint using the exact signed query bytes. Reject duplicate parameters, malformed signatures, unknown keys, wrong reward/unit, and invalid timestamps. Only the two configured production units are accepted: iOS `6438262242`, Android `9855772231`, both `6 messages` under publisher `pub-7927361926882871`.

Send only the opaque session challenge in SDK `customData`; no chat, device secret, email, or advertising identifier is needed in it. Redact callback challenges/signatures from operational logs. A genuine signed AdMob URL-testing callback without a valid app challenge is acknowledged without issuing credits. Google test ad units never create real credits.

The database creates `dream_buddy_ad_sessions` and `dream_buddy_ad_transactions` on first access. Reward processing uses a row lock and a single transaction: unique Google transaction ID and unique session, quota bonus increment, then session redemption. Replays do not grant credits. A database failure rolls back and returns 503. Keep these records for retry/idempotency; no cleanup is added here.

## Verification and deployment gates

Seven focused Jest tests passed on the isolated SSD test copy: signed-byte verification/tamper rejection, duplicates/unknown keys, unsigned callback rejection, device authentication/startup fail-closed, header authentication/database fail-closed, wrong unit/reward rejection, and signed challenge-free URL probes with no credits.

Still required before production enablement: real PostgreSQL concurrent/replayed callback tests, required repository CI and review, production deployment/health checks, AdMob SSV URL verification, then actual device rewarded-ad delivery. Passing the unit suite is not evidence of a deployed callback or real Google reward delivery. App-store releases also require current-package H icon inspection and native/chat QA.

Google reference: https://developers.google.com/admob/ios/ssv
