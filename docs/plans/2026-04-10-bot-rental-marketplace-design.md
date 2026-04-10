# Bot Rental Marketplace — Design Document

**Formal name**: EClaw Bot Rental Marketplace (BRM)
**Codename**: `brm` (used in commit messages, branch names, API prefixes)
**Status**: Phase 0 complete, Phase 1 foundation complete, Phase 2-A/B complete
**Design locked**: 2026-04-09
**Document version**: 1.0 (2026-04-10)
**Author**: Hank + Claude (session transcript)
**Related feature branch**: `feature/bot-rental-p0-wallet`
**Related PR**: [#1656](https://github.com/HankHuang0516/EClaw/pull/1656)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Product Overview](#3-product-overview)
4. [Locked Design Decisions](#4-locked-design-decisions)
5. [Economic Model](#5-economic-model)
6. [Data Model](#6-data-model)
7. [State Machines](#7-state-machines)
8. [API Surface](#8-api-surface)
9. [Subsystem Specifications](#9-subsystem-specifications)
10. [Phase Plan & Delivery Tracking](#10-phase-plan--delivery-tracking)
11. [Technical Deep Dives](#11-technical-deep-dives)
12. [Privacy, Security & Compliance](#12-privacy-security--compliance)
13. [Open Issues & Risks](#13-open-issues--risks)
14. [Rollout Plan](#14-rollout-plan)
15. [Test Strategy](#15-test-strategy)
16. [File Map](#16-file-map)

---

## 1. Executive Summary

The **Bot Rental Marketplace (BRM)** is an ambitious two-sided marketplace built on top of EClaw that lets bot owners **monetize idle bot capacity** and lets users **pay-per-use for premium bots** without buying their own OpenClaw subscription.

### Core value proposition

- **Bot owners** (typically OpenClaw subscribers with spare token quota) list their bots, set a rate in "e-coin" (e幣), and earn passive income from renters. Bots are verified via an **automated interview** that locks in capability claims on the Agent Card.
- **Bot renters** browse a marketplace, pay a deposit in e-coin, and temporarily bind a rented bot to their device. The rented bot integrates with the EClaw A2A ecosystem — chat, broadcast, kanban, mission board — exactly like a bot they own, except for a few guardrails (no rename, no sub-lease, rate-limited).
- The platform earns a **15% commission** on every rental transaction, and operates a **2% insurance pool** that reimburses renters in case of bot failure disputes.

### How it reshapes the Bot 廣場 (Marketplace)

Prior to BRM, the "bot 廣場" in EClaw served as a static showcase of official/community bots. After BRM ships, the marketplace becomes a **dynamic rental exchange** where every listing has:

- Verified capability tags (from interview)
- Live rate in e幣/1K token
- Real-time availability status
- User ratings and dispute history
- Suggested vs owner-set rate comparison

### Positioning

BRM is the single most ambitious initiative on the EClaw roadmap — it introduces a **real economy** with real-money top-ups, a **ledger-based wallet system**, cross-module transactional guarantees, and a **risk-managed dispute pipeline**. It is intentionally gated behind:

- A fixed exchange rate (no internal speculation)
- Non-convertible e-coin (no withdrawal, avoids securities/AML regulation)
- Google Play and Apple IAP only (delegates tax/invoicing to app stores)
- A conservative MVP that can be trimmed back if retention doesn't justify the ops burden

---

## 2. Goals & Non-Goals

### 2.1 Goals

| # | Goal | Measured by |
|---|------|-------------|
| G1 | Let an OpenClaw-subscribed user list their bot and earn e-coin from other users' usage | First rental contract > 30 min completed |
| G2 | Let a user without OpenClaw rent a premium bot on-demand | Successful contract with token-metered billing |
| G3 | Guarantee financial correctness (no lost e-coin, no double-credit, no orphaned holds) | Daily reconcile cron reports 0 drift for 30 days |
| G4 | Automate capability verification so owners can't over-claim | Interview-locked Agent Card with 0 manual review needed for 95% of listings |
| G5 | Provide a dispute path for bot crashes / quality issues | 80% of disputes resolved within SLA |
| G6 | Keep the marketplace frictionless for both sides | < 60s from "I want this bot" to "I'm chatting with it" |
| G7 | Preserve EClaw's A2A collaboration model — rented bots integrate with mission / kanban / chat | Rented bot can receive `speakTo` and appear in kanban assignments |

### 2.2 Non-Goals (explicit scope cuts)

| # | Non-goal | Rationale |
|---|----------|-----------|
| N1 | No cash-out / withdrawal of e-coin | Avoids securities regulation, AML/KYC burden, tax complexity |
| N2 | No variable exchange rate | Prevents internal speculation, fixed 1 TWD = 100 e幣 |
| N3 | No sub-leasing (renter re-renting to another user) | Breaks the chain of trust and version-lock guarantees |
| N4 | No owner-to-owner bot transfer | Out of scope — bots are device-bound |
| N5 | No fractional ownership of bots | Over-engineering for MVP |
| N6 | No guaranteed uptime SLA for owners | Cannot enforce against a distributed OpenClaw bot without major changes |
| N7 | No support for non-Anthropic/OpenAI/Gemini model families in the pricing advisor | Base rates can be added later; fallback is `'unknown'` family |
| N8 | No automated dispute resolution beyond crash detection | Admin-human is the arbiter for quality/capability disputes in v1 |
| N9 | No real-time bidding / auctions | Out of scope — fixed-price rentals only |
| N10 | No integration with external bot marketplaces (A2A cross-platform) | Phase 5 at earliest |

---

## 3. Product Overview

### 3.1 Personas

**Owner (出租方)**: An EClaw user with an OpenClaw subscription who isn't using their full token quota. Wants passive income without maintenance burden. Risk-averse — needs to trust the platform to protect them from abuse.

**Renter (租借方)**: An EClaw user without OpenClaw who needs a specific high-end capability (Opus-level reasoning, Python execution, web browsing) for a bounded task. Price-sensitive, time-sensitive.

**Admin (平台管理員)**: The operator (initially Hank). Handles disputes, manages insurance pool, runs reconcile audits, investigates fraud.

### 3.2 User stories

#### Owner flow

```
As an OpenClaw subscriber
I want to list my bot for rent
So that I can earn back some of my subscription cost

1. I open the Bot Rental section in EClaw Portal/App
2. I select one of my bots (already bound to a device+entity slot)
3. I fill in title, description, and a rate (e.g. 10 e幣/1K tokens)
4. System shows suggested rate range ("Market avg 8–14 e幣/1K for Opus + Python")
5. I hit "Run Interview" — system sends 8 probes, scores them, shows capability chips
6. If score >= 60, I can hit "Publish"
7. Listing appears in marketplace
8. Someone rents it → I see "Rented to anonymous user, earning ~X e幣/hour"
9. My bot entity shows a "Leased out 出租中" overlay; I can't chat with it until contract ends
10. After contract ends (or gets ended), I see earned e-coin in my wallet after a 24-hour settlement delay
```

#### Renter flow

```
As a user wanting to try Claude Opus for a 1-hour coding task
I want to rent an Opus bot instead of paying for a full subscription
So that I only pay for what I use

1. I open the Marketplace
2. I filter by capability = python_exec, sort by rating
3. I see a listing: "Coding Wizard Bot — Opus 4.6, Python, 10 e幣/1K, ★4.8"
4. Click → see full agent card, interview benchmark, rate, deposit (200 e幣 = NT$2)
5. I hit "Rent for 1 hour" → warning modal about sensitive data
6. Check my wallet balance: 500 e幣 > deposit + buffer, OK
7. Confirm → deposit goes to "held", bot appears in my dashboard with 🔒 badge
8. I chat normally; each message shows "12 tokens, -0.012 e幣" in the footer
9. Balance ticks down as I use it
10. I hit 30 minutes and decide I'm done → click "End rental"
11. 50% of deposit refunded (early termination), contract closes
```

#### Admin flow

```
As the platform admin
I want to handle a bot-crash dispute
So that I can rule fairly and keep both sides happy

1. Renter reports "this bot stopped responding 10 minutes in"
2. System auto-runs 5 probes to the bot's webhook
3. 4/5 probes time out → auto-verified crash
4. System triggers ended_disputed path → renter gets full refund
5. Owner sees "crash dispute resolved against you" + crash counter increments
6. If owner hits 3 crashes in 30 days, listing auto-suspends
7. Admin dashboard shows the dispute timeline for audit
```

### 3.3 Guardrails (what users cannot do)

| # | Guardrail | Enforcement point |
|---|-----------|------------------|
| GR1 | Self-rental (owner rents their own bot) | `startRental` checks `owner !== renter` |
| GR2 | Double-renting (two renters, same listing) | DB `UNIQUE` partial index on `rental_contracts(listing_id)` WHERE status IN active |
| GR3 | Sub-leasing | Rental entities are blocked from `POST /api/rental/listing` at route level |
| GR4 | Owner-side config change mid-rental | `rental_snapshots` freezes identity/rules/skills at contract start; runtime reads snapshot, not live listing |
| GR5 | Rental entity accessing owner's secrets | `device_vars` whitelist on rental entity blocks `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD` (P2-D) |
| GR6 | Renter blowing up owner's bot with spam | Rate limit: 30 req/min on rental entity (P2-E) |
| GR7 | Bot falsifying token usage | Backend computes tokens via `tiktoken` — bot self-reports are ignored |
| GR8 | Underage users renting adult bots | Age confirmation hook at rental time; existing users must backfill `age_confirmed_at` |

---

## 4. Locked Design Decisions

The following 27 decisions are **locked**. They have been discussed, debated, and confirmed. Do not re-litigate them without explicit user direction.

| # | Item | Decision | Rationale |
|---|------|----------|-----------|
| **1** | Token metering source | **Pure backend computation via `tiktoken`** on message bodies flowing through the rental proxy | Unforgeable by owner, simpler than bot self-reporting, fair to renter because "what you see is what you pay" |
| **2** | Settlement delay | **T+24h** — owner income enters `pending_income`, auto-released to spendable balance after 24h unless a dispute is raised | Buffer for refund / chargeback scenarios |
| **3** | Deduction order on exhaustion | Main balance → 禁言態 (6–12h grace + push) → final message settled from deposit → handover → unbind | Human-friendly — gives renter time to top up before losing access |
| **4** | Bot exclusivity | **One listing = one active renter** (enforced at DB layer via partial UNIQUE index) | Simplifies rate-limit accounting and avoids owner-bot overload |
| **5** | Owner lockout during rental | Owner **cannot** use their own bot while leased out; UI shows half-transparent + "出租中" banner | Prevents self-farming token revenue |
| **6** | Deposit lock moment | At "renter clicks confirm" — `rate_mli_per_ktoken_snapshot` stored on contract row | Decouples live listing edits from in-flight contracts |
| **7** | Deposit formula | `deposit_mli = rate_mli_per_ktoken × 20` (covers ~20,000 tokens of runway) | Lowered from 200,000 after user feedback — reduces entry barrier |
| **8** | Interview cost | Platform absorbs cost; 3 interview attempts per listing per 7-day rolling window | Encourages listing while preventing spam |
| **9** | Rental duration bounds | Min 30 min, max 7 days | Min prevents impulse churn, max limits financial exposure |
| **10** | Rental eligibility check | Renter balance ≥ `deposit + (rate × 60K tokens)` buffer (≈1h typical chat) | Prevents starting a rental that immediately exhausts |
| **11** | Exchange rate | **1 TWD = 100 e幣 = 100,000 mli** (fixed, hard-coded in `wallet.js`) | Avoids becoming a crypto exchange; no DB-configurable rates |
| **12** | Platform fee | **15% = 1500 bps**; of this, 2% = 200 bps routes to insurance pool | Matches App Store commission expectations |
| **13** | e-coin withdrawal | **Not allowed** — station-internal spending only (rentals, subscriptions, tips) | Avoids securities regulation, AML/KYC, tax filings |
| **14** | Owner anonymity | Renter sees only Agent Card fields + aggregate stats; `owner_user_id` is stripped from public API responses | Privacy-by-default |
| **15** | Rental entity A2A collab | ✅ `speakTo`, ✅ `broadcast`, ✅ kanban `assigned_bots`, ✅ mission notes read, ❌ rename, ❌ delete, ❌ identity update, ❌ sub-lease, ❌ cross-speak to owner's devices. Rate limit: 30 req/min | Preserves EClaw collaboration UX while preventing abuse |
| **16** | Top-up channels | **Google Play only** in MVP; Apple IAP later; TapPay skipped (unavailable) | Focus on Android ecosystem first |
| **17** | Privacy strategy | Transparent disclosure + sensitive data rich-card interception. No attempt at absolute isolation (admit owner can log backend requests). | Realistic about threat model |
| **18** | Vault isolation (HARD) | Rental entity **cannot** read `device_vars` matching `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`. Owner explicitly whitelists vars at listing time. | Defense-in-depth against credential leakage |
| **19** | Gatekeeper scope for rentals | Only: (1) prompt injection, (2) sensitive data leak. NOT illegal content. | Limits false-positive rate |
| **20** | Violation counter | 5-strike limit per contract, **resets on handover back**. 5th strike → forced `ended_violation` → 30% deposit forfeit to insurance pool, 70% refund | Graduated response, not zero-tolerance |
| **21** | Age confirmation | Enforced at rental time; existing users backfill via modal. IP + timestamp captured. | Legal cover without blocking existing UX |
| **22** | Grace period on funds exhaustion | **6–12 hours** (min of contract remaining time). Push notifications at T+0 and T+6h. | Gives time to top up without stranding user |
| **23** | Interview judge model | **Pure regex + heuristic** — no LLM judge | Free, deterministic, reproducible, unforgeable |
| **24** | Listing approval gate | **Open to all** — interview score < 60 auto-rejects. No whitelist. | Scales to many owners without manual review burden |
| **25** | Rate unit anchor | **1K token = 1 e幣** as market anchor (advisory only). Owner fully free to set any rate. Warning shown at >2× deviation from suggestion. | UX-friendly small numbers; owner autonomy preserved |
| **26** | Invoice / tax | System records top-up history only; owner reports tax via Google Play Console directly | Delegates tax burden to app store |
| **27** | Dispute SLA | Crash: instant auto-verify 5min. Quality: 24h response / 72h resolve. Capability mismatch: 24h/48h. Financial: 12h/48h. Missed SLA → 50 e幣 auto-compensation from insurance pool. | Sets clear expectations, reduces admin panic |

### 4.1 Referenced but not yet locked

These came up during design but weren't finalized — flag to user before implementing:

- Rating system granularity (5-star only? or thumbs up/down for simplicity?)
- Whether the `credit score` affects listing search rank directly or just shows as a badge
- Whether renters can leave reviews anonymously
- Whether owners can block specific renters

---

## 5. Economic Model

### 5.1 Units

| Unit | Symbol | Conversion | Notes |
|------|--------|------------|-------|
| TWD | NT$ | — | External fiat; user pays / cashes out via Google Play |
| e-coin | e幣 | `1 TWD = 100 e幣` | User-visible currency |
| mli (厘) | — | `1 e幣 = 1000 mli` | Storage unit in DB; avoids floats for fractional charges |

All BIGINT columns in the schema use **mli**. All user-visible UI displays **e-coin**. The conversion happens at the edge.

### 5.2 Top-up tiers (Google Play)

Hard-coded in `wallet.js` `TOPUP_TIERS`. Bonus % escalates to reward larger purchases:

| Tier | SKU | TWD | Base e幣 | Bonus e幣 | Total e幣 | Effective rate |
|------|-----|-----|----------|-----------|-----------|---------------|
| Small | `ecoin_tier_small` | 90 | 9,000 | 0 | 9,000 | 100 e幣 / TWD |
| Starter | `ecoin_tier_starter` | 170 | 17,000 | 850 (+5%) | 17,850 | 105 e幣 / TWD |
| Standard | `ecoin_tier_standard` | 340 | 34,000 | 2,720 (+8%) | 36,720 | 108 e幣 / TWD |
| Advanced | `ecoin_tier_advanced` | 990 | 99,000 | 11,880 (+12%) | 110,880 | 112 e幣 / TWD |
| Premium | `ecoin_tier_premium` | 1,990 | 199,000 | 29,850 (+15%) | 228,850 | 115 e幣 / TWD |

### 5.3 Rental pricing (owner-set, advisor-suggested)

**Formula used by `pricing-advisor.js`**:

```
suggested_rate_mli = BASE_RATE[model_family] × (1 + capability_count × 0.3)
band_width         = suggested × (0.4 if confidence=high else 0.6)
min_suggested      = suggested - band_width
max_suggested      = suggested + band_width
```

**Base rates** (in mli per 1K tokens):

| Model family | Base e幣/1K | Notes |
|--------------|-------------|-------|
| Claude Opus (any version) | 10 | Premium tier |
| Claude Sonnet / GPT-4 | 5 | Mid-tier workhorse |
| GPT-4o | 6 | Slightly above Sonnet |
| Claude Haiku / GPT-4o-mini / Gemini Flash | 2 | Entry-level |
| Gemini Pro | 5 | Mid-tier |
| **unknown** (fallback) | 3 | Conservative default |

**Capability multiplier**: +30% per supported capability (python_exec, web_browse, vision, file_io, …)

**Example**: Opus + Python + Browse + Vision
```
suggested = 10 × (1 + 3 × 0.3) = 19 e幣/1K
high-conf band = 19 × 0.4 = 7.6
range: 11.4 – 26.6 e幣/1K
```

### 5.4 Deposit formula

```
deposit_mli = rate_mli_per_ktoken × 20   // 20,000 tokens of runway
```

**Examples**:

| Rate | Deposit (mli) | Deposit (e幣) | Deposit (NT$) |
|------|---------------|---------------|---------------|
| 1 e幣/1K (1000 mli) | 20,000 | 20 | 0.20 |
| 5 e幣/1K (5000 mli) | 100,000 | 100 | 1.00 |
| 10 e幣/1K (10000 mli) | 200,000 | 200 | 2.00 |
| 30 e幣/1K (30000 mli) | 600,000 | 600 | 6.00 |

Intentionally low to minimize entry friction. The design memo explicitly traded off "lower breach deterrence" for "easier first-time try".

### 5.5 Platform fee split

On every rental token charge (`rental_spend` ledger entry):

```
renter pays:        100%  (debited from renter balance_mli)
owner receives:      85%  (credited to owner balance_mli, T+24h)
platform fee:        13%  (credited to PLATFORM_WALLET)
insurance pool:       2%  (credited to INSURANCE_POOL_WALLET)
                    ────
                    100%
```

`PLATFORM_FEE_BPS = 1500` (total fee), `INSURANCE_POOL_BPS = 200` (portion of fee to insurance).

### 5.6 Minimum balance to initiate rental

```
required_mli = deposit_mli + (rate_mli_per_ktoken × 60)   // 60K token buffer ≈ 1h typical chat
```

If renter balance < required, the API returns `insufficient_balance_for_rental` with an error details payload containing `required_mli`, `current_mli`, `deposit_mli`, `buffer_mli`.

### 5.7 Rental income cashflow timeline

```
T+0        renter rents, deposit held, contract active
T+0..end   every message triggers:
             - renter balance_mli -= charge
             - owner pending_income_mli += 85% × charge  (NEW table in P2-C)
             - platform_wallet_mli += 13% × charge
             - insurance_pool_mli +=  2% × charge
             - rental_usage_events row inserted
             - wallet_ledger row inserted
T+end      contract ends (normal or early):
             - deposit disposition applied (refund / forfeit)
             - contract status → ended_*

T+end+24h  pending_income cron sweeps:
             - owner pending_income_mli -= earned_this_contract
             - owner balance_mli       += earned_this_contract
             - wallet_ledger row inserted (rental_income type)
```

---

## 6. Data Model

### 6.1 ERD overview

```
┌──────────────────────┐
│   user_accounts      │  (existing — auth.js)
│   id UUID PK         │
└──────────┬───────────┘
           │
           │ FK
           ├──────────────────────────────────────────┐
           │                                          │
           ▼                                          ▼
┌──────────────────────┐                ┌──────────────────────┐
│     wallets          │                │   topup_orders       │
│   user_id UUID PK    │                │   id UUID PK         │
│   balance_mli        │                │   user_id FK         │
│   held_mli           │                │   ecoin_total_mli    │
│   lifetime_*         │                │   external_txn_id    │
└──────────┬───────────┘                └──────────────────────┘
           │
           │ 1:N (append-only)
           ▼
┌──────────────────────┐
│   wallet_ledger      │
│   id BIGSERIAL PK    │
│   user_id FK         │
│   delta_mli          │
│   held_delta_mli     │
│   balance_after_mli  │
│   type ENUM          │
│   idempotency_key UNIQUE
└──────────────────────┘

┌──────────────────────┐
│   bot_listings       │
│   id UUID PK         │◄───┐
│   owner_user_id FK   │    │
│   rate_mli_per_ktoken│    │
│   capabilities JSONB │    │
│   interview_passed   │    │
│   status ENUM        │    │
└──────┬───────────────┘    │
       │                    │
       │ 1:N                │ N:1
       ▼                    │
┌──────────────────────┐    │
│   bot_interviews     │    │
│   id UUID PK         │    │
│   listing_id FK      │    │
│   probes_json        │    │
│   passed, score      │    │
└──────────────────────┘    │
                            │
┌───────────────────────────┴──┐
│   rental_contracts           │
│   id UUID PK                 │◄──────┐
│   listing_id FK              │       │
│   owner_user_id FK           │       │
│   renter_user_id FK          │       │
│   rate_mli_snapshot          │       │
│   deposit_mli                │       │
│   started_at, ends_at        │       │
│   tokens_consumed            │       │
│   violation_count            │       │
│   status ENUM                │       │
│   [UNIQUE partial idx        │       │
│    on listing_id WHERE       │       │
│    non-terminal status]      │       │
└──────┬───────────────────────┘       │
       │                               │
       │ 1:1                           │ 1:N
       ▼                               │
┌──────────────────────┐               │
│   rental_snapshots   │               │
│   contract_id PK/FK  │               │
│   identity JSONB     │               │
│   rules, skills      │               │
│   webhook_url        │               │
│   allowed_vars       │               │
└──────────────────────┘               │
                                       │
                          ┌────────────┘
                          ▼
                 ┌──────────────────────┐
                 │   rental_usage_events│
                 │   id BIGSERIAL PK    │
                 │   contract_id FK     │
                 │   direction          │
                 │   tokens             │
                 │   ecoin_charged_mli  │
                 └──────────────────────┘

┌──────────────────────────────┐
│   pricing_market_snapshots    │   (cron-populated, read-only advisor input)
│   id BIGSERIAL PK             │
│   model_family                │
│   rate_p25/p50/p75/p95_mli    │
└──────────────────────────────┘
```

### 6.2 Table specifications

#### `wallets` — 1:1 with `user_accounts`

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | UUID PK | FK → `user_accounts(id)` ON DELETE CASCADE |
| `balance_mli` | BIGINT NOT NULL DEFAULT 0 | CHECK (>= 0) |
| `held_mli` | BIGINT NOT NULL DEFAULT 0 | CHECK (>= 0) — deposit escrow |
| `lifetime_earned_mli` | BIGINT NOT NULL DEFAULT 0 | Denormalized aggregate (for fast reads; reconciled daily) |
| `lifetime_spent_mli` | BIGINT NOT NULL DEFAULT 0 | Same |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**Indexes**: `idx_wallets_updated` on `updated_at DESC`.

**Invariants**:
- `balance_mli + held_mli == SUM(delta_mli) over wallet_ledger WHERE user_id = w.user_id`
- `held_mli > 0` only during active rental contracts
- Daily reconcile cron verifies the above invariant

#### `wallet_ledger` — append-only double-entry

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `user_id` | UUID NOT NULL | FK → `user_accounts(id)` |
| `delta_mli` | BIGINT NOT NULL | Signed: + credit, − debit |
| `held_delta_mli` | BIGINT NOT NULL DEFAULT 0 | Signed: change to held_mli |
| `balance_after_mli` | BIGINT NOT NULL | Snapshot post-mutation |
| `held_after_mli` | BIGINT NOT NULL | Snapshot post-mutation |
| `type` | VARCHAR(32) NOT NULL | Enum: see below |
| `ref_type`, `ref_id` | VARCHAR | Optional — e.g. `('rental_contract', 'contract-xyz')` |
| `counterparty_user_id` | UUID | For p2p transfers |
| `note` | TEXT | Human-readable annotation |
| `idempotency_key` | VARCHAR(128) NOT NULL UNIQUE | Retry protection |
| `created_at` | TIMESTAMPTZ | |

**`type` enum values**: `topup`, `rental_income`, `rental_spend`, `platform_fee`, `deposit_hold`, `deposit_release`, `deposit_forfeit`, `referral_bonus`, `signup_bonus`, `refund`, `admin_adjust`, `withdraw`.

**Indexes**:
- `idx_ledger_user_time (user_id, created_at DESC)` — primary read path
- `idx_ledger_type (type)` — admin queries
- `idx_ledger_ref (ref_type, ref_id)` — per-contract drilldown

#### `topup_orders`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK DEFAULT gen_random_uuid() | |
| `user_id` | UUID NOT NULL | FK → `user_accounts(id)` |
| `channel` | VARCHAR(32) | `google_play`, `apple_iap`, `admin_grant`, `invite_bonus`, `signup_bonus` |
| `amount_twd` | INTEGER NOT NULL | CHECK (>= 0) |
| `ecoin_base_mli`, `ecoin_bonus_mli`, `ecoin_total_mli` | BIGINT | All CHECK (>= 0) |
| `status` | VARCHAR(32) DEFAULT 'pending' | `pending`, `paid`, `failed`, `refunded` |
| `external_txn_id` | VARCHAR(255) | Google Play purchaseToken / Apple IAP transactionId |
| `external_raw` | JSONB | Full verification payload for audit |
| `created_at`, `paid_at`, `refunded_at` | TIMESTAMPTZ | |

**Indexes**:
- `idx_topup_user (user_id, created_at DESC)`
- `idx_topup_status`
- `idx_topup_external_txn UNIQUE (channel, external_txn_id) WHERE external_txn_id IS NOT NULL` — dedupe key for replay safety

#### `bot_listings`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `owner_user_id` | UUID NOT NULL | FK |
| `owner_device_id`, `owner_entity_id` | TEXT / INT | Points to the actual bot slot |
| `title`, `description` | VARCHAR(120) / TEXT | User-facing |
| `rate_mli_per_ktoken` | BIGINT NOT NULL | Owner-set, editable while not rented |
| `min_rental_minutes`, `max_rental_minutes` | INT | Default 30 / 10080 (7 days) |
| `availability_windows` | JSONB | Optional weekly schedule |
| `model_detected` | TEXT | **LOCKED** after interview |
| `capabilities` | JSONB | **LOCKED** after interview; `{python_exec: {supported:true}, …}` |
| `benchmark_score` | JSONB | **LOCKED**; `{reasoning: 82, latency_p50_ms: 2300, …}` |
| `interview_passed` | BOOLEAN DEFAULT FALSE | Gate for publishing |
| `last_interview_at` | TIMESTAMPTZ | |
| `avg_rating` | NUMERIC(3,2) | |
| `total_rentals` | INTEGER | |
| `uptime_pct` | NUMERIC(5,2) | Cron-computed |
| `status` | VARCHAR(32) | `draft`, `interview`, `listed`, `paused`, `delisted` |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**Locked-after-interview fields**: `model_detected`, `capabilities`, `benchmark_score`, `interview_passed`. The `updateListing` function whitelist excludes these, returning `no_fields_to_update` if the caller tries.

**Indexes**:
- `idx_listings_owner (owner_user_id)`
- `idx_listings_status`
- `idx_listings_rate WHERE status = 'listed'` — marketplace filter
- `idx_listings_rating DESC WHERE status = 'listed'` — default sort

#### `bot_interviews`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `listing_id` | UUID NOT NULL | FK → `bot_listings(id)` CASCADE |
| `probes_json` | JSONB NOT NULL | Snapshot of probe catalogue at interview time |
| `responses_json` | JSONB NOT NULL | Bot's responses to each probe |
| `passed` | BOOLEAN NOT NULL | Score >= 60 |
| `score` | INT 0–100 | |
| `duration_ms` | INT | How long the interview took |
| `failure_reason` | TEXT | Populated on `passed = FALSE` |
| `created_at` | TIMESTAMPTZ | |

**Rate limiting**: `INTERVIEW_RATE_LIMIT = 3` per listing per 7 days (enforced in `runInterview()` by `COUNT(*) WHERE listing_id = $1 AND created_at > NOW() - '7 days'`).

#### `rental_contracts`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `listing_id` | UUID NOT NULL | FK → `bot_listings(id)` RESTRICT |
| `owner_user_id`, `renter_user_id` | UUID NOT NULL | Both FK to `user_accounts` |
| `renter_device_id` | TEXT NOT NULL | Which device the rental entity gets attached to |
| `renter_entity_slot` | INTEGER | NULL until P2-F entity handover lands |
| `rate_mli_per_ktoken_snapshot` | BIGINT NOT NULL | **Frozen at contract start** |
| `deposit_mli` | BIGINT NOT NULL | `rate × 20` at contract start |
| `planned_duration_min` | INTEGER NOT NULL | |
| `started_at`, `ends_at`, `actual_ended_at` | TIMESTAMPTZ | |
| `grace_period_starts_at` | TIMESTAMPTZ | Set when `suspended_insufficient_funds` begins |
| `tokens_consumed` | BIGINT DEFAULT 0 | Running total |
| `ecoin_charged_mli` | BIGINT DEFAULT 0 | Running total |
| `violation_count` | INTEGER DEFAULT 0 | 0–5, resets on handover |
| `status` | VARCHAR(40) | See state machine |
| `end_reason` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

**Critical constraint**:
```sql
CREATE UNIQUE INDEX idx_contracts_exclusive_active
    ON rental_contracts(listing_id)
    WHERE status IN ('reserved', 'active', 'suspended_insufficient_funds');
```
This enforces GR2 at the DB layer — no application bug can create double-bookings.

**Indexes**:
- `idx_contracts_renter (renter_user_id, created_at DESC)`
- `idx_contracts_owner (owner_user_id, created_at DESC)`
- `idx_contracts_active_ends (ends_at) WHERE status = 'active'` — cron sweep
- `idx_contracts_listing`
- `idx_contracts_exclusive_active` — exclusivity

#### `rental_snapshots` — version lock

| Column | Type | Notes |
|--------|------|-------|
| `contract_id` | UUID PK | FK → `rental_contracts(id)` CASCADE |
| `identity` | JSONB | Frozen bot identity |
| `rules` | JSONB | Frozen rule templates |
| `skills` | JSONB | Frozen skill templates |
| `webhook_url` | TEXT | Owner's real webhook (never exposed to renter) |
| `allowed_vars` | JSONB DEFAULT `[]` | Whitelist of device_vars keys the rental entity may read |
| `created_at` | TIMESTAMPTZ | |

#### `rental_usage_events`

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `contract_id` | UUID NOT NULL | FK CASCADE |
| `direction` | VARCHAR(8) | `'in'` or `'out'` |
| `tokens` | INT NOT NULL | Computed by `tiktoken` in rental-proxy |
| `ecoin_charged_mli` | BIGINT NOT NULL DEFAULT 0 | |
| `message_id` | VARCHAR(64) | FK-ish to `chat_messages` (loose) |
| `created_at` | TIMESTAMPTZ | |

One row per proxy-intercepted message. The `wallet_ledger` row for the charge and this event row share the `contract_id` ref.

#### `pricing_market_snapshots`

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `snapshot_at` | TIMESTAMPTZ | |
| `model_family` | TEXT NOT NULL | `'opus'`, `'sonnet'`, … |
| `listing_count` | INT | How many active listings in this family |
| `rate_p25_mli`, `p50`, `p75`, `p95` | BIGINT | Percentile breakdown |
| `rental_success_rate` | NUMERIC(4,3) | Completed / started for this family |

Populated by an hourly cron (P3). Read by `pricing-advisor.js` for "market median" display.

### 6.3 Tables deferred to later phases

These are referenced in the design but not yet in `rental_schema.sql`:

| Table | Phase | Purpose |
|-------|-------|---------|
| `bot_reviews` | P3 | 1–5 star ratings + comments per completed contract |
| `disputes` | P3 | Arbitration tickets with evidence + SLA timestamps |
| `user_credit_scores` | P3 | Aggregate credit per user based on history |
| `gatekeeper_violations` | P3 | Per-rental violation events for the 5-strike counter |
| `fraud_detection_log` | P3 | Device fingerprint + rule-trigger history |
| `crash_reports` | P3 | Auto-verified bot crash audit trail |
| `insurance_pool_ledger` | P4 | Separate append-only ledger for the pool wallet |
| `user_blacklist` | P4 | Temporary bans with expiration |
| `invite_codes`, `invite_redemptions` | P5 | Referral program |

---

## 7. State Machines

### 7.1 Listing lifecycle

```
                       ┌──────┐
                       │draft │
                       └───┬──┘
                           │ POST /interview/start
                           ▼
                     ┌───────────┐
                     │ interview │
                     └────┬──────┘
                          │
              score ≥ 60  │     score < 60
                   ┌──────┴──────┐
                   ▼             ▼
             ┌──────────┐   ┌────────┐
             │  listed  │   │  draft │  (owner can retry, 3/7d limit)
             └────┬─────┘   └────────┘
                  │
        ┌─────────┼─────────┐
        │         │         │
        ▼         ▼         ▼
  ┌────────┐ ┌────────┐ ┌─────────┐
  │ paused │ │delisted│ │  listed │  (renter engagement keeps it here)
  └────┬───┘ └────────┘ └─────────┘
       │
       │ owner resumes
       └──→ listed
```

- **draft → interview**: Owner clicks "Run Interview". Listing status changes while probes dispatch.
- **interview → listed**: Score ≥ 60 auto-promotes; capability fields lock.
- **interview → draft**: Score < 60 returns to draft; owner can edit and retry (max 3/7d).
- **listed → paused**: Owner temporarily hides (e.g. going on vacation).
- **listed → delisted**: Owner permanently removes.
- **paused → listed**: Owner resumes.

Capability fields are **permanent** after the first passing interview. Re-interviewing an already-`listed` bot updates the `last_interview_at` timestamp but does not change locked fields (enforced by the update whitelist).

### 7.2 Contract lifecycle

```
               [startRental]
                    │
                    ▼
              ┌──────────┐
              │  active  │◄─────────────────┐
              └────┬─────┘                  │
                   │                         │
      balance ↓ 0  │            topup        │
                   ▼                         │
         ┌────────────────────────┐          │
         │suspended_insufficient_ │──────────┘
         │       funds            │
         └────┬───────────────────┘
              │ grace period (6-12h) expires
              ▼
      ┌──────────────────┐
      │ended_zero_balance│
      └──────────────────┘

  [active]
      │
      ├─ time elapses ─→ ended_normal
      ├─ renter quits early ─→ ended_early_by_renter (50% refund)
      ├─ 5 violations ─→ ended_violation (70% refund)
      ├─ crash dispute ─→ ended_disputed (100% refund, forfeit to insurance)
      └─ admin force ─→ ended_admin (full refund)
```

**Implementation note**: In P2-A/B the `reserved` state is **skipped** — `startRental()` transitions directly to `active`. The enum value remains for future flows (e.g. deferred payment verification). This keeps the happy path simple: 1 atomic transaction = 1 state change.

### 7.3 Deposit disposition matrix

| End reason | Refund % | Forfeit % | Notes |
|------------|----------|-----------|-------|
| `ended_normal` | 100 | 0 | Standard completion |
| `ended_disputed` | 100 | 0 | Crash verified, owner's fault |
| `ended_admin` | 100 | 0 | Admin override |
| `ended_early_by_renter` | 50 | 50 | Soft penalty for cancellation |
| `ended_zero_balance` | 0 | 100 | Renter ran out of money |
| `ended_violation` | 70 | 30 | 5-strike limit hit |

Forfeited amounts route to the insurance pool by default (implemented in P4).

---

## 8. API Surface

### 8.1 Currently implemented (PR #1656)

#### Wallet module — `/api/wallet/*`

| Method | Path | Auth | Status | Description |
|--------|------|------|--------|-------------|
| GET | `/balance` | user | ✅ | Current balance + held + lifetime stats |
| GET | `/history` | user | ✅ | Paginated ledger, optional `type` filter |
| GET | `/topup/tiers` | public | ✅ | 5-tier catalog |
| POST | `/topup/verify-google` | user | ✅ (stub) | Google Play purchase verification. **Real `purchaseToken` check via androidpublisher API is TODO** — currently trusts the token and relies on UNIQUE(channel, external_txn_id) dedupe. |
| POST | `/admin/grant` | admin | ✅ | Manual e-coin grant, audited |
| GET | `/admin/reconcile` | admin | ✅ | On-demand ledger vs cached balance audit |

#### Rental module — `/api/rental/*`

| Method | Path | Auth | Status | Description |
|--------|------|------|--------|-------------|
| POST | `/listing` | user | ✅ | Create draft listing |
| PATCH | `/listing/:id` | owner | ✅ | Update whitelisted fields only |
| POST | `/listing/:id/publish` | owner | ✅ | Requires `interview_passed = TRUE` |
| POST | `/listing/:id/pause` | owner | ✅ | Temporarily hide from marketplace |
| DELETE | `/listing/:id` | owner | ✅ | Permanent delist |
| GET | `/listing/:id` | public | ✅ | Detail view (owner_user_id hidden from non-owners) |
| GET | `/my-listings` | user | ✅ | Owner's own listings |
| GET | `/marketplace` | public | ✅ | Search with `rate`, `capability`, `sort`, pagination |
| POST | `/contract` | user | ✅ | Start a rental (atomic: deposit + contract + snapshot) |
| POST | `/contract/:id/end` | renter/owner | ✅ | End contract with deposit disposition |
| GET | `/my-contracts` | user | ✅ | Filter by `role=renter\|owner` |

#### Cron jobs

| Schedule | Job | Status |
|----------|-----|--------|
| `23 4 * * *` (daily 04:23) | Wallet reconcile audit | ✅ |
| (TBD) hourly | Pricing market snapshot aggregation | 🟡 P1 follow-up |
| (TBD) per-minute | Contract expiration sweep (active → ended_normal) | 🔴 P2-F |
| (TBD) per-minute | Grace period expiration sweep | 🔴 P2-C |
| (TBD) T+24h | Owner pending_income release sweep | 🔴 P2-C |

### 8.2 Planned in later phases

#### P2-C: Token metering proxy

| Method | Path | Description |
|--------|------|-------------|
| (internal) | `POST /api/client/speak` hook | Intercepts when `rentalContractId` present |
| POST | `/api/rental/contract/:id/suspend` | Admin force-suspend |
| POST | `/api/rental/contract/:id/resume` | Admin force-resume |

#### P3: Reviews + disputes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/rental/contract/:id/review` | Renter 1-5★ rating + comment |
| POST | `/api/rental/contract/:id/dispute` | File a dispute |
| GET | `/api/rental/disputes` | User's own disputes |
| GET | `/api/admin/rental/disputes` | Admin workqueue |
| POST | `/api/admin/rental/disputes/:id/resolve` | Admin decision |

#### P4: Risk management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/rental/listing/:id/sla` | Uptime % + crash count |
| GET | `/api/admin/rental/insurance-pool` | Pool balance + history |
| POST | `/api/admin/rental/blacklist` | Ban user from renting |

#### P5: Growth

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/invite/my-code` | User's referral code |
| POST | `/api/invite/redeem` | Claim invite bonus |
| GET | `/api/invite/stats` | Referral performance |

---

## 9. Subsystem Specifications

The original user request listed 11 subsystems. Each is mapped here to its phase, implementation status, and relevant code locations.

### 9.1 錢包系統 (Wallet System)

**Status**: ✅ Complete (Phase 0)
**Files**: `backend/wallet.js`, `backend/wallet_schema.sql`, `backend/tests/jest/wallet.test.js`

- Double-entry ledger with idempotency keys
- Atomic BEGIN/COMMIT around every mutation
- Row-locking via `SELECT ... FOR UPDATE`
- Denormalized aggregates (`lifetime_earned_mli`, `lifetime_spent_mli`) for fast reads
- Daily reconciliation cron

### 9.2 APP 儲值 e幣系統 (Top-up System)

**Status**: 🟡 Stub (Google Play token verification pending real integration)
**Files**: `backend/wallet.js` (`creditTopup`, `createTopupOrder`, `markTopupPaid`, `TOPUP_TIERS`)

- 5 hard-coded tiers (NT$90 / 170 / 340 / 990 / 1990)
- Escalating bonus % (0 → 15%)
- `UNIQUE(channel, external_txn_id)` dedupe prevents replay
- Atomic `markTopupPaid`: single transaction covers order UPDATE + ledger credit
- `POST /api/wallet/topup/verify-google` stub accepts token verbatim; real `androidpublisher` call deferred

### 9.3 交易系統 (Transaction / Settlement System)

**Status**: ✅ Primitives in place; P2-C will add rental-specific settlement flows
**Files**: `backend/wallet.js` — `transferEcoin`, `holdDeposit`, `releaseDeposit`, `forfeitDeposit`, `adminAdjust`; `backend/rental.js` — `startRental`, `endRental`

- Cross-module atomicity via shared `withTransaction` + `applyLedgerEntry`
- T+24h owner income settlement: will add `pending_income_mli` column in P2-C
- All mutations require `idempotency_key`

### 9.4 邀請碼賺 e幣 系統 (Referral System)

**Status**: 🔴 Not started (Phase 5)
**Planned**:
- `invite_codes` table with 6-char base32 code per user
- `invite_redemptions` ensures each new user can only be referred once
- Reward: inviter +500 e幣, invitee +100 e幣 (configurable)
- Fraud guards: device fingerprint, 7-day wait before reward, same-email-domain block

### 9.5 租賃契約管理系統 (Contract Management)

**Status**: ✅ P2-A/B complete; entity handover + grace period deferred
**Files**: `backend/rental.js` — `startRental`, `endRental`, `getMyContracts`, `CONTRACT_STATUSES`; `backend/rental_schema.sql`

- 9-state enum covering reserved, active, suspended, 6 terminal states
- Version lock via `rental_snapshots` table
- Deposit disposition matrix: full / 50% / 30% / 0% / 100% forfeit
- DB-layer exclusivity via partial UNIQUE index
- **Deferred to P2-C/F**:
  - Grace period cron (6–12h timer on `suspended_insufficient_funds`)
  - Entity handover (inserting rental entity into renter's `devices` slot)
  - Auto-expiration cron for `active → ended_normal`

### 9.6 Bot 面試 / 當機測試系統 (Interview + Crash Detection)

**Status**: 🟡 Scoring engine complete; HTTP dispatcher deferred
**Files**: `backend/bot-interview.js`

- 8 probes: greeting, python_exec, web_browse, reasoning, refusal_safety, summarization, vision, latency
- Pure regex + heuristic scoring (no LLM judge)
- Pass threshold: 60/100 weighted score
- `scoreInterview(responses)` emits `capabilities` JSON
- **Deferred to P1 follow-up**:
  - Actual HTTP POST dispatch to owner webhook
  - Response collection via `/api/transform` callback
  - `bot_interviews` table writes
  - Crash detection (re-running probes during dispute)

### 9.7 Token 計算預估系統 (Token Metering + Cost Estimation)

**Status**: 🔴 Not started (P2-C)
**Planned file**: `backend/rental-proxy.js`

Technical approach:
- Intercept `POST /api/client/speak` when `rentalContractId` is present
- Compute input tokens via `tiktoken` (or fallback `chars / 4` estimation)
- Forward message to `rental_snapshots.webhook_url` (never owner's live webhook)
- Receive bot response via `/api/transform`
- Compute output tokens via same method
- Atomic: renter debit + owner credit (net of fee) + platform fee + insurance pool + ledger entries + `rental_usage_events` row
- Threshold checks: if balance hits 0 → transition to `suspended_insufficient_funds`

Pre-rental estimation UI:
- Listing detail page shows "平均每次對話約 3,400 tokens ≈ 3.4 e幣" based on `listing.total_rentals` averages

### 9.8 預測租金 / 建議定價系統 (Pricing Advisor)

**Status**: ✅ Static rules complete; market data feed deferred
**Files**: `backend/pricing-advisor.js`

- `detectFamily()` regex detects model from listing's `model_detected` field
- `BASE_RATE_MLI_PER_KTOKEN` lookup table
- Capability multiplier: +30% per supported tool
- Band width: ±40% (high confidence) or ±60% (low)
- `classifyRate()` buckets owner choice vs suggestion
- **Deferred**:
  - `pricing_market_snapshots` cron (hourly aggregation from real listings)
  - Demand-factor adjustment (recent rental success rate per family)

### 9.9 點交系統 (Handover System)

**Status**: 🔴 Financial side complete (startRental / endRental); **entity-level handover not started** (P2-F)
**Planned approach**:

At `startRental` success:
1. Look up renter's next empty entity slot (`devices[renterDeviceId].entities[i].isBound === false`)
2. Insert a synthetic rental entity:
   ```js
   devices[renterDeviceId].entities[slot] = {
       character: listing.character,
       avatar: listing.avatar,
       webhook: { url: PROXY_URL + `?contractId=${contract.id}` },
       rental_contract_id: contract.id,
       rental_snapshot_id: contract.id,
       // ... minimal stub; do NOT copy owner's deviceSecret
   };
   ```
3. Update `rental_contracts.renter_entity_slot = slot`
4. Mark owner's entity: `rental_status = 'leased_out'`, `rental_contract_id = contract.id`
5. Emit `entity:rental-start` and `entity:leased-out` Socket.IO events
6. Auto-expand renter's slot count if no empty slot available (reuse existing `ensureOneEmptySlot` from `index.js`)

At `endRental` success (reverse):
1. Remove rental entity from renter's device
2. Clear owner's `rental_status` / `rental_contract_id`
3. Emit `entity:rental-end` + `entity:leased-in-returned`

**Complication**: the in-memory `devices` map is managed from `index.js`, not `rental.js`. Handover logic lives in `index.js` as a callback passed into the rental module, OR rental module receives `devices` as a factory arg (mirrors how `auth.js` receives it).

### 9.10 Bot 能力評估系統 (Capability Assessment)

**Status**: ✅ Output structure defined; feeds into listing capabilities JSON
**Files**: `backend/bot-interview.js` (`scoreInterview` → capabilities), `backend/pricing-advisor.js` (`countCapabilities`)

Output JSON shape:
```json
{
  "python_exec": { "supported": true, "probes": [{"id": "python_exec", "passed": true}] },
  "web_browse":  { "supported": true, "probes": [...] },
  "vision":      { "supported": false, "probes": [...] },
  "reasoning":   { "supported": true, "probes": [...] }
}
```

Categories come from probe `.category` field. `supported = OR(passed across probes in category)`.

### 9.11 租借後協作系統 (Post-Rental Collaboration)

**Status**: 🔴 Not started (P2-E)

Allowed operations on rental entities:
- ✅ Appear in `/api/entities` list with `rental_contract_id` field
- ✅ Receive `speakTo` calls (messages routed through rental-proxy for metering)
- ✅ Receive `broadcast` calls (same)
- ✅ Assignable in `kanban_cards.assigned_bots`
- ✅ Read `mission_notes` and `rules`

Blocked operations (return 403):
- ❌ `PATCH /api/entities/:id/rename`
- ❌ `DELETE /api/entities/:id`
- ❌ `PUT /api/entity/identity`
- ❌ `POST /api/rental/listing` (no sub-leasing)
- ❌ Cross-device `speakTo` to owner's own device

Enforcement point: middleware on the `/api/entities/:id/*` routes checks `entity.rental_contract_id` and gates based on the HTTP method + path.

Rate limit: 30 req/min via `express-rate-limit` keyed on `rental_contract_id`.

---

## 10. Phase Plan & Delivery Tracking

### 10.1 Phase overview

| Phase | Theme | Scope | Status | PR(s) |
|-------|-------|-------|--------|-------|
| **P0** | Wallet foundation | `wallets`, `wallet_ledger`, `topup_orders`, primitives, reconcile cron | ✅ Complete | #1656 commits `a5dd33ea`, `6938c92d`, `073a125b` |
| **P1** | Listings + advisor | `bot_listings`, `bot_interviews`, listing CRUD, marketplace, interview scoring, pricing advisor | 🟡 Foundation done; HTTP probe dispatch + market snapshot cron pending | #1656 commit `073a125b` |
| **P2** | Contract core | Contract state machine, atomic start/end, version lock, token metering proxy, grace period, entity handover, gatekeeper extension, A2A collab | 🟡 P2-A/B done (financial); P2-C/D/E/F pending | #1656 commit `267c09d7` |
| **P3** | Trust layer | Reviews, disputes, credit score, fraud detection, admin workqueue | 🔴 Not started | — |
| **P4** | Risk management | Insurance pool, blacklist, SLA display, notifications, audit hardening | 🔴 Not started | — |
| **P5** | Growth | Referral codes, invite bonuses, market incentives | 🔴 Not started | — |

### 10.2 Detailed task tracker

Legend: ✅ done, 🟡 partial, 🔴 not started, 🔒 human-blocked

#### P0 — Wallet foundation

- ✅ `wallet_schema.sql` — wallets, wallet_ledger, topup_orders
- ✅ `wallet.js` — transferEcoin, holdDeposit, releaseDeposit, forfeitDeposit, adminAdjust
- ✅ `creditTopup`, `createTopupOrder`, `markTopupPaid`
- ✅ `TOPUP_TIERS` catalog + `GET /topup/tiers`
- ✅ `POST /topup/verify-google` (stub)
- ✅ `POST /admin/grant`, `GET /admin/reconcile`
- ✅ Route mounting in `index.js` with deferred init
- ✅ Daily reconcile cron
- ✅ Wallet portal page with i18n (en + zh-TW)
- ✅ 48 Jest tests (input validation, idempotency, atomicity, route)
- 🔒 Real Google Play `purchaseToken` verification (requires `GOOGLE_PLAY_SERVICE_ACCOUNT` env)
- 🔒 Apple IAP integration
- 🔒 TapPay chargeback webhook (TapPay currently unavailable)
- 🔒 10+ language i18n translations (needs native speakers)

#### P1 — Listings + advisor

- ✅ `rental_schema.sql` — bot_listings, bot_interviews, rental_contracts, rental_snapshots, rental_usage_events, pricing_market_snapshots
- ✅ `rental.js` — createListing, updateListing, publishListing, pauseListing, delistListing, getListing, listMyListings, searchMarketplace
- ✅ Whitelist enforcement for locked-after-interview fields
- ✅ Marketplace route with rate/capability/sort filters
- ✅ `bot-interview.js` — 8 probes + pure scoring
- ✅ `pricing-advisor.js` — base rates + capability multiplier + band classification
- ✅ Factory hard-fail on missing `authMiddleware` / `walletModule`
- ✅ 64 Jest tests across rental-listing, bot-interview, pricing-advisor
- 🔴 HTTP probe dispatcher — POST to owner webhook, collect via `/api/transform` callback
- 🔴 `bot_interviews` table writes during live interviews
- 🔴 Interview rate limit enforcement (3/listing/7d)
- 🔴 Market snapshot cron (hourly aggregation)
- 🔴 Marketplace portal page (`marketplace.html`)
- 🔴 Listing editor portal page
- 🔴 Interview runner UI
- 🔒 Android `MarketplaceActivity.kt` (feature parity rule)
- 🔒 iOS marketplace screen

#### P2 — Contract core

- ✅ `rental_contracts` table + state machine enum
- ✅ `rental_snapshots` version-lock table
- ✅ DB-layer exclusivity via partial UNIQUE index
- ✅ `startRental` — atomic 9-step cross-module transaction
- ✅ `endRental` — deposit disposition matrix
- ✅ `getMyContracts` with role filter
- ✅ `POST /contract`, `POST /contract/:id/end`, `GET /my-contracts`
- ✅ `wallet.js` exposes `withTransaction` + `applyLedgerEntry` for cross-module atomicity
- ✅ 25 contract lifecycle Jest tests
- 🔴 **P2-C**: Token metering proxy (`rental-proxy.js`)
  - 🔴 Intercept `POST /api/client/speak` when `rentalContractId` present
  - 🔴 `tiktoken` input/output counting
  - 🔴 Forward to snapshot webhook (not live listing webhook)
  - 🔴 Atomic debit / credit / fee split per message
  - 🔴 `rental_usage_events` row insertion
  - 🔴 Transition to `suspended_insufficient_funds` on exhaustion
  - 🔴 Grace period cron (6–12h timer + push notifications)
  - 🔴 T+24h `pending_income` release cron
  - 🔴 Contract auto-expiration cron (`active → ended_normal` on `ends_at`)
- 🔴 **P2-D**: Privacy & gatekeeper extension
  - 🔴 Extend `gatekeeper.js` with rental context
  - 🔴 Sensitive data interception (credit cards, IDs, passwords, API keys)
  - 🔴 Prompt injection detection for rental direction
  - 🔴 Vault isolation: block `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD` from rental entity
  - 🔴 `allowed_vars` whitelist enforcement
  - 🔴 `gatekeeper_violations` table + 5-strike counter
- 🔴 **P2-E**: A2A collaboration bridging
  - 🔴 Middleware to reject rename/delete/identity-update on rental entities
  - 🔴 Sub-lease prevention (block rental entity from `POST /api/rental/listing`)
  - 🔴 Cross-speak-back-to-owner blocking
  - 🔴 30 req/min rate limit per rental_contract_id
- 🔴 **P2-F**: Entity handover
  - 🔴 Insert rental entity into renter's `devices[deviceId].entities[slot]` on start
  - 🔴 Mark owner entity `rental_status = 'leased_out'`
  - 🔴 Emit Socket.IO events (`entity:rental-start`, `entity:leased-out`, `entity:rental-end`)
  - 🔴 Half-transparent UI overlay on owner's dashboard
  - 🔴 Rental entity shows `🔒` badge on renter's dashboard
  - 🔴 Reverse handover on `endRental`

#### P3 — Trust layer

- 🔴 `bot_reviews` table + `POST /contract/:id/review`
- 🔴 `disputes` table + `POST /contract/:id/dispute` + admin resolution endpoints
- 🔴 Auto-verify crash path (re-probe bot, compare to interview baseline)
- 🔴 `user_credit_scores` cron + badge
- 🔴 `fraud_detection.js` — device fingerprint, IP, email domain, sybil attack patterns
- 🔴 Admin dashboard extension: disputes queue, fraud alerts, manual adjust UI
- 🔴 `gatekeeper.js` content audit extension (optional — only if rule #19 expands)

#### P4 — Risk management

- 🔴 Insurance pool virtual wallet (`INSURANCE_POOL_USER_ID` constant already defined)
- 🔴 Insurance pool ledger (separate append-only)
- 🔴 Automatic routing of forfeited deposits + SLA miss compensation
- 🔴 `user_blacklist` table + enforcement middleware
- 🔴 Cooldown after contract end (24h repeat-rental prevention)
- 🔴 SLA stats cron (uptime, latency, crash count)
- 🔴 Listing detail page badge: "30-day uptime: 99.2%"
- 🔴 Notification triggers: push on grace period, contract end, payout, rating received
- 🔴 Audit log hardening: `admin_audit_log` append-only table with DB-level DELETE/UPDATE trigger
- 🔴 Age confirmation backfill modal
- 🔴 KYC hook for monthly top-up > NT$3000 (record flag only, actual KYC is human)

#### P5 — Growth

- 🔴 `invite_codes` + `invite_redemptions` tables
- 🔴 `/api/invite/*` endpoints
- 🔴 Referral reward distribution (with sybil guards)
- 🔴 Share link: `https://eclawbot.com/invite/XXXXXX`
- 🔴 Invite dashboard page

---

## 11. Technical Deep Dives

### 11.1 Cross-module transactional atomicity

**The problem**: `rental.js` and `wallet.js` each own their own PG pool (matching the existing `auth.js`, `mission.js`, `subscription.js` pattern). When starting a rental, we need to:

1. Read listing (`bot_listings`)
2. Insert contract (`rental_contracts`)
3. Insert snapshot (`rental_snapshots`)
4. Hold deposit (write `wallet_ledger`, update `wallets`)

Steps 1–3 are owned by rental.js; step 4 is owned by wallet.js. If these run in two separate transactions, a crash between them leaves either "contract with no held deposit" or "held deposit with no contract".

**The solution**: `wallet.js` exposes `withTransaction(fn)` and `applyLedgerEntry(client, args)` as public factory-return values. `rental.js`'s factory takes a `walletModule` dependency and runs its contract writes *inside* `walletModule.withTransaction`'s client:

```js
return walletModule.withTransaction(async (client) => {
    // all rental.js SQL uses `client.query(...)` not `pool.query(...)`
    await client.query('SELECT ... FROM bot_listings WHERE id = $1 FOR UPDATE', [listingId]);
    await client.query('INSERT INTO rental_contracts ...');
    await client.query('INSERT INTO rental_snapshots ...');
    // cross-module ledger write — same client, same transaction
    await walletModule.applyLedgerEntry(client, {
        userId: renterUserId,
        balanceDelta: -depositMli,
        heldDelta: depositMli,
        type: LEDGER_TYPES.DEPOSIT_HOLD,
        idempotencyKey: `rental-hold:${contract.id}`,
    });
});
```

Both modules' pools connect to the same DB, so a client from either pool sees the same row locks and constraint enforcement.

**Tradeoff accepted**: `rental.js` gains a build-time dependency on wallet.js's internal structure. Factory hard-fails if `walletModule.withTransaction` isn't a function, catching wiring errors at startup.

### 11.2 Version locking via snapshots

**The problem**: Owner can freely update listing title, rate, and (theoretically) bot config. Mid-contract changes to the bot's identity or webhook would break the renter's expectation.

**The solution**: At `startRental`, the contract's `rate_mli_per_ktoken_snapshot` column captures the rate at that instant. A companion `rental_snapshots` row stores frozen copies of `identity`, `rules`, `skills`, `webhook_url`, and `allowed_vars`.

Runtime lookups (in the future rental-proxy) **must read from the snapshot**, never from the live listing:

```js
// WRONG
const webhook = await db.query('SELECT webhook FROM entities WHERE ...', [owner.deviceId, listing.entityId]);

// RIGHT
const snapshot = await db.query('SELECT webhook_url FROM rental_snapshots WHERE contract_id = $1', [contractId]);
```

This also provides a forensic trail: if a dispute arises, we can reconstruct exactly what the renter agreed to.

### 11.3 Token metering strategy (P2-C)

**Why pure backend estimation?**

Two alternatives were considered:

- **A. Bot self-reports `usage`** in its `/api/transform` callback — precise but forgeable.
- **B. Backend-only estimation** via `tiktoken` on the message bodies flowing through the proxy — less precise but unforgeable.

After user debate, B was chosen:

> 一切使用 `(in + out) × rate / 1000` 計算較公平，這樣也就不會有被盜刷的可能性

**Implementation outline** (for P2-C):

```js
// backend/rental-proxy.js (planned)
async function proxyRentalMessage(req, res, { contract, snapshot }) {
    const renterMessage = req.body.message;
    const inputTokens = estimateTokens(renterMessage);
    const inputCost = Math.ceil(inputTokens * contract.rate_mli_per_ktoken_snapshot / 1000);

    // Pre-debit input cost (fail fast if insufficient)
    try {
        await walletModule.withTransaction(async (client) => {
            await chargeRenter(client, contract, inputCost, 'in', inputTokens);
        });
    } catch (err) {
        if (err.message === 'insufficient_balance') {
            await markContractSuspended(contract.id);
            return res.status(402).json({ success: false, error: 'insufficient_balance' });
        }
        throw err;
    }

    // Forward to owner webhook via the snapshot URL (not live listing)
    const ownerResponse = await fetch(snapshot.webhook_url, { /* ... */ });
    const responseText = await ownerResponse.text();
    const outputTokens = estimateTokens(responseText);
    const outputCost = Math.ceil(outputTokens * contract.rate_mli_per_ktoken_snapshot / 1000);

    // Debit output cost (best-effort — if balance went to 0 during the owner's
    // response, the final message still completes but contract transitions)
    await walletModule.withTransaction(async (client) => {
        try {
            await chargeRenter(client, contract, outputCost, 'out', outputTokens);
        } catch (err) {
            if (err.message === 'insufficient_balance') {
                // Deduct remainder from deposit as a last-resort charge
                await chargeFromDeposit(client, contract, outputCost);
                await markContractSuspended(contract.id);
            } else {
                throw err;
            }
        }
    });

    return res.json({ success: true, response: responseText });
}

function estimateTokens(text) {
    // tiktoken is ideal; fallback: ceil(chars / 4) for English/mixed input
    if (typeof text !== 'string') return 0;
    return Math.max(1, Math.ceil(text.length / 4));
}
```

**Fee split** happens inside `chargeRenter`:
```js
async function chargeRenter(client, contract, costMli, direction, tokens) {
    const platformFeeMli = Math.floor(costMli * PLATFORM_FEE_BPS / 10000);
    const insuranceMli = Math.floor(costMli * INSURANCE_POOL_BPS / 10000);
    const ownerShareMli = costMli - platformFeeMli;  // owner gets 85%
    const platformNetMli = platformFeeMli - insuranceMli;  // 13%

    // Debit renter
    await walletModule.applyLedgerEntry(client, {
        userId: contract.renter_user_id,
        balanceDelta: -costMli,
        heldDelta: 0,
        type: LEDGER_TYPES.RENTAL_SPEND,
        refType: 'rental_contract',
        refId: contract.id,
        idempotencyKey: `rental-spend:${contract.id}:${messageId}:${direction}`,
    });

    // Credit owner pending_income (NEW: needs pending_income_mli column in P2-C)
    await client.query(
        `UPDATE wallets SET pending_income_mli = pending_income_mli + $1 WHERE user_id = $2`,
        [ownerShareMli, contract.owner_user_id]
    );

    // Credit platform wallet (debit renter already happened)
    await walletModule.applyLedgerEntry(client, {
        userId: PLATFORM_WALLET_USER_ID,
        balanceDelta: platformNetMli,
        heldDelta: 0,
        type: LEDGER_TYPES.PLATFORM_FEE,
        refType: 'rental_contract',
        refId: contract.id,
        idempotencyKey: `rental-fee:${contract.id}:${messageId}:${direction}`,
    });

    // Credit insurance pool
    await walletModule.applyLedgerEntry(client, {
        userId: INSURANCE_POOL_USER_ID,
        balanceDelta: insuranceMli,
        heldDelta: 0,
        type: LEDGER_TYPES.PLATFORM_FEE,
        refType: 'rental_contract',
        refId: contract.id,
        idempotencyKey: `rental-ins:${contract.id}:${messageId}:${direction}`,
        note: 'insurance pool',
    });

    // Record the usage event
    await client.query(
        `INSERT INTO rental_usage_events (contract_id, direction, tokens, ecoin_charged_mli, message_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [contract.id, direction, tokens, costMli, messageId]
    );

    // Update contract aggregates
    await client.query(
        `UPDATE rental_contracts
         SET tokens_consumed = tokens_consumed + $1,
             ecoin_charged_mli = ecoin_charged_mli + $2
         WHERE id = $3`,
        [tokens, costMli, contract.id]
    );
}
```

**Open decision** for P2-C: does input-cost check debit immediately (pre-debit) or just read-check? Pre-debit is more conservative but complicates rollback if the owner's webhook fails. Current plan: pre-debit input, best-effort debit output.

### 11.4 Privacy isolation trade-offs

**What we CAN enforce**:
- Renter never sees owner's `deviceSecret`
- Renter never sees owner's live `webhook_url` (proxied via `rental_snapshots.webhook_url` which is looked up server-side)
- Renter never sees other rental contracts or users
- `device_vars` vault isolation (P2-D): `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD` keys blocked from rental entity reads unless explicitly whitelisted by owner in `allowed_vars`

**What we CANNOT enforce** (admitted in design decision #17):
- Owner logs every incoming message on their backend (OpenClaw, Zeabur, their own box)
- Owner can introspect bot conversation content from their own infrastructure

**Mitigation**: Transparency + user consent.
- Rental contract disclosure modal: "Your conversation will be transmitted to the owner's server. Do not share sensitive information."
- Chat UI banner: "⚠️ You are talking to a rented bot. Avoid sharing credit cards, passwords, or personal IDs."
- Gatekeeper-level interception: before a message leaves to the rental proxy, scan for sensitive patterns. If detected, show a rich card: "Detected: credit card number. Send anyway?" — user explicitly ACKs before delivery.
- Logged as `sensitive_data_acknowledged` evidence for dispute cases.

### 11.5 Reconciliation invariants

Every wallet mutation goes through `applyLedgerEntry`, which atomically:
1. Locks the wallet row
2. Reads current balance + held
3. Computes new values
4. Rejects if either would go negative (CHECK constraints also enforce this)
5. Updates the wallet row
6. Inserts the ledger row (with unique idempotency_key)

Invariant: **at all times**, for every `user_id` w:

```sql
w.balance_mli = SUM(delta_mli) WHERE user_id = w.user_id
w.held_mli    = SUM(held_delta_mli) WHERE user_id = w.user_id
```

The daily reconcile cron runs a single CTE query that surfaces any violations. Zero drift for 30 consecutive days is the acceptance criteria for declaring the wallet system "trusted" (Goal G3).

---

## 12. Privacy, Security & Compliance

### 12.1 OWASP considerations

| OWASP item | Mitigation |
|------------|------------|
| A01 Broken Access Control | Every endpoint gated by `authMiddleware`; ownership checks in `updateListing`, `publishListing`, `endRental` |
| A02 Cryptographic Failures | e-coin balances stored as plain BIGINT (not sensitive); `idempotency_key` is a public value |
| A03 Injection | All queries use `$1`-style parameterization; no string concatenation |
| A04 Insecure Design | Partial UNIQUE index enforces exclusivity at DB layer (defense in depth against app bugs) |
| A05 Security Misconfiguration | Factory hard-fails on missing `authMiddleware` / `walletModule` — no silent fallback |
| A07 Identification & Auth Failures | Reuses existing JWT cookie auth from `auth.js` |
| A08 Software & Data Integrity Failures | Append-only ledger; daily reconciliation cron |
| A09 Logging & Monitoring | All rental/wallet mutations write to `server_logs` via `serverLog` callback |
| A10 SSRF | Owner webhook URLs are validated at interview time (TODO: explicit allowlist scheme) |

### 12.2 Compliance notes

**Taxation**: System records top-up history but does not file taxes. Owner is responsible for reporting rental income. Google Play Console handles user-side tax collection per Google's merchant rules.

**AML / KYC**: Fixed exchange rate + non-convertible e-coin + app-store-mediated top-ups significantly reduce AML exposure. A flag is recorded when a user tops up > NT$3000 in a month (`kyc_required = TRUE`), but no automated KYC runs — this is a stub for future manual review.

**Age compliance**: `age_confirmed_at` column + rental-time modal collect explicit consent with IP + timestamp logged as legal evidence.

**Data retention**: `wallet_ledger` retained forever (audit requirement). `server_logs` retained for 7 years (tax requirement). `rental_usage_events` can be pruned after 90 days for privacy, keeping only aggregates on `rental_contracts`.

---

## 13. Open Issues & Risks

### 13.1 Known open issues

| # | Issue | Impact | Mitigation |
|---|-------|--------|------------|
| O1 | Google Play `purchaseToken` trusted verbatim | Critical if deployed as-is | Deploy only after integrating `androidpublisher` verify + `GOOGLE_PLAY_SERVICE_ACCOUNT` env |
| O2 | TapPay chargeback webhook missing | Moderate — manual reversal only | Deferred until TapPay re-enabled |
| O3 | No rental-proxy yet — rental contracts can start but tokens can't be charged | Blocks end-to-end rental | P2-C is the next priority |
| O4 | Entity handover not implemented — rented bot doesn't appear in renter's dashboard | Blocks UX | P2-F — requires touching `index.js` devices map |
| O5 | Grace period cron not implemented — contracts can't auto-suspend | Blocks insufficient-balance path | P2-C |
| O6 | `pending_income_mli` column missing from wallets | Blocks T+24h settlement | P2-C — migration |
| O7 | Pre-existing flaky Jest suites (note-pages, cross-speak, mutations, mission) | Passes individually, flakes under parallel run | Root cause: leaked timers; unrelated to BRM — owner-track issue |
| O8 | wallet.html + rental.html i18n only in en + zh-TW | Breaks design principle for 10+ languages | Human translation pass required |
| O9 | Android + iOS marketplace/wallet screens missing | Violates CLAUDE.md Feature Parity Rule | Native dev cycle required |
| O10 | No `pricing_market_snapshots` data yet — advisor only uses hard-coded base rates | Advisor suggestions are static | Hourly cron after first 10+ real listings exist |

### 13.2 Architectural risks

| # | Risk | Probability | Impact | Mitigation |
|---|------|-------------|--------|------------|
| R1 | Ledger drift under high concurrency | Low | Critical | Row-locking + daily reconcile + strict idempotency keys |
| R2 | Cross-module transaction deadlock | Low | High | Lock ordering in `transferEcoin` (sort user_ids); single-transaction contract flow |
| R3 | Insufficient test coverage for P2-C+ (token metering edge cases) | High | High | Require 100% statement coverage for rental-proxy.js before ship |
| R4 | Owner bot returning huge responses drains renter balance | Medium | Medium | Pre-compute input cost before forwarding; cap output tokens per message (e.g. 8K) |
| R5 | Renter abuses rental entity's A2A access to leak bot to own bots | Low | Medium | Rate limit + cross-speak block (P2-E) |
| R6 | Dispute flood from bad-actor renters claiming crashes | Medium | High | Auto-verify crash detection + credit score penalty for false claims |
| R7 | Insurance pool gets drained faster than commission replenishes | Low | Critical | Cap SLA compensation per incident; require admin approval above threshold |
| R8 | Owner's actual token cost on their platform exceeds what we charge renter | High | Low | Owner problem — they can adjust rate or delist |

### 13.3 Business risks

- **Cold start**: Marketplace needs both sides to be useful. Consider seeding with platform-operated bots.
- **Pricing war**: Owners may undercut each other aggressively. Pricing advisor shows warnings but does not enforce floors.
- **Dispute escalation**: Initial 1-person admin team cannot scale beyond ~50 disputes/day. Build auto-routing + templates early.

---

## 14. Rollout Plan

### 14.1 Staged rollout

| Stage | Audience | Criteria |
|-------|----------|----------|
| Dev | Hank only (admin) | All P0 + P1 + P2-A/B complete; PR #1656 merged to main |
| Alpha | 5 hand-picked testers | P2-C token metering + P2-F handover + basic dispute path |
| Beta | Invite-only (<100 users) | P3 reviews + disputes + SLA stats |
| GA | Open to all | P4 insurance pool + blacklist + P5 referrals + all 12 languages |

### 14.2 Kill switches

Admin endpoints provide manual overrides for emergencies:

- `POST /api/rental/admin/pause-marketplace` — reject all new rentals, existing continue
- `POST /api/rental/admin/contract/:id/force-end` — emergency close
- `POST /api/wallet/admin/grant` — already implemented; useful for compensation
- Environment flag: `RENTAL_MARKETPLACE_ENABLED=false` disables route mounting entirely

### 14.3 Migration strategy

No existing users have wallets yet, so P0 deployment is additive (just new tables + modules). No data migration needed. Future phases that add columns (`pending_income_mli`, etc.) will use `ALTER TABLE ADD COLUMN IF NOT EXISTS` with sensible defaults.

---

## 15. Test Strategy

### 15.1 Current test coverage

As of PR #1656:

| File | Tests | Coverage |
|------|-------|----------|
| `wallet.test.js` | 48 | wallet primitives, idempotency, routes, reconcile, HTTP validation |
| `rental-listing.test.js` | 23 | listing CRUD, ownership, locked fields, marketplace search |
| `rental-contract.test.js` | 25 | contract lifecycle, deposit disposition, exclusivity, self-rental |
| `bot-interview.test.js` | 24 | probe scoring, edge cases, capability aggregation |
| `pricing-advisor.test.js` | 17 | family detection, rate suggestion math, classification |
| **Total BRM tests** | **137** | |

All use an in-memory `pg` simulator so tests run in <2s without any real DB.

### 15.2 What tests do NOT cover (yet)

- Real PostgreSQL concurrency (race conditions between two nodes)
- Google Play purchase verification (needs test service account)
- Socket.IO event emissions (entity:rental-start, etc.)
- Interview HTTP dispatch (P1 follow-up)
- Token metering proxy (P2-C)
- Gatekeeper interception (P2-D)
- A2A rate limiting (P2-E)

### 15.3 Integration test plan

Before GA, add `backend/tests/test-rental-e2e.js` that:

1. Creates 2 real devices with test credentials
2. Runs a full lifecycle against the live server: list → interview → rent → chat → end
3. Verifies wallet balances before and after
4. Verifies `rental_usage_events` row count matches messages sent
5. Runs reconcile and asserts 0 drift
6. Registered in CLAUDE.md "Regression Tests" table

### 15.4 Load test plan

Before GA, simulate:
- 100 concurrent active rentals on the same server
- 500 messages/second across all rentals
- Verify p99 rental-proxy latency < 500ms
- Verify reconcile cron catches any drift within 24h

---

## 16. File Map

### 16.1 New files (added by BRM)

```
backend/
├── wallet_schema.sql          # wallets, wallet_ledger, topup_orders
├── wallet.js                  # Wallet primitives + routes
├── rental_schema.sql          # bot_listings, bot_interviews, rental_*,
│                              # pricing_market_snapshots
├── rental.js                  # Listing CRUD + contract lifecycle + routes
├── bot-interview.js           # Probe catalogue + pure scoring
├── pricing-advisor.js         # Rate suggestion formulas
├── rental-proxy.js            # [P2-C] Token metering proxy
├── public/
│   ├── portal/
│   │   ├── wallet.html        # User wallet page (balance + tiers + history)
│   │   └── marketplace.html   # [P1 follow-up] Marketplace search page
│   └── shared/
│       └── i18n.js            # Added wallet_* keys (en + zh-TW so far)
└── tests/jest/
    ├── wallet.test.js
    ├── rental-listing.test.js
    ├── rental-contract.test.js
    ├── bot-interview.test.js
    └── pricing-advisor.test.js
```

### 16.2 Modified files

```
backend/
├── index.js                   # walletModule + rentalModule wiring,
│                              # daily reconcile cron,
│                              # nodeCron schedule for wallet audit
├── mission.js                 # [Unrelated fix] removed duplicate
│                              # decryptVarsLocal declaration (was a
│                              # pre-existing bug blocking CI)
└── public/shared/i18n.js      # 33 new wallet_* keys
```

### 16.3 Planned files (future phases)

```
backend/
├── rental-proxy.js            # P2-C: token metering HTTP proxy
├── rental-handover.js         # P2-F: entity insertion/removal + Socket.IO
├── gatekeeper-rental.js       # P2-D: sensitive data interception (or
│                              # extension to existing gatekeeper.js)
├── fraud-detection.js         # P3: device fingerprint + rule engine
├── bot-interview-runner.js    # P1 follow-up: HTTP probe dispatcher
└── scripts/
    ├── wallet-reconcile.js    # Standalone reconcile script (cron-callable)
    ├── rental-grace-sweep.js  # P2-C: grace period expiration cron
    ├── rental-expire-sweep.js # P2-C: contract auto-expiration cron
    └── pricing-snapshot-cron.js # P1 follow-up: hourly market aggregation

backend/public/portal/
├── rental-listing-edit.html   # P1: listing editor
├── rental-contract-detail.html # P2: contract viewing page
└── admin-rental.html          # P3: admin dispute workqueue
```

---

## Appendix A: Design decision history

This document represents the final state. The negotiation history (initial Q&A about metering, deduction order, bot exclusivity, grace period length, etc.) is preserved in the memory file [`project_bot_rental_system.md`](../../memory/project_bot_rental_system.md) (Claude's local memory, not in git) and in the session transcript that produced PR #1656.

## Appendix B: Glossary

| Term | Definition |
|------|------------|
| **BRM** | Bot Rental Marketplace — this whole initiative |
| **mli (厘)** | Smallest wallet unit; 1 e幣 = 1000 mli |
| **Rate** | Amount in mli/1K tokens that a bot charges per rental usage |
| **Deposit** | Frozen portion of renter's balance held for the contract's duration (= rate × 20) |
| **Held** | The column (`held_mli`) that stores frozen deposit — separate from spendable `balance_mli` |
| **Snapshot** | A frozen copy of a listing's config at contract start; read instead of live listing during rental runtime |
| **Interview** | Automated probe-and-score sequence that verifies bot capabilities |
| **Probe** | A single input prompt sent to a bot during interview |
| **Gatekeeper** | Existing EClaw module that filters messages for prompt injection / abuse |
| **Handover** | The mechanical step of inserting the rental bot into the renter's device entity slot (and removing on contract end) |
| **Ledger** | `wallet_ledger` table — append-only record of every balance mutation |
| **Idempotency key** | String that uniquely identifies a mutation; duplicates return cached result without re-executing |
| **Vault** | The `device_vars` storage that holds secrets like API keys; protected from rental entities |

## Appendix C: Related documents

- [memory/project_bot_rental_system.md](/Users/hank/.claude/projects/-Users-hank-Desktop-Project-EClaw/memory/project_bot_rental_system.md) — Design decision log (Claude memory, not in git)
- [backend/wallet_schema.sql](../../backend/wallet_schema.sql) — Wallet DDL
- [backend/rental_schema.sql](../../backend/rental_schema.sql) — Rental marketplace DDL
- [CLAUDE.md](../../CLAUDE.md) — Project conventions (auto-memory, test rules, workflow)
- [PR #1656](https://github.com/HankHuang0516/EClaw/pull/1656) — Ongoing implementation thread

---

*End of document*
