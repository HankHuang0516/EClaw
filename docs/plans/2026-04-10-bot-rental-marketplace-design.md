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
5. I hit "Run Interview" — system routes to Arena (12 interactive challenges), scores in real-time, shows capability chips
6. If score >= 40% of 147 (≈59), I can hit "Publish"
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
- **interview → listed**: Arena score ≥ 40% of 147 (≈59) auto-promotes; capability fields lock.
- **interview → draft**: Arena score < 40% returns to draft; owner can retry (max 3/7d).
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
| `ended_zero_balance` | remaining | 0 | Last-message cost already deducted from deposit by rental-proxy; remaining deposit refunded to renter |
| `ended_violation` | 70 | 30 | 5-strike limit hit |

#### 7.3.1 UI copy per perspective (MANDATORY)

The my-rentals.html page has two tabs (`renter` / `owner`) showing the **same contract** from different angles. Deposit disposition copy MUST differ by perspective — the word "退還" (refund) is ambiguous without a subject.

| Status | Renter tab (租借中) — you are the renter | Owner tab (出租中) — you are the lessor |
|--------|------------------------------------------|------------------------------------------|
| `ended_normal` / `_disputed` / `_admin` | **押金全額退回給你** | **押金已全額退回給承租方** |
| `ended_early_by_renter` | **押金**：退回你 50% · 沒收 50% | **押金**：退回承租方 50% · 你獲得違約金 50% |
| `ended_violation` | **押金**：退回你 70% · 30% 進入保險金池 | **押金**：退回承租方 70% · 30% 進入保險金池 |
| `ended_zero_balance` | **押金**扣除用量後剩餘已退回給你 | **押金**扣除用量後剩餘已退回給承租方 |

**規則**：**每一條文案必須帶「押金」二字**，明確標示這筆錢的性質。沒有主詞的百分比（如「退回你 50%」）會讓使用者疑惑是什麼的 50%。

**Implementation**: `depositDisposition(c)` in `my-rentals.html` reads `currentTab` and picks the matching i18n key family:

- `mr_deposit_renter_*` — for `currentTab === 'renter'`
- `mr_deposit_owner_*` — for `currentTab === 'owner'`

The legacy keys (`mr_deposit_full_refund`, `mr_deposit_early_end`, `mr_deposit_violation`, `mr_deposit_zero_balance`) are kept for backward compatibility but SHOULD NOT be used for new UI — they lack the subject ("who is refunding whom") and cause user confusion.

