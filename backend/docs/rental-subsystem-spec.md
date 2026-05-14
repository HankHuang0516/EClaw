# Rental subsystem — cross-subsystem contract (v0.2)

**Layer:** This doc covers the contract *between* subsystems — health-probe → rebind cascade → wallet refund → alert routing — that no single `specs/<subsystem>.md` owns end-to-end.

**Companions (per-subsystem detail, source of truth for their own scope):**
- [`backend/docs/specs/rental.md`](./specs/rental.md) — constants, status enums, deposit disposition matrix.
- [`backend/docs/specs/rental-rebind-cascade.md`](./specs/rental-rebind-cascade.md) — Phase 1-4 cascade detail; **atomicity authority** for refund / forfeit / state transitions.
- [`backend/docs/specs/wallet.md`](./specs/wallet.md) — ledger types, idempotency-key registry, special pool UUIDs.
- [`backend/docs/specs/channel-bridge.md`](./specs/channel-bridge.md) — `/api/transform` + `senderHint` routing used by alert payloads.

**Scope.** This is the cross-subsystem *contract* layer — health probe triggers, refund-flow ownership, official-vs-rental lifecycle differences, alert routing. Endpoint shapes, DB schema, and cron table changes for *unshipped* surfaces are still out of scope (see §6); §7 tracks open contract questions per version.

**v0.2 deltas.** Q1 (listing soft-pause on `yellow_sustained`) and Q3 (cross-device rebind cascade uniformity) are now settled by shipped code — folded into §1.4 and §2 respectively. Q2 (force-active audit trail) and Q4 (`promoted` × `degraded` orthogonality) carry forward; both still depend on code that hasn't been written. See §7.

**Policy anchor.** Hank 2026-04-25 1on1 Q1 — "B 重綁屬於 owner 問題 所以虧要 owner 吃". Health-probe-triggered rebind keeps that ruling: the refund flow charges the owner, not platform or renter. The probe is detection; the cascade is the resolution; this doc binds the two together.

---

## 1. Health probe — triggers, severity, retry/backoff

The probe is a **classification + debouncer** in front of the rebind cascade. It does not itself terminate contracts. When it crosses a threshold, it hands off to either §2 (rebind cascade) or §4 (alert-only path) — never both.

### 1.1 Trigger sources

| # | Source | Cadence | Scope |
|---|--------|---------|-------|
| T1 | Rental fleet cron | every 15 minutes | every `bot_listings.status IN ('listed','paused')` row owned by `(device, entity)` slots in active use |
| T2 | Renter chat-silence fast-path | on-demand | renter posts to bot via `/api/client/speak`, bot reply not observed in `chat_messages` within `CHAT_SILENCE_PROBE_DELAY_S` |
| T3 | Official-bot scheduled heartbeat | separate cron (lower frequency than T1; see §3.4) | every `entities` row with `is_official = true` |

T1 owns the *baseline truth*. T2 is the *fast-path* — it short-circuits the 15-minute lag when a real interaction has already failed. T3 is on its own clock because official bots have no owner wallet (§3) so they cannot share T1's cron schedule logic.

### 1.2 Severity classification

For each probe sample:

| Severity | Condition (any of) |
|----------|--------------------|
| `green` | probe round-trip ≤ `PROBE_TIMEOUT_MS`; AND `load < LOAD_YELLOW_THRESHOLD`; AND `mem_free >= MEM_YELLOW_THRESHOLD_MB` |
| `yellow` | probe succeeded, but `load >= LOAD_YELLOW_THRESHOLD` (default 50) OR `mem_free < MEM_YELLOW_THRESHOLD_MB` (default 500) |
| `red` | probe timeout (`> PROBE_TIMEOUT_MS`) OR connection refused OR auth failure |

