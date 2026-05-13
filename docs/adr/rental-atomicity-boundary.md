# ADR: Rental rebind / refund / listing atomicity boundary

- **Status:** Locked for implementation review
- **Date:** 2026-05-13
- **Owner:** Mac_F (#1)
- **Reviewer:** LOBSTER (#2)
- **Parent:** `card_3ca7b8d8` rental mother card §4 + §9 Q1
- **Blocks:**
  - `card_84c13b91f46439cb30a9d94b` — Rebind cascade Phase 4: second-granular refund + atomic transaction + audit log
  - `card_59f88da531f04361765a0375` — Renter health warning / degraded terminology
  - `card_4bcbb14d854bec7bce14fd71` — Listing soft-pause for degraded bot listings
  - `card_97b53d0a5baccc704b44583f` — Roster rental admin manual rebind UI
- **Related implementation PR:** #2703 (`feat/rental): strict rebind cascade refunds`)

## Context

Rental rebind is financially sensitive. If an owner rebinds an entity slot while rentals are still active, renters may lose access to the exact bot they paid for. The project policy is **owner eats the loss**: the renter gets a deterministic refund for the remaining time, and the owner wallet funds it.

This ADR locks the atomicity boundary, refund math, audit schema, idempotency, clock source, and listing soft-pause separation before dependent implementation cards proceed. Where an existing implementation differs from this ADR, the implementation must be amended to match this ADR after #2 review/merge.

## 1. Wallet ledger / refund transaction boundary

Refund is a single financial transaction. For each affected active rental, the owner wallet debit, renter wallet credit, rental status mutation, and audit rows must commit or roll back together.

Decision: use a **single PostgreSQL transaction**, not a saga.

Rationale:

- The operation is small and bounded: one owner wallet, one or more renter wallets, affected active rentals, and audit rows.
- There is no long-running external step that would justify a saga.
- Financial correctness is more important than partial progress.

Required transaction shape:

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;

-- Rebind idempotency / request result row is created or locked first.
-- DB clock is captured from PostgreSQL, not the app server.
SELECT now() AS db_now;

-- Lock affected active rentals for the rebound entity slot.
SELECT *
FROM rentals
WHERE owner_entity_id = $1
  AND status = 'active'
FOR UPDATE;

-- Lock all participating wallets in deterministic order.
SELECT *
FROM wallets
WHERE entity_id = ANY($wallet_entity_ids)
ORDER BY entity_id
FOR UPDATE;

-- Calculate refunds, preflight owner balance, mutate wallets/rentals, write audit.

COMMIT;
```

Owner wallet insufficiency policy:

- If the owner wallet cannot cover the **full** refund amount, reject the entire rebind.
- Do **not** partially refund.
- Do **not** clamp refunds to owner balance.
- Do **not** continue the rebind and leave rentals active.

The rejection is part of the same transaction and leaves no wallet, rental, entity-binding, or audit mutation behind.

Transaction isolation level: **SERIALIZABLE**.

Rationale: this is a financial boundary. `READ COMMITTED` can be sufficient with careful row locks, but `SERIALIZABLE` gives the safest retryable semantics for concurrent rebind/refund attempts and prevents subtle phantoms around newly matching active rentals.

## 2. Rental binding state mutation boundary

The rebind cascade has three distinct state domains:

1. Entity binding state — which bot brain is bound to the owner entity slot.
2. Rental state — active rentals on that owner entity slot.
3. Listing health/soft-pause state — whether new rentals may be created for a degraded listing.

Decisions:

- `rentals.status = 'active' → 'terminated_by_rebind'` is in the **same transaction** as wallet debit/credit.
- Entity rebind is in the **same transaction** as the rental cascade.
- `listing.soft_pause_until` is **not** in the rebind transaction.

The entity rebind and rental termination must be atomic to avoid an invalid intermediate state:

- Bad: entity is rebound, but rentals still show `active` for the old bot.
- Bad: rentals are terminated/refunded, but entity rebind failed.
- Good: entity rebind + rental termination + wallet refund + audit commit together.

Listing soft-pause is intentionally outside this boundary because it is triggered by health degradation, not by owner rebind. It must use an independent transaction and must not mutate existing active rentals.

## 3. Audit event schema

All rows produced by a single rebind cascade share one UUIDv4 `audit_event_id`. The API entry point generates this UUID once and passes it through every wallet and rental audit write.

### Wallet audit log

Create an explicit wallet audit log for user-visible financial audit and reconciliation:

```sql
CREATE TABLE wallet_audit_log (
  id BIGSERIAL PRIMARY KEY,
  entity_id INT NOT NULL,
  delta_amount NUMERIC(12,4) NOT NULL,
  balance_after NUMERIC(12,4) NOT NULL,
  reason VARCHAR(64) NOT NULL,
  related_rental_id VARCHAR(40),
  related_event_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wallet_audit_log_entity_created
  ON wallet_audit_log(entity_id, created_at DESC);

CREATE INDEX idx_wallet_audit_log_related_event
  ON wallet_audit_log(related_event_id);
```

Required wallet audit semantics:

- Owner debit row: `delta_amount < 0`, `reason = 'rebind_refund'`.
- Renter credit row: `delta_amount > 0`, `reason = 'rebind_refund'`.
- `balance_after` is captured after the wallet mutation inside the same transaction.
- `related_rental_id` points to the terminated rental.
- `related_event_id` is the shared cascade UUID.

If the codebase also has a lower-level ledger table, that table may remain the balance source of truth, but `wallet_audit_log` is the locked audit surface required by this ADR.

### Rental audit log additions

Extend rental audit with refund calculation fields:

```sql
ALTER TABLE rental_audit_log
  ADD COLUMN refund_seconds_remaining INT,
  ADD COLUMN refund_amount NUMERIC(12,4),
  ADD COLUMN refund_basis VARCHAR(32),
  ADD COLUMN audit_event_id UUID;

CREATE INDEX idx_rental_audit_log_audit_event
  ON rental_audit_log(audit_event_id);
```

Required rental audit semantics:

- `refund_seconds_remaining`: remaining seconds at DB clock time, clamped to `[0, total_duration_sec]`.
- `refund_amount`: final 4-decimal amount credited to renter and debited from owner.
- `refund_basis`: one of `per_second`, `per_day`, or `flat`; rebind refund uses `per_second`.
- `audit_event_id`: same UUID as all related wallet audit rows.

## 4. Idempotency key and retry semantics

`POST /api/entity/rebind` accepts an `idempotencyKey: UUID` in the request body.

Server-side behavior:

- Store the key in a DB-backed idempotency table or Redis with 24h retention.
- Recommended DB table when Redis is unavailable:

```sql
CREATE TABLE entity_rebind_idempotency_keys (
  idempotency_key UUID PRIMARY KEY,
  device_id UUID NOT NULL,
  entity_id INT NOT NULL,
  request_hash TEXT NOT NULL,
  audit_event_id UUID NOT NULL,
  response_status INT,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_entity_rebind_idempotency_expires
  ON entity_rebind_idempotency_keys(expires_at);
```

Retry semantics:

- Same key + same request body within 24h returns the first-attempt result.
- Same key + different request body returns `409 idempotency_key_conflict`.
- A completed successful attempt must not execute the cascade again.
- A completed rejected attempt, including owner insufficient funds, returns the same rejection without recomputing.
- If the first attempt is still in progress, return `409 idempotency_in_progress` or block on the idempotency row lock, depending on API convention.

DB concurrency protection:

- Insert or lock the idempotency row before mutation.
- Lock all matching active rentals with `SELECT ... FOR UPDATE`.
- Lock participating wallet rows with `SELECT ... FOR UPDATE` in deterministic order.
- Use `SERIALIZABLE` isolation so concurrent inserts/updates that would affect the active-rental set fail as retryable serialization conflicts rather than producing duplicate refunds.

## 5. Second-granular rounding rule

Refund calculation uses seconds, not days or minutes.

Formula:

```text
remaining_sec = max(0, endsAt_unix_seconds - now_unix_seconds)
remaining_sec = min(remaining_sec, totalDurationSec)
refund_amount_raw = remaining_sec / totalDurationSec * rental.price
refund_amount = FLOOR(refund_amount_raw to 4 decimal places)
```

SQL-oriented expression:

```sql
remaining_sec = GREATEST(
  0,
  EXTRACT(EPOCH FROM (ends_at - db_now))::INT
);

refund_amount = FLOOR(
  (
    (remaining_sec::NUMERIC(20,10) / NULLIF(total_duration_sec, 0)::NUMERIC(20,10))
    * rental_price::NUMERIC(20,10)
  ) * 10000
) / 10000;
```

Rules:

- Compute with `NUMERIC(20,10)` precision.
- Store final refund as `NUMERIC(12,4)`.
- Rounding direction is **FLOOR**.
- FLOOR is intentionally owner-favorable by at most `0.0001` unit and avoids over-refunding in financial disputes where owner rebind is treated as an unintentional owner-side interruption.
- If `ends_at < db_now`, refund is `0`.
- Even when refund is `0`, active rental status still updates to `terminated_by_rebind` during the rebind cascade.
- If `total_duration_sec <= 0` or is missing for a row that requires refund math, reject and roll back rather than guessing.

## 6. Clock source

Refund math uses **PostgreSQL `now()`** as the only clock source.

The application server clock is forbidden for refund calculation.

Rationale:

- Multi-replica/serverless app servers can drift by seconds.
- Seconds directly affect refund amount.
- DB `now()` keeps the rental read, lock, calculation, wallet mutation, and audit record in one deterministic transaction context.

Migration / creation rule:

```sql
total_duration_sec = EXTRACT(EPOCH FROM (ends_at - starts_at))::INT
```

Use the same DB-side expression when creating or backfilling `total_duration_sec`; do not calculate the denominator with application time.

## 7. Listing soft-pause reads which rental state

Listing soft-pause is driven by renter health degradation, not rental rebind.

Decisions:

- Soft-pause trigger: renter health degraded continuously for 1 hour, defined by the renter-health sub-card.
- Soft-pause action writes listing state only, for example `listing.soft_pause_until`.
- Soft-pause does **not** scan or mutate `rentals`.
- Existing active rentals continue unchanged when a listing is soft-paused.
- `POST /api/rental/create` reads `listing.soft_pause_until` during new-order creation and rejects new rentals while the listing is paused.
- Existing active rentals are terminated only by explicit rebind cascade or other rental lifecycle flows, not by soft-pause.

This separation prevents Q4 health-degraded state from accidentally becoming a financial termination source.

## Consequences

- Rebind cascade Phase 4 must implement one strict transaction, not best-effort per-rental mutation.
- Owner insufficient balance blocks the entire rebind/refund cascade.
- All refund-related wallet and rental audit rows share one UUID `audit_event_id`.
- Dependent cards must reference this ADR for transaction, audit, idempotency, rounding, DB clock, and soft-pause semantics.
- Any existing implementation that uses different audit table names or idempotency timing must be amended to match this ADR after review.
