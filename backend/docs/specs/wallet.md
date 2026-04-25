# wallet — e-coin balance, ledger, and top-up

**Source:** `backend/wallet.js`, `backend/wallet_schema.sql`
**Mounted at:** `/api/wallet`
**Callers (cross-module):** `backend/rental.js`, `backend/rental-proxy.js`, `backend/invite.js`, `backend/subscription.js`

The wallet is the e-coin spine: every monetary mutation in EClaw flows
through `applyLedgerEntry` and lands in the append-only `wallet_ledger`
table. This spec captures the unit system, the ledger type matrix, the
balance/held invariants, the idempotency contract, and the special
accounts. Constants are cited **by name + value** so a grep against this
doc and a grep against the code lead to the same line.

---

## 1. Units & constants

| Name | Value | Defined at | Meaning |
|------|-------|------------|---------|
| `ECOIN_TO_MLI` | `1000` | `wallet.js:39` | 1 e幣 = 1000 厘 (mli) |
| `USD_TO_MLI` | `3_000_000` | `wallet.js:36` | 1 USD → 3,000 e幣 |
| Exchange rate | 1 TWD = 100 e幣 = 100,000 厘 | `wallet_schema.sql:13` | hard-coded, no FX feed |
| `PLATFORM_FEE_BPS` | `1500` | `wallet.js:42` | platform commission = 15% |
| `INSURANCE_POOL_BPS` | `200` | `wallet.js:45` | of the 15% above, 2% goes to insurance |
| `PLATFORM_WALLET_USER_ID` | `00000000-0000-0000-0000-000000000001` | `wallet.js:48` | virtual user receiving 13% net platform fee |
| `INSURANCE_POOL_USER_ID` | `00000000-0000-0000-0000-000000000002` | `wallet.js:49` | virtual user receiving 2% insurance |
| `GOOGLE_PACKAGE_NAME` | env `GOOGLE_PLAY_PACKAGE` or `'com.hank.clawlive'` | `wallet.js:52` | androidpublisher v3 package name |
| `GOOGLE_TOKEN_CACHE_MS` | `55 × 60 × 1000` (55 min) | `wallet.js:54` | OAuth access-token cache TTL (under Google's 3600s) |

**Mli, not e幣, is the canonical unit.** Every column, every API
parameter, every ledger row is in mli. `mliToEcoin(mli)` is for display
only — never store the converted value.

There is **no `MIN_TOPUP`** and **no `MAX_BALANCE`** constant. The floor
is implicit in the smallest topup tier (`ec.topup.small` = 1 USD = 3,000
e幣). The ceiling is `BIGINT` overflow at the SQL layer; no application
ceiling is enforced.

---

## 2. Top-up tier catalog (`TOPUP_TIERS`, `wallet.js:89-115`)

`Object.freeze`'d at module load — pricing changes require a code change
+ deploy.

| Product ID | Price (USD) | Base e幣 | Bonus | Total e幣 | Bonus % |
|------------|------------:|--------:|------:|----------:|--------:|
| `ec.topup.small` | 1 | 3,000 | 0 | 3,000 | 0% |
| `ec.topup.starter` | 3 | 9,000 | 450 | 9,450 | +5% |
| `ec.topup.standard` | 5 | 15,000 | 1,200 | 16,200 | +8% |
| `ec.topup.advanced` | 10 | 30,000 | 3,600 | 33,600 | +12% |
| `ec.topup.premium` | 20 | 60,000 | 9,000 | 69,000 | +15% |

The same product IDs are wired to Google Play (Android Path B) and
Apple IAP (iOS); the tier catalog is the single source of truth for
both verifiers.

---

## 3. Ledger type matrix (`LEDGER_TYPES`, `wallet.js:66-80`)

Every value here is one of the 13 enum strings stored in
`wallet_ledger.type`. Schema mirror at `wallet_schema.sql:51-54`. **Adding
a value requires touching both files in the same PR** + this matrix.

| Ledger type | Const | Caller | balance Δ | held Δ | Idempotency-key prefix | Notes |
|-------------|-------|--------|----------:|-------:|------------------------|-------|
| `topup` | `TOPUP` | `wallet.js` `markTopupPaid` (`:622`), `creditTopup` (`:406`) | + | 0 | `topup:<orderId>` (`wallet.js:649`) | credited only after Google/Apple verify |
| `subscription_grant` | `SUBSCRIPTION_GRANT` | `wallet.js` `grantSubscriptionEcoin` (`:426`) | + | 0 | `sub-grant:<userId>:<planId>:<YYYY-MM>` (`wallet.js:429`) | one grant per user per plan per month |
| `signup_bonus` | `SIGNUP_BONUS` | (reserved — no current caller) | + | 0 | (caller-defined) | enum present for future use |
| `referral_bonus` | `REFERRAL_BONUS` | `invite.js:178,186` (inviter + invitee legs) | + | 0 | `invite-inviter:<code>:<inviteeUserId>:<ts>`, `invite-invitee:<code>:<inviteeUserId>:<ts>` | two ledger rows per successful invite |
| `deposit_hold` | `DEPOSIT_HOLD` | `wallet.js` `holdDeposit` (`:500`) — used by `rental.js:734` | − | + | `rental-hold:<contractId>` | renter freezes deposit on rental start |
| `deposit_release` | `DEPOSIT_RELEASE` | `wallet.js` `releaseDeposit` (`:518`) — used by `rental.js:837` | + | − | `rental-release:<contractId>` | full or partial refund on rental end |
| `deposit_forfeit` | `DEPOSIT_FORFEIT` | `wallet.js` `forfeitDeposit` (`:538`) — used by `rental.js:853` | 0 | − | `rental-forfeit:<contractId>` | held leaves renter; counterparty credits are separate ledger rows |
| `rental_income` | `RENTAL_INCOME` | `rental-proxy.js:234` (token metering, post-fee net) | + | 0 | `rental-usage:<contractId>:<msgId>:income` | owner receives net of token charge; written to `pending_income_mli` (T+24h hold) |
| `rental_spend` | `RENTAL_SPEND` | `rental-proxy.js:187` (token metering, renter side) | − | 0 | `rental-usage:<contractId>:<msgId>:spend`, `:dep-deduct` for held leg | renter is debited per token chunk |
| `platform_fee` | `PLATFORM_FEE` | `rental-proxy.js:246` (15% per token charge) + `rental.js:880` (forfeit-pfee) | + (to platform pool) | 0 | `rental-usage:<contractId>:<msgId>:pfee`, `rental-forfeit-pfee:<contractId>` | gross fee includes the 2% insurance share |
| `refund` | `REFUND` | (reserved — used by tests + admin paths) | + | 0 | (caller-defined) | distinct from `deposit_release`; explicit refund of paid topups |
| `admin_adjust` | `ADMIN_ADJUST` | `wallet.js` `adminAdjust` (`:556`) — `/api/wallet/admin/grant` | ± | 0 | `admin-grant:<adminId>:<ts>:<rand>` (`wallet.js:1472`) | always audited via `serverLog warn` |
| `withdraw` | `WITHDRAW` | (reserved — no current caller) | − | 0 | (caller-defined) | bank/payment-processor withdraw, not yet wired |

**Forfeit's three counterparty legs** (the rental-end "violation" path,
`rental.js:856-895`) are written as separate ledger rows on the platform
+ insurance + owner-income wallets:

