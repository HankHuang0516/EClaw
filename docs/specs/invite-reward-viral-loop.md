# Invite Reward Viral Loop Spec

**Status:** Draft, 2026-05-31
**Owner:** Growth / Invite loop
**Scope:** Live device-auth invite flow in `backend/index.js`, invite reward wallet crediting, Community / Plaza CTA, and k-value tracking.
**Non-goals:** Rewriting the full Phase-5 user-auth invite router, changing production reward amounts without a migration flag, or replacing the existing `/invite/:code` landing route.

## 1. Current State Audit

### Live invite surface

The production invite flow is the device-auth implementation in `backend/index.js`.

| Route | Current behavior |
|---|---|
| `GET /invite/:code` | Public link landing. Validates a short code, logs a best-effort click row through `db.logInviteClick`, then redirects to `/portal/invite.html?redeem={code}`. |
| `GET /api/invite/my-code` | Resolves auth from `deviceId`/`deviceSecret` or the `eclaw_session` cookie, returns or creates one `invite_codes` row for the caller's `deviceId`. |
| `POST /api/invite/redeem` | Resolves auth, validates code, enforces per-code-once and no self-invite, marks `invite_codes.used_by_device_id`, then credits legacy bonus-message quota. |
| `GET /api/invite/stats` | Returns the caller's invite code, legacy bonus-message balance, total invite count, milestone tier state, and daily message limit. |
| `GET /api/invite/clicks` | Returns owner-scoped click and redemption funnel rows for the caller's invite codes. |

The adopted redemption policy is `docs/specs/invite-redemption-policy.md`: each code is redeemable once total, a device may redeem multiple distinct inviters' codes, and self-invite is rejected.

### Live schema

`backend/auth_schema.sql` owns the live device-based invite tables:

- `invite_codes(code, owner_device_id, used_by_device_id, used_at, created_at)`
- `invite_rewards(device_id, bonus_messages, total_invited, updated_at, milestones_claimed)`
- `invite_clicks(code, clicked_at, ip_hash, user_agent, referer, source)`

Current reward payout is not wallet-backed:

- Invitee gets `+300` bonus messages.
- Inviter gets `+50` bonus messages.
- Inviter milestone bonuses unlock at `3 / 10 / 30 / 100` total invites.

### Dormant Phase-5 router

`backend/invite.js` exists but is not mounted. Its header states that the live `/api/invite/*` endpoints are still the `backend/index.js` device-auth endpoints.

The dormant router targets a user-auth shape:

- `invite_codes.owner_user_id`, `max_uses`, `use_count`, `expires_at`
- `invite_redemptions(invitee_user_id, inviter_reward_mli, invitee_reward_mli, first_topup_bonus_mli, first_topup_credited)`
- Wallet credit constants:
  - inviter reward: `500 ecoin`
  - invitee reward: `100 ecoin`
  - first-topup bonus: `500 ecoin`

Because the live `invite_codes` table is device-based and already drives click/redemption metrics, mounting `backend/invite.js` directly would be a behavior change and a schema mismatch, not a safe incremental delivery.

### Wallet state

`backend/wallet.js` and `backend/wallet_schema.sql` are live. Wallets are user-account keyed, balances are stored in `mli` where `1 ecoin = 1000 mli`, and `wallet_ledger` is append-only with idempotency keys.

Ledger type constants already include:

- `referral_bonus`
- `signup_bonus`
- `subscription_grant`

The dormant invite router currently calls `walletModule.creditTopup(...)`, which writes a `topup` ledger row. For invite rewards, the live implementation should use `applyLedgerEntry` or a small wallet helper that writes `referral_bonus` / `signup_bonus`, not a fake top-up.

### Community / Plaza state

`backend/public/portal/community.html` currently loads:

- community bots from `/api/community/search`
- rental listings from `/api/rental/marketplace`

