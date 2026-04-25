# rental — bot rental marketplace

**Source:** `backend/rental.js`, `backend/rental_schema.sql`, `backend/rental-proxy.js`
**Mounted at:** `/api/rental`
**Wallet contract:** `backend/wallet.js` (held balance + ledger)

This spec is the anchor doc for the rental subsystem. Every constant here is cited
**by name + value** so a grep against this file finds the rule, and a grep against
the source finds the implementation — both lead to the same line.

---

## 1. Constants

| Name | Value | Defined at | Meaning |
|------|-------|------------|---------|
| `ECOIN_TO_MLI` | `1000` | `rental.js:41` | 1 e幣 = 1000 厘 (mirrors `wallet.js`) |
| `DEPOSIT_TOKEN_MULTIPLIER` | `20` | `rental.js:44` | deposit = `rate_mli_per_ktoken × 20` (covers ~20k tokens of usage buffer) |
| `MIN_RENTAL_MINUTES` | `30` | `rental.js:47` | reservation duration floor |
| `MAX_RENTAL_MINUTES` | `7 × 24 × 60 = 10080` | `rental.js:48` | reservation duration ceiling (7 days) |
| `INTERVIEW_PASS_SCORE` | `60` | `rental.js:51` | minimum interview score required to publish a listing |
| `COOLDOWN_HOURS` | `24` | `rental.js:54` | same-renter / same-listing rental cooldown |
| `INTERVIEW_RATE_LIMIT` | `3` | `rental.js:57` | interview attempts per listing per 7 days |

Listings additionally store per-listing `min_rental_minutes` / `max_rental_minutes`
that **must fall within** the global bounds; reservations are also validated against
the listing-specific bounds (`rental.js:648-652`).

---

## 2. Status enums

### 2.1 `LISTING_STATUSES` (`rental.js:59-65`)

| Value | Meaning |
|-------|---------|
| `draft` | created, not yet interviewed |
| `interview` | interview probe queued / in progress |
| `listed` | passed interview (`score >= INTERVIEW_PASS_SCORE`), visible in marketplace |
| `paused` | temporarily withdrawn by owner OR auto-paused on rebind (Phase 3) |
| `delisted` | terminal; owner removed listing |

### 2.2 `CONTRACT_STATUSES` (`rental.js:67-77`)

| Value | Meaning |
|-------|---------|
| `reserved` | renter committed deposit; rental window not yet started |
| `active` | rental in progress; usage charged from `held_mli` |
| `suspended_insufficient_funds` | deposit emptied mid-window; renter can top up to resume |
| `ended_normal` | terminal — full refund of remaining held |
| `ended_early_by_renter` | terminal — 50% refund / 50% forfeit |
| `ended_zero_balance` | terminal — deposit consumed; remainder (if any) returned |
| `ended_disputed` | terminal — full refund pending dispute resolution |
| `ended_violation` | terminal — 70% refund / 30% forfeit |
| `ended_admin` | terminal — full refund (admin / cascade-driven termination) |

Only the `reserved`, `active`, and `suspended_insufficient_funds` states allow
`endRental` (`rental.js:775`); calling on terminal states throws
`contract_already_ended`.

---

## 3. Deposit disposition matrix (`endRental`, `rental.js:752-895`)

`actualHeldMli = min(wallets.held_mli, contract.deposit_mli)` — read inside the
transaction so it reflects post-`chargeRentalUsage` reality, not the original
deposit.

| `endReason` | Refund (held → balance, renter) | Forfeit (split below) |
|-------------|---------------------------------|------------------------|
| `ended_normal` | `actualHeldMli` (100%) | 0 |
| `ended_disputed` | `actualHeldMli` (100%) | 0 |
| `ended_admin` | `actualHeldMli` (100%) | 0 |
| `ended_early_by_renter` | `floor(actualHeldMli / 2)` (50%) | remainder (50%) |
| `ended_violation` | `actualHeldMli − forfeit` (70%) | `floor(actualHeldMli × 0.3)` (30%) |
| `ended_zero_balance` | `actualHeldMli` (whatever remains) | 0 |

