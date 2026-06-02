# Spec: Backend `[SILENT]` / noop-ack class filter

**Status:** Draft — awaiting #1/#6 sign-off
**Card:** `card_54c10308cf2386e5dc15104b` (P0, opened 2026-06-02 08:31 TW)
**Driver:** Hank web_chat 2026-06-02 08:31 TW — 「開卡把 [SILENT] 這類訊息後台濾除 不要 speak to anyone」
**Author:** #2 (LOBSTER)
**Related work:**
- `claude-code-eclaw-channel` PR #11 / #12 / #13 widened `isNoopAck` at the bridge layer; PR #13 also added an `ECLAW_HEALTHCHECK` fast-path.
- This spec is the **server-side** counterpart Hank explicitly asked for. Bridge-only suppression scales only to my session; the same noise still wakes #1, #3, #5, #6.

---

## 1. Problem statement

Today, 2026-06-02 between 08:30 and 09:00 TW, the channel session received this sequence in under 60 seconds:

```
[📢 FWD from #3] ACK HC3mpvwhsbyn869xp
[📢 FWD from #5] ACK HC5mpvwi1pf1as7xv
[📢 FWD from #6] ACK HC6mpvwi6d9x8blly
[EClaw from entity:5:LOBSTER] Standby。       (Bot-to-Bot quota 8/8)
[EClaw from entity:5] [📢 FWD from #5] MODEL_HEALTH MH2mpvwifvbfw7owk entity=#2
[EClaw from entity:6:LOBSTER] ACK HC6mpvwi6d9x8blly
[EClaw from entity:6] [📢 FWD from #6] ACK HC6mpvwi6d9x8blly
```

Every one of these woke #2's session, consumed Claude tokens, and burned Hank's prompt budget — for messages that carry no actionable content. The channel-side `isNoopAck` widening (PR #11/12/13) suppresses the **outbound** auto-wake nudge, but the messages still:

1. Hit `/api/transform`.
2. Pass through `getSilentTransformSuppressionReason` without matching.
3. Get inserted into `chat_history` (via the speakTo delivery loop or self-save).
4. Trigger the channel poll (Claude Code channel plugin polls `chat_history` every N seconds).
5. Surface to my Claude session → I consume them → I reply with another `[SILENT]` → next round of echoes.

### 1.1 Why the existing filter misses

`backend/index.js:8223 getSilentTransformSuppressionReason`:

```js
if (/^\[SILENT\]$/i.test(afterMentions)) return 'silent_token';
if (/^\[SILENT\](?:\s|$)/i.test(afterMentions)) {
    const remainder = afterMentions.replace(/^\[SILENT\]\s*/i, '');
    if (isLowSignalFwd(remainder)) return 'silent_noise';
}
return null;
```

`backend/org-fwd-filter.js::ORG_FWD_NOISE_PATTERNS` requires a FULL match on:

```js
/^\s*(ping|pong|ack|ok|received|noted)\s*[.!]*\s*$/i
```

Concrete misses:

| Inbound text | After strip | Length | Matches? | Result |
|---|---|---|---|---|
| `[SILENT] ACK HC3mpvwhsbyn869xp` | `ACK HC3mpvwhsbyn869xp` | 20 | No (`ACK` + nonce ≠ bare `ack`) | **leaks** |
| `[📢 FWD from #3] ACK HC3mpvwhsbyn869xp` | n/a (no `[SILENT]`) | 35 | Not even reached | **leaks** |
| `MODEL_HEALTH MH2mpvwifvbfw7owk entity=#2` | n/a | 40 | Not matched | **leaks** |
| `Standby。` | n/a | 8 | `bare ack` regex no | **leaks** (verbose-stand-by class) |
| `[📢 FWD from #5] MODEL_HEALTH ...` | n/a | 46 | No | **leaks** |

The bridge-side `isNoopAck` already catches all five shapes — but the bridge only protects #2. #1, #3, #5, #6 still get their wake-loop firing because `/api/transform` happily writes the row into `chat_history`.

### 1.2 Why the bridge fix isn't enough

- **Per-bot scaling:** every bot session needs its own bridge update + redeploy + verify.
- **No control over polling sessions:** Claude Code sessions that don't use this bridge (browser web_chat, mobile app) still see the noise in their `/api/chat/history` feeds.
- **Wasted DB writes:** every noop-ack inserts a row that will be filtered out at read time — silent for the bot but real cost for postgres + indexes.

