# ErrLog Cluster Triage — 2026-06-19

**Source**: `GET /api/mission/cards` (entityId=2, status=blocked, title prefix `[ErrLog/`).
**Worktree analyzed**: `/Users/hank/Desktop/Project/claude-code-eclaw-channel/.work/card_01417648_401fix/backend/`.

---

## 1. Summary

| Metric | Value |
|---|---|
| Total blocked ErrLog cards | **76** |
| Distinct clusters | **19** (every cluster = 4 cards, one per ~6h cron cycle) |
| Singletons (cards that don't cluster) | **0** |
| High-severity clusters (`ERROR-high`) | 1 (`transform_entityid_0` × 4 cards) |
| Push-family clusters (one root cause) | 9 clusters / 36 cards (47% of backlog) |

The 76 cards collapse into **5 root causes** once the push family is unified. Two clusters are by-design log-noise that the team memory has already pre-approved for downgrade (`HNSW`, `REDIS_URL`). One is a real high-severity bug (`Transform entityId='0'`). Two are real fixable warnings (`Kanban Auth`, `Trust schema`).

The exact `4 cards per cluster` pattern means the cron runs every ~6h, takes a 6h log window, and files one card per *line* of the error block — so a single multi-line Push failure spawns 8 cards per run (1 header + 1 "Full error" + 6 stack-trace frames + 1 closing brace) and is responsible for 32 of the 76 cards.

---

## 2. Per-Cluster Triage

### Cluster A — Push to Device `2a0ad04d` (the offline device family) — **8 clusters / 32 cards**

| Cluster | Cards | Signature |
|---|---|---|
| `push_failed_to_push` | 4 | `[Push] ✗ Failed to push to Device 2a0ad04d… Entity N: <reason>` |
| `push_device_entity` | 4 | `[Push] ✗ Device 2a0ad04d… Entity N: Push failed with status NNN` |
| `push_timeout_domexception` | 4 | `[Push] Full error: DOMException [TimeoutError]: The operation was aborted…` |
| `stack_pushtobot` | 4 | `at async pushToBot (/app/index.js:18967:26)` |
| `stack_index_12061` | 4 | `at async /app/index.js:12061:21` (Promise.allSettled in broadcast) |
| `stack_index_12008` | 4 | `at async /app/index.js:12008:30` (the pushToBot await) |
| `stack_promise_allsettled` | 4 | `at async Promise.allSettled (index 0)` |
| `stack_processticks` | 4 | `at process.processTicksAndRejections (node:internal/process/...)` |
| `stack_undici` | 4 | `at node:internal/deps/undici/undici:13510:13` |

**Sample card IDs**: `card_9c7c23afd282502923f8743d`, `card_3f73bacd1cd8f5778a08817c`, `card_edccbe5b3424a7c8f79a1011`, `card_fe004d07d91f3d4ac49fa1e5`, `card_13dc98ba99ed011c6e856ec4`.

**Diagnosis**: All 32 cards trace to **one** event class — `pushToBot()` against an offline/unresponsive webhook for device `2a0ad04d-9107-4250-b8be-ecd565983fb2`. The stack frames at `:18967`, `:12008`, `:12061`, `:13510` (undici), `Promise.allSettled`, and `processTicksAndRejections` are all from the same call tree (verified at `backend/index.js:19084-19105`).

The team has already partially landed the right fix on the worktree code (`index.js:19099-19105`):
```js
if (isAbort) {
    console.warn(`[Push] ⏳ Device ${deviceId} Entity ${entity.entityId}: push gateway timeout (no 15s ack) — bot may reply async via /api/transform: ${err.message}`);
} else {
    console.error(`[Push] ✗ Device ${deviceId} Entity ${entity.entityId}: Push error:`, err.message);
    console.error(`[Push] Full error:`, err);
    serverLog('error', 'push_error', ...);
}
```
The comment above this block literally cites the team memory rule: *"Log severity must match reality (no 'benign error'): a gateway timeout is a known async-uncertain state, so it is a WARN, not an ERROR."*

**But the ErrLog cron is still tripping**. Three sites still emit the multi-line `Push` error block visible in the cards:

1. **`backend/index.js:12018`** — `console.warn('[Push] ✗ Failed to push to Device ${deviceId} Entity ${eId}: ${pushResult.reason}')`. Level=warn but title still surfaces as `[ErrLog/ERROR-low]` because the cron's title filter doesn't distinguish warn vs error reliably (see below).
2. **`backend/index.js:19057-19058`** — `console.error(...status...)` for non-2xx HTTP responses. Hard failure, stays as error. OK.
3. **`backend/index.js:19102-19103`** — the **non-abort** branch. This is the right one to keep error-level.

**Root cause for offline-device noise**: Device `2a0ad04d` looks abandoned / offline. Every 6h the broadcast cron fans out and produces a wall of warn/error logs for this one device. The fix is **not** to silence logs — the fix is to **mark the entity unreachable** after N consecutive timeouts so the broadcast skip-list short-circuits.

**Recommended action** — **Root-cause fix**, two-part:

- **Part 1 (immediate, log-shape)**: At `backend/index.js:12018`, change the message format so the multi-line `Full error:` dump (lines 19103) and stack-trace are NOT emitted on timeout. Currently the cron's regex splits each newline of `err.stack` into its own card. Replace `console.error('[Push] Full error:', err)` at **`backend/index.js:19103`** with a single-line `console.error('[Push] Full error: ${err.name}: ${err.message} (no stack — see push_error serverLog)')`. The full stack already goes to `serverLog('error', 'push_error', …)` at line 19104, which is queryable via `/api/logs`. **This alone collapses ~24 of the 32 cards (all 6 stack-frame clusters + the orphan `}` cluster).**

- **Part 2 (real fix)**: Add a consecutive-failure counter on `entity.pushStatus` and skip pushes once it crosses a threshold (e.g. 10 in a row). Surface this as `entity.message = "[SYSTEM:WEBHOOK_DORMANT]"` so the user sees why. New code goes around `backend/index.js:19057-19082` (the non-2xx branch) and `:19102-19115` (the catch branch). This kills the recurrence itself.

---

### Cluster B — `[Push] ✗ Failed to push…` warn header (already warn) — 4 cards

Same family as A but the warn-level header at `backend/index.js:12018` is the title-line for cluster `push_failed_to_push`. The ErrLog cron is picking up `warn` lines even though the title says `[ErrLog/ERROR-low]`.

**Recommended action**: separate from the Part-1/Part-2 fix, also **patch the ErrLog cron's title classifier** — `[ErrLog/ERROR-*]` should only be assigned to lines whose Railway log level is `error`. Right now `warn`-level lines (line 12018) get filed under `ERROR-low`, violating the *"severity = reality"* rule by inflating warn to error.

This is a cron-side fix (location not in this worktree but tracked by card `card_d473b36fb1caeda83fc95fc6` per team memory). Defer the title-classifier patch to that card, but include the fix-cron PR in the same batch.

---

### Cluster C — `[Trust] Schema warning: functions in index predicate must be marked IMMUTABLE` — 4 cards

| Cards | Signature |
|---|---|
| 4 | `[Trust] Schema warning: functions in index predicate must be marked IMMUTABLE` |

**Sample IDs**: `card_d6a2e8b9db727093a65917ca`, `card_6f343287b39fa4d6248bbb62`, `card_d03bde2f41da73578c08da04`, `card_1c05a2719afbfc13f16f758b`.

**Site**: `backend/trust.js:77` — `console.warn('[Trust] Schema warning:', err.message)` inside `initTable()`. Triggered by one of the `CREATE INDEX … WHERE func(col)` statements in `trust_schema.sql` using a non-IMMUTABLE function (likely `NOW()` or `current_timestamp` in a partial-index predicate).

**Recommended action**: **Root-cause fix**, not downgrade. Inspect `backend/trust_schema.sql`, find the partial index whose `WHERE` clause uses a non-immutable function, and replace it with either (a) a plain index without predicate, or (b) a literal interval (e.g. `WHERE created_at > '2025-01-01'::timestamptz` is immutable; `WHERE created_at > NOW() - interval '30 days'` is not). The schema warning is real and silently means **the index never gets created**, which is a perf bug, not benign.

Same pattern likely lurks in `auth.js:122`, `mission.js:251`, `rental.js:302`, `interview-arena.js:1059`, `invite.js:75`, `companion-api.js:233` — they all share the same `[Module] Schema warning:` swallow-and-warn idiom. Investigate `trust_schema.sql` first since that's the one that triggered; the others may also have the same bug but didn't surface yet.

---

### Cluster D — `[Kanban] Auth failed: { … }` — 4 cards (+ 16 satellite cards from same multi-line dump)

| Cluster | Cards | Signature |
|---|---|---|
| `kanban_auth_failed` | 4 | `[Kanban] Auth failed: {` |
| `auth_deviceid_arg` | 4 | `deviceId: '2a0ad04d…',` |
| `auth_hasdevicesecret_arg` | 4 | `hasDeviceSecret: false,` |
| `auth_hasbotsecret_arg` | 4 | `hasBotSecret: true,` |
| `orphan_brace` | 4 | `}` |

**Sample IDs**: `card_95b76a141651fed77b59cdf6`, `card_2d42c4967c1e40570989098f`, `card_b0a862acd85da05457dc2b33`, `card_5451ebf2c3dfd445c29c75c2`, `card_92204be1702a9f43790215be`.

**Site**: `backend/kanban.js:421`:
```js
console.warn('[Kanban] Auth failed:', { deviceId, hasDeviceSecret: !!deviceSecret, hasBotSecret: !!botSecret, entityId });
```

This is the **same device** `2a0ad04d` again — a bot is hammering Kanban API with `botSecret` only (no deviceSecret) and an entityId that doesn't match the secret. The fallback path at `kanban.js:381-390` handles that case (botSecret → entity lookup), so if auth is *still* failing the botSecret is stale/rotated.

**Recommended action**: **Root-cause fix + log-shape fix**.
- **Root cause**: device `2a0ad04d` has a bot with a rotated/invalid botSecret that's still cached on the bot side. This is the same offline-device problem as Cluster A — these errors will stop once the consecutive-failure dormancy logic (Part 2 above) is in place.
- **Log-shape**: replace the multi-line object dump at `kanban.js:421` with a single-line format so the cron doesn't spawn 5 cards per auth failure. Suggested replacement:
  ```js
  console.warn(`[Kanban] Auth failed: device=${deviceId} deviceSecret=${!!deviceSecret} botSecret=${!!botSecret} entityId=${entityId ?? 'undefined'}`);
  ```
  This collapses **20 of the 76 cards (26%) into 4 cards** — the biggest single quick win in the backlog.

---

### Cluster E — `[Transform] Device …: entityId='0'` — 4 cards — **HIGH SEVERITY**

| Cards | Signature |
|---|---|
| 4 | `[Transform] Device 480def4c-2183-4d8e-afd0-b131ae89adcc: entityId='0' doesn't match botSecret, auto-corrected to N` + auto-corrected, level `ERROR-high` |

**Sample IDs**: `card_cd06e33ff099a92545ba8b90`, `card_58868b851c4e4fdd169d93a6`, `card_9780173cf348c8a32eae55d8`, `card_8f48c0ea0f9e6195d0829092`.

**Satellite cluster**: `transform_entityid_0_arg` (4 cards) — the bare `entityId: '0'` line is the arg-dump from this same site. Sample IDs: `card_4c2e0cf209e3c57359809017`, `card_99574528e4027c7fb87a1800`, `card_12635bc8a93f71503166967c`, `card_16757790657e2c9c78cc6d65`. Same 4-cycle pattern (one arg-dump per cron run).

**Site**: `backend/index.js:9226`:
```js
console.warn(`[Transform] Device ${deviceId}: entityId=${requestedId} doesn't match botSecret, auto-corrected to ${correctId}`);
```

**Diagnosis** — per team memory `[Verify card claims]` and `[No "benign error" label]`, this is a **real bug**, not benign:
- A bot is calling `/api/transform` with `entityId='0'` (string zero) and a valid botSecret.
- The auto-correct path at `index.js:9219-9226` rescues it by looking up the entity owning the botSecret — but it logs `console.warn`, which the ErrLog cron then files as **ERROR-high** (not ERROR-low like the other clusters). The high severity is the cron classifier's call, and it's right: a recurring entityId='0' indicates client-side bug shipping bad params.
- This is device `480def4c-2183-4d8e-afd0-b131ae89adcc` (the commander device — entity #2 = LOBSTER, owner). Most likely the entity-status panel, mission-mindmap, or a polling cron is calling transform without populating `entityId` from the device state, falling through to `entityId='0'` default.

**Recommended action**: **Root-cause fix**, NOT downgrade.
1. Grep client-side callers of `/api/transform` for `entityId` params that may fall through to `'0'`:
   - `backend/index.js:8202` — `parseInt(entityId || '0')` is the read site
   - Look in `backend/public/portal/dashboard.html`, `backend/public/portal/chat.html`, `backend/public/shared/api.js` for any transform calls that don't pass entityId
   - Look in `backend/public/portal/kanban.html` and `backend/public/portal/mission.html` for OODA-R / preflight callers
2. Fix the offending client by requiring entityId at the API boundary OR by validating the caller's identity matches the botSecret's owner *before* the warn fires (i.e. don't warn when the auto-correct succeeded *and* the requested entityId was a falsy default like `'0'`/`undefined` — those mean "caller didn't specify", not "caller specified wrong").
3. At `backend/index.js:9226`, gate the warn:
   ```js
   if (requestedId !== 0 && String(requestedId) !== '0' && requestedId !== undefined) {
       console.warn(`[Transform] Device ${deviceId}: entityId=${requestedId} doesn't match botSecret, auto-corrected to ${correctId}`);
   }
   // (silently auto-correct when requestedId is the default; only warn on genuine mismatch)
   ```
   The genuine-mismatch case (e.g. entityId=3 but botSecret belongs to entity=5) is a real security-adjacent signal and stays a warn.

---

### Cluster F — `[ChatEmbedding] HNSW index creation failed` — 4 cards

**Site**: `backend/chat-embedding.js:79`:
```js
console.warn('[ChatEmbedding] HNSW index creation failed (search still works, just slower):', err.message);
```

**Per team memory** (`[Local zero-key embedding provider]` 2026-06-18 entry): *"HNSW idx still fails (Railway pg-shmem), seq-scan fallback works"* — this is a known Railway infrastructure constraint (insufficient shared memory for pgvector HNSW build). It's been triaged, documented, and accepted as a sequential-scan-fallback case.

**Recommended action**: **Downgrade to `console.debug` (or remove)**.

Justification (airtight per the no-benign-error rule):
1. The work the line describes IS being done correctly — sequential-scan fallback kicks in automatically (`CREATE INDEX IF NOT EXISTS` doesn't break the embedding flow).
2. The line is purely informational — there is no follow-up action a developer can take without a Railway infra upgrade.
3. Production search behavior is verified working (per the same team-memory entry: `mode:"semantic"` returns valid distances).
4. This is exactly the team-stated "downgrade is the right call" example.

Suggested replacement at `backend/chat-embedding.js:79`:
```js
console.debug('[ChatEmbedding] HNSW index not created (Railway pg-shmem limit); falling back to sequential scan. err=', err.message);
```
Sample IDs: `card_286cfac020921f3d6fb7e19d`, `card_62f7628a8a90068fc9be3326`, `card_6f68d7a62785de730de9fe83`, `card_ca24e539154a0c167f5f7221`.

---

### Cluster G — `[WARN] LIFECYCLE: REDIS_URL not set — deadline wheel disabled` — 4 cards

**Site**: `backend/lib/message-lifecycle/deadline-wheel.js:45`:
```js
console.warn(`[WARN] LIFECYCLE: ${reason} — deadline wheel disabled, timeouts will not auto-advance. Set REDIS_URL env var.`);
```
Called from line 76: `return makeDisabledWheel('REDIS_URL not set')`.

**Per team memory** + per the explicit code comment at `backend/index.js:20067-20069`:
> *"Redis is optional: without REDIS_URL the wheel is a disabled no-op and transitions still persist to PG (the source of truth); stuck-alert auto-arming is then deferred to the cold-start scan on next boot."*

The behavior the warn describes is **intentional** for this deployment — PG remains source of truth, cold-start scan covers the stuck-alert gap. The warn was added to tell devs setting up a new env "you should probably configure Redis" but it's not an error on the current EClawbot production topology.

**Recommended action**: **Downgrade to `console.info` (one-time on startup)**.

Justification (airtight per the no-benign-error rule):
1. The behavior is documented in the same file's design comment (spec §7 dual-write).
2. PG persistence (the actual source of truth) continues working.
3. Cold-start scan re-arms stuck-alerts on every boot — coverage is not lost, just delayed.
4. Treating this as an error/warn pages on-call for a config that the team has deliberately chosen not to set.

Suggested replacement at `backend/lib/message-lifecycle/deadline-wheel.js:45`:
```js
console.info(`[lifecycle] deadline wheel disabled (${reason}). PG remains source of truth; cold-start scan re-arms on boot.`);
```
Sample IDs: `card_a44aa1bb3d0fd6505f1c3c90`, `card_eb9eacb5c547c918719557bd`, `card_5f3159ba15d8903e08bba1c8`, `card_c2941377734aa73ad2b04667`.

---

## 3. Singletons

**None.** Every one of the 76 cards belongs to one of the 19 clusters listed above. The 4-cards-per-cluster regularity confirms this is purely a cron-cycle artifact — 4 cron runs × N error blocks per run.

---

## 4. Batch-PR Strategy

Recommended **3 PRs**, in this merge order:

### PR 1 — "ErrLog log-shape fixes" (low risk, kills 60+ of 76 cards)
- `backend/index.js:19103` — collapse multi-line `[Push] Full error:` to single-line; keep full stack in `serverLog('error', 'push_error', …)`
- `backend/kanban.js:421` — collapse `[Kanban] Auth failed:` object dump to single-line
- `backend/index.js:9226` — gate the `[Transform] entityId mismatch` warn so it only fires on genuine mismatch, not falsy-default auto-correct
- `backend/chat-embedding.js:79` — downgrade HNSW warn to `console.debug` with team-memory citation in code comment
- `backend/lib/message-lifecycle/deadline-wheel.js:45` — downgrade REDIS_URL warn to `console.info` with `index.js:20067` cross-ref in code comment

Estimated card collapse after merge: **76 → ~16** within one cron cycle. Zero behavior change, all stack traces still queryable via `/api/logs` and `serverLog`.

### PR 2 — "Trust schema IMMUTABLE predicate fix" (medium risk, real fix)
- Fix the non-IMMUTABLE function in `backend/trust_schema.sql` partial index predicate
- Add a regression test that asserts `pg_indexes` actually contains the partial index after `initTable()`
- Audit `auth_schema.sql`, `mission_schema.sql`, `interview_arena_schema.sql`, `invite_schema.sql`, `rental_schema.sql` for the same pattern (they all use the same warn-and-swallow idiom)

Estimated card collapse: **4 → 0** (the schema warning stops at the source).

### PR 3 — "Push dormancy + Transform entityId hygiene" (medium-high risk, real fix)
- Add consecutive-failure counter on `entity.pushStatus`; skip push when over threshold; set `entity.message = "[SYSTEM:WEBHOOK_DORMANT]"` for UX
- Grep portal pages + `shared/api.js` for `/api/transform` callers passing missing/zero `entityId`; fix at the caller
- Regression test: 11 consecutive timeouts → push is skipped, `pushStatus.dormant = true`

Estimated card collapse: **the offline-device 32-card family drops to ~1 dormancy notification per cycle**.

### Plus — cron-side log-classifier fix (separate card, not in this worktree)
Track on `card_d473b36fb1caeda83fc95fc6` (the Railway log-monitor cron card per team memory). Title classifier should respect Railway log severity rather than re-classifying every line containing the word "error" as `ERROR-*`. Will eliminate the warn→error mis-classification that lets warn-level lines (e.g. `[Push] ✗`) get filed as `ERROR-low`.

---

## 5. Rule Compliance Check

Per team memory `[No "benign error" label]` (2026-06-18):

- **Cluster A (Push family)**: Root-cause fix proposed (PR 3 dormancy). No "tolerate" labeling.
- **Cluster C (Trust schema)**: Root-cause fix proposed (PR 2). Schema warning is a real perf bug.
- **Cluster D (Kanban Auth)**: Root-cause fix (botSecret rotation upstream) + log-shape fix. No tolerate.
- **Cluster E (Transform entityId='0')**: Root-cause fix (caller-side + server-side gate). No tolerate. Note: per team memory this is explicitly flagged as a real bug, not benign — fixing the caller is non-optional.
- **Cluster F (HNSW)**: Downgrade — justified by 4 explicit points and direct quote from team memory authorizing this exact downgrade.
- **Cluster G (REDIS_URL)**: Downgrade — justified by 4 explicit points and direct quote from in-code design comment authorizing the no-op behavior.

No cluster is labeled "benign", "ignored", "archived", or "tolerated". Every downgrade points at the underlying intended behavior. Every fix names a file + line.

---

## 6. Card disposition (after PR 1 merge)

The 76 cards can be **closed as "fixed by PR 1"** in batches once each PR lands and the next cron cycle confirms zero recurrence. Do NOT close cards in this triage report — per task instructions, this report only proposes the plan.