**Forfeit split** (`rental.js:856-859`, integer math; insurance fully inside
platform's 15%):
- `insuranceMli = floor(forfeit × 200 / 10000)` → **2%**
- `platformGross = floor(forfeit × 1500 / 10000)` → **15%**
- `platformNet = platformGross − insuranceMli` → **13%**
- `ownerShare = forfeit − platformGross` → **85%**

Insurance pool user id: `00000000-0000-0000-0000-000000000002`.
Platform fee pool user id: `00000000-0000-0000-0000-000000000001`.

**Idempotency keys** (one per contract per leg):
- `rental-release:<contractId>`
- `rental-forfeit:<contractId>`
- `rental-forfeit-income:<contractId>`
- `rental-forfeit-pfee:<contractId>`
- `rental-forfeit-ins:<contractId>`

A duplicate `endRental` call is therefore safe — `applyLedgerEntry` rejects
idempotency-key collisions before mutating wallet rows.

---

## 4. Drift handling (rebind cascade)

When a slot's entity is rebound to a different bot, all listings + active
contracts attached to that slot become **drifted**: the row in
`rental_contracts` / `bot_listings` still references the old `(device_id,
entity_id)` pair, but the bot occupying that slot is now a different identity.

The full cascade lives in `backend/docs/specs/rental-rebind-cascade.md` — this
spec only covers the surface that callers grep for:

| Phase | Helper | Behaviour |
|-------|--------|-----------|
| 1 | (none, schema-only) | every rebind bumps `entities.rebind_count` and stamps `last_rebind_at` |
| 2 | `filterDriftedListings` (`rental.js:593-602`) | marketplace search hides any listing where `liveCount = entities.rebind_count > bound_rebind_count` (the snapshot taken when the listing was published) |
| 3 | `pauseListingsOnRebind` | cascade: drifted listings auto-transition `listed → paused` so the marketplace search doesn't have to re-filter forever |
| 4 | `terminateActiveContractsOnRebind` | cascade: every `reserved/active/suspended_insufficient_funds` contract on the slot ends as `ended_admin` (renter gets 100% deposit back), then the **owner** pays a pro-rata penalty `floor(deposit × remaining_ms / planned_ms)` to the renter, clamped to owner's available balance |

**Why owner pays the pro-rata penalty:** Hank's 2026-04-25 1on1 Q1 ruling — "B 重綁屬於 owner 問題 所以虧要 owner 吃". The renter contracted bot X; the rebind replaces X with Y inside the slot, so the renter's lost rental window is on the owner.

**Reserved-contract semantics:** `remainingMs / plannedMs = 1` because the rental
hasn't started — full deposit's worth of pro-rata penalty applies (`rental.js:403-412`).

**Shortfall behaviour:** `applyLedgerEntry` rejects negative balances. If the
owner's balance is below the computed penalty, the helper clamps to
`min(penalty, owner_balance)` and writes the residual as `shortfallMli` to a
`serverLog` warn entry — it is **not** pursued further (no debt collection,
no negative balance, no async retry).

---

## 5. Operations blocked on rental entities (`rental.js:966-1041`)

When a bot is currently rented (any active contract on its `(device, entity)`
slot), the renter — not the owner — is the de-facto operator. To prevent owner
sabotage, the middleware blocks these operations at the API boundary:

- entity rename / persona edit
- vault key edit
- entity delete
- entity rebind (which would trigger Phase 4 cascade above; allowed only via admin path that consciously fires the cascade)
- channel reconfiguration that would change the bot's identity

Owner can still: pause listing, view dashboard, withdraw earnings.

---

## 6. Rate limiting

- Interview attempts: `INTERVIEW_RATE_LIMIT = 3` per listing per rolling 7 days
  (rental.js:57). Counted across all renters; an interview that ends in
  `passed=false` still consumes a slot.
- Same-renter cooldown: a renter cannot reserve the same listing again within
  `COOLDOWN_HOURS = 24` of a previous contract end on that listing.

---

## 7. What this doc deliberately does NOT cover

- **API shape** of the route handlers — see `/api/help` and JSDoc on the route
  handlers in `rental.js`. This spec captures invariants and boundaries, not
  request/response schemas.
- **Wallet ledger types** — see `wallet.js` (and the future `wallet.md` spec
  per the gap list in `INDEX.md`). This spec only references ledger types by
  the names `endRental` actually writes: `DEPOSIT_RELEASE`, `DEPOSIT_FORFEIT`,
  `RENTAL_INCOME`, `PLATFORM_FEE`.
- **Bot interview probe set** — see `bot-interview.js` and `getProbeList`.
- **Token metering during rentals** — see `rental-proxy.js` and
  `chargeRentalUsage`.

---

## 8. Update discipline

- When any constant value in §1 changes, update this file in the **same PR** as
  the source change.
- When a new contract status or listing status is added, update §2 and §3 (if
  it has a refund disposition) in the same PR.
- When the rebind cascade adds a new phase, update §4's table and link the
  detailed spec.
- CI does not yet enforce drift between code and spec — file a follow-up if
  drift becomes a problem.