| Counterparty | Ledger type | Idempotency-key | Driven by |
|--------------|-------------|-----------------|-----------|
| renter | `deposit_forfeit` | `rental-forfeit:<contractId>` | held −forfeit |
| owner | `rental_income` | `rental-forfeit-income:<contractId>` | balance +85% × forfeit |
| platform pool | `platform_fee` | `rental-forfeit-pfee:<contractId>` | balance +13% (net of insurance) |
| insurance pool | `platform_fee` | `rental-forfeit-ins:<contractId>` | balance +2% |

Five distinct idempotency keys per `endRental` call → one duplicate retry
yields zero net mutation across all five rows.

**Rebind cascade refund** (`rental.js:450-461`, Phase 4 of the rebind
cascade — `rental-rebind-cascade.md`):

| Leg | Ledger type | Idempotency-key |
|-----|-------------|-----------------|
| owner debit (pro-rata penalty) | `admin_adjust` | `rebind-refund-debit:<contractId>` |
| renter credit (matching) | `admin_adjust` | `rebind-refund-credit:<contractId>` |

---

## 4. Balance / held invariants (`applyLedgerEntry`, `wallet.js:281-374`)

Every successful ledger write upholds these invariants. They are enforced
twice — application logic in `applyLedgerEntry`, and DB `CHECK`
constraints (`wallet_schema.sql:32-33`) as defence-in-depth.

