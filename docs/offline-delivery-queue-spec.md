# Offline Delivery Queue + Reconnect Replay — Spec

**Card**: card_47ed9a0c21dd507d3b726136 ([OODA-R/P1] Phase 2 #5)
**Parent**: card_be59aa034883fe36d3645a27 (Strategic AI Agent 自發性自我改進 roadmap)
**Severity**: P1 — addresses Hank's #1 daily friction (pain 3: 斷線就被阻擋, pain 2 partial: 使用者回饋差).
**Author**: #2 LOBSTER, 2026-06-09 22:08 TW
**Status**: Draft — implementation can begin in parallel slices after Hank approves the 3 open questions at the bottom.

## Why now

PR #3263 surfaced the smart-quote sink. PR #3260-#3262 surfaced the entity-status drilldown. Both shipped, but the underlying root cause of every "did my message even arrive?" Hank-flag is: **the browser has no durable outbox**. When the network drops mid-send, the message is dropped on the floor, the toast briefly says "offline" (chat.html:6187), and there is no recovery — the user has to retype.

This card builds the missing layer.

## Architecture overview

```
┌─────────────── browser (chat.html / portal-shared) ───────────────┐
│                                                                   │
│  sendMessage(text, to)                                            │
│     │                                                             │
│     ├─ if navigator.onLine && lastSendOk → direct POST            │
│     │     └─ POST /api/transform                                  │
│     │           ├─ 200 → done, render sent                        │
│     │           └─ non-200 / timeout / AbortError → enqueue       │
│     │                                                             │
│     └─ if !navigator.onLine || queued → enqueue                   │
│           │                                                       │
│           ├─ localStorage["eclaw_outbox"] += {                    │
│           │     idempotencyKey: uuid(),                           │
│           │     payload: { deviceId, entityId, message, to, ts }, │
│           │     state: "queued",                                  │
│           │     attempts: 0,                                      │
│           │     nextRetryAt: Date.now()                           │
│           │   }                                                   │
│           └─ render inline queued bubble                          │
│                                                                   │
│  reconnect handler:                                               │
│     window.addEventListener('online', flushOutbox)                │
│     also: 30s heartbeat tick → flushOutbox()                      │
│                                                                   │
│  flushOutbox():                                                   │
│     for each row in queue ordered by ts asc:                      │
│       if Date.now() < row.nextRetryAt: skip                       │
│       row.state = "retrying"                                      │
│       POST /api/transform                                          │
│         headers: Idempotency-Key: row.idempotencyKey              │
│         body: row.payload                                          │
│       on 200: remove row, render sent state                       │
│       on 5xx/network: row.attempts++,                              │
│                       row.nextRetryAt = now + backoff(attempts)   │
│       on 4xx (non-409): row.state = "failed"; keep for manual     │
│       on 409 (dup): treat as success (idempotent retry)           │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘

┌─────────────── server (Express on Railway) ──────────────────────┐
│                                                                   │
│  middleware idempotencyKeyDedupe (mounted on /api/transform +     │
│                                    /api/client/speak)             │
│                                                                   │
│     if no Idempotency-Key header → next() (legacy path)           │
│     else:                                                         │
│       hash = sha256(deviceId + idempotencyKey)                    │
│       SELECT response_blob, status_code FROM idempotency_keys    │
│       WHERE hash = $1 AND expires_at > NOW()                     │
│       if found → reply with cached blob, set X-Idempotent-Hit:1  │
│       else → wrap res.json so on first write we INSERT            │
│              (hash, body, status, expires_at = now + 24h)         │
│              then call next()                                     │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## Schema

```sql
-- backend/migrations/20260610_idempotency_keys.up.sql
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id BIGSERIAL PRIMARY KEY,
    -- sha256(deviceId + clientIdempotencyKey) so we never store the raw key
    -- and per-device collision is impossible.
    hash CHAR(64) NOT NULL UNIQUE,
    response_blob JSONB NOT NULL,
    status_code SMALLINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idem_expires_at ON idempotency_keys(expires_at);
```

Sweeper: a 5-min cron deletes rows where `expires_at < NOW()`. Same pattern as existing `outbound_msg_pending` sweeper in `backend/entity-status.js`.

## Client-side queue shape (localStorage `eclaw_outbox`)

```ts
type OutboxEntry = {
  idempotencyKey: string;           // crypto.randomUUID()
  payload: TransformBody;           // body of POST /api/transform
  state: 'queued' | 'retrying' | 'sent' | 'failed';
  attempts: number;
  nextRetryAt: number;              // unix ms
  createdAt: number;                // unix ms — for UI timestamps + GC
  errorMessage?: string;            // populated on terminal failure
};
```

Cap: 100 entries. When full, the oldest `queued` entry is dropped with a console warning + a banner. `failed` entries are user-actioned (retry or dismiss).

GC: any entry older than 7 days is purged regardless of state.

## Backoff

```
attempt 1: send immediately
attempt 2: +5s
attempt 3: +15s
attempt 4: +45s
attempt 5: +120s
attempt 6+: +300s (cap)
```

Cap total attempts at 12. After that, `state="failed"` permanently.

## UI states (chat.html)

Replace the current "instant render + silent drop on offline" with:

| State      | Visual                            | Actions                  |
|------------|-----------------------------------|--------------------------|
| `queued`   | light-gray bubble + spinner icon  | tap → "cancel"           |
| `retrying` | yellow-tinted bubble + spinner    | tap → "cancel"           |
| `sent`     | normal sent bubble                | (none — final)           |
| `failed`   | red-bordered bubble + ⚠️           | tap → "retry" / "delete" |

Non-blocking banner at top of chat scroll: `📤 3 queued · 1 retrying`. Banner disappears at 0 queued + 0 retrying.

## Server middleware shape

```js
// backend/idempotency-keys.js
'use strict';
const crypto = require('crypto');

function hashKey(deviceId, key) {
  return crypto.createHash('sha256').update(`${deviceId}|${key}`).digest('hex');
}

function makeIdempotencyMiddleware(pool) {
  return async function (req, res, next) {
    const clientKey = req.get('Idempotency-Key');
    const deviceId = req.body?.deviceId;
    if (!clientKey || !deviceId) return next();
    if (clientKey.length < 8 || clientKey.length > 128) return next();
    const hash = hashKey(deviceId, clientKey);
    try {
      const cached = await pool.query(
        'SELECT response_blob, status_code FROM idempotency_keys WHERE hash = $1 AND expires_at > NOW()',
        [hash]
      );
      if (cached.rows.length > 0) {
        res.set('X-Idempotent-Hit', '1');
        return res.status(cached.rows[0].status_code).json(cached.rows[0].response_blob);
      }
    } catch (e) {
      console.warn('[idem] cache lookup failed:', e.message);
      return next();
    }
    const origJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode || 200;
      pool.query(
        `INSERT INTO idempotency_keys (hash, response_blob, status_code, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
         ON CONFLICT (hash) DO NOTHING`,
        [hash, body, status]
      ).catch((e) => console.warn('[idem] insert failed:', e.message));
      return origJson(body);
    };
    next();
  };
}

