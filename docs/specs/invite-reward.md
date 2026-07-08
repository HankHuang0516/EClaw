# Invite Reward — viral loop k>1

**Status:** Draft (2026-05-31)
**Owner:** #2 (LOBSTER)
**Card:** `card_e56010f1a00a0d9ce4644455`
**Goal:** Each existing EClaw user invites ≥1 new user who signs up + activates (k>1).

## Problem
`/api/help?intent=invite` returns 0 endpoints. No invite-code mint, no redeem path, no reward ledger, no k-value tracking. Growth gate is missing.

## Non-goals (this spec)
- Multi-tier referral cascades (level-2+ rewards)
- Paid invite slots (separate monetization)
- Invite spam abuse mitigation beyond rate-limit + per-device cap (separate hardening pass)

## Architecture

### Invite-code lifecycle
```
mint → share (off-platform) → redeem (new user signup) → activate (new user binds first entity) → reward (both parties credited)
```

### DB schema additions (one migration)
**`invite_codes`**
- `id` UUID PK
- `code` varchar(12) UNIQUE — short URL-safe code (e.g. `inv_a8f2k1q9`)
- `owner_device_id` varchar(36) — minter
- `owner_entity_id` int — minter's preferred crediting entity
- `created_at` timestamptz
- `expires_at` timestamptz — default 30d
- `max_redemptions` int default 10 — anti-abuse cap
- `redeemed_count` int default 0
- `status` enum: `active|exhausted|expired|revoked`

**`invite_redemptions`**
- `id` UUID PK
- `code_id` FK → invite_codes.id
- `redeemer_device_id` varchar(36) — new user's device
- `redeemed_at` timestamptz
- `activated_at` timestamptz NULL — set when redeemer binds first entity
- `reward_status` enum: `pending|owner_credited|redeemer_credited|both_credited|forfeit_inactive_30d`

**`reward_ledger`**
- `id` UUID PK
- `device_id` varchar(36)
- `entity_id` int NULL — optional entity-scoped credit
- `event_type` enum: `invite_minted|invite_redeemed_owner_reward|invite_activated_owner_reward|invite_redeemer_signup_reward|invite_redeemer_activated_reward`
- `amount` int — credit/coin units (TBD by Hank)
- `currency` varchar(8) — `xp` | `coin` | `slot` (TBD)
- `source_redemption_id` FK → invite_redemptions.id NULL
- `created_at` timestamptz
- `metadata` jsonb

### k-value tracking (analytics)
- `k = sum(activated_redemptions in window) / sum(active_inviters in window)`
- Window: rolling 14 days
- Source-of-truth: `invite_redemptions` joined with `devices` (filter `activated_at IS NOT NULL`)
- Surface: `/api/analytics/viral` (new endpoint, owner-device-only)

## API endpoints (3 new)

### `POST /api/invite/mint`
Body: `{deviceId, deviceSecret OR botSecret+entityId}`
- Generates a fresh code for owner
- Returns: `{code, shareUrl, expiresAt, max_redemptions}`
- Rate-limit: 5 mints/owner/24h

### `POST /api/invite/redeem`
Body: `{code, redeemerDeviceId}` — called during new device signup
- Validates code (active, not expired, not exhausted)
- Increments `redeemed_count`
- Creates `invite_redemptions` row (no activation yet)
- Triggers ledger entry: `invite_redeemed_owner_reward` for owner (small reward, e.g. 50 xp)

### `GET /api/invite/status?code=`
Public-ish (rate-limited): returns `{status, owner_display_name, redeemed_count, max_redemptions}` — no PII.

### Activation hook (existing path)
When `redeemerDeviceId` binds first entity (in `/api/transform` initial-bind or `/api/official-borrow/bind-free`):
- Look up `invite_redemptions` where `redeemer_device_id = deviceId AND activated_at IS NULL`
- If found: set `activated_at = NOW()`, ledger entry both sides:
  - Owner: `invite_activated_owner_reward` (bigger reward, e.g. 200 xp)
  - Redeemer: `invite_redeemer_activated_reward` (small starter pack, e.g. 100 xp + 1 free-bot slot)

## Frontend (one CTA page + invite tab)

### `portal/community.html` — invite tab
- "Your invite code: `inv_a8f2k1q9`" (copy button)
- "Active redemptions: 3 / 10"
- "k-value: 1.4 (last 14d)" — only show if k>0
- Share-sheet integration: `navigator.share()` fallback to copy link

### Onboarding CTA (existing signup flow)
- Add invite-code input field on `/portal/auth.html` or first-time-binding screen
- On bind, call `/api/invite/redeem` BEFORE first entity bind
- Show toast: "歡迎！你的邀請者 @{owner} 已得到獎勵 ✓"

## PR split

**PR-A: Backend** (1 migration + 3 endpoints + activation hook in /api/transform)
- migration `004x_invite_reward.sql` (3 tables, 1 index per FK)
- backend/invite-reward.js (new module, ~300 lines)
- backend/index.js — mount route + activation hook (~30 lines)
- Unit tests: 8 cases (mint/redeem/expire/exhaust/double-redeem/activation/ledger/k-value)

**PR-B: Frontend (invite tab + onboarding CTA)**
- portal/community.html invite tab
- portal/auth.html invite-code input
- shared/i18n.js: 12 new keys × 4 locales (zh-TW/zh/en/ja)
- E2E: Playwright `invite-redeem.test.js` — happy path + expired + exhausted

**PR-C: Analytics endpoint**
- backend/analytics-viral.js (k-value calculator)
- portal/dashboard.html add k-value widget (owner-only view)

## Acceptance (full feature)
- [ ] `/api/help?intent=invite` returns 3+ endpoints
- [ ] Mint → share URL → cold-signup → redeem → activate (E2E)
- [ ] Owner sees reward credit in ledger
- [ ] Redeemer sees starter pack credit
- [ ] Dashboard shows k-value (≥0)
- [ ] Rate-limit honored (mint 6th time/24h returns 429)
- [ ] Expired code returns 410 with reason
- [ ] i18n all 4 locales

## Open questions (need Hank sign-off before PR-A)
1. **Reward currency**: XP-only or also coin/slot? Specifically: should redeemer get a free bot slot as starter pack?
2. **Owner reward gating**: pay on redeem (signup) or only on activation (binds entity)? Spec defaults to small-on-redeem + bigger-on-activate.
3. **Code format**: prefix `inv_` then 8-char base32? Or human-friendly (e.g. `LOBSTER-X8FQ`)?
4. **Anti-abuse**: 5 mints/day + 10 redemptions/code enough? Or need device-fingerprint dedup on redeem side?
5. **Max code age**: 30d default OK? Or unlimited (with manual revoke)?

## Dependencies
- None on EClaw codebase (independent feature)
- Soft dependency: stop-mode redo workflow (card_248e8fdee) should land first if i18n is shared (they touch same i18n.js)

## Estimate
- PR-A: 1.5 day (#2 self, backend)
- PR-B: 1 day (i18n + frontend; possibly split: #2 frontend, Hermes i18n)
- PR-C: 0.5 day (#2 self, analytics)
- Total: ~3 days clock time + #1 spec sign-off + Hank sign-off on open questions

## Reference
- Card: `card_e56010f1a00a0d9ce4644455`
- Cron sweep that flagged this: viral daily 2026-05-31
- Hank autonomy grant: 2026-05-31 15:48 TPE "你可以自己安排"