It has bot share buttons and rental CTA flows, but no invite CTA, no invite reward preview, and no share link UX tied to `GET /api/invite/my-code`.

### Growth metric state

`backend/growth.js` exposes `GET /api/growth/daily`. Invite metrics currently include:

- cumulative `invite_conversion` from `invite_codes`
- date-scoped `invite_clicks` from `invite_clicks`

The response explicitly notes that invite conversion is cumulative-to-now and not suitable for historical k-value by day.

## 2. Gap To A k > 1 Viral Loop

The current loop can create invite codes and redeem them, but it is not yet a measured wallet-backed viral loop.

1. **Reward formula is undocumented for the live path.** The dormant Phase-5 router has ecoin constants, while the live route pays bonus messages. There is no single spec saying which reward is the growth incentive, which ledger types to use, or how retry/idempotency works.
2. **User-auth invite is not mounted.** The wallet system is user-account keyed, but the live invite route resolves only a device ID. The implementation needs a device-to-user lookup bridge instead of swapping in `backend/invite.js`.
3. **Live redeem does not credit wallet.** Successful redemptions only update `invite_rewards`; no `wallet_ledger` rows are written.
4. **Community CTA is missing.** The highest-discovery page, Community / Plaza, does not prompt a user to share their invite link.
5. **k-value tracker is missing.** Existing conversion is cumulative and does not expose `shares -> clicks -> redemptions -> activated invitees` for a date or cohort window.

## 3. Proposed Reward Contract

### Reward amounts

Use the dormant Phase-5 constants as the initial wallet-backed contract:

| Reward event | Recipient | Amount |
|---|---:|---:|
| Invite redemption | Inviter | `500 ecoin` (`500000 mli`) |
| Invite redemption | Invitee | `100 ecoin` (`100000 mli`) |
| Invitee first top-up | Inviter | `500 ecoin` (`500000 mli`) |

The first-topup bonus is part of the contract but should ship after the base redeem-credit path unless the backend PR already touches top-up verification.

### Reward source of truth

Wallet ledger is the source of truth for spendable ecoin rewards. The existing `invite_rewards.bonus_messages` fields remain a backward-compatible quota surface during migration, but new product UI should show wallet rewards.

### Idempotency

Each successful code redemption must be retry-safe.

Recommended idempotency keys:

- inviter credit: `invite:redeem:inviter:{code}:{invitee_device_id}`
- invitee credit: `invite:redeem:invitee:{code}:{invitee_device_id}`
- first-topup inviter bonus: `invite:first-topup:inviter:{code}:{invitee_user_id}:{topup_order_id}`

Replaying `POST /api/invite/redeem` after a success must not create additional wallet credit.

### Eligibility

Base constraints remain:

- code exists
- code has not been used
- invitee device is not the owner device
- one code can be redeemed once total

Wallet credit requires a `user_accounts` row for the target device. If either side is device-only and has no wallet-capable user account, the redeem path must not silently claim wallet success. It should record the redemption and return a wallet status such as `pending_user_account`, or reject with an explicit `wallet_user_required` error if the product requires login for this flow.

P0 recommendation: require the portal/JWT path for wallet credit, keep device-secret redemption backward-compatible for bonus-message credit, and expose the wallet status in the response.

## 4. Proposed Schema Delta

### Wallet ledger type contract

`wallet_ledger.type` is currently a `VARCHAR(32)` mirrored by `LEDGER_TYPES` in `wallet.js`, not a PostgreSQL enum. Keep that pattern unless the whole ledger moves to a DB-level enum.

Required code/docs delta:

- Confirm `referral_bonus` is the inviter redemption ledger type.
- Confirm `signup_bonus` is the invitee welcome ledger type.
- Add `invite_first_topup_bonus` to `LEDGER_TYPES` and the `wallet_schema.sql` type comment if first-topup ships as a distinct ledger type. If not, use `referral_bonus` with `ref_type='invite_first_topup'`.

Recommended ledger refs:

| Event | `type` | `ref_type` | `ref_id` |
|---|---|---|---|
| Inviter redeem credit | `referral_bonus` | `invite_code` | `{code}` |
| Invitee redeem credit | `signup_bonus` | `invite_code` | `{code}` |
| Inviter first-topup credit | `invite_first_topup_bonus` or `referral_bonus` | `invite_first_topup` | `{topup_order_id}` |

### Invite redemption reward audit

The existing `invite_redemptions` table is Phase-5-shaped and currently requires `invitee_user_id`. Do not force the live device-auth path into this table without a migration that supports device IDs.

Recommended non-breaking migration:

```sql
ALTER TABLE invite_redemptions
    ADD COLUMN IF NOT EXISTS inviter_device_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS invitee_device_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS inviter_user_id UUID,
    ADD COLUMN IF NOT EXISTS reward_type VARCHAR(32) NOT NULL DEFAULT 'redeem',
    ADD COLUMN IF NOT EXISTS inviter_reward_amount_mli BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS invitee_reward_amount_mli BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS inviter_wallet_ledger_id BIGINT,
    ADD COLUMN IF NOT EXISTS invitee_wallet_ledger_id BIGINT,
    ADD COLUMN IF NOT EXISTS wallet_credit_status VARCHAR(32) NOT NULL DEFAULT 'not_attempted';
```

Follow-up migration options:

- Relax `invitee_user_id NOT NULL` only when live device-auth redemptions will dual-write here.
- Add a partial uniqueness guard for live device redemptions:
  `UNIQUE (code) WHERE reward_type = 'redeem'`.
- Add `reward_type` values: `redeem`, `first_topup`.

If relaxing `invite_redemptions` is too risky, create a separate `invite_reward_events` audit table with the same columns above and leave Phase-5 `invite_redemptions` untouched until the account migration.

### k-value event support

`invite_clicks` covers click telemetry. The missing explicit event is share intent.

Add either:

- `invite_share_events(code, owner_device_id, owner_user_id, channel, source, shared_at)`

or log an equivalent portal beacon action:

- `action='invite_share'`
- `meta.source='community' | 'invite_page' | 'profile'`
- `meta.channel='copy' | 'native_share' | 'qr'`

P0 recommendation: use portal beacons if the existing table already supports the needed fields; add `invite_share_events` only if owner-code joins become awkward or slow.

## 5. API Spec

### Decision: extend the live route

Extend `POST /api/invite/redeem` in `backend/index.js`. Do not mount `backend/invite.js` for this feature.

Reasons:

- `/invite/:code` and click telemetry already target the live `invite_codes` table.
- The adopted redemption policy is implemented in `backend/index.js`.
- `backend/invite.js` assumes user-auth and a different `invite_codes` shape.
- A route swap would risk breaking device-auth Android and existing portal invite links.

### `GET /api/invite/my-code`

Keep existing response fields and add share/reward metadata:

```json
{
  "success": true,
  "code": "ABCD2345",
  "share_url": "https://eclawbot.com/invite/ABCD2345?utm_source=community&utm_medium=share",
  "bonus_messages": 0,
  "total_invited": 0,
  "wallet_reward_preview": {
    "inviter_reward_mli": 500000,
    "invitee_reward_mli": 100000,
    "first_topup_bonus_mli": 500000
  }
}
```

### `POST /api/invite/redeem`

Request stays backward-compatible:

```json
{
  "code": "ABCD2345",
  "deviceId": "optional-device-auth",
  "deviceSecret": "optional-device-auth"
}
```

Success response extends the current shape:

```json
{
  "success": true,
  "bonus_granted": 300,
  "message": "Invite code redeemed! +300 bonus messages added.",
  "wallet_rewards": {
    "status": "credited",
    "inviter_reward_mli": 500000,
    "invitee_reward_mli": 100000,
    "inviter_ledger_id": 123,
    "invitee_ledger_id": 124
  },
  "inviter_milestones_unlocked": []
}
```