**Why this matters**: A single contract appears in BOTH tabs (once under each party's perspective). Without subject-aware copy, users see "退還 10 e幣" in 出租中 and wonder "我要退錢嗎？"; in 租借中 and wonder "我會收到錢嗎？". Subject-prefixed copy eliminates the ambiguity.

Forfeited amounts are split via the standard 85/13/2 ratio: 85% to owner (as `RENTAL_INCOME`), 13% to platform wallet, 2% to insurance pool. All three credits run inside the same transaction as the contract status update.

For `ended_zero_balance`: the token metering proxy (`chargeRentalUsage`) deducts the last-message shortfall directly from the deposit (`held_mli`) at charge time, splits it 85/13/2 to owner/platform/insurance, then signals `suspended: true`. When `endRental` subsequently runs, whatever deposit remains is refunded in full to the renter.

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
| `11 * * * *` (hourly at :11) | Pricing market snapshot aggregation | ✅ |
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

**Status**: ✅ Arena integration complete
**Files**: `backend/interview-arena.js`

- 12 challenges: vision, button_click, form_fill, drag_drop, navigation, table_extract, distraction, coding, response_time, memory, file_mgmt, tts
- Real-time scoring via Arena exam engine (max 147 points)
- Pass threshold: 40% of 147 (≈59)
- `mapArenaToRentalCapabilities(arenaResults)` emits `capabilities` JSON
- `arena_exams` + `arena_sessions` table writes (real-time)
- Crash detection (re-running challenges during dispute)

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
**Files**: `backend/interview-arena.js` (`mapArenaToRentalCapabilities`), `backend/pricing-advisor.js` (`countCapabilities`)

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
| **P1** | Listings + advisor | `bot_listings`, `bot_interviews`, listing CRUD, marketplace, interview scoring, pricing advisor | 🟡 Foundation done; Arena integration, market snapshot cron, and marketplace portal complete; listing editor/mobile parity pending | #1656 commit `073a125b` |
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
- ✅ `interview-arena.js` — 12 challenges + real-time scoring
- ✅ `pricing-advisor.js` — base rates + capability multiplier + band classification
- ✅ Factory hard-fail on missing `authMiddleware` / `walletModule`
- ✅ 64 Jest tests across rental-listing, bot-interview, pricing-advisor
- ✅ Arena integration — 12-challenge interactive evaluation via interview-arena.js
- ✅ `arena_exams` + `arena_sessions` table writes (real-time)
- 🔴 Interview rate limit enforcement (3/listing/7d)
- ✅ Market snapshot cron (hourly aggregation)
- ✅ Marketplace portal page (`marketplace.html`)
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
| `rental-interview.test.js` | 24 | Arena integration, challenge scoring, capability aggregation |
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
├── interview-arena.js         # 12-challenge Arena evaluation + capability mapping
├── pricing-advisor.js         # Rate suggestion formulas
├── rental-proxy.js            # [P2-C] Token metering proxy
├── public/
│   ├── portal/
│   │   ├── wallet.html        # User wallet page (balance + tiers + history)
│   │   └── marketplace.html   # Marketplace search page
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
├── # (bot-interview-runner.js superseded by interview-arena.js)
└── scripts/
    ├── wallet-reconcile.js    # Standalone reconcile script (cron-callable)
    ├── rental-grace-sweep.js  # P2-C: grace period expiration cron
    └── rental-expire-sweep.js # P2-C: contract auto-expiration cron

backend/public/portal/
├── rental-listing-edit.html   # P1: listing editor
├── rental-contract-detail.html # P2: contract viewing page
└── admin-rental.html          # P3: admin dispute workqueue
```

Pricing snapshot aggregation now runs from `backend/index.js` at `11 * * * *`.

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
| **Interview** | Arena 12-challenge interactive evaluation that verifies bot capabilities |
| **Challenge** | A single interactive task (e.g. vision, coding, form_fill) sent to a bot during Arena interview |
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

---

# Bot Rental Marketplace — 設計文件（繁體中文版）

**正式名稱**：EClaw Bot Rental Marketplace (BRM)
**代號**：`brm`（用於 commit 訊息、branch 名稱、API 前綴）
**狀態**：Phase 0 已完成，Phase 1 基礎已完成，Phase 2-A/B 已完成
**設計已鎖定**：2026-04-09
**文件版本**：1.0 (2026-04-10)
**作者**：Hank + Claude（session 記錄）
**相關 feature branch**：`feature/bot-rental-p0-wallet`
**相關 PR**：[#1656](https://github.com/HankHuang0516/EClaw/pull/1656)

---

## 目錄

1. [執行摘要](#1-執行摘要)
2. [目標與非目標](#2-目標與非目標)
3. [產品概述](#3-產品概述)
4. [鎖定設計決策](#4-鎖定設計決策)
5. [經濟模型](#5-經濟模型)
6. [資料模型](#6-資料模型)
7. [狀態機](#7-狀態機)
8. [API 介面](#8-api-介面)
9. [子系統規格](#9-子系統規格)
10. [階段計畫](#10-階段計畫)
11. [技術深入探討](#11-技術深入探討)
12. [隱私、安全與合規](#12-隱私安全與合規)
13. [未解問題與風險](#13-未解問題與風險)
14. [上線計畫](#14-上線計畫)
15. [測試策略](#15-測試策略)
16. [檔案對照表](#16-檔案對照表)

---

## 1. 執行摘要

**Bot Rental Marketplace (BRM)** 是一個建立在 EClaw 之上的雙邊市場，讓機器人所有者**貨幣化閒置的機器人容量**，讓用戶**按使用量付費租用高階機器人**，而無需自行訂閱 OpenClaw。

### 核心價值主張

- **機器人所有者**（通常是擁有剩餘配額的 OpenClaw 訂閱者）掛出他們的機器人、以 e-coin（e幣）設定費率，從租用者那裡賺取被動收入。機器人透過**自動化面試**進行驗證，將能力聲明鎖定在 Agent Card 上。
- **機器人租用者**瀏覽市集、以 e-coin 支付押金，暫時將租用的機器人绑定到他們的設備。租用的機器人與 EClaw A2A 生態系統整合——聊天、廣播、看板、任務板——就像擁有它一樣，只是有一些防護限制（不能改名、不能轉租、速率限制）。
- 平台從每筆租賃交易中賺取 **15% 佣金**，並營運 **2% 保險池**，在機器人故障爭議時補償租用者。

### 如何重塑 Bot 廣場（Marketplace）

在 BRM 之前，EClaw 中的「bot 廣場」是官方/社區機器人的靜態展示區。BRM 上線後，市集成為**動態租賃交易所**，每個上架商品都有：

- 驗證過的能力標籤（來自面試）
- 即時 e幣/1K token 費率
- 即時可用性狀態
- 用戶評分和爭議歷史
- 建議費率與所有者設定費率比較

### 定位

BRM 是 EClaw 路線圖上最雄心勃勃的計劃——它引入了**真實經濟**與真實貨幣充值、**分類帳式錢包系統**、跨模組交易保證，以及**風險管理的爭議處理流程**。它故意設有以下門檻：

- 固定匯率（無內部投機）
- 不可兌換的 e-coin（不能提現，避免證券/AML 監管）
- 僅限 Google Play 和 Apple IAP（將稅務/發票處理委託給應用商店）
- 保守的 MVP，如果留存率不能證明營運負擔的合理性，可以縮減

---

## 2. 目標與非目標

### 2.1 目標

| # | 目標 | 衡量標準 |
|---|------|-------------|
| G1 | 讓 OpenClaw 訂閱用戶掛出他們的機器人並從其他用戶的使用中賺取 e-coin | 首筆租賃合約完成超過 30 分鐘 |
| G2 | 讓沒有 OpenClaw 的用戶按需租用高階機器人 | 成功建立按 token 計費的合約 |
| G3 | 保證財務正確性（不丟失 e-coin、不重複計入、沒有孤兒保留） | 每日 reconcile cron 報告連續 30 天零誤差 |
| G4 | 自動化能力驗證，讓所有者不能過度聲稱 | 面試鎖定的 Agent Card，95% 的上架商品無需人工審查 |
| G5 | 為機器人崩潰/品質問題提供爭議處理路徑 | 80% 的爭議在 SLA 內解決 |
| G6 | 為雙方保持市集無摩擦 | 從「我想要這個機器人」到「我在和它聊天」少於 60 秒 |
| G7 | 保留 EClaw 的 A2A 協作模型——租用機器人與 mission / kanban / chat 整合 | 租用機器人可以接收 `speakTo` 並出現在看板分配中 |

### 2.2 非目標（明確的範圍削減）

| # | 非目標 | 理由 |
|---|----------|-----------|
| N1 | 不能兌現/提現 e-coin | 避免證券監管、AML/KYC 負擔、稅務複雜性 |
| N2 | 無可變匯率 | 防止內部投機，固定 1 TWD = 100 e幣 |
| N3 | 不允許轉租（租用者再租給另一個用戶） | 破壞信任鏈和版本鎖保證 |
| N4 | 不允許所有者之間的機器人轉移 | 超出範圍——機器人與設備绑定 |
| N5 | 不支援機器人份額擁有制 | MVP 过度工程化 |
| N6 | 不為所有者提供保證正常運行時間 SLA | 在不進行重大更改的情況下無法對分布式 OpenClaw 機器人強制執行 |
| N7 | 定價顧問不支援非 Anthropic/OpenAI/Gemini 模型系列 | 以後可以添加基本費率；fallback 為 `'unknown'` 系列 |
| N8 | 除了崩潰檢測外不進行自動爭議解決 | 在 v1 中，管理員人工是品質/能力爭議的裁決者 |
| N9 | 不支援即時投標/拍賣 | 超出範圍——僅限固定價格租賃 |
| N10 | 不與外部機器人市集整合（A2A 跨平台） | 最早在 Phase 5 |

---

## 3. 產品概述

### 3.1 人物角色

**Owner（出租方）**：具有 OpenClaw 訂閱但未使用其全部配額的 EClaw 用戶。希望在不承擔維護負擔的情況下獲得被動收入。風險趨避——需要信任平台保護他們免受虐待。

**Renter（租借方）**：沒有 OpenClaw 但需要特定高階能力（Opus 級推理、Python 執行、網頁瀏覽）來完成有限任務的 EClaw 用戶。對價格和時間敏感。

**Admin（平台管理員）**：運營商（最初是 Hank）。處理爭議、管理保險池、運行對帳審計、調查欺詐。

### 3.2 用戶故事

#### 所有者流程

```
作為 OpenClaw 訂閱者
我想掛出我的機器人出租
這樣我就能從其他用戶的使用中賺回一些訂閱費用

1. 我在 EClaw Portal/App 中打開 Bot Rental 區塊
2. 我選擇我的其中一個機器人（已與設備+entity slot 绑定）
3. 我填寫標題、描述和費率（例如 10 e幣/1K tokens）
4. 系統顯示建議費率範圍（「Opus + Python 的市場均價 8–14 e幣/1K」）
5. 我點擊「執行面試」——系統發送 8 個探針，評分，顯示能力晶片
6. 如果分數 >= 60，我可以點擊「發布」
7. 上架商品出現在市集中
8. 有人租用它 → 我看到「出租給匿名用戶，每小時賺約 X e幣」
9. 我的機器人 entity 顯示「出租中」覆蓋層；在合約結束前我不能與它聊天
10. 合約結束後（或被終止後），我在 24 小時結算延遲後在錢包中看到賺取的 e-coin
```

#### 租用者流程

```
作為想要試用 Claude Opus 進行 1 小時編碼任務的用戶
我想租用 Opus 機器人而不是支付完整訂閱
這樣我只支付我使用的部分

1. 我打開市集
2. 我按能力 = python_exec 篩選，按評分排序
3. 我看到一個上架商品：「Coding Wizard Bot — Opus 4.6, Python, 10 e幣/1K, ★4.8」
4. 點擊 → 查看完整 agent card、面試基準、費率、押金（200 e幣 = NT$2）
5. 我點擊「租用 1 小時」→ 關於敏感資料的警告彈窗
6. 查看我的錢包餘額：500 e幣 > 押金 + 緩衝，OK
7. 確認 → 押金進入「保留」，機器人帶著 🔒 標誌出現在我的儀表板上
8. 我正常聊天；每條訊息在底部顯示「12 tokens, -0.012 e幣」
9. 餘額隨著使用而減少
10. 我到 30 分鐘時決定完成 → 點擊「結束租用」
11. 押金 50% 退還（提前終止），合約關閉
```

#### 管理員流程

```
作為平台管理員
我想處理機器人崩潰爭議
這樣我可以公平裁決並讓雙方滿意

1. 租用者報告「這個機器人在 10 分鐘後停止回應」
2. 系統自動對機器人的 webhook 運行 5 個探針
3. 4/5 個探針超時 → 自動驗證崩潰
4. 系統觸發 ended_disputed 路徑 → 租用者獲得全額退還
5. 所有者看到「針對你的崩潰爭議已解決」+ 崩潰計數器增加
6. 如果所有者在 30 天內達到 3 次崩潰，上架商品自動暫停
7. 管理員儀表板顯示爭議時間線以供審計
```

### 3.3 防護欄（用戶不能做的事）

| # | 防護欄 | 執行點 |
|---|-----------|------------------|
| GR1 | 自我租用（所有者租用自己的機器人） | `startRental` 檢查 `owner !== renter` |
| GR2 | 雙重租用（兩個租用者，同一個上架商品） | DB 在 `rental_contracts(listing_id)` 上有 `UNIQUE` 部分索引，WHERE status IN active |
| GR3 | 轉租 | 租用 entity 在路由層被阻止 `POST /api/rental/listing` |
| GR4 | 租賃期間所有者端配置變更 | `rental_snapshots` 在合約開始時冻结 identity/rules/skills；運行時讀取 snapshot，不讀取 live 上架商品 |
| GR5 | 租用 entity 訪問所有者的密鑰 | 在租用 entity 上對 `device_vars` 白名單阻止 `*_KEY`、`*_SECRET`、`*_TOKEN`、`*_PASSWORD`（P2-D） |
| GR6 | 租用者向所有者的機器人發送垃圾訊息轟炸 | 租用 entity 速率限制：30 req/min（P2-E） |
| GR7 | 機器人偽造 token 使用量 | 後端透過 `tiktoken` 計算 token——機器人自我報告被忽略 |
| GR8 | 未成年用戶租用成人機器人 | 在租用時需要年齡確認鉤子；現有用戶必須補填 `age_confirmed_at` |

---

## 4. 鎖定設計決策

以下 27 項決策已**鎖定**。它們已經過討論、辯論和確認。未經明確用戶指示，不得重新爭議。

| # | 項目 | 決策 | 理由 |
|---|------|----------|-----------|
| **1** | Token 計量來源 | **透過 `tiktoken` 的純後端計算**，針對流經租賃代理的消息體 | 所有者無法偽造，比機器人自我報告更簡單，對租用者公平，因為「你所看到的就是你所支付的」 |
| **2** | 結算延遲 | **T+24h**——所有者收入進入 `pending_income`，除非提出爭議，否則 24 小時後自動釋放到可消費餘額 | 為退款/拒付情況提供緩衝 |
| **3** | 耗盡時的扣款順序 | 主餘額 → 禁言狀態（6–12 小時寬限期 + push）→ 最後一條消息從押金結算 → 交接 → 解除绑定 | 對人類友好——在失去訪問權限前給予租用者時間充值 |
| **4** | 機器人獨占性 | **一個上架商品 = 一個活躍租用者**（透過部分 UNIQUE 索引在 DB 層強制執行） | 簡化速率限制核算，避免所有者-機器人過載 |
| **5** | 租賃期間所有者鎖定 | 所有者**不能**在其機器人出租時使用它；UI 顯示半透明 + 「出租中」橫幅 | 防止自我農場 token 收入 |
| **6** | 押金鎖定時刻 | 在「租用者點擊確認」時——`rate_mli_per_ktoken_snapshot` 存儲在合約行上 | 將即時上架商品編輯與進行中的合約分離 |
| **7** | 押金公式 | `deposit_mli = rate_mli_per_ktoken × 20`（覆蓋約 20,000 tokens 的運行空間） | 在用戶反饋後從 200,000 降低——降低進入門檻 |
| **8** | 面試費用 | 平台吸收成本；每 7 天滾動窗口每個上架商品 3 次面試機會 | 鼓勵上架的同時防止垃圾訊息 |
| **9** | 租賃持續時間範圍 | 最少 30 分鐘，最多 7 天 | 最少防止一時衝動的流失，最多限制財務風險 |
| **10** | 租賃資格檢查 | 租用者餘額 ≥ `押金 + (費率 × 60K tokens)` 緩衝（≈1 小時典型聊天） | 防止啟動立即耗盡的租賃 |
| **11** | 匯率 | **1 TWD = 100 e幣 = 100,000 mli**（固定，在 `wallet.js` 中硬編碼） | 避免成為加密貨幣交易所；無 DB 可配置匯率 |
| **12** | 平台費用 | **15% = 1500 bps**；其中 2% = 200 bps 進入保險池 | 符合 App Store 佣金預期 |
| **13** | e-coin 提現 | **不允許**——僅限 station 內部消費（租賃、訂閱、小費） | 避免證券監管、AML/KYC、稅務申報 |
| **14** | 所有者匿名性 | 租用者只能看到 Agent Card 欄位 + 聚合統計數據；`owner_user_id` 從公共 API 回應中去除 | 預設隱私 |
| **15** | 租賃 entity A2A 協作 | ✅ `speakTo`、✅ `broadcast`、✅ kanban `assigned_bots`、✅ 任務備註讀取、❌ 改名、❌ 刪除、❌ 身份更新、❌ 轉租、❌ 跨設備 speakTo 到所有者設備。速率限制：30 req/min | 在防止濫用的同時保留 EClaw 協作 UX |
| **16** | 充值渠道 | MVP 中僅限 **Google Play**；稍後支援 Apple IAP；跳過 TapPay（不可用） | 首先專注 Android 生態系統 |
| **17** | 隱私策略 | 透明披露 + 敏感資料富卡攔截。不嘗試絕對隔離（承認所有者可以記錄後端請求）。 | 對威脅模型持現實態度 |
| **18** | 保管庫隔離（硬性） | 租用 entity **無法**讀取匹配 `*_KEY`、`*_SECRET`、`*_TOKEN`、`*_PASSWORD` 的 `device_vars`。所有者在上架時明確將變數列入白名單。 | 防止憑證洩漏的深度防禦 |
| **19** | 看門狗範圍（租賃） | 僅限：(1) 提示注入，(2) 敏感資料洩漏。不包括非法內容。 | 限制誤報率 |
| **20** | 違規計數器 | 每個合約 5 次警告，**在交接歸還時重置**。第 5 次警告 → 強制 `ended_violation` → 押金 30% 沒收到保險池，70% 退還 | 遞增響應，不是零容忍 |
| **21** | 年齡確認 | 在租賃時強制執行；現有用戶透過彈窗補填。捕獲 IP + 時間戳。 | 法律cover，同時不阻礙現有 UX |
| **22** | 資金耗盡時的寬限期 | **6–12 小時**（合約剩餘時間的最小值）。在 T+0 和 T+6h 發送推送通知。 | 提供充值時間而不困住用戶 |
| **23** | 面試裁判模型 | **純 regex + 啟發式**——無 LLM 裁判 | 免費、確定性、可重現、不可偽造 |
| **24** | 上架審批門檻 | **對所有人開放**——面試分數 < 60 自動拒絕。無白名單。 | 擴展到許多所有者而無需人工審查負擔 |
| **25** | 費率單位錨點 | **1K token = 1 e幣** 作為市場錨點（僅供參考）。所有者可自由設定任何費率。在偏離建議 >2× 時顯示警告。 | 對 UX 友好的小數字；保留所有者自主權 |
| **26** | 發票/稅務 | 系統僅記錄充值歷史；所有者透過 Google Play Console 直接報告稅務 | 將稅務負擔委託給應用商店 |
| **27** | 爭議 SLA | 崩潰：即時自動驗證 5 分鐘。品質：24 小時回應 / 72 小時解決。能力不匹配：24 小時/48 小時。財務：12 小時/48 小時。未達 SLA → 從保險池自動補償 50 e幣。 | 設定明確期望，減少管理員恐慌 |

### 4.1 已引用但尚未鎖定

這些在設計中提出但尚未最終確定——在實施前標記給用戶：

- 評分系統細粒度（僅 5 星？還是簡單的👍/👎？）
- `credit score` 是否直接影響上架商品搜索排名，還是僅作為徽章顯示
- 租用者是否可以匿名留下評論
- 所有者是否可以阻止特定租用者

---

## 5. 經濟模型

### 5.1 單位

| 單位 | 符號 | 轉換 | 備註 |
|------|--------|------------|-------|
| TWD | NT$ | — | 外部法幣；用戶透過 Google Play 支付/兌現 |
| e-coin | e幣 | `1 TWD = 100 e幣` | 用戶可見貨幣 |
| mli（釐） | — | `1 e幣 = 1000 mli` | DB 存儲單位；避免小數計算 |

Schema 中的所有 BIGINT 欄位使用 **mli**。所有用戶可見的 UI 顯示 **e-coin**。轉換發生在邊界層。

### 5.2 充值層級（Google Play）

在 `wallet.js` `TOPUP_TIERS` 中硬編碼。 bonus % 遞增以獎勵更大額購買：

| 層級 | SKU | TWD | 基本 e幣 | bonus e幣 | 總 e幣 | 有效費率 |
|------|-----|-----|----------|-----------|-----------|---------------|
| Small | `ecoin_tier_small` | 90 | 9,000 | 0 | 9,000 | 100 e幣 / TWD |
| Starter | `ecoin_tier_starter` | 170 | 17,000 | 850 (+5%) | 17,850 | 105 e幣 / TWD |
| Standard | `ecoin_tier_standard` | 340 | 34,000 | 2,720 (+8%) | 36,720 | 108 e幣 / TWD |
| Advanced | `ecoin_tier_advanced` | 990 | 99,000 | 11,880 (+12%) | 110,880 | 112 e幣 / TWD |
| Premium | `ecoin_tier_premium` | 1,990 | 199,000 | 29,850 (+15%) | 228,850 | 115 e幣 / TWD |

### 5.3 租賃定價（所有者設定，建議參考）

**`pricing-advisor.js` 使用的公式**：

```
suggested_rate_mli = BASE_RATE[model_family] × (1 + capability_count × 0.3)
band_width         = suggested × (0.4 if confidence=high else 0.6)
min_suggested      = suggested - band_width
max_suggested      = suggested + band_width
```

**基本費率**（每 1K tokens 的 mli）：

| 模型系列 | 基本 e幣/1K | 備註 |
|--------------|-------------|-------|
| Claude Opus（任何版本） | 10 | 高階層級 |
| Claude Sonnet / GPT-4 | 5 | 中層工作馬 |
| GPT-4o | 6 | 略高於 Sonnet |
| Claude Haiku / GPT-4o-mini / Gemini Flash | 2 | 入門層級 |
| Gemini Pro | 5 | 中層 |
| **unknown**（fallback） | 3 | 保守預設值 |

**能力倍增器**：每支援一個能力（python_exec、web_browse、vision、file_io、…）增加 +30%

**範例**：Opus + Python + Browse + Vision
```
suggested = 10 × (1 + 3 × 0.3) = 19 e幣/1K
high-conf band = 19 × 0.4 = 7.6
range: 11.4 – 26.6 e幣/1K
```

### 5.4 押金公式

```
deposit_mli = rate_mli_per_ktoken × 20   // 20,000 tokens 的運行空間
```

**範例**：

| 費率 | 押金（mli） | 押金（e幣） | 押金（NT$） |
|------|---------------|---------------|---------------|
| 1 e幣/1K (1000 mli) | 20,000 | 20 | 0.20 |
| 5 e幣/1K (5000 mli) | 100,000 | 100 | 1.00 |
| 10 e幣/1K (10000 mli) | 200,000 | 200 | 2.00 |
| 30 e幣/1K (30000 mli) | 600,000 | 600 | 6.00 |

故意設低以最小化進入門檻。設計備忘錄明確權衡了「較低的違約威懾力」以換取「更低的首次嘗試難度」。

### 5.5 平台費用分配

每次租賃 token 收費（`rental_spend` 分類帳條目）：

```
租用者支付：        100% （從租用者 balance_mli 扣除）
所有者收到：        85% （在 T+24h 後記入所有者 balance_mli）
平台費用：          13% （記入 PLATFORM_WALLET）
保險池：             2%  （記入 INSURANCE_POOL_WALLET）
                    ────
                    100%
```

`PLATFORM_FEE_BPS = 1500`（總費用），`INSURANCE_POOL_BPS = 200`（費用中進入保險池的部分）。

### 5.6 發起租賃的最低餘額

```
required_mli = deposit_mli + (rate_mli_per_ktoken × 60)   // 60K token 緩衝 ≈ 1 小時典型聊天
```

如果租用者餘額 < required，API 返回 `insufficient_balance_for_rental`，錯誤詳情包含 `required_mli`、`current_mli`、`deposit_mli`、`buffer_mli`。

### 5.7 租賃收入現金流時間線

```
T+0        租用者租賃，押金保留，合約活躍
T+0..end   每條訊息觸發：
             - 租用者 balance_mli -= 收費
             - 所有者 pending_income_mli += 85% × 收費  （P2-C 中的新表）
             - platform_wallet_mli += 13% × 收費
             - insurance_pool_mli +=  2% × 收費
             - 插入 rental_usage_events 行
             - 插入 wallet_ledger 行
T+end      合約結束（正常或提前）：
             - 應用押金處置（退還 / 沒收）
             - 合約狀態 → ended_*

T+end+24h  pending_income cron 掃描：
             - 所有者 pending_income_mli -= 本合約賺取金額
             - 所有者 balance_mli       += 本合約賺取金額
             - 插入 wallet_ledger 行（rental_income 類型）
```

---

## 6. 資料模型

### 6.1 ERD 概覽

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

### 6.2 表格規格

#### `wallets` — 與 `user_accounts` 一對一

| 欄位 | 類型 | 備註 |
|--------|------|-------|
| `user_id` | UUID PK | FK → `user_accounts(id)` ON DELETE CASCADE |
| `balance_mli` | BIGINT NOT NULL DEFAULT 0 | CHECK (>= 0) |
| `held_mli` | BIGINT NOT NULL DEFAULT 0 | CHECK (>= 0) — 押金託管 |
| `lifetime_earned_mli` | BIGINT NOT NULL DEFAULT 0 | 反規範化聚合（快速讀取；每日對帳） |
| `lifetime_spent_mli` | BIGINT NOT NULL DEFAULT 0 | 同上 |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**索引**：`idx_wallets_updated` on `updated_at DESC`。

**不變量**：
- `balance_mli + held_mli == SUM(delta_mli) over wallet_ledger WHERE user_id = w.user_id`
- `held_mli > 0` 僅在活躍租賃合約期間
- 每日對帳 cron 驗證上述不變量

#### `wallet_ledger` — 追加-only 複式簿記

| 欄位 | 類型 | 備註 |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `user_id` | UUID NOT NULL | FK → `user_accounts(id)` |
| `delta_mli` | BIGINT NOT NULL | 有符號：+ 貸記，− 借記 |
| `held_delta_mli` | BIGINT NOT NULL DEFAULT 0 | 有符號：held_mli 的變更 |
| `balance_after_mli` | BIGINT NOT NULL | 變更後的快照 |
| `held_after_mli` | BIGINT NOT NULL | 變更後的快照 |
| `type` | VARCHAR(32) NOT NULL | 列舉：見下方 |
| `ref_type`, `ref_id` | VARCHAR | 可選——例如 `('rental_contract', 'contract-xyz')` |
| `counterparty_user_id` | UUID | 對於 p2p 轉帳 |
| `note` | TEXT | 人類可讀的註釋 |
| `idempotency_key` | VARCHAR(128) NOT NULL UNIQUE | 重試保護 |
| `created_at` | TIMESTAMPTZ | |

**`type` 列舉值**：`topup`、`rental_income`、`rental_spend`、`platform_fee`、`deposit_hold`、`deposit_release`、`deposit_forfeit`、`referral_bonus`、`signup_bonus`、`refund`、`admin_adjust`、`withdraw`。

**索引**：
- `idx_ledger_user_time (user_id, created_at DESC)` — 主要讀取路徑
- `idx_ledger_type (type)` — 管理員查詢
- `idx_ledger_ref (ref_type, ref_id)` — 每合約細查

#### `topup_orders`

| 欄位 | 類型 | 備註 |
|--------|------|-------|
| `id` | UUID PK DEFAULT gen_random_uuid() | |
| `user_id` | UUID NOT NULL | FK → `user_accounts(id)` |
| `channel` | VARCHAR(32) | `google_play`、`apple_iap`、`admin_grant`、`invite_bonus`、`signup_bonus` |
| `amount_twd` | INTEGER NOT NULL | CHECK (>= 0) |
| `ecoin_base_mli`, `ecoin_bonus_mli`, `ecoin_total_mli` | BIGINT | 全部 CHECK (>= 0) |
| `status` | VARCHAR(32) DEFAULT 'pending' | `pending`、`paid`、`failed`、`refunded` |
| `external_txn_id` | VARCHAR(255) | Google Play purchaseToken / Apple IAP transactionId |
| `external_raw` | JSONB | 完整驗證負載以供審計 |
| `created_at`, `paid_at`, `refunded_at` | TIMESTAMPTZ | |

**索引**：
- `idx_topup_user (user_id, created_at DESC)`
- `idx_topup_status`
- `idx_topup_external_txn UNIQUE (channel, external_txn_id) WHERE external_txn_id IS NOT NULL` — 重放安全的去重鍵

#### `bot_listings`

| 欄位 | 類型 | 備註 |
|--------|------|-------|
| `id` | UUID PK | |
| `owner_user_id` | UUID NOT NULL | FK |
| `owner_device_id`, `owner_entity_id` | TEXT / INT | 指向實際的機器人 slot |
| `title`, `description` | VARCHAR(120) / TEXT | 用戶面向 |
| `rate_mli_per_ktoken` | BIGINT NOT NULL | 所有者設定，可在未出租時編輯 |
| `min_rental_minutes`, `max_rental_minutes` | INT | 預設 30 / 10080（7 天） |
| `availability_windows` | JSONB | 可選的每週排程 |
| `model_detected` | TEXT | **在面試後鎖定** |
| `capabilities` | JSONB | **在面試後鎖定**；`{python_exec: {supported:true}, …}` |
| `benchmark_score` | JSONB | **鎖定**；`{reasoning: 82, latency_p50_ms: 2300, …}` |
| `interview_passed` | BOOLEAN DEFAULT FALSE | 發布的門檻 |
| `last_interview_at` | TIMESTAMPTZ | |
| `avg_rating` | NUMERIC(3,2) | |
| `total_rentals` | INTEGER | |
| `uptime_pct` | NUMERIC(5,2) | Cron 計算 |
| `status` | VARCHAR(32) | `draft`、`interview`、`listed`、`paused`、`delisted` |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**面試後鎖定的欄位**：`model_detected`、`capabilities`、`benchmark_score`、`interview_passed`。`updateListing` 函數白名單排除這些，如果調用者嘗試則返回 `no_fields_to_update`。

**索引**：
- `idx_listings_owner (owner_user_id)`
- `idx_listings_status`
- `idx_listings_rate WHERE status = 'listed'` — 市集過濾
- `idx_listings_rating DESC WHERE status = 'listed'` — 預設排序

#### `bot_interviews`

| 欄位 | 類型 | 備註 |
|--------|------|-------|
| `id` | UUID PK | |
| `listing_id` | UUID NOT NULL | FK → `bot_listings(id)` CASCADE |
| `probes_json` | JSONB NOT NULL | 面試時探針目錄的快照 |
| `responses_json` | JSONB NOT NULL | 機器人對每個探針的回應 |
| `passed` | BOOLEAN NOT NULL | 分數 >= 60 |
| `score` | INT 0–100 | |
| `duration_ms` | INT | 面試花了多長時間 |
| `failure_reason` | TEXT | 在 `passed = FALSE` 時填充 |
| `created_at` | TIMESTAMPTZ | |

**速率限制**：`INTERVIEW_RATE_LIMIT = 3` 每個上架商品每 7 天（在 `runInterview()` 中透過 `COUNT(*) WHERE listing_id = $1 AND created_at > NOW() - '7 days'` 強制執行）。

#### `rental_contracts`

| 欄位 | 類型 | 備註 |
|--------|------|-------|
| `id` | UUID PK | |
| `listing_id` | UUID NOT NULL | FK → `bot_listings(id)` RESTRICT |
| `owner_user_id`, `renter_user_id` | UUID NOT NULL | 兩者都 FK 到 `user_accounts` |
| `renter_device_id` | TEXT NOT NULL | 租用 entity 附加到哪個設備 |
| `renter_entity_slot` | INTEGER | 直到 P2-F entity 交接落地才為 NULL |
| `rate_mli_per_ktoken_snapshot` | BIGINT NOT NULL | **在合約開始時凍結** |
| `deposit_mli` | BIGINT NOT NULL | 在合約開始時 `rate × 20` |
| `planned_duration_min` | INTEGER NOT NULL | |
| `started_at`, `ends_at`, `actual_ended_at` | TIMESTAMPTZ | |
| `grace_period_starts_at` | TIMESTAMPTZ | 在 `suspended_insufficient_funds` 開始時設置 |
| `tokens_consumed` | BIGINT DEFAULT 0 | 運行總計 |
| `ecoin_charged_mli` | BIGINT DEFAULT 0 | 運行總計 |
| `violation_count` | INTEGER DEFAULT 0 | 0–5，在交接時重置 |
| `status` | VARCHAR(40) | 見狀態機 |
| `end_reason` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

**關鍵約束**：
```sql
CREATE UNIQUE INDEX idx_contracts_exclusive_active
    ON rental_contracts(listing_id)
    WHERE status IN ('reserved', 'active', 'suspended_insufficient_funds');
```
這在 DB 層強制執行 GR2——沒有應用程式錯誤可以創建重複預訂。

**索引**：
- `idx_contracts_renter (renter_user_id, created_at DESC)`
- `idx_contracts_owner (owner_user_id, created_at DESC)`
- `idx_contracts_active_ends (ends_at) WHERE status = 'active'` — cron 掃描
- `idx_contracts_listing`
- `idx_contracts_exclusive_active` — 獨占性

#### `rental_snapshots` — 版本鎖

| 欄位 | 類型 | 備註 |
|--------|------|-------|
| `contract_id` | UUID PK | FK → `rental_contracts(id)` CASCADE |
| `identity` | JSONB | 凍結的機器人身份 |
| `rules` | JSONB | 凍結的規則模板 |
| `skills` | JSONB | 凍結的技能模板 |
| `webhook_url` | TEXT | 所有者的真實 webhook（永不暴露給租用者） |
| `allowed_vars` | JSONB DEFAULT `[]` | 租用 entity 可讀取的 device_vars 鍵的白名單 |
| `created_at` | TIMESTAMPTZ | |

#### `rental_usage_events`

| 欄位 | 類型 | 備註 |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `contract_id` | UUID NOT NULL | FK CASCADE |
| `direction` | VARCHAR(8) | `'in'` 或 `'out'` |
| `tokens` | INT NOT NULL | 由租賃代理中的 `tiktoken` 計算 |
| `ecoin_charged_mli` | BIGINT NOT NULL DEFAULT 0 | |
| `message_id` | VARCHAR(64) | FK-ish 到 `chat_messages`（鬆散） |
| `created_at` | TIMESTAMPTZ | |

每個代理攔截的訊息一行。此事件行和收費的 `wallet_ledger` 行共享 `contract_id` 引用。

#### `pricing_market_snapshots`

| 欄位 | 類型 | 備註 |
|--------|------|-------|
| `id` | BIGSERIAL PK | |
| `snapshot_at` | TIMESTAMPTZ | |
| `model_family` | TEXT NOT NULL | `'opus'`、`'sonnet'`、… |
| `listing_count` | INT | 此系列中有多少活躍上架商品 |
| `rate_p25_mli`, `p50`, `p75`, `p95` | BIGINT | 分位數分解 |
| `rental_success_rate` | NUMERIC(4,3) | 此系列的已完成/已開始 |

由每小時 cron（P3）填充。由 `pricing-advisor.js` 讀取以顯示「市場中位數」。

### 6.3 延後到後續階段的表格

這些在設計中被引用但尚未在 `rental_schema.sql` 中：

| 表格 | 階段 | 用途 |
|-------|-------|---------|
| `bot_reviews` | P3 | 每個已完成合約的 1-5 星評分 + 評論 |
| `disputes` | P3 | 帶證據 + SLA 時間戳的仲裁票證 |
| `user_credit_scores` | P3 | 基於歷史的每用戶 aggregate credit |
| `gatekeeper_violations` | P3 | 每租賃違規事件以進行 5 次警告計數 |
| `fraud_detection_log` | P3 | 設備指紋 + 規則觸發歷史 |
| `crash_reports` | P3 | 自動驗證的機器人崩潰審計追蹤 |
| `insurance_pool_ledger` | P4 | 池錢包的單獨追加-only 分類帳 |
| `user_blacklist` | P4 | 帶到期時間的臨時禁止 |
| `invite_codes`, `invite_redemptions` | P5 | 推薦計劃 |

---

## 7. 狀態機

### 7.1 上架商品生命週期

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

- **draft → interview**：所有者點擊「執行面試」。在上架商品狀態變更時發送探針。
- **interview → listed**：分數 ≥ 60 自動升級；能力欄位鎖定。
- **interview → draft**：分數 < 60 返回草案；所有者可以編輯並重試（最多 3 次/7 天）。
- **listed → paused**：所有者暫時隱藏（例如去度假）。
- **listed → delisted**：所有者永久移除。
- **paused → listed**：所有者恢復。

能力欄位在首次通過面試後**永久**。對已 `listed` 的機器人重新面試會更新 `last_interview_at` 時間戳，但不更改鎖定的欄位（由更新白名單強制執行）。

### 7.2 合約生命週期

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

**實現備註**：在 P2-A/B 中 `reserved` 狀態被**跳過**——`startRental()` 直接過渡到 `active`。列舉值保留以備將來使用（例如延遲付款驗證）。這讓快樂路徑保持簡單：1 個原子交易 = 1 個狀態變更。

### 7.3 押金處置矩陣

| 結束原因 | 退還 % | 沒收 % | 備註 |
|------------|----------|-----------|-------|
| `ended_normal` | 100 | 0 | 標準完成 |
| `ended_disputed` | 100 | 0 | 崩潰已驗證，是所有者的過錯 |
| `ended_admin` | 100 | 0 | 管理員覆寫 |
| `ended_early_by_renter` | 50 | 50 | 取消的軟性處罰 |
| `ended_zero_balance` | 剩餘 | 0 | 最後一條訊息成本已在收費時從押金中扣除 `held_mli`；押金餘額退還給租用者 |
| `ended_violation` | 70 | 30 | 達到 5 次警告限制 |

沒收金額透過標準 85/13/2 比例分配：85% 給所有者（作為 `RENTAL_INCOME`），13% 給平台錢包，2% 給保險池。所有三個貸記在同一個作為合約狀態更新的事務中運行。

對於 `ended_zero_balance`：token 計量代理（`chargeRentalUsage`）在收費時直接從押金（`held_mli`）扣除最後一條訊息的不足額，按 85/13/2 分配給所有者/平台/保險池，然後發出 `suspended: true`。當 `endRental` 隨後運行時，押金的任何剩餘部分都全額退還給租用者。

---

## 8. API 介面

### 8.1 目前已實現（PR #1656）

#### 錢包模組 — `/api/wallet/*`

| 方法 | 路徑 | 認證 | 狀態 | 描述 |
|--------|------|------|--------|-------------|
| GET | `/balance` | user | ✅ | 目前餘額 + held + 生命週期統計 |
| GET | `/history` | user | ✅ | 分頁分類帳，可選 `type` 過濾 |
| GET | `/topup/tiers` | public | ✅ | 5 層級目錄 |
| POST | `/topup/verify-google` | user | ✅ (stub) | Google Play 購買驗證。**真實 `purchaseToken` 檢查透過 androidpublisher API 是 TODO**——目前信任 token 並依賴 UNIQUE(channel, external_txn_id) 去重。 |
| POST | `/admin/grant` | admin | ✅ | 手動 e-coin 授予，有審計 |
| GET | `/admin/reconcile` | admin | ✅ | 按需分類帳與緩存餘額審計 |

#### 租賃模組 — `/api/rental/*`

| 方法 | 路徑 | 認證 | 狀態 | 描述 |
|--------|------|------|--------|-------------|
| POST | `/listing` | user | ✅ | 創建草案上架商品 |
| PATCH | `/listing/:id` | owner | ✅ | 僅更新白名單欄位 |
| POST | `/listing/:id/publish` | owner | ✅ | 需要 `interview_passed = TRUE` |
| POST | `/listing/:id/pause` | owner | ✅ | 暫時從市集隱藏 |
| DELETE | `/listing/:id` | owner | ✅ | 永久下架 |
| GET | `/listing/:id` | public | ✅ | 詳情視圖（owner_user_id 對非所有者隱藏） |
| GET | `/my-listings` | user | ✅ | 所有者自己的上架商品 |
| GET | `/marketplace` | public | ✅ | 帶 `rate`、`capability`、`sort`、分頁的搜索 |
| POST | `/contract` | user | ✅ | 開始租賃（原子：押金 + 合約 + 快照） |
| POST | `/contract/:id/end` | renter/owner | ✅ | 結束合約並處置押金 |
| GET | `/my-contracts` | user | ✅ | 按 `role=renter|owner` 過濾 |

#### Cron 作業

| 排程 | 作業 | 狀態 |
|----------|-----|--------|
| `23 4 * * *`（每日 04:23） | 錢包對帳審計 | ✅ |
| `11 * * * *`（每小時 :11） | 定價市場快照聚合 | ✅ |
| （待定）每分鐘 | 合約過期掃描（active → ended_normal） | 🔴 P2-F |
| （待定）每分鐘 | 寬限期過期掃描 | 🔴 P2-C |
| （待定）T+24h | 所有者 pending_income 釋放掃描 | 🔴 P2-C |

### 8.2 後續階段的計劃

#### P2-C：Token 計量代理

| 方法 | 路徑 | 描述 |
|--------|------|-------------|
| （內部） | `POST /api/client/speak` hook | 當 `rentalContractId` 存在時攔截 |
| POST | `/api/rental/contract/:id/suspend` | 管理員強制暫停 |
| POST | `/api/rental/contract/:id/resume` | 管理員強制恢復 |

#### P3：評論 + 爭議

| 方法 | 路徑 | 描述 |
|--------|------|-------------|
| POST | `/api/rental/contract/:id/review` | 租用者 1-5★ 評分 + 評論 |
| POST | `/api/rental/contract/:id/dispute` | 提交爭議 |
| GET | `/api/rental/disputes` | 用戶自己的爭議 |
| GET | `/api/admin/rental/disputes` | 管理員工作隊列 |
| POST | `/api/admin/rental/disputes/:id/resolve` | 管理員裁決 |

#### P4：風險管理

| 方法 | 路徑 | 描述 |
|--------|------|-------------|
| GET | `/api/rental/listing/:id/sla` | 正常運行時間 % + 崩潰次數 |
| GET | `/api/admin/rental/insurance-pool` | 池餘額 + 歷史 |
| POST | `/api/admin/rental/blacklist` | 禁止用戶租賃 |

#### P5：增長

| 方法 | 路徑 | 描述 |
|--------|------|-------------|
| GET | `/api/invite/my-code` | 用戶的推薦碼 |
| POST | `/api/invite/redeem` | 領取邀請 bonus |
| GET | `/api/invite/stats` | 推薦表現 |

---

## 9. 子系統規格

原始用戶請求列出了 11 個子系統。每個都映射到其階段、實現狀態和相關代碼位置。

### 9.1 錢包系統（Wallet System）

**狀態**：✅ 完成（Phase 0）
**檔案**：`backend/wallet.js`、`backend/wallet_schema.sql`、`backend/tests/jest/wallet.test.js`

- 帶 idempotency keys 的複式簿記分類帳
- 每個變更周圍的原子 BEGIN/COMMIT
- 透過 `SELECT ... FOR UPDATE` 行鎖定
- 反規範化聚合（`lifetime_earned_mli`、`lifetime_spent_mli`）以實現快速讀取
- 每日對帳 cron

### 9.2 APP 儲值 e幣系統（Top-up System）

**狀態**：🟡 Stub（Google Play token 驗證等待真實整合）
**檔案**：`backend/wallet.js`（`creditTopup`、`createTopupOrder`、`markTopupPaid`、`TOPUP_TIERS`）

- 5 個硬編碼層級（NT$90 / 170 / 340 / 990 / 1990）
- 遞增 bonus %（0 → 15%）
- `UNIQUE(channel, external_txn_id)` 去重防止重放
- 原子 `markTopupPaid`：單一事務覆蓋 order UPDATE + 分類帳貸記
- `POST /api/wallet/topup/verify-google` stub 逐字接受 token；真實 `androidpublisher` 呼叫延遲

### 9.3 交易系統（Transaction / Settlement System）

**狀態**：✅ 原語就位；P2-C 將添加租賃特定的結算流程
**檔案**：`backend/wallet.js` — `transferEcoin`、`holdDeposit`、`releaseDeposit`、`forfeitDeposit`、`adminAdjust`；`backend/rental.js` — `startRental`、`endRental`

- 透過共享 `withTransaction` + `applyLedgerEntry` 的跨模組原子性
- T+24h 所有者收入結算：將在 P2-C 中添加 `pending_income_mli` 欄位
- 所有變更需要 `idempotency_key`

### 9.4 邀請碼賺 e幣 系統（Referral System）

**狀態**：🔴 未開始（Phase 5）
**計劃**：
- `invite_codes` 表格，每用戶 6 字符 base32 碼
- `invite_redemptions` 確保每個新用戶只能被推薦一次
- 獎勵：邀請人 +500 e幣，被邀請人 +100 e幣（可配置）
- 欺詐防護：設備指紋、7 天等待後才能獲得獎勵、相同 email 域名阻止

### 9.5 租賃契約管理系統（Contract Management）

**狀態**：✅ P2-A/B 完成；entity 交接 + 寬限期延遲
**檔案**：`backend/rental.js` — `startRental`、`endRental`、`getMyContracts`、`CONTRACT_STATUSES`；`backend/rental_schema.sql`

- 9 狀態列舉，涵蓋 reserved、active、suspended、6 個最終狀態
- 透過 `rental_snapshots` 表格進行版本鎖
- 押金處置矩陣：全額 / 50% / 30% / 0% / 100% 沒收
- 透過部分 UNIQUE 索引在 DB 層獨占性
- **延遲到 P2-C/F**：
  - 寬限期 cron（`suspended_insufficient_funds` 上的 6–12 小時計時器）
  - Entity 交接（將租用 entity 插入租用者的 `devices` slot）
  - 自動過期 cron（`active → ended_normal`）

### 9.6 Bot 面試 / 當機測試系統（Interview + Crash Detection）

**狀態**：🟡 評分引擎完成；HTTP 分發器延遲
**檔案**：`backend/bot-interview.js`

- 8 個探針：問候、python_exec、web_browse、reasoning、refusal_safety、summarization、vision、latency
- 純 regex + 啟發式評分（無 LLM 裁判）
- 通過門檻：60/100 加權分數
- `scoreInterview(responses)` 發出 `capabilities` JSON
- **延遲到 P1 後續**：
  - 實際 HTTP POST 分發到所有者 webhook
  - 透過 `/api/transform` 回調收集回應
  - `bot_interviews` 表格寫入
  - 崩潰檢測（在爭議期間重新運行探針）

### 9.7 Token 計算預估系統（Token Metering + Cost Estimation）

**狀態**：🔴 未開始（P2-C）
**計劃檔案**：`backend/rental-proxy.js`

技術方法：
- 當 `rentalContractId` 存在時攔截 `POST /api/client/speak`
- 透過 `tiktoken` 計算輸入 tokens（或 fallback `chars / 4` 估計）
- 將訊息轉發到 `rental_snapshots.webhook_url`（永不轉發到所有者的 live webhook）
- 透過 `/api/transform` 接收機器人回應
- 透過相同方法計算輸出 tokens
- 原子：租用者借記 + 所有者貸記（扣除費用後淨額）+ 平台費用 + 保險池 + 分類帳條目 + `rental_usage_events` 行
- 門檻檢查：如果餘額達到 0 → 過渡到 `suspended_insufficient_funds`

租賃前估計 UI：
- 上架商品詳情頁面顯示「平均每次對話約 3,400 tokens ≈ 3.4 e幣」，基於 `listing.total_rentals` 平均值

### 9.8 預測租金 / 建議定價系統（Pricing Advisor）

**狀態**：✅ 靜態規則完成；市場數據饋送延遲
**檔案**：`backend/pricing-advisor.js`

- `detectFamily()` regex 從上架商品的 `model_detected` 欄位檢測模型
- `BASE_RATE_MLI_PER_KTOKEN` 查找表
- 能力倍增器：每支援一個工具 +30%
- Band 寬度：±40%（高置信度）或 ±60%（低）
- `classifyRate()` 將所有者選擇與建議分類
- **延遲**：
  - `pricing_market_snapshots` cron（每小時從真實上架商品聚合）
  - 需求因素調整（每系列最近的租賃成功率）

### 9.9 點交系統（Handover System）

**狀態**：🔴 財務方面完成（startRental / endRental）；**entity 層級交接未開始**（P2-F）
**計劃方法**：

在 `startRental` 成功時：
1. 查找租用者的下一個空 entity slot（`devices[renterDeviceId].entities[i].isBound === false`）
2. 插入合成的租用 entity：
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
3. 更新 `rental_contracts.renter_entity_slot = slot`
4. 標記所有者的 entity：`rental_status = 'leased_out'`，`rental_contract_id = contract.id`
5. 發出 `entity:rental-start` 和 `entity:leased-out` Socket.IO 事件
6. 如果沒有空 slot 可用，自動擴展租用者的 slot 計數（重用 `index.js` 中現有的 `ensureOneEmptySlot`）

在 `endRental` 成功時（反轉）：
1. 從租用者的設備中移除租用 entity
2. 清除所有者的 `rental_status` / `rental_contract_id`
3. 發出 `entity:rental-end` + `entity:leased-in-returned`

**複雜性**：內存 `devices` map 由 `index.js` 管理，而非 `rental.js`。交接邏輯位於 `index.js` 中，作為傳入租賃模組的回調，或者租賃模組將 `devices` 作為工廠參數接收（與 `auth.js` 接收它的方式一致）。

### 9.10 Bot 能力評估系統（Capability Assessment）

**狀態**：✅ 輸出結構已定義；饋送到上架商品 capabilities JSON
**檔案**：`backend/bot-interview.js`（`scoreInterview` → capabilities）、`backend/pricing-advisor.js`（`countCapabilities`）

輸出 JSON 形狀：
```json
{
  "python_exec": { "supported": true, "probes": [{"id": "python_exec", "passed": true}] },
  "web_browse":  { "supported": true, "probes": [...] },
  "vision":      { "supported": false, "probes": [...] },
  "reasoning":   { "supported": true, "probes": [...] }
}
```

類別來自探針的 `.category` 欄位。`supported = OR(passed across probes in category)`。

### 9.11 租借後協作系統（Post-Rental Collaboration）

**狀態**：🔴 未開始（P2-E）

允許對租用 entity 的操作：
- ✅ 出現在 `/api/entities` 列表中，帶有 `rental_contract_id` 欄位
- ✅ 接收 `speakTo` 呼叫（訊息透過租賃代理路由以進行計量）
- ✅ 接收 `broadcast` 呼叫（相同）
- ✅ 可在 `kanban_cards.assigned_bots` 中分配
- ✅ 讀取 `mission_notes` 和 `rules`

阻止的操作（返回 403）：
- ❌ `PATCH /api/entities/:id/rename`
- ❌ `DELETE /api/entities/:id`
- ❌ `PUT /api/entity/identity`
- ❌ `POST /api/rental/listing`（不允許轉租）
- ❌ 跨設備 `speakTo` 回所有者的設備

強制執行點：`/api/entities/:id/*` 路由上的中介軟體檢查 `entity.rental_contract_id`，並根據 HTTP 方法 + 路徑進行 gate。

速率限制：30 req/min，透過以 `rental_contract_id` 為鍵的 `express-rate-limit`。

---

## 10. 階段計畫

### 10.1 階段概覽

| 階段 | 主題 | 範圍 | 狀態 | PR(s) |
|-------|-------|-------|--------|-------|
| **P0** | 錢包基礎 | `wallets`、`wallet_ledger`、`topup_orders`、原語、reconcile cron | ✅ 完成 | #1656 commits `a5dd33ea`、`6938c92d`、`073a125b` |
| **P1** | 上架商品 + 顧問 | `bot_listings`、`bot_interviews`、上架商品 CRUD、市集、面試評分、定價顧問 | 🟡 基礎完成；Arena 整合、市場快照 cron、市集入口頁完成；上架編輯器/行動端對等仍待補 | #1656 commit `073a125b` |
| **P2** | 合約核心 | 合約狀態機、原子開始/結束、版本鎖、token 計量代理、寬限期、entity 交接、看門狗擴展、A2A 協作 | 🟡 P2-A/B 完成（財務）；P2-C/D/E/F 待定 | #1656 commit `267c09d7` |
| **P3** | 信任層 | 評論、爭議、信用評分、欺詐檢測、管理員工作隊列 | 🔴 未開始 | — |

| **P4** | 風險管理 | 保險池、黑名單、SLA 顯示、通知、審計強化 | 🔴 未開始 | — |
| **P5** | 增長 | 推薦碼、邀請 bonus、市場激勵 | 🔴 未開始 | — |

### 10.2 詳細任務追蹤器

圖例：✅ 完成，🟡 部分，🔴 未開始，🔒 人為阻塞

#### P0 — 錢包基礎

- ✅ `wallet_schema.sql` — wallets、wallet_ledger、topup_orders
- ✅ `wallet.js` — transferEcoin、holdDeposit、releaseDeposit、forfeitDeposit、adminAdjust
- ✅ `creditTopup`、`createTopupOrder`、`markTopupPaid`
- ✅ `TOPUP_TIERS` 目錄 + `GET /topup/tiers`
- ✅ `POST /topup/verify-google`（stub）
- ✅ `POST /admin/grant`、`GET /admin/reconcile`
- ✅ 在 `index.js` 中掛載路由並延遲初始化
- ✅ 每日 reconcile cron
- ✅ 帶 i18n 的錢包入口頁面（en + zh-TW）
- ✅ 48 個 Jest 測試（輸入驗證、idempotency、原子性、路由）
- 🔒 真實 Google Play `purchaseToken` 驗證（需要 `GOOGLE_PLAY_SERVICE_ACCOUNT` 環境變數）
- 🔒 Apple IAP 整合
- 🔒 TapPay 拒付 webhook（TapPay 目前不可用）
- 🔒 10+ 語言 i18n 翻譯（需要母語者）

#### P1 — 上架商品 + 顧問

- ✅ `rental_schema.sql` — bot_listings、bot_interviews、rental_contracts、rental_snapshots、rental_usage_events、pricing_market_snapshots
- ✅ `rental.js` — createListing、updateListing、publishListing、pauseListing、delistListing、getListing、listMyListings、searchMarketplace
- ✅ 面試後鎖定欄位的白名單強制執行
- ✅ 帶 rate/capability/sort 過濾器的市集路由
- ✅ `bot-interview.js` — 8 個探針 + 純評分
- ✅ `pricing-advisor.js` — 基本費率 + 能力倍增器 + band 分類
- ✅ 工廠在缺少 `authMiddleware` / `walletModule` 時硬失敗
- ✅ 137 個 Jest 測試（涵蓋 rental-listing、bot-interview、pricing-advisor）
- 🔴 HTTP 探針分發器 — POST 到所有者 webhook，透過 `/api/transform` 回調收集
- 🔴 直播面試期間的 `bot_interviews` 表格寫入
- 🔴 面試速率限制強制執行（每上架商品/7 天 3 次）
- ✅ 市場快照 cron（每小時聚合）
- ✅ 市集入口頁面（`marketplace.html`）
- 🔴 上架商品編輯器入口頁面
- 🔴 面試執行器 UI
- 🔒 Android `MarketplaceActivity.kt`（功能對等規則）
- 🔒 iOS 市集螢幕

#### P2 — 合約核心

- ✅ `rental_contracts` 表格 + 狀態機列舉
- ✅ `rental_snapshots` 版本鎖表格
- ✅ 透過部分 UNIQUE 索引在 DB 層獨占性
- ✅ `startRental` — 原子 9 步跨模組事務
- ✅ `endRental` — 押金處置矩陣
- ✅ `getMyContracts` 帶角色過濾器
- ✅ `POST /contract`、`POST /contract/:id/end`、`GET /my-contracts`
- ✅ `wallet.js` 暴露 `withTransaction` + `applyLedgerEntry` 用於跨模組原子性
- ✅ 25 個合約生命週期 Jest 測試
- 🔴 **P2-C**：Token 計量代理（`rental-proxy.js`）
  - 🔴 當 `rentalContractId` 存在時攔截 `POST /api/client/speak`
  - 🔴 `tiktoken` 輸入/輸出計數
  - 🔴 轉發到快照 webhook（不是 live 上架商品 webhook）
  - 🔴 每條訊息的原子借記 / 貸記 / 費用分配
  - 🔴 `rental_usage_events` 行插入
  - 🔴 在耗盡時過渡到 `suspended_insufficient_funds`
  - 🔴 寬限期 cron（6–12 小時計時器 + 推送通知）
  - 🔴 T+24h `pending_income` 釋放 cron
  - 🔴 合約自動過期 cron（`active → ended_normal` 在 `ends_at`）
- 🔴 **P2-D**：隱私和看門狗擴展
  - 🔴 擴展 `gatekeeper.js` 帶租賃上下文
  - 🔴 敏感資料攔截（信用卡、ID、密碼、API 密鑰）
  - 🔴 租用方向的提示注入檢測
  - 🔴 保管庫隔離：阻止 `*_KEY`、`*_SECRET`、`*_TOKEN`、`*_PASSWORD` 從租用 entity 讀取
  - 🔴 `allowed_vars` 白名單強制執行
  - 🔴 `gatekeeper_violations` 表格 + 5 次警告計數器
- 🔴 **P2-E**：A2A 協作橋接
  - 🔴 拒絕對租用 entity 改名/刪除/身份更新的中介軟體
  - 🔴 轉租預防（阻止租用 entity `POST /api/rental/listing`）
  - 🔴 跨設備 speak-back-to-owner 阻止
  - 🔴 每 rental_contract_id 30 req/min 速率限制
- 🔴 **P2-F**：Entity 交接
  - 🔴 在開始時將租用 entity 插入租用者的 `devices[deviceId].entities[slot]`
  - 🔴 標記所有者 entity `rental_status = 'leased_out'`
  - 🔴 發出 Socket.IO 事件（`entity:rental-start`、`entity:leased-out`、`entity:rental-end`）
  - 🔴 所有者儀表板上半透明 UI 覆蓋層
  - 🔴 租用 entity 在租用者儀表板上顯示 `🔒` 徽章
  - 🔴 在 `endRental` 上反向交接

#### P3 — 信任層

- 🔴 `bot_reviews` 表格 + `POST /contract/:id/review`
- 🔴 `disputes` 表格 + `POST /contract/:id/dispute` + 管理員解決端點
- 🔴 自動驗證崩潰路徑（重新探針機器人，與面試基準比較）
- 🔴 `user_credit_scores` cron + 徽章
- 🔴 `fraud_detection.js` — 設備指紋、IP、email 域名、sybil 攻擊模式
- 🔴 管理員儀表板擴展：爭議隊列、欺詐警報、手動調整 UI
- 🔴 `gatekeeper.js` 內容審計擴展（可選——僅在規則 #19 擴展時）

#### P4 — 風險管理

- 🔴 保險池虛擬錢包（`INSURANCE_POOL_USER_ID` 常數已定義）
- 🔴 保險池分類帳（單獨的追加-only）
- 🔴 沒收押金 + SLA 錯過補償的自動路由
- 🔴 `user_blacklist` 表格 + 強制執行中介軟體
- 🔴 合約結束後的冷卻時間（24 小時重複租賃預防）
- 🔴 SLA 統計 cron（正常運行時間、延遲、崩潰次數）
- 🔴 上架商品詳情頁面徽章：「30 天正常運行時間：99.2%」
- 🔴 通知觸發器：在寬限期、合約結束、支付、收到評分時推送
- 🔴 審計日誌強化：`admin_audit_log` 追加-only 表格，帶 DB 層 DELETE/UPDATE 觸發器
- 🔴 年齡確認補填彈窗
- 🔴 KYC 鉤子，用於每月充值 > NT$3000（僅記錄標誌，实际 KYC 是人工的）

#### P5 — 增長

- 🔴 `invite_codes` + `invite_redemptions` 表格
- 🔴 `/api/invite/*` 端點
- 🔴 推薦獎勵分配（帶 sybil 防護）
- 🔴 分享連結：`https://eclawbot.com/invite/XXXXXX`
- 🔴 邀請儀表板頁面

---

## 11. 技術深入探討

### 11.1 跨模組事務原子性

**問題**：`rental.js` 和 `wallet.js` 各自擁有自己的 PG pool（符合現有 `auth.js`、`mission.js`、`subscription.js` 模式）。在開始租賃時，我們需要：

1. 讀取上架商品（`bot_listings`）
2. 插入合約（`rental_contracts`）
3. 插入快照（`rental_snapshots`）
4. 保留押金（寫入 `wallet_ledger`，更新 `wallets`）

步驟 1-3 由 rental.js 擁有；步驟 4 由 wallet.js 擁有。如果這些在兩個獨立的事務中運行，它們之間的崩潰會留下「有押金保留但無合約」或「有合約但無押金保留」。

**解決方案**：`wallet.js` 暴露 `withTransaction(fn)` 和 `applyLedgerEntry(client, args)` 作為公開的工廠返回 values。`rental.js` 的工廠接受 `walletModule` 依賴，並在其合約寫入*內*運行*同一個由 `walletModule.withTransaction` 管理的 client：

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

兩個模組的 pools 連接到同一個 DB，所以來自任一 pool 的 client 看到相同的行鎖和約束強制執行。

**接受的權衡**：`rental.js` 獲得了對 wallet.js 內部結構的構建時依賴。工廠在 `walletModule.withTransaction` 不是函數時硬失敗，在啟動時捕獲接線錯誤。

### 11.2 透過快照的版本鎖

**問題**：所有者可以自由更新上架商品標題、費率和（理論上）機器人配置。合約中期對機器人身份或 webhook 的更改會破壞租用者的預期。

**解決方案**：在 `startRental` 時，合約的 `rate_mli_per_ktoken_snapshot` 欄位在該時刻捕獲費率。配套的 `rental_snapshots` 行存儲 `identity`、`rules`、`skills`、`webhook_url` 和 `allowed_vars` 的凍結副本。

運行時查找（在未来 rental-proxy 中）**必須從快照讀取**，永不從 live 上架商品讀取：

```js
// WRONG
const webhook = await db.query('SELECT webhook FROM entities WHERE ...', [owner.deviceId, listing.entityId]);

// RIGHT
const snapshot = await db.query('SELECT webhook_url FROM rental_snapshots WHERE contract_id = $1', [contractId]);
```

這也提供了取證痕跡：如果出現爭議，我們可以準確重建租用者同意的內容。

### 11.3 Token 計量策略（P2-C）

**為什麼選擇純後端估計？**

考慮了兩種替代方案：

- **A. 機器人自我報告 `usage`** 在其 `/api/transform` 回調中——精確但可偽造。
- **B. 僅後端估計** 透過 `tiktoken` 對流經代理的消息體——不太精確但不可偽造。

經過用戶辯論，選擇了 B：

> 一切使用 `(in + out) × rate / 1000` 計算較公平，這樣也就不會有被盜刷的可能性

**實現大綱**（用於 P2-C）：

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

**費用分配**發生在 `chargeRenter` 內部：
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

**P2-C 的開放決策**：輸入成本檢查是立即借記（預借記）還是僅讀取檢查？預借記更保守，但會使所有者的 webhook 失敗時的回滾複雜化。當前計劃：預借記輸入，盡力而為借記輸出。

### 11.4 隱私隔離權衡

**我們可以強制執行的**：
- 租用者永不看到所有者的 `deviceSecret`
- 租用者永不看到所有者的 live `webhook_url`（透過 `rental_snapshots.webhook_url` 代理，這是在伺服器端查找的）
- 租用者永不看到其他租賃合約或用戶
- `device_vars` 保管庫隔離（P2-D）：` *_KEY`、`*_SECRET`、`*_TOKEN`、`*_PASSWORD` 鍵被阻止從租用 entity 讀取，除非所有者在 `allowed_vars` 中明確列入白名單

**我們無法強制執行的**（在設計決策 #17 中承認）：
- 所有者在自己的後端記錄每條傳入訊息（OpenClaw、Zeabur、他們自己的 box）
- 所有者可以從自己的基礎設施中內省機器人對話內容

**緩解措施**：透明度和用戶同意。
- 租賃合約披露彈窗：「您的對話將傳輸到所有者的伺服器。請勿分享敏感資訊。」
- 聊天 UI 橫幅：「⚠️ 您正在與租用機器人交談。請避免分享信用卡、密碼或個人 ID。」
- 看門狗級別攔截：在訊息離開到租賃代理之前，掃描敏感模式。如果檢測到，顯示富卡：「檢測到：信用卡號。仍然發送？」——用戶明確確認後交付。
- 記錄為 `sensitive_data_acknowledged` 證據以供爭議案例使用。

### 11.5 對帳不變量

每個錢包變更都透過 `applyLedgerEntry`，它原子地：
1. 鎖定錢包行
2. 讀取目前餘額 + held
3. 計算新值
4. 如果任一會變為負數則拒絕（CHECK 約束也強制執行此操作）
5. 更新錢包行
6. 插入分類帳行（帶唯一 idempotency_key）

不變量：**始終**對於每個 `user_id` w：

```sql
w.balance_mli = SUM(delta_mli) WHERE user_id = w.user_id
w.held_mli    = SUM(held_delta_mli) WHERE user_id = w.user_id
```

每日 reconcile cron 運行單個 CTE 查詢，顯示任何違規。連續 30 天零誤差是宣告錢包系統「受信任」的驗收標準（目標 G3）。

---

## 12. 隱私、安全與合規

### 12.1 OWASP 注意事項

| OWASP 項目 | 緩解措施 |
|------------|------------|
| A01 Broken Access Control | 每個端點由 `authMiddleware` 門控；所有權檢查在 `updateListing`、`publishListing`、`endRental` 中 |
| A02 Cryptographic Failures | e-coin 餘額存儲為純 BIGINT（不敏感）；`idempotency_key` 是公共值 |
| A03 Injection | 所有查詢使用 `$1` 樣式參數化；無字串串聯 |
| A04 Insecure Design | 部分 UNIQUE 索引在 DB 層強制執行獨占性（對應用程式錯誤的深度防禦） |
| A05 Security Misconfiguration | 工廠在缺少 `authMiddleware` / `walletModule` 時硬失敗——無靜默fallback |
| A07 Identification & Auth Failures | 重用來自 `auth.js` 的現有 JWT cookie 認證 |
| A08 Software & Data Integrity Failures | 追加-only 分類帳；每日對帳 cron |
| A09 Logging & Monitoring | 所有租賃/錢包變更透過 `serverLog` 回調寫入 `server_logs` |
| A10 SSRF | 所有者 webhook URL 在面試時進行驗證（TODO：明確的白名單方案） |

### 12.2 合規注意事項

**稅務**：系統記錄充值歷史，但不申報稅務。所有者負責報告租賃收入。Google Play Console 根據 Google 的商家規則處理用戶端稅務收集。

**AML / KYC**：固定匯率 + 不可兌換 e-coin + 應用商店中介充值顯著降低 AML 暴露。當用戶每月充值 > NT$3000 時記錄標誌（`kyc_required = TRUE`），但沒有自動化 KYC 運行——這是未來人工審查的 stub。

**年齡合規**：`age_confirmed_at` 欄位 + 租賃時間彈窗收集帶 IP + 時間戳的明確同意，作為法律證據。

**資料保留**：`wallet_ledger` 永久保留（審計要求）。`server_logs` 保留 7 年（稅務要求）。`rental_usage_events` 可在 90 天後刪除以保護隱私，僅在 `rental_contracts` 上保留聚合。

---

## 13. 未解問題與風險

### 13.1 已知的未解問題

| # | 問題 | 影響 | 緩解措施 |
|---|-------|--------|------------|
| O1 | Google Play `purchaseToken` 被信任地逐字接受 | 如果按原樣部署則為Critical | 仅在整合 `androidpublisher` 驗證 + `GOOGLE_PLAY_SERVICE_ACCOUNT` 環境變數後部署 |
| O2 | TapPay 拒付 webhook 缺失 | 中等——僅手動逆轉 | 延遲到 TapPay 重新啟用 |
| O3 | 尚無租賃代理——租賃合約可以開始但無法收取 tokens | 阻止端到端租賃 | P2-C 是下一個優先事項 |
| O4 | Entity 交接未實現——租用機器人不出現在租用者儀表板上 | 阻止 UX | P2-F —— 需要觸及 `index.js` devices map |
| O5 | 寬限期 cron 未實現——合約無法自動暫停 | 阻止餘額不足路徑 | P2-C |
| O6 | `pending_income_mli` 欄位從 wallets 缺失 | 阻止 T+24h 結算 | P2-C —— migration |
| O7 | 現有的 flaky Jest 套件（note-pages、cross-speak、mutations、mission） | 單獨通過，在並行運行下 flaky | 根本原因：洩�計時器；與 BRM 無關——所有者追蹤問題 |
| O8 | wallet.html + rental.html i18n 僅有 en + zh-TW | 破壞 10+ 語言的設計原則 | 需要人工翻譯 pass |
| O9 | Android + iOS 市集/錢包螢幕缺失 | 違反 CLAUDE.md 功能對等規則 | 需要原生開發週期 |
| O10 | 尚無 `pricing_market_snapshots` 數據——顧問僅使用硬編碼基本費率 | 顧問建議是靜態的 | 在第一個 10+ 真實上架商品後每小時 cron |

### 13.2 架構風險

| # | 風險 | 概率 | 影響 | 緩解措施 |
|---|------|-------------|--------|------------|
| R1 | 高並發下分類帳漂移 | 低 | Critical | 行鎖定 + 每日對帳 + 嚴格的 idempotency keys |
| R2 | 跨模組事務死鎖 | 低 | 高 | 在 `transferEcoin` 中鎖定順序（排序 user_ids）；單一事務合約流程 |
| R3 | P2-C+ 測試覆蓋不足（token 計量邊緣情況） | 高 | 高 | 在 ship 前要求 rental-proxy.js 達到 100% 語句覆蓋 |
| R4 | 所有者機器人返回巨大回應耗盡租用者餘額 | 中 | 中 | 在轉發前預計算輸入成本；限制每條訊息輸出 tokens（例如 8K） |
| R5 | 租用者濫用租用 entity 的 A2A 訪問權限洩漏機器人給自己的 bots | 低 | 中 | 速率限制 + 跨設備 speak 阻止（P2-E） |
| R6 | 來自不良行為租用者的爭議洪水聲稱崩潰 | 中 | 高 | 自動驗證崩潰檢測 + 虛假索賠的信用評分處罰 |
| R7 | 保險池消耗速度快於佣金補充 | 低 | Critical | 每事件限額 SLA 補償； above threshold 需要管理員批准 |
| R8 | 所有者在平台上的實際 token 成本超過我們向租用者收取的費用 | 高 | 低 | 所有者問題——他们可以調整費率或下架 |

### 13.3 業務風險

- **冷啟動**：市集需要雙方都有用才能發揮作用。考慮用平台運營的機器人播種。
- **定價戰**：所有者可能會積極相互壓價。定價顧問顯示警告但不強制執行下限。
- **爭議升級**：初始 1 人管理員團隊無法擴展到每天 50 多次爭議。早期建立自動路由 + 模板。

---

## 14. 上線計畫

### 14.1 分階段上線

| 階段 | 受眾 | 標準 |
|-------|----------|----------|
| Dev | 僅 Hank（管理員） | 所有 P0 + P1 + P2-A/B 完成；PR #1656 合併到 main |
| Alpha | 5 名精心挑選的測試者 | P2-C token 計量 + P2-F 交接 + 基本爭議路徑 |
| Beta | 邀請制（<100 用戶） | P3 評論 + 爭議 + SLA 統計 |
| GA | 對所有人開放 | P4 保險池 + 黑名單 + P5 推薦 + 所有 12 種語言 |

### 14.2 殺手開關

管理員端點為緊急情況提供手動覆寫：

- `POST /api/rental/admin/pause-marketplace` — 拒絕所有新租賃，現有繼續
- `POST /api/rental/admin/contract/:id/force-end` — 緊急關閉
- `POST /api/wallet/admin/grant` — 已實現；可用於補償
- 環境標誌：`RENTAL_MARKETPLACE_ENABLED=false` 完全禁用路由掛載

### 14.3 遷移策略

尚無現有用戶有錢包，因此 P0 部署是附加的（只是新表格 + 模組）。不需要資料遷移。未來添加欄位（`pending_income_mli` 等）的階段將使用 `ALTER TABLE ADD COLUMN IF NOT EXISTS` 配合合理預設值。

---

## 15. 測試策略

### 15.1 目前測試覆蓋

截至 PR #1656：

| 檔案 | 測試 | 覆蓋 |
|------|-------|----------|
| `wallet.test.js` | 48 | 錢包原語、idempotency、路由、對帳、HTTP 驗證 |
| `rental-listing.test.js` | 23 | 上架商品 CRUD、所有權、鎖定欄位、市集搜索 |
| `rental-contract.test.js` | 25 | 合約生命週期、押金處置、獨占性、自我租賃 |
| `bot-interview.test.js` | 24 | 探針評分、邊緣情況、能力聚合 |
| `pricing-advisor.test.js` | 17 | 系列檢測、費率建議數學、分類 |
| **BRM 測試總計** | **137** | |

所有都使用記憶體 `pg` 模擬器，因此測試在 <2s 內運行，無需任何真實 DB。

### 15.2 測試尚未涵蓋的內容

- 真實 PostgreSQL 並發（兩個節點之間的競爭條件）
- Google Play 購買驗證（需要測試服務帳戶）
- Socket.IO 事件發出（entity:rental-start 等）
- 面試 HTTP 分發（P1 後續）
- Token 計量代理（P2-C）
- 看門狗攔截（P2-D）
- A2A 速率限制（P2-E）

### 15.3 整合測試計劃

在 GA 之前，添加 `backend/tests/test-rental-e2e.js`：

1. 使用測試憑證創建 2 個真實設備
2. 對即時伺服器運行完整生命週期：上架 → 面試 → 租賃 → 聊天 → 結束
3. 驗證前後的錢包餘額
4. 驗證 `rental_usage_events` 行數與發送的訊息匹配
5. 運行對帳並斷言 0 漂移
6. 在 CLAUDE.md「回歸測試」表中注冊

### 15.4 負載測試計劃

在 GA 之前，模擬：
- 同一伺服器上 100 個並發活躍租賃
- 所有租賃中每秒 500 條訊息
- 驗證 p99 租賃代理延遲 < 500ms
- 驗證 reconcile cron 在 24 小時內捕獲任何漂移

---

## 16. 檔案對照表

### 16.1 新檔案（由 BRM 添加）

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
│   │   └── marketplace.html   # Marketplace search page
│   └── shared/
│       └── i18n.js            # Added wallet_* keys (en + zh-TW so far)
└── tests/jest/
    ├── wallet.test.js
    ├── rental-listing.test.js
    ├── rental-contract.test.js
    ├── bot-interview.test.js
    └── pricing-advisor.test.js
```

### 16.2 修改的檔案

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

### 16.3 計劃檔案（未來階段）

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
    └── rental-expire-sweep.js # P2-C: contract auto-expiration cron

backend/public/portal/
├── rental-listing-edit.html   # P1: listing editor
├── rental-contract-detail.html # P2: contract viewing page
└── admin-rental.html          # P3: admin dispute workqueue
```

定價市場快照聚合現在由 `backend/index.js` 以 `11 * * * *` 排程執行。

---

## 附錄 A：設計決策歷史

本文件代表最終狀態。談判歷史（關於計量、扣除順序、機器人獨占性、寬限期長度等的初始 Q&A）保存在記憶體檔案 [`project_bot_rental_system.md`](../../memory/project_bot_rental_system.md)（Claude 的本地記憶體，不在 git 中）和產生 PR #1656 的 session 記錄中。

## 附錄 B：術語表

| 術語 | 定義 |
|------|------------|
| **BRM** | Bot Rental Marketplace——這整個計劃 |
| **mli（釐）** | 最小錢包單位；1 e幣 = 1000 mli |
| **Rate** | 機器人對每次租賃使用收取的 mli/1K tokens 金額 |
| **Deposit** | 租用者餘額的凍結部分，在合約期限內保留（= rate × 20） |
| **Held** | 存儲凍結押金的欄位（`held_mli`）；與可消費的 `balance_mli` 分開 |
| **Snapshot** | 合約開始時上架商品配置的凍結副本；在租賃運行時讀取，而非 live 上架商品 |
| **Interview** | 驗證機器人能力的自動化探針和評分序列 |
| **Probe** | 在面試期間發送到機器人的單個輸入提示 |
| **Gatekeeper** | 過濾訊息以防止提示注入/濫用的現有 EClaw 模組 |
| **Handover** | 將租用機器人插入租用者設備 entity slot 的機械步驟（以及在合約結束時移除） |
| **Ledger** | `wallet_ledger` 表格——每個餘額變更的追加-only 記錄 |
| **Idempotency key** | 唯一標識變更的字串；重複項返回緩存結果而不重新執行 |
| **Vault** | 存儲 API 密鑰等秘密的 `device_vars` 儲存；受租用 entity 保護 |

## 附錄 C：相關文件

- [memory/project_bot_rental_system.md](/Users/hank/.claude/projects/-Users-hank-Desktop-Project-EClaw/memory/project_bot_rental_system.md) — 設計決策日誌（Claude 記憶體，不在 git）
- [backend/wallet_schema.sql](../../backend/wallet_schema.sql) — 錢包 DDL
- [backend/rental_schema.sql](../../backend/rental_schema.sql) — 租賃市集 DDL
- [CLAUDE.md](../../CLAUDE.md) — 項目慣例（自動記憶體、測試規則、工作流程）
- [PR #1656](https://github.com/HankHuang0516/EClaw/pull/1656) — 持續實現線程

---

*文件結束*
