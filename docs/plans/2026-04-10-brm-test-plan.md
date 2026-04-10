# Bot Rental Marketplace — Test Plan

**Version**: 1.0 (2026-04-10)
**Related**: [BRM Design Document](2026-04-10-bot-rental-marketplace-design.md)
**Roadmap**: [/portal/roadmap.html](https://eclawbot.com/portal/roadmap.html)

---

## 1. Route Coverage Matrix

Every HTTP route defined in BRM modules is verified to be (a) mounted in `index.js`, (b) reachable via HTTP, and (c) covered by at least one Jest test.

### 1.1 Wallet Module (`wallet.js` → `/api/wallet`)

| # | Method | Path | Auth | Test File | Tests | Status |
|---|--------|------|------|-----------|-------|--------|
| W1 | GET | `/api/wallet/balance` | user | `wallet.test.js` | auth gate + returns wallet | ✅ |
| W2 | GET | `/api/wallet/history` | user | `wallet.test.js` | pagination, type filter, unknown type 400 | ✅ |
| W3 | GET | `/api/wallet/topup/tiers` | public | `wallet.test.js` | returns 5 tiers with USD pricing | ✅ |
| W4 | POST | `/api/wallet/topup/verify-google` | user | `wallet.test.js` | missing fields 400, unknown product 400, success + dedupe | ✅ |
| W5 | GET | `/api/wallet/admin/reconcile` | admin | `wallet.test.js` | non-admin 403, admin ok report | ✅ |
| W6 | POST | `/api/wallet/admin/grant` | admin | `wallet.test.js` | non-admin 403, success + ledger, input validation | ✅ |

**Primitive function tests** (no HTTP, direct call):
| # | Function | Tests | Status |
|---|----------|-------|--------|
| W7 | `creditTopup()` | credit + idempotency + reject zero | ✅ |
| W8 | `holdDeposit()` | hold + insufficient balance | ✅ |
| W9 | `releaseDeposit()` | release back to balance | ✅ |
| W10 | `forfeitDeposit()` | forfeit + overshoot held | ✅ |
| W11 | `transferEcoin()` | atomic p2p + self-transfer block + insufficient | ✅ |
| W12 | `adminAdjust()` | delta + reason enforcement | ✅ |
| W13 | `reconcileBalances()` | clean ok + injected drift + transfer round-trip | ✅ |
| W14 | `createTopupOrder()` | insert + dedupe + reject invalid | ✅ |
| W15 | `markTopupPaid()` | credit + idempotent + order_not_found | ✅ |
| W16 | `usdToMli()` / `ecoinToMli()` / `mliToEcoin()` | conversion math + reject invalid | ✅ |
| W17 | Factory hard-fail | missing authMiddleware → throw | ✅ |

---

### 1.2 Rental Module (`rental.js` → `/api/rental`)

| # | Method | Path | Auth | Test File | Tests | Status |
|---|--------|------|------|-----------|-------|--------|
| R1 | POST | `/api/rental/listing` | user | `rental-listing.test.js` | create draft + validations | ✅ |
| R2 | PATCH | `/api/rental/listing/:id` | owner | `rental-listing.test.js` | update + non-owner 403 + locked fields | ✅ |
| R3 | POST | `/api/rental/listing/:id/publish` | owner | `rental-listing.test.js` | publish + interview gate + non-owner | ✅ |
| R4 | POST | `/api/rental/listing/:id/pause` | owner | `rental-listing.test.js` | pause + wrong status | ✅ |
| R5 | DELETE | `/api/rental/listing/:id` | owner | `rental-listing.test.js` | delist | ✅ |
| R6 | GET | `/api/rental/listing/:id` | public | `rental-listing.test.js` | exists + not found null | ✅ |
| R7 | GET | `/api/rental/my-listings` | user | `rental-listing.test.js` | owner-scoped results | ✅ |
| R8 | GET | `/api/rental/marketplace` | public | `rental-listing.test.js` | listed+passed only + limit | ✅ |
| R9 | POST | `/api/rental/contract` | user | `rental-contract.test.js` | happy path + 6 validation errors | ✅ |
| R10 | POST | `/api/rental/contract/:id/end` | renter/owner | `rental-contract.test.js` | 4 deposit dispositions + auth | ✅ |
| R11 | GET | `/api/rental/my-contracts` | user | `rental-contract.test.js` | role filter (renter/owner/both) | ✅ |

**Primitive function tests**:
| # | Function | Tests | Status |
|---|----------|-------|--------|
| R12 | `startRental()` | atomic contract + snapshot + deposit hold | ✅ |
| R13 | `endRental()` | 4 disposition paths + zero-balance refund | ✅ |
| R14 | `isRentalEntity()` | true/false/null | ✅ |
| R15 | `createRentalEntityGuard()` | blocks rename/delete/identity + allows speakTo | ✅ |
| R16 | `checkRentalRateLimit()` | 30/min + independent per contract | ✅ |
| R17 | `insertRentalEntity()` | empty slot + auto-expand + device not found | ✅ |
| R18 | `markOwnerEntityLeasedOut()` + `clear` | mark + clear + missing device graceful | ✅ |
| R19 | `removeRentalEntity()` | reset + missing contract no-op | ✅ |
| R20 | Factory hard-fail | missing authMiddleware / walletModule → throw | ✅ |

---

### 1.3 Trust Module (`trust.js` → `/api/rental` extended)

| # | Method | Path | Auth | Test File | Tests | Status |
|---|--------|------|------|-----------|-------|--------|
| T1 | POST | `/api/rental/contract/:id/review` | user | `trust.test.js` | submit + non-renter 403 + duplicate + invalid rating + active contract | ✅ |
| T2 | GET | `/api/rental/listing/:id/reviews` | public | `trust.test.js` | returns listing reviews | ✅ |
| T3 | POST | `/api/rental/contract/:id/dispute` | user | `trust.test.js` | open + invalid type | ✅ |
| T4 | GET | `/api/rental/my-disputes` | user | `trust.test.js` | user-scoped results | ✅ |
| T5 | GET | `/api/rental/admin/disputes` | admin | `trust.test.js` | admin workqueue | ✅ |
| T6 | POST | `/api/rental/admin/disputes/:id/resolve` | admin | `trust.test.js` | resolve + double-resolve 404 | ✅ |
| T7 | POST | `/api/rental/admin/disputes/:id/reject` | admin | `trust.test.js` | reject dispute | ✅ |
| T8 | GET | `/api/rental/credit-score` | user | `trust.test.js` | recalculate + unknown user | ✅ |
| T9 | POST | `/api/rental/admin/blacklist` | admin | `trust.test.js` | add + check lifecycle | ✅ |
| T10 | DELETE | `/api/rental/admin/blacklist/:userId` | admin | `trust.test.js` | remove from blacklist | ✅ |
| T11 | GET | `/api/rental/age-check` | user | `trust.test.js` | unconfirmed returns false | ✅ |
| T12 | POST | `/api/rental/age-confirm` | user | `trust.test.js` | confirm + fraud log recorded | ✅ |

**Primitive function tests**:
| # | Function | Tests | Status |
|---|----------|-------|--------|
| T13 | `isBlacklisted()` | check + add + remove | ✅ |
| T14 | `checkCooldown()` / `setCooldown()` | no cooldown + set-and-check | ✅ |
| T15 | `recalculateCreditScore()` | returns score | ✅ |
| T16 | Factory hard-fail | missing authMiddleware → throw | ✅ |

---

### 1.4 Invite Module (`invite.js` → `/api/invite`)

| # | Method | Path | Auth | Test File | Tests | Status |
|---|--------|------|------|-----------|-------|--------|
| I1 | GET | `/api/invite/my-code` | user | `invite.test.js` | create + idempotent return | ✅ |
| I2 | POST | `/api/invite/redeem` | user | `invite.test.js` | success + credits + self-invite + double-redeem + unknown code + invalid format | ✅ |
| I3 | GET | `/api/invite/stats` | user | `invite.test.js` | empty stats | ✅ |

**Primitive function tests**:
| # | Function | Tests | Status |
|---|----------|-------|--------|
| I4 | `getOrCreateMyCode()` | create + idempotent | ✅ |
| I5 | `redeemCode()` | all validation paths | ✅ |
| I6 | Factory hard-fail | missing authMiddleware → throw | ✅ |

---

### 1.5 Pure Modules (no HTTP routes)

#### Bot Interview (`bot-interview.js`)
| # | Function | Test File | Tests | Status |
|---|----------|-----------|-------|--------|
| B1 | `scoreProbeResponse()` | `bot-interview.test.js` | greeting, python_exec, refusal safety, too short/long, null response | ✅ |
| B2 | `scoreInterview()` | `bot-interview.test.js` | perfect run, all-empty, baseline-only, capability tracking | ✅ |
| B3 | `getProbeList()` | `bot-interview.test.js` | returns serializable metadata | ✅ |
| B4 | `PROBES` catalogue | `bot-interview.test.js` | frozen, non-empty, each has id+prompt | ✅ |
| B5 | `MAX_SCORE` | `bot-interview.test.js` | sums non-optional weights | ✅ |

#### Pricing Advisor (`pricing-advisor.js`)
| # | Function | Test File | Tests | Status |
|---|----------|-----------|-------|--------|
| P1 | `detectFamily()` | `pricing-advisor.test.js` | opus, sonnet, haiku, gpt-4 family, gemini, unknown | ✅ |
| P2 | `countCapabilities()` | `pricing-advisor.test.js` | supported-only count, null/empty graceful | ✅ |
| P3 | `suggestRate()` | `pricing-advisor.test.js` | opus+2caps, unknown family, no caps, band width | ✅ |
| P4 | `classifyRate()` | `pricing-advisor.test.js` | in_range, below, above, way_above, way_below, null | ✅ |

#### Rental Proxy (`rental-proxy.js`)
| # | Function | Test File | Tests | Status |
|---|----------|-----------|-------|--------|
| X1 | `estimateTokens()` | `rental-proxy.test.js` | empty, short, rounding, CJK | ✅ |
| X2 | `computeCostMli()` | `rental-proxy.test.js` | basic, rounding, zero, realistic | ✅ |
| X3 | `splitFees()` | `rental-proxy.test.js` | 15% split, zero, small amount, 1 mli, large realistic | ✅ |
| X4 | Constants match | `rental-proxy.test.js` | PLATFORM_FEE_BPS, virtual UUIDs | ✅ |
| X5 | End-to-end cost | `rental-proxy.test.js` | 200-char in + 800-char out breakdown | ✅ |

#### Fraud Detection (`fraud-detection.js`)
| # | Function | Test File | Tests | Status |
|---|----------|-----------|-------|--------|
| F1 | `evaluateRentalRisk()` | `invite.test.js` | self-rental block, new account +50%, old account normal | ✅ |
| F2 | `computeReviewWeight()` | `invite.test.js` | new account 0.3×, old account 1× | ✅ |

#### Gatekeeper Extension (`gatekeeper.js` — P2-D)
| # | Function | Test File | Tests | Status |
|---|----------|-----------|-------|--------|
| G1 | `detectRentalSensitiveData()` | `rental-guardrails.test.js` | normal text, injection (4 patterns), sensitive data (6 patterns), false-negative, match masking | ✅ |

---

## 2. Coverage Summary

| Test File | Test Count | Module(s) Covered |
|-----------|-----------|-------------------|
| `wallet.test.js` | 48 | wallet.js (①②③) |
| `rental-listing.test.js` | 23 | rental.js listings + marketplace |
| `rental-contract.test.js` | 18 | rental.js contracts + cross-module atomicity |
| `rental-guardrails.test.js` | 30 | gatekeeper P2-D + rental.js P2-E/F |
| `rental-proxy.test.js` | 18 | rental-proxy.js (⑧) |
| `bot-interview.test.js` | 24 | bot-interview.js (④⑥) |
| `pricing-advisor.test.js` | 17 | pricing-advisor.js (⑤) |
| `trust.test.js` | 22 | trust.js (P3+P4) |
| `invite.test.js` | 10+4=14 | invite.js (P5) + fraud-detection.js |
| **Total BRM** | **214** | **11 modules** |

---

## 3. Route Mounting Verification

All routes confirmed mounted in `backend/index.js`:

```
Line 1698:  app.use('/api/wallet', walletModule.router);
Line 1714:  app.use('/api/rental', rentalModule.router);
Line 1729:  app.use('/api/rental', trustModule.router);      // extends rental routes
Line 1740:  app.use('/api/invite', inviteModule.router);
```

Schema init ordering (deferred via `setTimeout` to respect FK dependencies):
```
authModule.initAuthDatabase()          →  immediate
walletModule.initWalletDatabase()      →  +2000ms
rentalModule.initRentalDatabase()      →  +2500ms
trustModule.initTrustDatabase()        →  +3000ms
inviteModule.initInviteDatabase()      →  +3500ms
```

Cron jobs:
```
* * * * *     expireContracts() + expireGracePeriods()    (per-minute)
17 */6 * * *  releasePendingIncome()                       (every 6h)
23 4 * * *    reconcileBalances()                          (daily 04:23)
```

---

## 4. Route Conflict Analysis

**rental.js** and **trust.js** are both mounted at `/api/rental`. Verified no path conflicts:

| rental.js path | trust.js path | Conflict? |
|----------------|---------------|-----------|
| POST `/listing` | — | — |
| PATCH `/listing/:id` | — | — |
| POST `/listing/:id/publish` | — | — |
| POST `/listing/:id/pause` | — | — |
| DELETE `/listing/:id` | — | — |
| GET `/listing/:id` | GET `/listing/:id/reviews` | ❌ No (different suffix) |
| GET `/my-listings` | — | — |
| GET `/marketplace` | — | — |
| POST `/contract` | — | — |
| POST `/contract/:id/end` | POST `/contract/:id/review` | ❌ No (different suffix) |
| — | POST `/contract/:id/dispute` | — |
| GET `/my-contracts` | GET `/my-disputes` | ❌ No (different name) |
| — | GET `/credit-score` | — |
| — | GET/POST `/age-check`, `/age-confirm` | — |
| — | GET/POST/DELETE `/admin/disputes/*`, `/admin/blacklist/*` | — |

**Result: Zero conflicts.** All paths are unique.

---

## 5. Integration Test Plan (Pre-GA)

These are end-to-end tests against the live server, to be added in `backend/tests/`:

### 5.1 Full rental lifecycle (`test-rental-e2e.js`)
1. Create two real devices (owner + renter)
2. Owner: create listing → run interview → publish
3. Renter: top up e-coin → browse marketplace → find listing
4. Renter: start rental → verify deposit held + entity appears
5. Renter: send 5 messages via chat → verify token metering charges
6. Renter: end rental (normal) → verify deposit refunded
7. Renter: submit 5★ review → verify listing avg_rating updated
8. Run reconcile → verify 0 drift
9. Verify all wallet_ledger entries have idempotency keys

### 5.2 Dispute flow (`test-dispute-e2e.js`)
1. Start rental → send 1 message → simulate bot timeout
2. Renter: open dispute (bot_crash)
3. Admin: resolve dispute → verify deposit refunded
4. Verify owner credit score updated

### 5.3 Referral flow (`test-invite-e2e.js`)
1. User A: get invite code
2. User B: register → redeem code
3. Verify both wallets credited (500 + 100 e幣)
4. Verify code use_count incremented
5. User B: try to redeem again → expect 400

### 5.4 Fraud + blacklist flow (`test-fraud-e2e.js`)
1. Create new account (<7 days)
2. Try to rent → verify +50% deposit premium
3. Admin: blacklist user → verify rental blocked
4. Admin: remove from blacklist → verify rental allowed
5. Test cooldown: end rental → immediately try same listing → blocked 24h

### 5.5 Zero-balance termination (`test-zero-balance-e2e.js`)
1. Renter: top up minimal amount
2. Start rental → send messages until balance exhausted
3. Verify: last-message cost deducted from deposit
4. Verify: grace period entered (6–12h)
5. After grace period: verify remaining deposit refunded
6. Reconcile: 0 drift

---

## 6. Load Test Plan (Pre-GA)

| Scenario | Target | Acceptance Criteria |
|----------|--------|---------------------|
| 100 concurrent active rentals | Steady-state | p99 latency < 500ms per message charge |
| 500 messages/second across all rentals | Burst | No ledger drift, all usage_events recorded |
| 50 simultaneous rental starts | Contention | No double-bookings (partial UNIQUE holds) |
| 1000 reconcile with 10K wallets | Daily cron | Completes < 30s |
| 100 invite redemptions/second | Burst | No duplicate credits |

---

## 7. Test Execution Commands

```bash
# All BRM tests (214 tests)
npx jest tests/jest/wallet.test.js tests/jest/rental-listing.test.js \
    tests/jest/rental-contract.test.js tests/jest/rental-guardrails.test.js \
    tests/jest/rental-proxy.test.js tests/jest/bot-interview.test.js \
    tests/jest/pricing-advisor.test.js tests/jest/trust.test.js \
    tests/jest/invite.test.js --no-coverage

# Full project suite (71+ suites)
cd backend && npm test

# Single module
npx jest tests/jest/wallet.test.js --no-coverage

# Integration tests (against live server, requires credentials)
node backend/tests/test-rental-e2e.js
```

---

## 8. Known Gaps & Future Test Work

| # | Gap | Priority | Notes |
|---|-----|----------|-------|
| 1 | `chargeRentalUsage()` not tested via HTTP (needs entity handover wired in index.js) | P2-F follow-up | Billing math is covered; missing the full flow through `/api/client/speak` |
| 2 | `preCheckBalance()` not tested | Low | Advisory-only function, not blocking |
| 3 | `expireContracts()` / `expireGracePeriods()` / `releasePendingIncome()` not tested with real DB | Integration test | Logic is in pure functions; cron scheduling is standard `node-cron` |
| 4 | SLA miss auto-compensation not implemented yet | P4 follow-up | `SLA_MISS_COMPENSATION_MLI` defined but not wired |
| 5 | `recalculateCreditScore()` CTE only tested with mock DB | Integration test | Formula correctness needs real PG to validate |
| 6 | First-topup bonus chain (`FIRST_TOPUP_BONUS_MLI`) not triggered | P5 follow-up | Defined in invite.js but no hook in wallet topup flow |
| 7 | Google Play `purchaseToken` real verification | Blocked on service account | Stub in place, dedupe via UNIQUE protects against replay |

---

*End of test plan*