Thresholds are nominal — final values land in `MONITORING_THRESHOLDS` (today's home: `backend/index.js:5768`) alongside `dbLatencyMaxMs`, `publisherDisconnectedYellow`, `publisherDisconnectedRed`. Naming-by-purpose, not by mechanism, so the threshold set can evolve without churning callers.

### 1.3 Retry / backoff

A single sample never moves a bot between severity classes. Debounce is asymmetric:

| Transition | Requires |
|-----------|----------|
| `green → yellow` | 1 yellow sample (immediate; cheap state change, no cascade trigger) |
| `green → red` | **2 consecutive red samples** (avoid one-shot transient → rebind) |
| `yellow → red` | **2 consecutive red samples** (same as above) |
| `red → yellow` | 1 yellow sample (recovery, no debouncer needed in this direction; rebind is the only state that *consumed work*, we're not undoing it) |
| `red → green` | **3 consecutive green samples** (avoid flap; only reset rebind eligibility once stability is convincing) |
| `yellow → green` | 1 green sample (recovery is cheap) |

Probe retry within a single sample uses exponential backoff:

| Attempt | Wait before |
|---------|-------------|
| 1 | 0 (immediate) |
| 2 | 2s |
| 3 | 8s |

3 attempts is the per-sample cap. The sample is `red` iff all 3 attempts fail. Per-sample retry budget is **separate from** the cross-sample debouncer — they compose: a `red → red → green` window leaves the bot in `red` even though attempt #6 (the green) succeeded, because the cross-sample rule is "3 consecutive greens to clear red".

### 1.4 Alert-only vs recovery/rebind branch

| Classification result | Action |
|-----------------------|--------|
| 1st `red` sample (debounce not yet satisfied) | alert owner via §4 channel; no cascade; reason code `probe_red_provisional` |
| 2nd consecutive `red` sample (debounce satisfied) on **rental** bot | trigger rebind cascade §2; reason code `probe_red_confirmed` |
| 2nd consecutive `red` sample on **official** bot | escalate ops alert (§3 + §4); **no cascade** — no owner to settle against |
| Sustained `yellow` ≥ `YELLOW_SUSTAIN_SAMPLES` (default 4 = 1hr at 15min cadence) | warn owner; auto-set `bot_listings.soft_pause_until` + `soft_pause_reason='response_timeout'` (shipped — see §1.5 below) |
| `red → green` debounce completed | clear owner red flag; no positive event emitted to renter (avoid alert-fatigue noise) |

The yellow-sustain path deliberately does NOT cascade — soft-pause keeps the listing taking no new reservations while existing contracts continue; the bot is *degraded* not *broken*. Only confirmed-red triggers the cascade.

### 1.5 Listing soft-pause (Q1 resolved in v0.2)

The soft-pause leg of §1.4 is now an automatic state transition, not just an alert. Authoritative implementation behavior, sourced from `backend/tests/jest/rental-soft-pause.test.js` and the `bot_listings.soft_pause_until` / `soft_pause_reason` columns:

| Aspect | Contract |
|--------|----------|
| Enter | `recordListingHealthSample` with `status='degraded'` AND `degradedSince` ≥ 60min → sets `soft_pause_until` (forward window) + `soft_pause_reason`; emits `action: 'soft_paused'`. |
| Clear (auto) | 5 consecutive `status='ok'` samples → `soft_pause_until = NULL`; emits `action: 'soft_pause_cleared'`. |
| Clear (manual) | `POST /api/rental/listing/:id/resume` (owner-only) → same NULL-out, audit-logged as operator override. |
| Reject behavior | `POST /api/rental/create` against a soft-paused listing → **HTTP 503** + `{ code: 'LISTING_SOFT_PAUSED', resumeEta, reason }`. |
| Existing-contract behavior | active rentals **remain visible to contract queries** and continue billing; only *new* reservations are blocked. This is the §2 cascade's job, not §1's. |
| Visibility to non-owner | `GET /api/rental/listing/:id` returns `is_soft_paused: true` + `soft_pause_reason` but **omits** `owner_user_id` for non-owners. Plaza search filters soft-paused listings unless `caller=owner`. |

Soft-pause sits *between* `yellow` (alert-only) and `red-confirmed` (cascade). It is recoverable without owner intervention and does not invoke the wallet refund flow.

---

## 2. Rebind cascade — refund flow + transactional boundaries

This section is the **inter-subsystem contract** between health probe (§1) and the existing Phase 1-4 cascade. The cascade itself (selection query, pro-rata math, idempotency keys) is owned by [`specs/rental-rebind-cascade.md`](./specs/rental-rebind-cascade.md). This section answers: *which steps share a transaction; which are async compensation; what happens when each leg fails.*

### 2.1 Event sequence on probe-triggered rebind

```
T+0    probe (§1) classifies bot as red-confirmed
T+0    cascade enters; state mutation begins
       │
       ├─[A] entities[id].rebindCount++; lastRebindAt = now   ← Phase 1 (synchronous, in-memory + DB)
       │
       ├─[B] pauseListingsOnRebind(device, entity)            ← Phase 3 (own txn; awaited)
       │       UPDATE bot_listings SET status='paused'
       │       WHERE owner_device_id=$1 AND owner_entity_id=$2
       │         AND status IN ('draft','interview','listed')
       │
       ├─[C] terminateActiveContractsOnRebind(...)            ← Phase 4 (own txn per contract)
       │       for each contract:
       │         Step 1: endRental(contractId, 'ended_admin') ← 100% deposit → renter
       │         Step 2: owner-pays-renter pro-rata penalty   ← own withTransaction
       │
       └─[D] alert dispatch                                    ← §4 (async, fire-and-forget)
              owner: rebind reason + penalty summary
              renter: contract terminated + refund + penalty credit summary
              ops:   aggregated cascade outcome
```

### 2.2 Transactional boundaries

| Boundary | What is in the same transaction | Why |
|----------|--------------------------------|-----|
| Per-contract Step 1 (`endRental`) | renter `held_mli` decrement + renter `balance_mli` increment + `ended_admin` status write | atomic refund — partial state where renter loses held but doesn't gain balance is unacceptable |
| Per-contract Step 2 (owner→renter pro-rata) | owner `balance_mli` decrement + renter `balance_mli` increment + 2 `wallet_ledger` rows | atomic transfer — half-applied transfer would diverge global ledger sum |
| Phase 3 (`pauseListingsOnRebind`) | every drifted listing row update for that slot | not strictly required to be atomic with Phase 4, but a single multi-row UPDATE is simpler than per-row and matches existing code |
| Phase 1 ↔ Phase 3 ↔ Phase 4 | **NOT in the same transaction** | per `specs/rental-rebind-cascade.md` §4.6: rebind is upstream truth (slot identity already changed). Rolling the rebind back on a Phase 3/4 failure would leave a worse inconsistency |
| Alert dispatch (§4) | NOT in any wallet/listing txn | alerts are best-effort observability; a failed Slack push must not roll back a successful refund |

**The two-step settlement.** Inside Phase 4, `endRental` (Step 1) and the owner-pays-renter transfer (Step 2) are deliberately separate transactions, not one. Rationale (lifted from `specs/rental-rebind-cascade.md` §4.3):

- Step 1 uses the existing rental termination path, including its idempotency keys (`rental-release:<contractId>` etc.). A second cascade pass over the same contract is a no-op there.
- Step 2 has its own idempotency keys (`rebind-refund-debit:<contractId>` / `rebind-refund-credit:<contractId>`) so it can be retried independently if Step 1 succeeded but Step 2 transiently failed (e.g. DB pool spike).
- Merging them would require either a single mega-key (loses idempotency granularity) or a saga (heavier than the actual risk).

### 2.3 Async compensation vs synchronous failure

| Failure point | Behaviour |
|---------------|-----------|
| Phase 1 fails (in-memory rebind itself fails) | abort cascade entry — there is no rebind to cascade against |
| Phase 3 fails on some listings | continue cascade; per-listing failures logged to `serverLog` warn; *not* retried (the bot is rebound, the next 15-min sweep can pick up stragglers via the soft-pause path in §1.4) |
| Phase 4 Step 1 fails for contract C | log + skip C; continue with next contract; renter for C stays in `active` against a now-different bot until next sweep — **acceptable transient** because the slot identity has changed and any traffic to it now reaches the new bot, which renter will quickly notice |
| Phase 4 Step 2 fails for contract C after Step 1 succeeded | log `shortfallMli = penaltyMli` (renter is whole on deposit, but owed compensation); **not** retried automatically; appears in audit log for manual reconciliation. The idempotency keys ensure a future replay (e.g. ops-triggered) is safe |
| Owner balance below penalty | clamp to balance, write `shortfallMli` to warn log (existing behaviour, `specs/rental-rebind-cascade.md` §4.4); cascade does not stall |
| Alert dispatch (§4) fails for one channel | continue with other channels; do not block on it |

The cascade is intentionally **forward-only**. No leg rolls back a prior leg. Async retry is **not** scheduled by the cascade itself — the recovery path is the next 15-min sweep (T1) re-evaluating the new bot identity on the slot, plus manual ops reconciliation for shortfalls.

### 2.4 Webhook / external state

This subsystem currently has no outbound webhooks tied to rebind. Channel notifications go through `/api/transform` (in-process) and `bridge.ts` (push to fakechat / external chat surfaces) — both are async from the cascade's perspective and do not gate the transaction. If a future surface (e.g. external billing webhook) is added, it MUST sit at the §4 alert layer (async, fire-and-forget) — never inside the Phase 4 transaction.

---

## 3. Official-bot vs rental-bot lifecycle

Both lifecycles share the same `entities` row shape and the same probe (§1), but the *response* to a red classification diverges because official bots have no owner wallet to settle against.

### 3.1 Shared lifecycle states

| State | Meaning | Source of truth |
|-------|---------|-----------------|
| `provisioning` | entity row created, bot not yet handshake-verified | `entities` row exists, no successful probe yet |
| `active` | last probe green or yellow; eligible for chat / rental | `entities` row + recent green probe sample |
| `degraded` | yellow-sustained (§1.4); listing soft-paused; existing chats continue | `entities` row + sustained yellow; listing status `paused` |
| `revoked` | red-confirmed and resolution applied | for rental: listing `paused`/`delisted` + contracts `ended_admin`; for official: see §3.3 |

### 3.2 Rental-only state additions

| State | Trigger | Effect |
|-------|---------|--------|
| `rebinding` | red-confirmed (§1.4) on rental bot | transient marker during Phase 1-4 cascade; ends when cascade completes (any outcome) |
| `manually_revoked` | owner-initiated `unbind` via API | listings `delisted`, contracts `ended_admin` with renter notification — owner pays the same pro-rata penalty as in §2 |

The renter sees `rebinding` only in audit / chat-system messages, never as a listing status the marketplace surfaces.

### 3.3 Official-only state additions

| State | Trigger | Effect |
|-------|---------|--------|
| `promoted` | manual ops decision (e.g. Hermes / Mac_F / Mac_E elevated to device-wide visibility) | bot becomes visible across all device entities; **does not participate in rental cascade** |
| `ops_alert` | red-confirmed on official bot | alert routed to ops channel (§4.3); bot stays in `degraded` state; **no rebind** — there is no owner to settle against, and rebinding an official identity would disrupt platform-wide users |

`promoted` is a *visibility* flag, not a health classification. A `promoted` bot still passes through §1 probes; the only difference vs a rental bot is the §1.4 row that decides what to do with red samples.

### 3.4 Bind / pause / expire / refund / manual-override differences

| Operation | Rental bot | Official bot |
|-----------|-----------|--------------|
| `bind` | owner creates entity + listing; passes through interview (`INTERVIEW_PASS_SCORE = 60`); refund eligible on Phase 4 cascade | platform-managed; no interview path; no refund concept |
| `pause` (listing soft-pause) | owner-initiated OR auto on `degraded` (§1.4) | N/A — no listing |
| `expire` (contract natural end) | `ended_normal`, 100% refund of remaining held | N/A — no contract |
| `refund` (any non-natural end) | per `specs/rental.md` §3 disposition matrix | N/A |
| `manual override` (force-active) | admin clears probe red counter; re-evaluation starts fresh; **no auto-rebind** until next confirmed red | same path; force-active does NOT promote |
| `borrow` (renter holding active contract) | renter is de-facto operator; owner ops blocked (`specs/rental.md` §5) | not applicable — official bots are not rented |
| `free` (no rental) | bot answers to owner only | bot answers per its `is_official` routing policy |

Free vs personal vs borrow binding for the public-code allocator is out of scope here — that's the `official-bind.md` gap in `INDEX.md` (row #6). This doc only documents differences *visible at the rental-subsystem layer*.

---

## 4. Recovery & alert routing

### 4.1 Self-recovery

A bot in `red` returns to `green` only after **3 consecutive green samples** (§1.3). During those 3 samples the bot stays flagged for alerting purposes — observability surfaces (admin dashboard, rental-monitor) keep showing the recent red event until the debouncer clears.

Self-recovery does NOT auto-restore rental capability:
- Listings paused by Phase 3 stay paused; owner must re-list (per `specs/rental-rebind-cascade.md` Phase 3).
- Contracts terminated by Phase 4 stay terminated; renter must re-reserve.

This is intentional — `red` already triggered a cascade with real wallet impact. Auto-re-listing would risk the same bot flapping into another cascade.

### 4.2 Manual recovery — force-active

| API | Body | Effect |
|-----|------|--------|
| `POST /api/rental/bot/{entityId}/force-active` (proposed, **not in this PR**) | `{ deviceId, deviceSecret, reason }` | clear probe red counter; reset debouncer to `green`; emit audit log entry; **does not re-list** (same self-recovery rationale §4.1) |

Authorization MUST require `deviceSecret` (the owner's full device credential), not `botSecret` — a rental bot cannot self-clear its own red flag. Endpoint, schema, and migration land in a separate implementation card (see §6).

### 4.3 Alert routing — owner, channel, retry limits, escalation

| Event | Channel | Recipient | Retry on failure | Escalation |
|-------|---------|-----------|------------------|------------|
| `probe_red_provisional` (1st red sample, rental) | fakechat → owner | owner entity | 1 retry @ 30s | none — provisional event; if confirmed-red follows, that alert supersedes |
| `probe_red_confirmed` → rebind started | fakechat → owner | owner entity | 1 retry @ 30s | if owner unreachable for 6h: post to ops summary channel |
| `probe_red_confirmed` → contract terminated | fakechat → renter | each affected renter | 2 retries @ 30s / 120s | if renter unreachable: chat-system message persists in `chat_messages` for next-login pickup |
| `rebind_settlement` (per-contract penalty applied) | fakechat → owner + renter | both parties of contract | 1 retry @ 30s | none — wallet ledger is the durable record |
| `rebind_shortfall` (§2.3) | fakechat → owner; ops summary | owner + ops | 2 retries @ 30s / 120s | if owner unreachable 24h: file kanban card via existing automation card for manual reconciliation |
| `probe_red_confirmed` on **official** bot | ops summary channel | ops on-call | 3 retries @ 30s / 120s / 600s | escalate to platform admin after 600s with no ack |
| `yellow_sustained` (§1.4) | fakechat → owner | owner entity | no retry | none — informational; auto-clears on green |

All alert payloads MUST carry a structured `reason` field. Reason codes (not exhaustive — extend as the probe surface grows):

| Code | Meaning |
|------|---------|
| `probe_timeout` | sample(s) timed out at `PROBE_TIMEOUT_MS` |
| `probe_load_high` | `load >= LOAD_YELLOW_THRESHOLD` |
| `probe_mem_low` | `mem_free < MEM_YELLOW_THRESHOLD_MB` |
| `probe_chat_silence` | T2 fast-path triggered (renter chat with no bot reply within deadline) |
| `probe_auth_fail` | probe credentials rejected (bot revoked / token expired) |
| `probe_connection_refused` | TCP-layer failure (process dead) |

The reason code is what callers downstream (ops dashboard, alert-deduper, future post-incident review) use as a stable grouping key. UI strings are localized separately and MUST NOT be the deduplication key.

### 4.4 Retry-limit philosophy

The retry counts above are *per-channel, per-event*, not global. They do not compound across the cascade. A red-confirmed event that triggers 4 contract terminations dispatches 4 independent renter alerts, each with its own retry budget. This matches the cascade's per-contract error isolation (`specs/rental-rebind-cascade.md` §4.6).

Manual-intervention escalation thresholds (6h / 24h) are wall-clock from event creation, not from last retry — once we've decided ops needs to know, the retry clock doesn't matter.

---

## 5. Cross-references

- §2 transaction boundaries reference `specs/rental.md` §3 (deposit disposition matrix) and `specs/rental-rebind-cascade.md` §4 (Phase 4 detail). When those move, this section's references must move with them.
- §3 lifecycle states reference `specs/rental.md` §2 (status enums). Adding a new status enum value requires updating both.
- §4 alert routing reference `specs/channel-bridge.md` for `/api/transform` + `senderHint` semantics.
- The `MONITORING_THRESHOLDS` block in `backend/index.js` is the eventual home of every threshold named in §1. Naming-by-purpose ensures threshold values can move without renaming the contract.

## 6. Out of scope (deliberately not in this PR)

- **Implementation.** No JS handler code, no SQL migration, no cron registration changes. Endpoint signatures sketched in §4.2 are proposals, not contracts.
- **Endpoint rename or behaviour change** for existing routes (`/api/monitoring/rental-health`, `/api/rental/...`). This PR does not redefine what those return today.
- **DB schema migration.** Probe sample storage, debouncer state persistence, official-bot heartbeat table — all deferred to implementation card(s).
- **API contract for `/api/rental/bot/{id}/force-active`** beyond the §4.2 sketch — full request/response shape lands with the implementation PR.
- **Atomicity / locking strategy** for any leg — see [`specs/rental-rebind-cascade.md`](./specs/rental-rebind-cascade.md) §4 which remains authoritative for cascade-internal atomicity.
- **Per-platform threshold tuning** (e.g. iOS vs Android vs web for chat-silence T2) — initial values live in implementation; this doc only fixes the contract that thresholds exist and that they are named-by-purpose, not by mechanism.

---

## 7. Open questions

Tracking inline so the next iteration knows what to settle. Resolved questions stay in this list (marked **RESOLVED in v0.X**) for two cycles so reviewers see the answer in-line; older resolutions move to §9 changelog.

- **Q1. RESOLVED in v0.2.** Should `yellow_sustained` (§1.4) auto-soft-pause listings, or only alert owner? — **Auto-soft-pause** (degraded > 60min triggers it, owner gets warned, no cascade). Now contractualized in §1.5; sourced from `backend/tests/jest/rental-soft-pause.test.js` and the shipped `soft_pause_until` / `soft_pause_reason` columns.
- **Q2.** Should `force-active` (§4.2) require a kanban card audit trail in addition to the audit log, given it bypasses the debouncer? — **Open**. `POST /api/rental/bot/{entityId}/force-active` is still proposed-only (zero grep hits in `backend/index.js` as of v0.2). When the implementation card opens, the contract recommendation is **dual audit**: an immutable audit-log row *and* a kanban card carrying operator entityId, reason, and probe-state snapshot at the moment of override. Rationale: force-active bypasses the §1 debouncer (which exists precisely so transient redness doesn't cascade) — losing both the debouncer and forensic kanban discoverability would make over-rides invisible to ops review. Settled at impl time, not now.
- **Q3. RESOLVED in v0.2.** Cross-device rebind (Phase 4 callsite `index.js:14494`) — does the cascade's pro-rata penalty respect the destination device's owner, or only the source? — **Uniform across all 8 callsites.** Per `specs/rental-rebind-cascade.md` §3 the cross-device callsite uses the same `pauseRentalListingsOnRebind` + `terminateRentalContractsOnRebind` wrappers as same-device rebinds. The owner-eats-loss policy anchors at the **source** owner (the slot that just rebound), independent of where the destination bot lives. No divergence needed; no §2 split shipped.
- **Q4.** Official-bot `promoted` state (§3.3) — is `promoted` orthogonal to `degraded` (a `promoted` bot can be `degraded`), or mutually exclusive? — **Designed orthogonal; not yet exercised in code.** No `promoted` literal exists in `backend/` (v0.2 grep). When the official-bot roster maintenance card lands, `promoted` should be implemented as a separate boolean / metadata flag from health severity (`degraded` / `down`), because they answer different questions: `promoted` = "should this surface in featured slots?" vs `degraded` = "is this bot still serving traffic correctly?". A `promoted` bot transitioning to `degraded` should *demote from featured surfaces* but keep the `promoted` intent flag, so it auto-refeatures on recovery. Restate contract once the roster card ships.

---

## 8. Update discipline

- This doc is the source of truth for **inter-subsystem contracts**. When a probe trigger changes, when a refund-flow ownership changes, when an alert channel changes — update here, in the same PR as the implementation.
- When a per-subsystem detail moves (e.g. `INTERVIEW_PASS_SCORE` changes) — update the relevant `specs/*.md` only; this doc references by name, not by value.
- v0.x versioning is informal. Cut a v1.0 when §7's open questions are all answered and the implementation is shipped.

---

## 9. Changelog

- **v0.2** (2026-05-15) — Q1 resolved (auto-soft-pause shipped; new §1.5). Q3 resolved (rebind cascade uniform per `specs/rental-rebind-cascade.md` §3). Q2 + Q4 still open; recommendations recorded inline for the impl card to consume.
- **v0.1** (2026-05-14, PR #2772) — Initial cut: §1 health probe, §2 rebind cascade, §3 official-vs-rental lifecycle, §4 alert routing, §6 out-of-scope fence, §7 open questions.