Possible `wallet_rewards.status` values:

- `credited`
- `already_credited`
- `pending_user_account`
- `skipped_device_only`

Error responses should keep current HTTP classes:

| Condition | Status | Error |
|---|---:|---|
| Missing code | `400` | `code_required` |
| Code not found | `404` | `invite_code_not_found` |
| Code already used | `409` | `invite_code_already_used` |
| Self invite | `400` | `self_invite` |
| Auth missing/invalid | `401` or `403` | existing auth error |

### Transaction requirement

Redeem, audit, and wallet credit must be one logical operation. Preferred backend shape:

1. Open one database transaction.
2. `SELECT ... FROM invite_codes WHERE code = $1 FOR UPDATE`.
3. Enforce code/self-use constraints.
4. Resolve inviter and invitee user IDs from `user_accounts.device_id`.
5. Mark `invite_codes.used_by_device_id` and `used_at`.
6. Preserve legacy `invite_rewards` updates during the migration.
7. Insert or update the redemption reward audit row.
8. Write wallet ledger entries with stable idempotency keys.
9. Commit.

If a single transaction cannot be shared cleanly across `authModule.pool` and `walletModule`, use `walletModule.withTransaction` and run all invite queries on that client, since the tables live in the same database.

### `GET /api/invite/stats`

Keep current fields and add wallet-backed reward stats:

```json
{
  "success": true,
  "code": "ABCD2345",
  "bonus_messages": 0,
  "total_invited": 4,
  "wallet_rewards": {
    "total_earned_mli": 2000000,
    "pending_mli": 0,
    "last_reward_at": "2026-05-31T09:00:00.000Z"
  },
  "tier": "bronze"
}
```

### Growth API

Extend `GET /api/growth/daily` with date-scoped invite k-value data:

```json
{
  "invite_k": {
    "window": "daily",
    "active_inviters": 12,
    "share_events": 18,
    "unique_clicks": 30,
    "redeemed": 6,
    "activated_invitees": 5,
    "k_observed": 0.42,
    "k_model": 0.42,
    "rates": {
      "shares_per_inviter": 1.5,
      "clicks_per_share": 1.67,
      "redeem_per_click": 0.2,
      "activation_per_redeem": 0.83
    }
  }
}
```

## 6. Frontend Flow

### Community / Plaza CTA

Add a logged-in invite CTA to `backend/public/portal/community.html` near the search/filter surface so it is visible during marketplace discovery.

Required behavior:

1. On page load, call `GET /api/invite/my-code` with `credentials:'include'`.
2. If authenticated, render an invite CTA with:
   - reward preview
   - copy-link action
   - native share action when `navigator.share` exists
   - link to `/portal/invite.html` for QR/details
3. Share link format:
   - `https://eclawbot.com/invite/{code}?utm_source=community&utm_medium={copy|native_share}`
4. Log share intent:
   - portal beacon `invite_share`, or `POST /api/invite/share-event` if a dedicated endpoint is added.
5. If unauthenticated, hide the CTA rather than showing an error block inside the plaza grid.

### Invite landing continuity

`/invite/:code` remains the public share URL. It should continue logging click telemetry and redirecting to `/portal/invite.html?redeem={code}`.

`invite.html` remains the redemption page. The wallet-backed response should let it show:

- invitee reward credited
- inviter reward credited or pending
- clear error for already-used/self/invalid code

### UX acceptance

The invite CTA must not block Community / Plaza loading. If `/api/invite/my-code` fails, the page should still load community and rental bots.

## 7. k-Value Metric Definition

### Product definition

The invite loop has k > 1 when each active inviter produces more than one activated invitee inside the measurement window.

Primary observed metric:

```text
k_observed = activated_invitees_from_invites / active_inviters
```

Where:

- `active_inviters`: users/devices that generated or shared an invite code in the window.
- `activated_invitees_from_invites`: invitees who redeemed a code and reached the activation threshold in the window.

