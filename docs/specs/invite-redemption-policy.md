# Invite Redemption Policy

**Status:** Active (adopted 2026-04-24 with PR #2039)
**Author:** Claude (entity #2), written at Hank's direction after confirming no prior spec existed.
**Scope:** `/api/invite/redeem` (device-auth path in `backend/index.js`). Does NOT cover the user-account-based flow in `backend/invite.js`, which has its own `max_uses` / `use_count` semantics.

## Summary (TL;DR)

Each invite code is redeemable **once total** (by any single device). A device may redeem **many different codes** — one per inviter — but never the same code twice (trivially enforced, since a code becomes "used" after first redemption).

This replaces the previous "one redemption per device, ever" rule which was not documented and never had a written rationale.

## Rules

| Rule | Enforced by |
|---|---|
| Code must exist | `SELECT ... WHERE code = $1` (404 if not found) |
| Code must not already be consumed | `if (used_by_device_id) → 409 invite_code_already_used` |
| Device cannot redeem its own code | `if (owner_device_id === deviceId) → 400 self_invite` |
| Device may redeem any number of distinct codes from different inviters | Absence of prior per-device-lifetime guard |

## Rewards (unchanged)

- Invitee: +300 bonus messages
- Inviter: +50 bonus messages per new redeemer, plus tier/milestone unlocks at 3 / 10 / 30 / 100 unique invitees.

Because each code pays out at most once, the total reward pool is O(unique codes issued), not O(device × code). Reward inflation is bounded by how many codes exist system-wide, not by how many devices redeem.

## Why Option B over "one-per-device lifetime"

Weighed on 2026-04-24 after week-one viral loop audit showed redemption = 0 / 8 issued codes. The prior lifetime-lock had two structural problems:

1. **It silently blocks second-degree network effects.** In a mutual-invite social app, the 2nd, 3rd, 4th friend who wants to invite an already-onboarded user is simply wasted. Their code gets shared, clicked, and rejected with `you_have_already_redeemed` — with no visible hint that it's a lifetime lock, not a code-level issue.
2. **It doesn't actually gate fraud.** Anyone motivated to farm bonus messages will spin up new device IDs — the per-device lock doesn't meaningfully raise the attack cost. Per-code-once (already enforced separately) is the real anti-abuse bound: each code pays out at most once regardless of who redeems.

The tradeoff accepted: a small mutual-invite ring of N real users could each redeem each other's code for a net of `N × (300 invitee + 50 inviter) − N` rewards. At N = 4, that's 1400 bonus messages for 4 real accounts — well within the noise floor of the current growth stage.

## What to revisit

- If reward fraud emerges at scale, tighten anti-abuse at the **account / identity** layer (shared phone, shared payment), not at the per-device-redemption layer.
- If the redemption count per device needs a rate-limit for other reasons (e.g. onboarding flow confusion), add a time-window cap (e.g. "max 3 codes redeemed in 7 days"), not a lifetime cap.

## References

- Source: `backend/index.js` — `POST /api/invite/redeem` (~line 4269)
- Prior behavior: `SELECT 1 FROM invite_codes WHERE used_by_device_id = $1` guard at old lines 4288-4290 (removed in PR #2039)
- Related: `backend/invite.js` — parallel user-account flow using `invite_redemptions` table (not yet wired to an HTTP route)
- Growth context: Week-of-2026-04-18 viral loop report (0/8 conversion) triggered this spec