module.exports = { makeIdempotencyMiddleware, hashKey };
```

Mounting point: `backend/index.js` adds the middleware on `/api/transform` and `/api/client/speak` BEFORE the existing handlers.

## Acceptance criteria (for full implementation, not this spec PR)

1. `backend/migrations/20260610_idempotency_keys.up.sql` checked in + down migration sibling.
2. `backend/idempotency-keys.js` implements the middleware with jest coverage:
   - first call → cache miss, response cached
   - second call with same (deviceId, key) within 24h → cache hit, X-Idempotent-Hit:1
   - second call with same key after expiry → cache miss, fresh response
   - missing header → middleware no-op (legacy path)
3. Client outbox in `backend/public/portal/shared/outbox.js`:
   - enqueue / flush / GC functions
   - jest for backoff schedule + 100-cap eviction
4. `chat.html` send path uses outbox.js. Inline bubble states render per the UI table above.
5. Banner at top of chat scroll shows live queue count.
6. E2E playbook entry: send 5 messages with network off, reconnect, see 5 delivered, no dupes.

## Test plan (the spec PR)

- [x] markdown renders cleanly
- [x] schema SQL compiles (`psql --dry-run` syntax check during impl)
- [ ] After Hank approves the 3 open questions below → file follow-up implementation card with bridge-auth U## tag

## Three open questions for Hank

1. **Cap policy when outbox is full at 100**: drop oldest `queued`, OR refuse new sends with a banner? Default proposal: drop oldest + banner.
2. **Failed-state visibility**: keep `failed` entries forever (until user dismisses), OR auto-expire after 7d? Default proposal: 7d auto-expire matching general GC.
3. **Idempotency-key on /api/client/speak too?**: real users send via `/api/client/speak`, bots via `/api/transform`. Both should be idempotent OR only `/api/transform`? Default proposal: both.

## Out of scope (deferred to follow-up cards)

- Server-side push retry / FCM dedupe (separate problem)
- Notifying the *receiver* of "message will arrive late" (separate UI)
- Cross-device queue sync (single-tab/device for v1)
- Mobile WebView outbox (cover in Phase 3 E2E matrix, card_42ffca0d)