The right layer is `/api/transform` (and possibly `/api/client/speak` if that's how user-facing noise enters) — drop the noise **before** any chat_history write, no matter who's calling.

---

## 2. Proposal

Extend the existing `isSuppressedMessage` short-circuit in `/api/transform` to also cover the noop-ack class, **before** any of the downstream propagation paths fire (entity.message rewrite, speakTo, broadcast, self-save, kanban auto-review, push-context inlining).

### 2.1 Classification expansion

Introduce a new exported helper in `org-fwd-filter.js`:

```js
function isNoopAckClass(message) {
    // True for any message that's effectively a noop ACK / health-check /
    // verbose stand-by reply. Mirrors the layered checks the channel
    // bridge does in claude-code-eclaw-channel/bridge-state.ts ::isNoopAck,
    // but enforced server-side so peer bots also get suppressed.
}
```

It returns true for any of:

1. **Bare-token forms** (already handled at line 8233, kept here for completeness):
   - `[SILENT]`
   - `@<mention> [SILENT]`
2. **`[SILENT] <noise>` trailers** (8235–8242 currently delegated to isLowSignalFwd — keep that fork).
3. **Healthcheck ACK echoes** (NEW):
   - `^ACK\s+[A-Za-z0-9_-]+$` (cap text length at 80 chars, no trailing prose)
   - `^\[(?:📢\s*)?FWD\s+from\s+(?:#\d+|entity:\d+|#?[a-z0-9]{6})\]\s+ACK\s+[A-Za-z0-9_-]+$` (FWD echo wrapper, emoji optional)
4. **MODEL_HEALTH echoes** (NEW):
   - `^MODEL_HEALTH\s+[A-Za-z0-9_-]+(\s+entity=#?\d+)?$`
   - Same wrapped-in-FWD variant.
5. **Verbose stand-by class** (NEW — match the bridge widening from PR #12):
   - `^(Standby|待機|Standing\s+by|On\s+stand[- ]?by)[。.!\s]*$`
   - Already-resolved Codex "Acknowledged" forms can be added later if they leak.
6. **Disqualifier guard** (matches the bridge's `NOOP_DISQUALIFIER` — prevents real verdicts from being swallowed):
   - If the message contains `PR #\d+`, `LGTM`, `still red`, `still pending`, `merged`, `reviewed`, drop the noop-ack classification.

Each pattern has a corresponding unit test in `backend/tests/org-fwd-filter.test.js` keyed to the incident shapes we've seen in production.

### 2.2 `/api/transform` integration

`backend/index.js:8821` becomes:

```js
const silentSuppressionReason =
    getSilentTransformSuppressionReason(finalMessage) ||
    (isNoopAckClass(finalMessage) ? 'noop_ack_class' : null);
const isSilentMessage = !!silentSuppressionReason;
const isSuppressedMessage = isPlaceholderLeak || isSilentMessage;
```

No other branch in `/api/transform` needs to change — the existing `!isSuppressedMessage` guards already cover entity.message rewrite, mention parse, senderHint resolution, kanban auto-review, push delivery, and self-save. The serverLog `transform_silent_drop` line picks up `noop_ack_class` as the reason for free.

### 2.3 `/api/client/speak` integration

`/api/client/speak` is the path real users hit (browser web_chat, mobile). Today it does NOT call `getSilentTransformSuppressionReason`, because the assumption is that real users don't send `[SILENT]`. That's true for `[SILENT]` literally — but a real user could end up echoing a noop ACK pattern in transcribed conversation. To keep the suppression purely server-side and avoid the same regression cycle, gate `/api/client/speak` on the **bare healthcheck ACK class only**:

- `^ACK\s+[A-Za-z0-9_-]+$` (cap 80 chars) — drop with `silent_reason: 'client_speak_healthcheck_ack'`.
- `^MODEL_HEALTH\s+[A-Za-z0-9_-]+` — drop with `silent_reason: 'client_speak_model_health'`.

Don't include the verbose stand-by class on this path — a real user saying "Standing by" should still be delivered.

### 2.4 `chat_history` serve-side guard (belt + suspenders)

Even after the write-side suppression, there may already be tens of rows from the past 24 hours sitting in `chat_history` that match the noop-ack class (Hank's session this morning is the most recent). Add an OPTIONAL read-side filter:

`GET /api/chat/history?...&hideNoopAck=true` (default `false` for backwards compat) — applies `isNoopAckClass` row-by-row after the SQL fetch. The channel bridge can flip the flag to `true` for its own poller; the legacy web client stays unchanged until the FE PR can flip it too.

This is **optional v1.5** if the write-side suppression turns out to leak through some path we haven't enumerated. Don't ship in v1.

---

## 3. Acceptance

### 3.1 Unit (server-side)

- `backend/tests/org-fwd-filter.test.js` — new file or extend existing — covers:
  - All 6 inbound shapes from §1 (bare ACK, FWD ACK, MODEL_HEALTH, Standby, FWD MODEL_HEALTH, `[SILENT] ACK`).
  - 4 disqualifier guards (`ACK HC3abc — but PR #12 still red` etc. mirror PR #13 test set).
  - Edge cases: length cap (>80 chars), exotic FWD sender token shapes (`@31tlkr`, `entity:5`).

### 3.2 Integration

- `backend/tests/test-transform-silent.js` (or extend the existing transform test): POST `/api/transform` with each noop-ack shape, assert:
  - HTTP 200.
  - Response includes `silentSuppressed: true, silentReason: 'noop_ack_class'`.
  - `entity.message` unchanged.
  - No chat_history row inserted (verify via SELECT).
  - No push delivery attempted (verify via mock `delivery-receipts` not called).

### 3.3 E2E

- Replay the 2026-06-02 08:30 storm from #3, #5, #6 via three test devices hitting `/api/transform`. Assert #2's `/api/chat/history?entityId=2&limit=10` returns 0 of the 6 messages. Bridge wake count = 0.

### 3.4 Production validation

- Stage 1 (canary, 24h): deploy with `transform_silent_drop` log enabled at info; tail Railway logs and confirm the noop-ack class accounts for a measurable fraction of suppressions without false positives. Watch for spike in `silentReason: 'noop_ack_class'` on real bot conversations — should be ~0 outside the auto-wake loop.
- Stage 2: flip channel bridge to use `?hideNoopAck=true` once we've confirmed §2.4 is the cleanup story.

---

## 4. Non-goals (v1)

- **No** changes to `/api/client/speak` for the `Standby` / verbose stand-by class — real users may legitimately type those, and Hank's instruction was specifically about bot-to-bot echoes.
- **No** changes to webhook delivery layer (`delivery-receipts.js`) — suppression happens at the entry point.
- **No** Mastodon / WeChat / WordPress integration (those are retired or out of scope per project memory).
- **No** mid-bot session retry of suppressed messages — if a bot calls `/api/transform` with a noop-ack class shape, the call returns success with `silentSuppressed: true` and the bot must respect that without retrying.

---

## 5. Open questions for #1 / #6 review

1. **Should `silent_noise` keep its existing wording or merge into `noop_ack_class`?**
   - I lean keep separate so the serverLog grep stays clean and we can attribute volume per shape.
2. **Do we need a metric counter on suppressions?**
   - Probably yes — add `transform_silent_drop_count{reason}` Prometheus counter (or whatever the current metric layer is — last I checked it was a Railway log scrape, not Prom).
3. **Is the disqualifier list complete?**
   - PR #13 settled on: `PR #\d+`, `LGTM`, `still red`, `still pending`, `merged`, `reviewed`. Add `card_[a-f0-9]{20}` so bot review verdicts that quote a card ID don't get swallowed.
4. **Does `org-fwd-filter.js` belong in this PR, or should the new helper live in a sibling file (`noop-ack-filter.js`)?**
   - I lean keep in `org-fwd-filter.js` — same domain, low cognitive cost. Open to refactor.
5. **Should the read-side `hideNoopAck=true` flag be opt-in or opt-out?**
   - Opt-in (`false` default) for v1 backwards compat. Channel bridge flips it on for its own polls; revisit after Stage 2.
6. **`/api/client/speak` — is the carve-out for real-user-typed ACK strings the right move, or should we also gate that path?**
   - Spec proposes carving out user prose; willing to flip.

---

## 6. Rollback

- All suppression is gated on the new `isNoopAckClass` helper. Roll back = revert the call site in `/api/transform`. Single commit, no data migration.

---

## 7. References

- `claude-code-eclaw-channel/bridge-state.ts::isNoopAck` — incumbent client-side filter (`5c0e486` + `7b49883`).
- `claude-code-eclaw-channel` PR #13 (squash 2026-06-02 03:04 UTC) — same regex shapes, expressed as TypeScript.
- `backend/index.js:8223 getSilentTransformSuppressionReason` — current server suppression.
- `backend/org-fwd-filter.js` — host file for the new helper.
- `backend/push-context.js:12 SILENT_TOKEN` — the canonical `[SILENT]` literal.
- Memory `feedback_check_i18n_fallback_before_emergency` — apply similar "verify before emergency" mindset to suppression patterns.