P0 activation threshold:

- redeemed invite code successfully
- wallet reward credited or marked pending

P1 activation threshold:

- redeemed invite code successfully
- completed one meaningful product action within 7 days, such as first bot chat, first marketplace detail open, first rental, or first bound entity action

### Funnel model

Use this for diagnosis:

```text
k_model =
  shares_per_inviter
  * clicks_per_share
  * redeem_per_unique_click
  * activation_per_redeem
```

Date-scoping rules:

- Use Asia/Taipei calendar days for `GET /api/growth/daily`.
- `share_events` use `shared_at`.
- `unique_clicks` use `invite_clicks.clicked_at`.
- `redeemed` use `invite_codes.used_at` or redemption audit `redeemed_at`.
- `activated_invitees` use activation event time.

Do not compute historical k-value from cumulative `invite_conversion`.

### Minimum viable tracker

P0 can ship with:

- `share_events` from portal beacon or dedicated share table
- `unique_clicks` from `invite_clicks`
- `redeemed` from `invite_codes.used_at`
- `activated_invitees = redeemed`

P1 should replace `activated_invitees = redeemed` with a real activation event.

## 8. Acceptance Criteria

### Spec PR

- `docs/specs/invite-reward-viral-loop.md` exists and documents current state, gaps, schema/API/frontend/metric decisions, acceptance, and PR split.
- No production code is changed in the spec PR.

### Schema PR

- Invite reward audit columns or `invite_reward_events` table are migrated without breaking existing Phase-5 `invite_redemptions` reads.
- Wallet ledger type constants and `wallet_schema.sql` comments include the invite reward types used by implementation.
- Migration is backward-compatible with current `invite_codes` and `invite_rewards`.

### Backend PR

- `POST /api/invite/redeem` still supports the current live auth contract.
- A successful portal user redemption:
  - marks `invite_codes.used_by_device_id`
  - preserves legacy invite reward updates during migration
  - credits inviter wallet
  - credits invitee wallet
  - writes idempotent wallet ledger rows
  - writes reward audit state
- Replaying the same redeem request does not double-credit wallet.
- Self-invite, invalid code, and already-used code return stable errors.
- `GET /api/invite/stats` includes wallet reward totals.
- `GET /api/growth/daily?date=YYYY-MM-DD` returns date-scoped `invite_k`.

### Frontend + tracker PR

- Community / Plaza shows an invite CTA for logged-in users without blocking bot/rental loading.
- Copy and native share produce `/invite/{code}` links with source/medium tags.
- Share intent is tracked.
- Invite landing and redeem UI show wallet reward result or explicit pending/error state.
- k-value calculation uses share, click, redeem, and activation counts for the requested date.

## 9. PR Split

1. **Schema migration PR**
   - Add invite reward audit support.
   - Confirm or add wallet reward ledger type constants.
   - Add migration/backfill tests where practical.

2. **Backend extension PR**
   - Extend live `backend/index.js` invite redeem path.
   - Add wallet crediting with idempotent ledger rows.
   - Extend invite stats and growth daily k-value.
   - Keep `backend/invite.js` unmounted.

3. **Frontend + tracker PR**
   - Add Community / Plaza invite CTA and share UX.
   - Add share-event tracking.
   - Update invite landing reward messaging.
   - Surface k-value in the growth/admin path used by owner bots.

## 10. Open Questions

1. Should wallet credit require both inviter and invitee to have `user_accounts` rows, or should device-only redemptions create pending wallet rewards for later account binding?
2. Should the legacy bonus-message rewards continue after wallet rewards launch, or become a temporary migration-only compatibility field?
3. Should first-topup bonus ship in the backend extension PR, or wait for a separate top-up integration PR?
4. What activation event should replace `activated_invitees = redeemed` for P1 k-value: first chat, first bot bind, first marketplace action, or first rental?