1. **`balance_mli >= 0`** at all times. `applyLedgerEntry` throws
   `insufficient_balance` (`wallet.js:328`) before writing; CHECK
   constraint catches any code path that bypasses the helper.
2. **`held_mli >= 0`** at all times. Throws `insufficient_held`
   (`wallet.js:329`); CHECK constraint mirrors.
3. **`held_mli` only mutates via `deposit_hold` / `deposit_release` /
   `deposit_forfeit`** — every other ledger type passes `heldDelta: 0`.
   Grep `held_mli` outside these three sites and you should find only
   reads / reconciliation.
4. **`pending_income_mli` is NOT in the ledger.** Rental income lives in
   the dedicated column for T+24h settlement (`wallet_schema.sql:42-44`,
   `rental-proxy.js:221`); the `income-release` daily cron sweeps it into
   `balance_mli` via `applyLedgerEntry({ type: 'rental_income',
   idempotencyKey: 'income-release:<userId>:<ts>' })` (`rental-proxy.js:425`).
5. **Wallet row is locked `FOR UPDATE`** inside the same transaction
   (`wallet.js:316-320`). All cross-module callers (`rental.js`,
   `rental-proxy.js`) use `withTransaction` from this module so the lock
   covers the whole business operation, not just the ledger insert.
6. **Lifetime counters are monotonic.** `lifetime_earned_mli` increases
   only on positive `balanceDelta`; `lifetime_spent_mli` increases only on
   negative. They are never decreased (`wallet.js:332-333,339-340`).
7. **No direct UPDATE to `wallets` outside `applyLedgerEntry`**, with one
   sanctioned exception: `pending_income_mli` mutations in
   `rental-proxy.js:221,413` (which are still bracketed by
   `applyLedgerEntry` calls for the moves into and out of the bucket).
   Adding any other direct write is a bug.

`reconcileBalances` (`wallet.js:695-728`) verifies invariants 1-2 + 6 by
re-summing the ledger and comparing to the cached aggregates. Empty
discrepancy list = invariants hold. The admin endpoint
`GET /api/wallet/admin/reconcile` runs this on demand; any drift logs
`serverLog error wallet "reconcile FAIL"` (`wallet.js:1456`).

---

## 5. Idempotency contract

The single load-bearing rule of the wallet:

> **Every `applyLedgerEntry` call MUST supply an `idempotencyKey`.**
> `wallet_ledger.idempotency_key` is `UNIQUE NOT NULL`
> (`wallet_schema.sql:67`). A duplicate key returns the existing row
> with `deduped: true` and **does not mutate** the wallet
> (`wallet.js:301-311`).

This means every caller can retry safely after a network blip, a
container restart, or a duplicate webhook.

### 5.1 Key length & shape

`assertIdempotencyKey` (`wallet.js:158-162`) requires `4 ≤ length ≤ 128`.
Convention: `<scope>:<id>[:<leg>]`, lower-snake, colon-separated.

### 5.2 Prefix registry

| Prefix | Owner | Shape | Notes |
|--------|-------|-------|-------|
| `topup:` | wallet.js | `topup:<orderId>` | one row per topup_order |
| `sub-grant:` | wallet.js | `sub-grant:<userId>:<planId>:<YYYY-MM>` | one grant per user/plan/month |
| `admin-grant:` | wallet.js | `admin-grant:<adminId>:<ts>:<rand>` | random suffix because admin can repeat-grant |
| `rental-hold:` | rental.js | `rental-hold:<contractId>` | one hold per contract |
| `rental-release:` | rental.js | `rental-release:<contractId>` | one release per contract |
| `rental-forfeit:` | rental.js | `rental-forfeit:<contractId>` | renter held debit |
| `rental-forfeit-income:` | rental.js | `rental-forfeit-income:<contractId>` | owner credit (85%) |
| `rental-forfeit-pfee:` | rental.js | `rental-forfeit-pfee:<contractId>` | platform fee (13%) |
| `rental-forfeit-ins:` | rental.js | `rental-forfeit-ins:<contractId>` | insurance pool (2%) |
| `rebind-refund-debit:` | rental.js | `rebind-refund-debit:<contractId>` | owner debit (Phase 4) |
| `rebind-refund-credit:` | rental.js | `rebind-refund-credit:<contractId>` | renter credit (Phase 4) |
| `rental-usage:<contractId>:<msgId>:spend` | rental-proxy.js (`:153,:187`) | per token charge | renter debit; `<msgId>` = caller-supplied messageId or `Date.now()` |
| `rental-usage:<contractId>:<msgId>:dep-deduct` | rental-proxy.js (`:210`) | per token charge | held debit (when balance exhausts) |
| `rental-usage:<contractId>:<msgId>:income` | rental-proxy.js (`:234`) | per token charge | owner pending_income credit |
| `rental-usage:<contractId>:<msgId>:pfee` | rental-proxy.js (`:246`) | per token charge | platform fee leg |
| `rental-usage:<contractId>:<msgId>:ins` | rental-proxy.js (`:260`) | per token charge | insurance pool leg |
| `income-release:<userId>:<ts>` | rental-proxy.js | per sweep run | T+24h pending_income release |
| `invite-inviter:<code>:<inviteeUserId>:<ts>` | invite.js | inviter bonus | |
| `invite-invitee:<code>:<inviteeUserId>:<ts>` | invite.js | invitee bonus | |
| `<base>:debit` / `<base>:credit` | wallet.js `transferEcoin` | derived from caller's `idempotencyKey` (`wallet.js:479,490`) | both legs share the caller's base key |

