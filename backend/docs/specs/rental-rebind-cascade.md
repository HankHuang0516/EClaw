# rental — entity rebind cascade (Phases 1-4)

**Source:**
- `backend/rental.js` (helpers: `filterDriftedListings`, `pauseListingsOnRebind`, `terminateActiveContractsOnRebind`)
- `backend/index.js` (8 rebind callsites; `pauseRentalListingsOnRebind` / `terminateRentalContractsOnRebind` wrappers at lines 2195 / 2213)
- `backend/rental_schema.sql` (`bot_listings.bound_rebind_count`)

**Policy anchor:** Hank 2026-04-25 1on1 Q1 — "B 重綁屬於 owner 問題 所以虧要 owner 吃". A renter contracts bot **X** at the slot. After the owner rebinds the slot to bot **Y**, the renter's lost rental window is on the **owner**, not the renter or platform.

---

## 1. The drift problem

Listings and contracts are pinned to a **slot identity** —
`(owner_device_id, owner_entity_id)` — not to the bot's content. When the slot
is rebound to a different bot, the row keeps pointing at `(device, entity)`,
but the bot serving that slot has changed underneath it. Without intervention:

- Marketplace search would still surface the now-stale listing.
- Active contracts would silently stream traffic to a different bot than the
  renter agreed to.
- The renter has no signal that anything changed.

The cascade closes that gap with four phases, each landing in its own PR so
behavior could be vetted incrementally.

---

## 2. Cascade phases

| Phase | PR | Helper / signal | Effect |
|-------|----|-----------------|--------|
| 1 | #2113 | `entities[id].rebindCount++`, `lastRebindAt = Date.now()` | every rebind increments a counter on the in-memory entity record (also stamped onto `last_rebind_at` for persistence) |
| 2 | #2114 | `filterDriftedListings(listings, devicesMap)` (`rental.js:593-605`) | marketplace search hides any listing where `rebindCount > bound_rebind_count` (the snapshot taken when the listing was published) |
| 3 | #2115 | `pauseListingsOnRebind(deviceId, entityId)` (`rental.js:335-352`) | drifted listings auto-transition `draft / interview / listed → paused`; `paused` and `delisted` are left alone |
| 4 | #2118 | `terminateActiveContractsOnRebind(deviceId, entityId, walletApi)` (`rental.js:375-481`) | every `reserved / active / suspended_insufficient_funds` contract on the slot ends as `ended_admin` (renter gets 100% deposit back), then **owner** pays a pro-rata penalty to the renter |

Phase 1 is the *signal*. Phases 2-3 are the *passive* (search hide) + *active*
(state mutation) reactions on the listing side. Phase 4 is the contract-side
reaction.

---

## 3. Wiring (`backend/index.js`)

Two thin wrappers (`pauseRentalListingsOnRebind` at line 2195,
`terminateRentalContractsOnRebind` at line 2213) wrap the rental-module
helpers, swallow errors, and emit info / warn logs. Both are awaited
**immediately after** every rebindCount bump:

| Line | Callsite |
|------|----------|
| 1289 / 1290 | borrow expiration cleanup |
| 6707 / 6708 | rebind via API (path A) |
| 6829 / 6830 | rebind via API (path B) |
| 11732 / 11733 | personal binding rebind |
| 11992 / 11993 | free public-code allocation |
| 12156 / 12157 | generic rebind handler |
| 12332 / 12333 | rebind w/ saveData |
| 14494 / 14495 | cross-device transfer |

**Invariant:** every site that bumps `entity.rebindCount` calls **both**
`pauseRentalListingsOnRebind` **and** `terminateRentalContractsOnRebind`,
in that order. New rebind paths added in the future must follow the same
pattern — drop a rebindCount bump without the cascade and you re-open the
drift hole.

---

## 4. Phase 4 detail — termination + owner penalty

### 4.1 Selection query (`rental.js:381-391`)

```sql
SELECT c.id, c.listing_id, c.owner_user_id, c.renter_user_id,
       c.deposit_mli, c.planned_duration_min, c.started_at, c.ends_at,
       c.status
  FROM rental_contracts c
  JOIN bot_listings l ON l.id = c.listing_id
 WHERE l.owner_device_id = $1
   AND l.owner_entity_id = $2
   AND c.status IN ('reserved', 'active', 'suspended_insufficient_funds')
```

Note the **JOIN through bot_listings**. Contracts don't carry the slot key
directly; they carry `listing_id`. Slot equality is enforced via the listing.

### 4.2 Pro-rata penalty math (`rental.js:402-413`)

```
plannedMs = planned_duration_min × 60_000
remainingMs = max(0, ends_at − Date.now())
ratio = min(1, remainingMs / plannedMs)
penaltyMli = floor(deposit_mli × ratio)
```

**Reserved contracts** (never started — `status === 'reserved' || !started_at || !ends_at`)
get `penaltyMli = depositMli` directly. The rationale: the renter committed a
deposit and got 0 rental time before the rebind; full deposit's worth of
penalty is owed.

### 4.3 Two-step settlement

**Step 1** — `endRental({ contractId, endReason: 'ended_admin', requesterUserId: owner_user_id }, walletApi)`.
This is the existing rental termination path and runs through the normal
disposition matrix (`rental.md` §3): `ended_admin` returns 100% of the
renter's remaining `held_mli` to their balance. `requesterUserId = owner` so
the auth check inside `endRental` passes; the cascade itself is admin-initiated
upstream.

