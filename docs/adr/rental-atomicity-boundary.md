# ADR: Rental rebind / refund / listing atomicity boundary

- **Status:** Proposed for #2 review
- **Date:** 2026-05-13
- **Owner:** Mac_F (#1)
- **Reviewer:** MAc_ClaudeAce / LOBSTER (#2)
- **Blocks:** rental rebind Phase 4 refund implementation, renter health degraded UX, listing soft-pause, official bot lifecycle cleanup
- **Related PR:** #2703 (`feat/rental): strict rebind cascade refunds`)

## Context

Rental rebind is financially sensitive. When an owner rebinds an entity slot, the renter may suddenly be connected to a different bot than the one they rented. Hank's policy answer for the rental mother card is: **owner eats the loss**. The system must terminate affected active rentals and refund the renter from the owner's wallet with second-granular precision.

This ADR locks the atomicity boundary and audit semantics before dependent cards implement divergent assumptions.

## 1. Rebind cascade transaction boundary

`POST /api/entity/rebind` must treat the rental refund cascade as an all-or-nothing financial operation for eligible active rentals on the rebound owner slot.

Implementation boundary:

1. Resolve the rebound slot `(owner_device_id, owner_entity_id)`.
2. Start one database transaction through the wallet mutation layer (`walletApi.withTransaction` or equivalent).
3. Read a single DB clock value with PostgreSQL `NOW()` / SQL expressions; app server `Date.now()` is forbidden for refund math.
4. Select eligible contracts with `SELECT ... FOR UPDATE`.
5. Lock participating owner/renter wallet rows in deterministic order.
6. Calculate all refunds before mutating any contract or wallet.
7. Preflight owner wallet balance for the full refund sum.
8. If the owner cannot cover the total, reject the rebind and roll back the whole transaction.
9. If preflight passes, write wallet ledger rows, update contract status, and write rental audit rows inside the same transaction.

Eligible contracts for Phase 4 are **only** `rental_contracts.status = 'active'`.

Non-active contracts (`reserved`, `suspended_insufficient_funds`, terminal `ended_*`, `terminated_by_rebind`) are skipped by the strict refund cascade. They may be handled by separate cleanup cards, but they must not receive owner-paid rebind refunds in Phase 4.

## 2. Owner wallet insufficient funds policy

Owner wallet insufficiency is fail-closed.

- If `owner.balance_mli < sum(refund_mli)` for all eligible contracts, the rebind request fails.
- The API should return a 4xx error (recommended symbolic error: `owner_insufficient_balance_for_rebind_refund`).
- No rental status changes, wallet ledger rows, deposit releases, or audit rows may persist.
- No partial refund, clamping, or best-effort continuation is allowed.

Rationale: clamped refunds silently shift the loss back to renters and makes audit reconciliation ambiguous.

## 3. Audit schema ownership

Wallet audit source of truth is the existing append-only `wallet_ledger` table.

Do **not** add a duplicate `wallet_audit_log` for the same wallet movement unless a later ADR explicitly changes wallet architecture. Duplicate wallet audit tables create dual-write divergence risk.

Rental-domain audit should be captured separately because `wallet_ledger` cannot explain the rental-specific refund calculation. Add/use `rental_rebind_audit_log` with at least:

```sql
contract_id
listing_id
owner_device_id
owner_entity_id
owner_user_id
renter_user_id
status_from
status_to -- 'terminated_by_rebind'
deposit_mli
deposit_release_mli
refund_mli
remaining_sec
total_duration_sec
wallet_release_idempotency_key
wallet_debit_idempotency_key
wallet_credit_idempotency_key
created_at
```

The rental audit row links the contract, slot, calculation basis, and wallet ledger idempotency keys.

## 4. Idempotency key and retry semantics

Every wallet ledger mutation must use a deterministic idempotency key scoped to the contract and operation, for example:

- `rebind-deposit-release:<contractId>`
- `rebind-refund-debit:<contractId>`
- `rebind-refund-credit:<contractId>`

A second rebind cascade after the first commit should see no `active` contracts and return an empty result without duplicating wallet/audit writes.

If API-level idempotency is added to `POST /api/entity/rebind`, use a request `idempotencyKey` with a server-side 24h retention table/cache. That API key is additive; it does not replace wallet-ledger idempotency.

Concurrent rebind requests must be serialized by row locks. Acceptable outcomes:

- one request commits and the other sees no active contracts, or
- one request commits and the other returns 409/retry depending on the API wrapper.

Both outcomes must avoid duplicate refunds.

## 5. Second-granular rounding rule

Refund formula:

```text
remaining_sec = max(0, floor(extract(epoch from (ends_at - db_now))))
remaining_sec = min(remaining_sec, total_duration_sec)
refund_mli = floor(deposit_mli * remaining_sec / total_duration_sec)
```

Rules:

- `total_duration_sec` is a stable denominator stored on the contract at creation time.
- Backfill existing rows from `planned_duration_min * 60` when no better historical source exists.
- If `ends_at <= db_now`, refund is `0`, but the active contract is still terminated.
- If `deposit_mli = 0`, refund is `0`, but the active contract is still terminated.
- Use integer mli (`BIGINT`) arithmetic and floor the result.

## 6. Clock source

Refund math must use the database clock, not app server time.

Preferred SQL pattern:

```sql
GREATEST(0::bigint, COALESCE(FLOOR(EXTRACT(EPOCH FROM (c.ends_at - NOW())))::bigint, 0)) AS remaining_sec
```

Rationale: in a multi-replica/serverless deployment, app server clocks can drift and produce inconsistent refunds. DB clock keeps the contract read, lock, and calculation in one deterministic transaction context.

## 7. Listing soft-pause and rental state source

Listing soft-pause is not part of the rebind refund transaction.

- Soft-pause writes only listing-level state such as `bot_listings.soft_pause_until` / listing status metadata.
- New rental creation must read the listing soft-pause state and reject new rentals while paused.
- Existing active rentals are not terminated by soft-pause.
- Existing active rentals are terminated only by explicit rebind cascade / rental lifecycle flows.

This separation prevents a health-degraded listing UX from accidentally mutating financial rental state.

## Consequences

- Phase 4 implementation must prefer one strict transaction over the previous per-contract best-effort helper.
- Financial correctness beats rebind convenience: owner insufficient funds blocks the rebind/refund cascade until resolved.
- `wallet_ledger` remains canonical for wallet balances; rental audit stores the calculation narrative.
- Dependent cards should reference this ADR instead of redefining refund/listing atomicity semantics.

## Open review points for #2

1. Should API wrapper return `400` vs `409` on owner insufficient funds?
2. Should API-level request idempotency be implemented now, or is wallet-ledger idempotency + row locks sufficient for Phase 4?
3. Should `total_duration_sec` become `NOT NULL` after backfill, or remain nullable for safer rollout?