When adding a new ledger writer, register its prefix here in the same PR.
Picking a prefix that collides with an existing scope is a correctness
bug (silent dedupe).

---

## 6. Topup-order lifecycle (`topup_orders` table)

| Column | Type | Invariant | Notes |
|--------|------|-----------|-------|
| `id` | UUID | PK, `gen_random_uuid()` | distinct from external_txn_id |
| `user_id` | UUID | FK `user_accounts ON DELETE CASCADE` | wallet credit lands here |
| `channel` | VARCHAR(32) | one of `google_play`, `apple_iap`, `admin_grant`, `invite_bonus`, `signup_bonus` (`wallet_schema.sql:82`) | |
| `amount_twd` | INTEGER | `>= 0` | misnamed (actually USD per `priceUsd` field); column kept for backward compat |
| `ecoin_base_mli` | BIGINT | `>= 0` | tier base |
| `ecoin_bonus_mli` | BIGINT | `>= 0`, default 0 | tier bonus |
| `ecoin_total_mli` | BIGINT | `>= 0`, = base + bonus | what gets credited |
| `status` | VARCHAR(32) | one of `pending`, `paid`, `failed`, `refunded` (`wallet_schema.sql:84`) | `paid` means ledger row exists |
| `external_txn_id` | VARCHAR(255) | UNIQUE per `(channel, external_txn_id)` when not null (`wallet_schema.sql:105-107`) | Google `orderId` preferred over raw token |
| `external_raw` | JSONB | full provider response | source of truth for ack-retry |
| `ack_state` | VARCHAR(16) | `pending` / `acked` / `failed` (`wallet_schema.sql:118-121`) | google_play only |
| `ack_attempts` | INTEGER | monotonic | 3 strikes → `failed` |
| `ack_at` | TIMESTAMPTZ | NULL until acked | |

### 6.1 Google Play verify-and-ack flow (`wallet.js:1114-1314`)

1. `verify-google` resolves `userId` (device-secret OR JWT).
2. Calls `verifyGooglePurchase` against androidpublisher v3.
3. Inserts a `topup_orders` row via `createTopupOrder`
   (deduped on `(channel, external_txn_id)`).
4. Calls `markTopupPaid` → ledger row + `status='paid'`.
5. Fire-and-forget `:acknowledge` → updates `ack_state`/`ack_attempts`.
6. `ack-retry-sweep.js` (hourly cron) retries `ack_state='pending'`
   rows up to 3 times before moving to `'failed'`.

**Why fire-and-forget:** ack failure must NOT revoke the user's e-coin
(`wallet.js:976-980`). Google auto-refunds after 72h of no-ack, which
becomes a wallet drift the sweep is responsible for catching. Hank's
explicit choice; do not "fix" by adding a synchronous ack.

### 6.2 Fail-closed verification (`wallet.js:759-768`)

Without `GOOGLE_PLAY_SERVICE_ACCOUNT` properly loaded, `/topup/verify-google`
returns 500 `purchase_not_verified` rather than silently crediting
unverified tokens. The escape hatch is `GOOGLE_PLAY_ALLOW_UNVERIFIED=1`,
which is audited via `serverLog warn` (`wallet.js:1172`) — only intended
for emergency rollback.