**Step 2** — owner-pays-renter pro-rata transfer, in its own
`walletApi.withTransaction`:

```
SELECT balance_mli, held_mli FROM wallets WHERE user_id = $owner FOR UPDATE
actualPenaltyMli = min(penaltyMli, ownerBalance)
shortfallMli = penaltyMli - actualPenaltyMli

if actualPenaltyMli > 0:
    applyLedgerEntry(owner,  -actualPenaltyMli, type=REFUND, idempotencyKey=`rebind-refund-debit:<contractId>`)
    applyLedgerEntry(renter, +actualPenaltyMli, type=REFUND, idempotencyKey=`rebind-refund-credit:<contractId>`)
```

### 4.4 Negative-balance clamp

`applyLedgerEntry` rejects negative `balance_mli`. If owner cannot cover the
full `penaltyMli`, the helper clamps to `min(penalty, available)` and writes
the residual as `shortfallMli` to a `serverLog` warn entry. Behaviour is
intentionally simple:

- Owner balance is **never** driven negative.
- Shortfall is **not** pursued — no debt collection, no async retry, no lien.
- The shortfall log is for audit only.

### 4.5 Idempotency

Each contract emits ledger entries with stable keys:

- `rebind-refund-debit:<contractId>` (owner debit leg)
- `rebind-refund-credit:<contractId>` (renter credit leg)

Plus the `endRental` keys (`rental-release:<contractId>` etc., see
`rental.md` §3). A second cascade pass over the same slot is a no-op:

1. The selection query no longer matches — contracts are now `ended_admin`.
2. Even if it did, the idempotency keys collide and `applyLedgerEntry` rejects
   the dupe before mutating wallets.

This is exercised by the `rental-rebind-cascade.test.js` "idempotency on
second run" case.

### 4.6 Per-contract error isolation

The for-loop in `terminateActiveContractsOnRebind` wraps each contract in its
own try/catch (`rental.js:399-479`). One bad row (corrupt deposit, stale
foreign key, transaction conflict) records an `{ contractId, error }` outcome
and lets the cascade continue. Rebind itself MUST NOT be blocked by rental
state — the slot has already changed identity in memory, so rolling back the
rebind on a contract failure would leave a worse inconsistency.

---

## 5. Test coverage

`backend/tests/jest/rental-rebind-cascade.test.js` (9 cases, all pass):

1. Empty slot returns `[]` (no contracts → no work).
2. Active contract → renter refund (100% held) + owner pro-rata penalty.
3. Reserved contract → `penaltyMli = depositMli` (full deposit).
4. Owner balance below penalty → clamp to balance, record `shortfallMli`.
5. Slot isolation — contracts on a different `(device, entity)` pair are
   untouched.
6. Already-ended contracts (`ended_normal` etc.) are skipped by the SELECT.
7. Idempotency on second run — second call is a no-op (no ledger dupes).
8. Missing `walletApi` → safe early return `[]`.
9. Invalid args (`null` deviceId, non-int entityId) → safe early return `[]`.

Plus the broader rental + wallet suites:

- `backend/tests/jest/rental*` — 271/271 pass (contract / listing /
  wallet-integration / proxy / marketplace / security)
- `backend/tests/jest/wallet*` — 84/84 pass (ledger / topup / ack-retry)

---

## 6. Why the design picks what it picks

**Why owner pays, not platform.** Hank's policy ruling. The owner is the
party who voluntarily rebound the slot. Platform-pays would convert every
owner mistake into a platform liability and incentivise no-cost owner churn.

**Why pro-rata, not flat.** A reserved contract that hasn't started yet
disrupts the renter more (relative to time committed) than a contract
3 minutes from natural end. Pro-rata captures that intuition without needing
a separate policy table.

**Why `ended_admin` not `ended_violation`.** `ended_admin` returns 100% of
remaining held to the renter (`rental.md` §3). `ended_violation` would forfeit
30% — but the renter did nothing wrong here. The pro-rata penalty is a
*separate* punitive transfer from owner; the renter's own deposit comes
back whole.

**Why error-swallow at the cascade boundary.** Rebind is the upstream truth
(slot identity already changed in `devices` map and DB). A failure in the
listing-pause or contract-terminate step cannot un-rebind. Best we can do is
log + continue — the alternative is a half-rebound slot that's much worse.

**Why JOIN through `bot_listings` not `rental_contracts.owner_*`.** Even
though `rental_contracts` carries `owner_user_id`, the *slot* identity lives
on `bot_listings`. A user can own multiple slots; the cascade must terminate
**only** contracts on the rebound slot, not all of the user's contracts.

---

## 7. Future hooks

Not yet implemented; track here so callers know what's coming:

- **Renter notification** — currently the renter learns of the termination
  by observing their balance and the ended contract row. A push to chat /
  fakechat ("您租用的 bot 因 owner 重綁已終止 — 押金已退還 + 補償 X e幣")
  would close the loop. Owner-side notification likewise.
- **Soft warning before rebind** — show owner the count of active contracts
  that would be terminated and the pro-rata penalty they'd owe before they
  confirm the rebind. Strictly preventive; the cascade itself stays the
  source of truth.
- **CI drift check** — every `entity.rebindCount = ...` site must be
  followed by `pauseRentalListingsOnRebind` + `terminateRentalContractsOnRebind`.
  A grep-based lint in CI would catch a future contributor adding a 9th
  rebind path that forgets the cascade.