### 6.3 Apple IAP verify (`wallet.js:1326-1442`)

Mirrors Google's flow but uses Apple's `/verifyReceipt` (prod → sandbox
21007 retry, `wallet.js:1346-1348`). Bundle-ID double-check against
`APPLE_BUNDLE_ID` (default `com.eclawbot.app`). No ack call (Apple is
ack-on-receipt-fetch).

---

## 7. Special accounts

| Account | UUID | Purpose | Seeded at |
|---------|------|---------|-----------|
| Platform fee pool | `00000000-0000-0000-0000-000000000001` | receives 13% net of every rental token charge + every forfeit | `wallet.js:207-218` (auto-seed in `initWalletDatabase`) |
| Insurance pool | `00000000-0000-0000-0000-000000000002` | receives 2% (of the 15% gross) for dispute / refund coverage | `wallet.js:209` |

Both are seeded as virtual user_accounts rows with `password_hash =
'SYSTEM_NO_LOGIN'` and `device_secret = 'SYSTEM_NO_LOGIN'` so the
foreign key on `wallets.user_id` is satisfied without exposing a login
path. **Never grant either account a real device_secret** — they must
remain unauthenticatable.

There is no "borrow shadow" wallet account in the current design; borrow
flow ledger entries land on the borrower's own wallet (see
official-bind spec, future).

---

## 8. Endpoint surface

| Method | Path | Auth | Defined at | Purpose |
|--------|------|------|------------|---------|
| GET | `/api/wallet/balance` | JWT | `wallet.js:1044` | balance + held + lifetime |
| GET | `/api/wallet/history` | JWT | `wallet.js:1050` | ledger rows, optional `?type=` filter |
| GET | `/api/wallet/topup/tiers` | public | `wallet.js:1057` | tier catalog (no secrets) |
| GET | `/api/wallet/topup/diag` | device-secret | `wallet.js:1074` | gated diagnostic for Path B; never exposes private_key |
| POST | `/api/wallet/topup/verify-google` | device-secret OR JWT | `wallet.js:1114` | Path B verification + credit |
| POST | `/api/wallet/topup/verify-apple` | JWT | `wallet.js:1363` | iOS IAP verification + credit |
| GET | `/api/wallet/admin/reconcile` | JWT + admin | `wallet.js:1452` | run `reconcileBalances` |
| POST | `/api/wallet/admin/grant` | JWT + admin | `wallet.js:1463` | manual e-coin grant; always audited |

---

## 9. What this doc deliberately does NOT cover

- **Rental token metering math** — see `rental-proxy.js` and the future
  `rental-proxy.md`; this spec only documents the ledger types it writes.
- **Rental refund disposition matrix** — see `rental.md §3` (this spec
  documents the ledger types, that spec documents the refund split).
- **Subscription plan catalog** — see `backend/subscription.js`; this
  spec only references the `subscription_grant` ledger type.
- **Invite bonus amounts / cap** — see `backend/invite.js`; this spec
  only documents the prefix `invite-inviter:` / `invite-invitee:`.
- **Bot rental income tax / withdrawal flow** — `withdraw` enum is
  reserved but no caller is wired yet. File a card before adding one.
- **Currency conversion at top-up** — fixed 1 USD = 3,000,000 mli, no FX
  feed. Adding tiered FX is a tier-catalog change, not a wallet change.

---

## 10. Update discipline

- New `LEDGER_TYPES` value → update §3 matrix + `wallet_schema.sql:51-54`
  comment + this file in the same PR.
- New idempotency-key prefix → register in §5.2 in the same PR. Picking
  a colliding prefix is a silent-dedupe correctness bug.
- New endpoint under `/api/wallet` → update §8.
- Tier catalog change → update §2 + the IAP product list in Play Console
  / App Store Connect.
- Schema column add/remove → update §6 (for `topup_orders`) or §4 (for
  `wallets`).
- New direct-write site to `wallets` outside `applyLedgerEntry` → STOP
  and re-read invariant 7 in §4. The only sanctioned direct write is
  `pending_income_mli`; anything else needs a policy doc here first.
- `PLATFORM_WALLET_USER_ID` / `INSURANCE_POOL_USER_ID` rotation → no
  rotation tooling exists; rotating either UUID would orphan every
  ledger row referencing it. File a card before doing it.
